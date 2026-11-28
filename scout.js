// Bounty Scout v3 — a personal agent that lives on a Fly.io Sprite.
// Watches HackenProof for NEW bug bounty programs AND for CHANGES to
// programs it already knows: a raised max reward, a lowered reputation
// gate, smart contracts added to scope, or a program that starts paying
// out. It scores each signal against the hunter's profile and files the
// good ones as GitHub issues. Runs on a Sprite. Uses the GitHub connector
// through the Sprites API Gateway (no token ever lives on the Sprite).
//
// v3 fix: the Sprite sleeps when idle and freezes Node timers, so the old
// 1h setInterval stalled for hours. The loop is now a 5-minute watchdog
// that runs a check whenever the wall-clock gap since the last check is
// >= 1h, plus a catch-up trigger on every status-page request.
//
// Scoring is deterministic and rule-based, so the demo is reproducible:
//   - max Critical reward (bigger payout = higher score)
//   - reputation gate vs the hunter's current rep (can join now?)
//   - smart-contract scope (the hunter's strength)
//   - web / API scope
//   - program maturity (rewards already paid out = real program)
//   - freshness (published in the last 30 days = new opportunity)
// New programs score 60+ to be filed. Changes file when they are
// significant: reward raised by $500+, rep gate now passable, or smart
// contracts added to scope.
//
// Optional LLM upgrade: if an OpenRouter connection with credits is
// available, set OPENROUTER_CONN_ID and the agent asks it to write the
// triage summary. Without it, a template summary is used instead.

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
const WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes: the Sprite sleeps when idle
// and freezes Node timers, so a 1h setInterval alone can stall for hours.
// The watchdog wakes every 5 min and runs a check whenever the wall-clock
// time since the last check is >= 1h, so it catches up after sleep.
const MAX_ISSUES_PER_RUN = 5;
const PORT = 8080;
const OPENROUTER_CONN_ID = process.env.OPENROUTER_CONN_ID || ""; // optional

const DATA_DIR = path.join(__dirname, "data");
const SEEN_FILE = path.join(DATA_DIR, "seen.json");
const STATUS_FILE = path.join(DATA_DIR, "status.json");

const UA = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 BountyScout/2.0",
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

