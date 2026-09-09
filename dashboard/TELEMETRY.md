# Anonymous usage metrics

CardBridge can report **anonymous, aggregate-only** usage to a central
telemetry project so the maintainer can see how many coaches use it and how
much — without collecting any personal data. It's opt-out, respects
Do-Not-Track, and is a **complete no-op until the maintainer configures it**.

## What is (and isn't) collected

**Sent** (only this):
- a **random install id** (a UUID generated in the browser — not tied to any
  identity) and a random per-session id,
- an **event name** (`app_open`, `heartbeat`, `signin`, `session_added`,
  `doc_opened`, `shared_identity`),
- a strict **allowlist of numeric/boolean counters**: number of sessions / live
  sessions / rooms / team members / openable docs / people online, and feature
  flags (sync on, shared code on, opened a doc, signed in).

**Never sent:** emails, names, Supabase or relay URLs, anon keys, relay tokens,
room ids, share codes, document content, or anything IP-derived. The payload is
built from an allowlist in [`telemetry.js`](./telemetry.js), so nothing else can
leak in even by accident.

Events are **insert-only** under Row-Level Security — the public key can write
but can **never read** events back, so no coach can see another's activity.

## Turning it off (coaches)

Untick **"Share anonymous usage stats"** in the setup wizard (Settings), or set
`localStorage['cardbridge-telemetry-optout'] = '1'`. Browsers sending
**Do-Not-Track** are excluded automatically.

## Maintainer setup (one-time)

1. Create a **dedicated** Supabase project just for telemetry (not a coach's
   project, not one with relay/document data).
2. Run [`telemetry.sql`](./telemetry.sql) in it (creates `usage_events`,
   insert-only for `anon`).
3. Paste that project's **URL** and **anon key** into the two constants at the
   top of [`telemetry.js`](./telemetry.js) and deploy.

Read aggregates from that project's SQL editor — example queries (unique
installs, sessions per install, daily-active, feature adoption) are at the
bottom of `telemetry.sql`.

> The anon key is safe to commit: it's write-only by RLS. Don't ever put a
> service-role key in the dashboard.

## Why exposing the key is fine + the origin guard

The anon key is **public by design** (it ships in every visitor's browser).
Secrecy isn't what protects the data — **Row-Level Security** is: `anon` may
`INSERT` but has no `SELECT` policy, so no one can ever read events back with the
key. Only you (owner / service-role) can read aggregates.

The only residual risk is someone POSTing *fake* events to skew your numbers. To
blunt that, `telemetry.js` has an **origin guard** — `TELEMETRY_HOSTS` — so only
pages served from your official host report. Forks and local copies that still
carry the key stay silent. Forking for your own deployment? Put your Pages host
in `TELEMETRY_HOSTS` (and your own `TELEMETRY_URL`/`TELEMETRY_KEY`); add
`'localhost'` to test locally; or set it to `[]` to disable the guard.
