// Bounty Scout — a personal agent that lives on a Fly.io Sprite.
// Watches HackenProof for new bug bounty programs, scores them against
// the hunter's profile, and files the good ones as GitHub issues.
// Runs on a Sprite. Uses the GitHub connector through the Sprites API
// Gateway (no token ever lives on the Sprite).
//
// Scoring is deterministic and rule-based, so the demo is reproducible:
//   - max Critical reward (bigger payout = higher score)
//   - reputation gate vs the hunter's current rep (can join now?)
//   - smart-contract scope (the hunter's strength)
//   - web / API scope
//   - program maturity (rewards already paid out = real program)
// New programs get a bonus. Score >= 60 gets filed as an issue.
//
// Optional LLM upgrade: if an OpenRouter connection is available, set
// OPENROUTER_CONN_ID and the agent asks it to write the triage summary.
// Without it, a template summary is used instead.

const fs = require("fs");
const path = require("path");
const http = require("http");

// ---------------------------------------------------------------- config
const GATEWAY = "https://api.sprites.dev/v1/gateway";
const GITHUB_CONN_ID = "D-PlHkX0Y2dWAydXkIcWBw"; // onlyjepe, read:org,repo
const REPO_OWNER = "onlyjepe";
const REPO_NAME = "bounty-scout";
const HACKENPROOF = "https://hackenproof.com";
const HUNTER_REP = 80; // takanome on HackenProof
const SCORE_THRESHOLD = 60;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ISSUES_PER_RUN = 5;
const PORT = 8080;
const OPENROUTER_CONN_ID = process.env.OPENROUTER_CONN_ID || ""; // optional

const DATA_DIR = path.join(__dirname, "data");
const SEEN_FILE = path.join(DATA_DIR, "seen.json");
const STATUS_FILE = path.join(DATA_DIR, "status.json");

const UA = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 BountyScout/1.0",
};

// ---------------------------------------------------------------- state
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let seen = loadJson(SEEN_FILE, {}); // slug -> { firstSeen, score, filed, name }
let status = loadJson(STATUS_FILE, {
  startedAt: new Date().toISOString(),
  lastRunAt: null,
  runs: 0,
  programsSeen: 0,
  issuesFiled: 0,
  lastFindings: [],
  errors: [],
});

// ---------------------------------------------------------------- helpers
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function money(n) {
  return "$" + Number(n || 0).toLocaleString("en-US");
}
function stripTags(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- scraping
async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.text();
}

async function listPrograms() {
  const html = await fetchText(`${HACKENPROOF}/programs`);
  const slugs = [
    ...new Set([...html.matchAll(/href="\/programs\/([a-z0-9-]+)"/g)].map((m) => m[1])),
  ];
  return slugs;
}

function parseProgramPage(html, slug) {
  const text = stripTags(html);
  const p = { slug, url: `${HACKENPROOF}/programs/${slug}` };

  // Name: from the <title> tag ("ZMO Exchange: Program Info | HackenProof")
  // or the <h1> ("ZMO Exchange: Program info"). Fall back to the slug.
  let name = slug;
  const titleM = html.match(/<title>([^<]*)<\/title>/i);
  if (titleM) name = titleM[1].replace(/:\s*Program Info\s*\|\s*HackenProof/i, "").trim();
  if (!name || name === slug) {
    const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1M) {
      const h1 = stripTags(h1M[1]).replace(/:\s*Program info/i, "").trim();
      if (h1) name = h1;
    }
  }
  p.name = name;

  const rangeM = text.match(/Rewards Range of bounty \$([\d,]+) - \$([\d,]+)/);
  p.rewardMin = rangeM ? parseInt(rangeM[1].replace(/,/g, "")) : 0;
  p.rewardMax = rangeM ? parseInt(rangeM[2].replace(/,/g, "")) : 0;

  const sev = {};
  for (const s of ["Critical", "High", "Medium", "Low"]) {
    const m = text.match(
      new RegExp(`${s} \\$([\\d,]+) - \\$([\\d,]+)`)
    );
    if (m) sev[s] = [parseInt(m[1].replace(/,/g, "")), parseInt(m[2].replace(/,/g, ""))];
  }
  p.severity = sev;

  const repM = text.match(/Reputation (\d+) points required/);
  p.repRequired = repM ? parseInt(repM[1]) : 0;

  const pubM = text.match(/Published date (\d+ [A-Za-z]+ \d{4})/);
  p.published = pubM ? pubM[1] : "unknown";

  const paidM = text.match(/Total rewards: \$([\d,]+)/);
  p.totalPaid = paidM ? parseInt(paidM[1].replace(/,/g, "")) : 0;

  const subM = text.match(/Submissions: (\d+)/);
  p.submissions = subM ? parseInt(subM[1]) : 0;

  const pocM = text.match(/PoC Required/);
  p.pocRequired = !!pocM;

  // scope: look for target types in the in-scope section
  const scopeIdx = text.indexOf("In scope");
  const scopeText = scopeIdx >= 0 ? text.slice(scopeIdx, scopeIdx + 3000) : text;
  p.hasSmartContracts = /Smart Contract/i.test(scopeText);
  p.hasWeb = /\bWeb\b/.test(scopeText);
  p.hasMobile = /Android|iOS/i.test(scopeText);
  p.hasApi = /\bAPI\b/.test(scopeText);

  const typeM = text.match(/Project types ([A-Za-z ,]+?) Types/);
  p.projectTypes = typeM ? typeM[1].trim() : "";

  return p;
}

