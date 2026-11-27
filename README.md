# Bounty Scout

A personal agent that lives on a [Fly.io Sprite](https://fly.io/sprites).
It watches HackenProof for new bug bounty programs, scores each one against
the hunter's profile, and files the good ones as GitHub issues — so the
hunter never misses a fresh program that fits them.

Built for **Hacksgiving 2026** (Fly.io, Nov 23–29).

## How it works

1. **Watch** — every hour it fetches the public HackenProof programs page
   (`hackenproof.com/programs`) and spots slugs it has not seen before.
2. **Research** — for each new program it fetches the program page and reads
   the reward range, per-severity rewards, reputation gate, scope
   (smart contracts / web / API / mobile), PoC requirement, published date,
   and total rewards paid so far. No API key needed, the pages are public.
3. **Score** — a deterministic 0–100 score:
   - max Critical reward (up to +45)
   - reputation gate vs the hunter's 80 rep (+20 if they can join now)
   - smart contracts in scope (+15), web (+10), API (+5)
   - already paid out rewards (+5), PoC required (-5)
4. **File** — programs scoring 60+ become GitHub issues in this repo with a
   triage note: rewards, scope, reputation verdict, and score breakdown.
   At most 5 issues per run, so the first run does not spam the repo.

## Connectors

- **GitHub** (Sprites connector) — the agent creates this repo's issues
  through the Sprites API Gateway. No token ever lives on the Sprite.
- **OpenRouter** (managed connector, optional) — if an OpenRouter connection
  is available, the agent asks it to write a two-sentence triage summary
  for each filed program. Without it, a template summary is used.
  Set `OPENROUTER_CONN_ID` to enable.

## Running it

On a Sprite, in `/home/sprite/bounty-scout`:

```bash
node scout.js
```

It runs the first check immediately, then every hour, and serves a status
page on port 8080 (`/` and `/status.json`). State lives in `data/seen.json`
and `data/status.json`, so it survives Sprite sleep.

As a service (survives restarts):

```bash
sprite-env services create bounty-scout -- node /home/sprite/bounty-scout/scout.js
```

## Hunter profile

- HackenProof nickname: `takanome`, reputation 80
- Strength: smart contracts, web
- This repo's issues are the triage queue: highest score first.
