# CardBridge

**A free, self-hosted collaboration relay for debate teams** — CardMirror's
live co-editing running on infrastructure *you* deploy for $0, plus the coach
tooling to actually run a program: a command-center dashboard, a document
viewer, cross-device sync, and a one-click deploy.

> Built on **[CardMirror](./README.md)** (the editor). CardBridge is the
> coach/relay layer on top. Not affiliated with other projects that share the
> name "CardBridge" (a media-sync tool and a bridge card game) — this one is for
> competitive debate.

- **License:** PolyForm Noncommercial 1.0.0, inherited from CardMirror
  (© 2026 Anthony Trufanov). Debate-team and academic use are explicitly
  permitted; commercial use is not.
- **Cost:** $0. No credit card.
- **Status:** relay verified in production; dashboard + cross-device sync +
  viewer shipped and deployed.

**→ New here? Follow the [guided setup walkthrough](./dashboard/guide.html)** (or
the text version in [`SETUP.md`](./SETUP.md)).

---

## What you get

- **A blind relay** (Render free tier) that stores & forwards **ciphertext
  only** — it never reads your team's work.
- **A coach command center** (static site, no backend) — relay health, live
  sessions, presence, storage, per-student attribution, and token management,
  all from Supabase metadata under Row-Level Security.
- **A document viewer/editor** — for docs a student invites the dashboard to:
  open with native CardMirror styling, go live, edit, comment, export `.docx`/
  PDF, scrub version history, and send notes.
- **Cross-device sync** — an encrypted vault carries your tokens, doc names, and
  room keys to any device after sign-in; opt into **one shared member code**
  across all your devices so students invite you just once.
- **Anonymous usage metrics** (opt-out) + a private analytics view — see
  [`dashboard/TELEMETRY.md`](./dashboard/TELEMETRY.md).

Security model and the risks you're accepting:
[`dashboard/SECURITY.md`](./dashboard/SECURITY.md).

---

## Findings first

Things you can't reconstruct from the services' own docs — they came from
testing on live hardware. Full detail in [`docs/findings.md`](./docs/findings.md).

- **Rooms survive the host leaving.** Force-kill the machine that started a
  session and the room lives on; the host picks up the partner's edits on return.
- **Ending a session is safe.** Whoever remains keeps the work as an editable
  local document, journaled even if unsaved.
- **Reopening rejoins the live room** — you get edits made while you were closed.
- **Storage runs ~3.5× document size.** ~30–40 concurrent docs fit the 500 MB
  free tier.
- **Sessions hold 10**, enforced at stream connect (HTTP 409).

### Traps that cost hours

- **CardMirror Lite has no collaboration** — install the full desktop build.
- **Supabase: use the Session pooler string, not Direct** (Direct is IPv6-only;
  Render dials IPv4 — silent failure).
- **All machines must run the same CardMirror version.**
- **Share codes are credentials** (they carry the room's read+write key) — never
  in a group chat.
- **The dashboard's crypto features need a modern browser** (WebCrypto X25519 —
  Chrome/Edge/Safari/Firefox recent versions). It warns if yours can't.

---

## Setup (~20 min, non-technical)

Three places: a **database** (Supabase), a **relay** (Render), and this
**dashboard**. The [guided walkthrough](./dashboard/guide.html) does it with
pictures + progress tracking; [`SETUP.md`](./SETUP.md) is the linear version;
[`docs/setup.md`](./docs/setup.md) is the deep 35-minute reference.

```
  Students (Windows · Mac · Chromebook)            Coach's browser
         │                                              │ (dashboard)
         ├──► Google Shared Drive  (permanent file storage)
         │
         ▼ encrypted edits              read-only metadata ▼
   ┌──────────────────────────┐   ┌──────────────────────────┐
   │  RELAY — Render free tier │   │  POSTGRES — Supabase free │
   │  stores & forwards        │◄──┤  rooms · updates ·        │
   │  ciphertext; reads nothing│   │  snapshots · mailbox      │
   └──────────────────────────┘   └──────────────────────────┘
         ▲ /relay/health every 5 min
   ┌──────────────────────┐
   │  UptimeRobot (free)  │  prevents Render cold starts
   └──────────────────────┘
```

| Piece | Service | Why this one |
|---|---|---|
| Relay | Render free tier | No credit card; deploys from the repo's Dockerfile |
| Database | Supabase free tier | Permanent — Render's free Postgres is deleted after 30 days |
| Keepalive | UptimeRobot free | Render sleeps after 15 min; waking takes ~60s |
| File storage | Google Shared Drives | Schools already have it; native on ChromeOS |

**Deploy the relay:** Render *New → Blueprint* → point at this repo (it reads
[`render.yaml`](./render.yaml), generates `RELAY_TOKEN`, prompts for
`DATABASE_URL`). **Set up the database:** run [`dashboard/setup.sql`](./dashboard/setup.sql)
once in Supabase. **Open the dashboard**, run the connect wizard, sign in.

> **The relay is not backup.** Drive stores files, the relay carries edits, and
> they never touch. Someone saves to Drive at the end of every real session. See
> [`docs/workflow.md`](./docs/workflow.md).

---

## Repository layout (CardBridge parts)

```
relay/                 relay source + Dockerfile (opt-in email notify)
render.yaml            one-click Deploy-to-Render blueprint
dashboard/             the static coach dashboard
  setup.sql            one-time Supabase setup (schema + RLS + tokens + vault)
  guide.html           guided setup walkthrough (pictures + progress)
  index.html/app.js    the dashboard (redesigned "mission-control" UI)
  sync.js              cross-device encrypted vault
  telemetry.js/.sql    anonymous usage metrics
  member/  viewer/     invite-pairing + doc viewer/editor bundles
  SECURITY.md          security model + residual risks
  TELEMETRY.md         what the metrics collect (and don't)
SETUP.md               linear setup guide
docs/
  setup.md             35-minute coach walkthrough
  workflow.md          rooms vs. Drive, who saves
  findings.md          verified findings, expanded
  E2E-TEST.md          end-to-end validation checklist
  troubleshooting.md   traps + error-to-cause table
```

---

## Status & what's next

**Shipped:** metadata dashboard, per-student tokens + attribution, DB-backed
token sync, document viewer + in-browser editor + comments, live sync, export,
version history, cross-device encrypted vault, one shared member code, anonymous
telemetry + private analytics, redesigned UI, guided onboarding.

**Considering next:** scheduled/auto backups, a condense/read-view mode, deeper
analytics, and cross-browser hardening. See [`docs/E2E-TEST.md`](./docs/E2E-TEST.md)
to validate a deployment end-to-end.