// ---------------------------------------------------------------- scoring
function scoreProgram(p) {
  let score = 0;
  const why = [];

  const max = p.rewardMax || 0;
  if (max >= 100000) { score += 45; why.push(`max reward ${money(max)} (+45)`); }
  else if (max >= 5000) { score += 40; why.push(`max reward ${money(max)} (+40)`); }
  else if (max >= 1000) { score += 35; why.push(`max reward ${money(max)} (+35)`); }
  else if (max >= 500) { score += 25; why.push(`max reward ${money(max)} (+25)`); }
  else if (max >= 100) { score += 15; why.push(`max reward ${money(max)} (+15)`); }
  else { why.push(`max reward ${money(max)} (+0)`); }

  if (p.repRequired === 0) { score += 20; why.push("no reputation gate (+20)"); }
  else if (p.repRequired <= HUNTER_REP) { score += 20; why.push(`rep gate ${p.repRequired} (you have ${HUNTER_REP}) (+20)`); }
  else { score += 5; why.push(`rep gate ${p.repRequired} (you have ${HUNTER_REP}, need more) (+5)`); }

  if (p.hasSmartContracts) { score += 15; why.push("smart contracts in scope (+15)"); }
  if (p.hasWeb) { score += 10; why.push("web in scope (+10)"); }
  if (p.hasApi) { score += 5; why.push("API in scope (+5)"); }

  if (p.totalPaid > 0) { score += 5; why.push(`already paid ${money(p.totalPaid)} (+5)`); }
  else { score -= 5; why.push("no rewards paid yet (-5)"); }

  if (p.pocRequired) { score -= 5; why.push("PoC required (-5)"); }

  return { score: Math.max(0, Math.min(100, score)), why };
}