// seen[slug] = { firstSeen, name, score, filed, snapshot: {...}, lastChangeAt }
let seen = loadJson(SEEN_FILE, {});
let status = loadJson(STATUS_FILE, {
  startedAt: new Date().toISOString(),
  lastRunAt: null,
  runs: 0,
  programsSeen: 0,
  issuesFiled: 0,
  changesFiled: 0,
  lastFindings: [],
  lastChanges: [],
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
  // or the <h1>. Fall back to the slug.
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

  // Severity: a range ("Critical $10,000 - $500,000") or a single value
  // ("Medium $1,000", "Low $0").
  const sev = {};
  for (const s of ["Critical", "High", "Medium", "Low"]) {
    const m = text.match(
      new RegExp(`${s} \\$([\\d,]+)(?: - \\$([\\d,]+))?`)
    );
    if (m) {
      const lo = parseInt(m[1].replace(/,/g, ""));
      const hi = m[2] ? parseInt(m[2].replace(/,/g, "")) : lo;
      sev[s] = [lo, hi];
    }
  }
  p.severity = sev;

  const repM = text.match(/Reputation (\d+) points required/);
  p.repRequired = repM ? parseInt(repM[1]) : 0;

  const pubM = text.match(/Published date (\d+ [A-Za-z]+ \d{4})/);
  p.published = pubM ? pubM[1] : "unknown";
  p.publishedAt = pubM ? Date.parse(pubM[1]) : null;

  const paidM = text.match(/Total rewards: \$([\d,]+)/);
  p.totalPaid = paidM ? parseInt(paidM[1].replace(/,/g, "")) : 0;

  const subM = text.match(/Submissions: (\d+)/);
  p.submissions = subM ? parseInt(subM[1]) : 0;

  p.pocRequired = /PoC Required/.test(text);

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

function snapshotOf(p) {
  return {
    rewardMax: p.rewardMax,
    rewardMin: p.rewardMin,
    repRequired: p.repRequired,
    hasSmartContracts: p.hasSmartContracts,
    hasWeb: p.hasWeb,
    hasApi: p.hasApi,
    hasMobile: p.hasMobile,
    totalPaid: p.totalPaid,
    submissions: p.submissions,
    published: p.published,
  };
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

  // freshness: published in the last 30 days is a fresh opportunity
  if (p.publishedAt && Date.now() - p.publishedAt < 30 * 24 * 60 * 60 * 1000) {
    score += 10;
    why.push(`published ${p.published}, fresh (+10)`);
  }

  return { score: Math.max(0, Math.min(100, score)), why };
}

// Detect a meaningful change between the stored snapshot and the fresh page.
// Returns null (no change worth filing) or { summary, important }.
function detectChange(oldSnap, p) {
  if (!oldSnap) return null; // first sighting, baseline only
  const changes = [];
  let important = false;

  if (p.rewardMax > oldSnap.rewardMax) {
    const diff = p.rewardMax - oldSnap.rewardMax;
    changes.push(`max reward rose ${money(oldSnap.rewardMax)} -> ${money(p.rewardMax)} (+${money(diff)})`);
    if (diff >= 500) important = true;
  }
  if (p.repRequired < oldSnap.repRequired) {
    changes.push(`reputation gate dropped ${oldSnap.repRequired} -> ${p.repRequired || "none"}`);
    if (oldSnap.repRequired > HUNTER_REP && p.repRequired <= HUNTER_REP) {
      changes.push("gate now passable with your 80 rep");
      important = true;
    }
  }
  if (!oldSnap.hasSmartContracts && p.hasSmartContracts) {
    changes.push("smart contracts added to scope");
    important = true;
  }
  if (!oldSnap.hasWeb && p.hasWeb) changes.push("web added to scope");
  if (!oldSnap.hasApi && p.hasApi) changes.push("API added to scope");
  if (p.totalPaid > oldSnap.totalPaid) {
    changes.push(`total paid rose ${money(oldSnap.totalPaid)} -> ${money(p.totalPaid)}`);
  }
  if (changes.length === 0) return null;
  return { summary: changes.join("; "), important };
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

function sevLines(p) {
  return Object.entries(p.severity || {})
    .map(([k, v]) => (v[0] === v[1] ? `- ${k}: ${money(v[0])}` : `- ${k}: ${money(v[0])} - ${money(v[1])}`))
    .join("\n");
}

function scopeList(p) {
  const s = [];
  if (p.hasSmartContracts) s.push("smart contracts");
  if (p.hasWeb) s.push("web");
  if (p.hasApi) s.push("API");
  if (p.hasMobile) s.push("mobile");
  return s.join(", ") || "see program page";
}

function repLine(p) {
  if (p.repRequired === 0) return "No reputation gate. You can join now.";
  if (p.repRequired <= HUNTER_REP)
    return `Reputation gate ${p.repRequired}. You have ${HUNTER_REP}, so you can join now.`;
  return `Reputation gate ${p.repRequired}. You have ${HUNTER_REP}, so you need ${p.repRequired - HUNTER_REP} more reputation first.`;
}

function issueBodyNew(p, s) {
  return [
    `**${p.name}** — new program on HackenProof.`,
    ``,
    `Program: ${p.url}`,
    `Published: ${p.published}`,
    `Reward range: ${money(p.rewardMin)} - ${money(p.rewardMax)}`,
    ``,
    `Rewards by severity:`,
    sevLines(p) || "- not listed",
    ``,
    `Scope: ${scopeList(p)}`,
    `PoC required: ${p.pocRequired ? "yes" : "no"}`,
    `Submissions so far: ${p.submissions} | Total paid: ${money(p.totalPaid)}`,
    ``,
    `**Reputation:** ${repLine(p)}`,
    ``,
    `**Score: ${s.score}/100** — ${s.score >= SCORE_THRESHOLD ? "Worth a look." : "Below the filing threshold."}`,
    `Score breakdown: ${s.why.join("; ")}.`,
    ``,
    `Filed by Bounty Scout (runs on a Fly.io Sprite).`,
  ].join("\n");
}

function issueBodyChange(p, s, change) {
  return [
    `**${p.name}** — this program changed on HackenProof.`,
    ``,
    `Program: ${p.url}`,
    ``,
    `**What changed:** ${change.summary}`,
    ``,
    `Reward range now: ${money(p.rewardMin)} - ${money(p.rewardMax)}`,
    ``,
    `Rewards by severity:`,
    sevLines(p) || "- not listed",
    ``,
    `Scope: ${scopeList(p)}`,
    `PoC required: ${p.pocRequired ? "yes" : "no"}`,
    `Submissions so far: ${p.submissions} | Total paid: ${money(p.totalPaid)}`,
    ``,
    `**Reputation:** ${repLine(p)}`,
    ``,
    `**Score: ${s.score}/100**`,
    `Score breakdown: ${s.why.join("; ")}.`,
    ``,
    `Filed by Bounty Scout (runs on a Fly.io Sprite).`,
  ].join("\n");
}

async function fileIssue(p, s, kind, change) {
  const summary = await llmSummary(p, s);
  let body, title;
  if (kind === "change") {
    body = issueBodyChange(p, s, change);
    title = `[Change] ${p.name} — ${change.summary.split(";")[0]} (score ${s.score}/100)`;
  } else {
    body = issueBodyNew(p, s);
    title = `[New] ${p.name} — up to ${money(p.rewardMax)} (score ${s.score}/100)`;
  }
  if (summary) {
    body = body.replace(
      `**Score: ${s.score}/100**`,
      `**Scout's take:** ${summary}\n\n**Score: ${s.score}/100**`
    );
  }
  const issue = await ghApi(`/repos/${REPO_OWNER}/${REPO_NAME}/issues`, "POST", {
    title,
    body,
    labels: kind === "change" ? ["change"] : ["new-program"],
  });
  return issue;
}

// ---------------------------------------------------------------- main loop
// Guard so two triggers (watchdog tick, HTTP request) never run a check twice.
let checking = false;
function lastRunMs() {
  return status.lastRunAt ? Date.parse(status.lastRunAt) : 0;
}
// Run a check only when one is not already running and the last check is
// stale (>= 1h ago, by wall-clock time, not by timer ticks).
async function maybeRunCheck(reason) {
  if (checking) return;
  if (Date.now() - lastRunMs() < CHECK_INTERVAL_MS) return;
  checking = true;
  try {
    log(`catch-up check (${reason}) — last check ${status.lastRunAt || "never"}`);
    await runCheck();
  } finally {
    checking = false;
  }
}

async function runCheck() {
  const runAt = new Date().toISOString();
  log("--- check started ---");
  const findings = [];
  const changes = [];
  try {
    const slugs = await listPrograms();
    log(`programs listed: ${slugs.length}`);

    let filed = 0;
    for (const slug of slugs) {
      try {
        await sleep(800); // be polite to hackenproof.com
        const html = await fetchText(`${HACKENPROOF}/programs/${slug}`);
        const p = parseProgramPage(html, slug);
        const s = scoreProgram(p);
        const prev = seen[slug];

        if (!prev) {
          // brand new program
          seen[slug] = { firstSeen: runAt, name: p.name, score: s.score, filed: false, snapshot: snapshotOf(p) };
          log(`new: ${p.name} — max ${money(p.rewardMax)}, rep ${p.repRequired || "none"}, score ${s.score}`);
          if (s.score >= SCORE_THRESHOLD && filed < MAX_ISSUES_PER_RUN) {
            const issue = await fileIssue(p, s, "new");
            seen[slug].filed = true;
            filed++;
            log(`filed issue #${issue.number}: ${p.name} (${issue.html_url})`);
            findings.push({
              kind: "new", name: p.name, slug: p.slug, score: s.score,
              maxReward: p.rewardMax, repRequired: p.repRequired, issue: issue.html_url,
            });
          }
        } else {
          // known program: check for changes
          const change = detectChange(prev.snapshot, p);
          prev.snapshot = snapshotOf(p);
          prev.score = s.score;
          prev.name = p.name;
          if (change) {
            log(`change: ${p.name} — ${change.summary} (important: ${change.important})`);
            changes.push({ name: p.name, slug: p.slug, summary: change.summary, score: s.score, maxReward: p.rewardMax, repRequired: p.repRequired });
            if (change.important && filed < MAX_ISSUES_PER_RUN) {
              const issue = await fileIssue(p, s, "change", change);
              filed++;
              log(`filed change issue #${issue.number}: ${p.name} (${issue.html_url})`);
              findings.push({
                kind: "change", name: p.name, slug: p.slug, score: s.score,
                maxReward: p.rewardMax, repRequired: p.repRequired, issue: issue.html_url,
                change: change.summary,
              });
            }
          }
        }
      } catch (e) {
        log(`failed ${slug}:`, e.message);
        status.errors.push(`${runAt} ${slug}: ${e.message}`);
      }
    }

    status.lastRunAt = runAt;
    status.runs++;
    status.programsSeen = Object.keys(seen).length;
    status.issuesFiled += filed;
    status.changesFiled = (status.changesFiled || 0) + findings.filter((f) => f.kind === "change").length;
    // keep the latest findings and changes across runs (newest first, max 5 each)
    status.lastFindings = [...findings, ...(status.lastFindings || [])].slice(0, 5);
    status.lastChanges = [...changes, ...(status.lastChanges || [])].slice(0, 5);
    saveJson(SEEN_FILE, seen);
    saveJson(STATUS_FILE, status);
    log(`--- check done: ${findings.length} filed, ${changes.length} changes seen ---`);
  } catch (e) {
    log("check failed:", e.message);
    status.errors.push(`${runAt}: ${e.message}`);
    saveJson(STATUS_FILE, status);
  }
}

// ---------------------------------------------------------------- status page
function statusHtml() {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const findingRows = (status.lastFindings || [])
    .map(
      (f) =>
        `<li><a href="${f.issue}">${esc(f.name)}</a> — ${f.kind === "change" ? "changed" : "new"}, score ${f.score}/100, up to ${money(f.maxReward)}, rep gate ${f.repRequired || "none"}</li>`
    )
    .join("\n") || "<li>No issues filed yet.</li>";
  const changeRows = (status.lastChanges || [])
    .map((c) => `<li>${esc(c.name)} — ${esc(c.summary)}</li>`)
    .join("\n") || "<li>No changes detected yet.</li>";
  const allRows = Object.entries(seen)
    .sort((a, b) => b[1].score - a[1].score)
    .map(
      ([, v]) =>
        `<tr><td>${esc(v.name)}</td><td>${v.score}/100</td><td>${v.snapshot ? money(v.snapshot.rewardMax) : "-"}</td><td>${v.snapshot && v.snapshot.repRequired ? v.snapshot.repRequired : "none"}</td><td>${v.filed ? "issue filed" : "-"}</td></tr>`
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bounty Scout</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5}h1{font-size:28px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;font-size:14px}</style>
</head><body>
<h1>Bounty Scout</h1>
<p>A personal agent living on a Fly.io Sprite. It watches HackenProof for new bug bounty programs and for changes to the ones it knows, scores each signal against the hunter (80 rep, smart-contract skills), and files the good ones as GitHub issues in <a href="https://github.com/onlyjepe/bounty-scout">onlyjepe/bounty-scout</a>.</p>
<p><strong>Status:</strong> running — last check ${status.lastRunAt || "never"} · ${status.runs} checks · ${status.programsSeen} programs watched · ${status.issuesFiled} issues filed (${status.changesFiled || 0} from changes)</p>
<h2>Latest findings</h2>
<ul>${findingRows}</ul>
<h2>Recent changes</h2>
<ul>${changeRows}</ul>
<h2>All programs watched</h2>
<table><tr><th>Program</th><th>Score</th><th>Max reward</th><th>Rep gate</th><th>Filed</th></tr>${allRows}</table>
<p><small>Checks run hourly. Scoring is rule-based: max reward, reputation gate, smart-contract scope, payout history, and freshness. A change is filed when a reward rises by $500+, a reputation gate becomes passable, or smart contracts are added to scope.</small></p>
</body></html>`;
}

const server = http.createServer((req, res) => {
  // Any visit to the status page wakes the Sprite and is a chance to catch
  // up a check that sleep delayed. Runs in the background; the response
  // is not blocked on it.
  maybeRunCheck("stale on status request").catch((e) => log("catch-up failed:", e.message));
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
  // Watchdog, not a plain 1h interval: ticks every 5 min and runs a check
  // whenever the wall-clock gap since the last check is >= 1h.
  setInterval(() => maybeRunCheck("watchdog tick"), WATCHDOG_MS);
})();