// ---------------------------------------------------------------- LLM (optional)
async function llmSummary(p, s) {
  if (!OPENROUTER_CONN_ID) return null;
  try {
    const res = await fetch(
      `${GATEWAY}/openrouter/${OPENROUTER_CONN_ID}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: `In 2 short sentences, why should a bug bounty hunter with 80 reputation and smart-contract skills look at this program? Program: ${p.name}. Max reward ${money(p.rewardMax)}. Scope: smart contracts ${p.hasSmartContracts}, web ${p.hasWeb}, API ${p.hasApi}. Reputation required: ${p.repRequired || "none"}. Total paid so far: ${money(p.totalPaid)}.`,
            },
          ],
          max_tokens: 120,
        }),
      }
    );
    const j = await res.json();
    return j.choices && j.choices[0] ? j.choices[0].message.content.trim() : null;
  } catch (e) {
    log("LLM summary failed:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------- GitHub
async function ghApi(path, method, body) {
  const res = await fetch(`${GATEWAY}/github/${GITHUB_CONN_ID}${path}`, {
    method: method || "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function issueBody(p, s) {
  const sevLines = Object.entries(p.severity || {})
    .map(([k, v]) => `- ${k}: ${money(v[0])} - ${money(v[1])}`)
    .join("\n");
  const scope = [];
  if (p.hasSmartContracts) scope.push("smart contracts");
  if (p.hasWeb) scope.push("web");
  if (p.hasApi) scope.push("API");
  if (p.hasMobile) scope.push("mobile");
  const gate = p.repRequired === 0
    ? "No reputation gate. You can join now."
    : p.repRequired <= HUNTER_REP
    ? `Reputation gate ${p.repRequired}. You have ${HUNTER_REP}, so you can join now.`
    : `Reputation gate ${p.repRequired}. You have ${HUNTER_REP}, so you need ${p.repRequired - HUNTER_REP} more reputation first.`;
  const verdict = s.score >= SCORE_THRESHOLD ? "Worth a look." : "Below the filing threshold.";
  return [
    `**${p.name}** — new program on HackenProof.`,
    ``,
    `Program: ${p.url}`,
    `Published: ${p.published}`,
    `Reward range: ${money(p.rewardMin)} - ${money(p.rewardMax)}`,
    ``,
    `Rewards by severity:`,
    sevLines || "- not listed",
    ``,
    `Scope: ${scope.join(", ") || "see program page"}`,
    `PoC required: ${p.pocRequired ? "yes" : "no"}`,
    `Submissions so far: ${p.submissions} | Total paid: ${money(p.totalPaid)}`,
    ``,
    `**Reputation:** ${gate}`,
    ``,
    `**Score: ${s.score}/100** — ${verdict}`,
    `Score breakdown: ${s.why.join("; ")}.`,
    ``,
    `Filed by Bounty Scout (runs on a Fly.io Sprite).`,
  ].join("\n");
}

async function fileIssue(p, s) {
  const summary = await llmSummary(p, s);
  let body = issueBody(p, s);
  if (summary) body = body.replace(
    `**Score: ${s.score}/100**`,
    `**Scout's take:** ${summary}\n\n**Score: ${s.score}/100**`
  );
  const issue = await ghApi(`/repos/${REPO_OWNER}/${REPO_NAME}/issues`, "POST", {
    title: `[New] ${p.name} — up to ${money(p.rewardMax)} (score ${s.score}/100)`,
    body,
    labels: ["new-program"],
  });
  return issue;
}

// ---------------------------------------------------------------- main loop
async function runCheck() {
  const runAt = new Date().toISOString();
  log("--- check started ---");
  const findings = [];
  try {
    const slugs = await listPrograms();
    log(`programs listed: ${slugs.length}`);
    const fresh = slugs.filter((s) => !seen[s]);
    log(`new programs: ${fresh.length}`);

    const scored = [];
    for (const slug of fresh) {
      try {
        await sleep(800); // be polite to hackenproof.com
        const html = await fetchText(`${HACKENPROOF}/programs/${slug}`);
        const p = parseProgramPage(html, slug);
        const s = scoreProgram(p);
        scored.push({ p, s });
        seen[slug] = { firstSeen: runAt, score: s.score, filed: false, name: p.name };
        log(`new: ${p.name} — max ${money(p.rewardMax)}, rep ${p.repRequired || "none"}, score ${s.score}`);
      } catch (e) {
        log(`failed to parse ${slug}:`, e.message);
        status.errors.push(`${runAt} ${slug}: ${e.message}`);
      }
    }

    scored.sort((a, b) => b.s.score - a.s.score);
    let filed = 0;
    for (const { p, s } of scored) {
      if (filed >= MAX_ISSUES_PER_RUN) break;
      if (s.score < SCORE_THRESHOLD) continue;
      try {
        const issue = await fileIssue(p, s);
        seen[p.slug].filed = true;
        filed++;
        log(`filed issue #${issue.number}: ${p.name} (${issue.html_url})`);
        findings.push({
          name: p.name,
          slug: p.slug,
          score: s.score,
          maxReward: p.rewardMax,
          repRequired: p.repRequired,
          issue: issue.html_url,
        });
      } catch (e) {
        log(`failed to file ${p.slug}:`, e.message);
        status.errors.push(`${runAt} file ${p.slug}: ${e.message}`);
      }
    }

    status.lastRunAt = runAt;
    status.runs++;
    status.programsSeen = Object.keys(seen).length;
    status.issuesFiled += filed;
    // keep the latest filed issues across runs (newest first, max 5)
    status.lastFindings = [...findings, ...(status.lastFindings || [])].slice(0, 5);
    saveJson(SEEN_FILE, seen);
    saveJson(STATUS_FILE, status);
    log(`--- check done: ${fresh.length} new, ${filed} issues filed ---`);
  } catch (e) {
    log("check failed:", e.message);
    status.errors.push(`${runAt}: ${e.message}`);
    saveJson(STATUS_FILE, status);
  }
}

// ---------------------------------------------------------------- status page
function statusHtml() {
  const rows = (status.lastFindings || [])
    .map(
      (f) =>
        `<li><a href="${f.issue}">${f.name}</a> — score ${f.score}/100, up to ${money(f.maxReward)}, rep gate ${f.repRequired || "none"}</li>`
    )
    .join("\n") || "<li>No issues filed yet.</li>";
  const seenRows = Object.entries(seen)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 10)
    .map(
      ([slug, v]) =>
        `<li>${v.name} — score ${v.score}/100 ${v.filed ? "(issue filed)" : ""}</li>`
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bounty Scout</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5}h1{font-size:28px}code{background:#f0f0f0;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Bounty Scout</h1>
<p>A personal agent living on a Fly.io Sprite. It watches HackenProof for new bug bounty programs, scores them against the hunter (80 rep, smart-contract skills), and files the good ones as GitHub issues in <a href="https://github.com/onlyjepe/bounty-scout">onlyjepe/bounty-scout</a>.</p>
<p><strong>Status:</strong> running — last check ${status.lastRunAt || "never"} · ${status.runs} checks · ${status.programsSeen} programs seen · ${status.issuesFiled} issues filed</p>
<h2>Latest findings</h2>
<ul>${rows}</ul>
<h2>Top programs seen</h2>
<ul>${seenRows}</ul>
<p><small>Checks run hourly. Scoring is rule-based: max reward, reputation gate, smart-contract scope, and payout history.</small></p>
</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/status.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...status, seenCount: Object.keys(seen).length }, null, 2));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(statusHtml());
});
server.listen(PORT, () => log(`status page on :${PORT}`));

// ---------------------------------------------------------------- start
(async () => {
  await runCheck();
  setInterval(runCheck, CHECK_INTERVAL_MS);
})();
