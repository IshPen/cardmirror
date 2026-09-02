# Debate Relay

A free, self-hosted collaboration stack for debate programs, built on
[CardMirror](./README.md).

- **What it is:** CardMirror's live co-editing, but running on a relay
  *you* deploy for free — plus the operational tooling (a coach
  dashboard, a one-click deploy blueprint, and documentation) a program
  needs to actually run it.
- **License:** PolyForm Noncommercial 1.0.0 (inherited from CardMirror).
  Debate-team and academic use are explicitly permitted.
- **Status:** relay verified in production on one team. Dashboard built;
  see the roadmap below.
- **Cost:** $0. Credit cards required: none.

> This document is the Debate Relay overlay. The repository's main
> [`README.md`](./README.md) is CardMirror's own — the editor this is
> built on.

---

## Findings first

The setup you can reconstruct from the services' own docs. **These you
can't** — they came from testing on live hardware, and they're the reason
this is worth reading. Full detail in [`docs/findings.md`](./docs/findings.md).

- **Rooms survive the host leaving.** Force-kill the machine that started
  a session and the room lives on. A partner keeps editing while the host
  is powered off; the host picks up those edits on return. Asynchronous
  shared editing, for real.
- **Ending a session is safe.** Whoever remains keeps the work as an
  editable local document, journaled by CardMirror even if unsaved.
  Saving makes work *visible to teammates* — it isn't what prevents loss.
- **Reopening rejoins the live room.** You get your partner's edits made
  while you were closed, not a stale local draft.
- **Storage runs ~3.5× document size** (pre-compaction; steady state is
  likely lower). ~30–40 concurrent documents fit the 500 MB free tier.
- **Sessions hold 10**, enforced at stream connect (HTTP 409).

### Traps that cost hours

- **CardMirror Lite has no collaboration** — install the full desktop
  build.
- **Supabase: use the Session pooler string, not Direct** (Direct is
  IPv6-only; Render dials IPv4 — silent failure).
- **All machines must run the same CardMirror version.**
- **The web editor needs a desktop-width window** (narrow = mobile
  layout = no collaboration).
- **Share codes are credentials** — they carry the room's read+write key.
  Never in a group chat.

---

## Setup, second

A non-technical coach can stand this up in about **35 minutes**. Full
walkthrough: [`docs/setup.md`](./docs/setup.md).

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

**Deploy:** click Render's *New → Blueprint*, point it at this repo. It
reads [`render.yaml`](./render.yaml), generates a unique `RELAY_TOKEN`,
and prompts for one connection string (`DATABASE_URL`). Wait for **Live**,
copy the relay URL and token into every machine's **Settings →
Collaboration**. **No fork required.**

> **The division that matters:** Drive stores files, the relay carries
> edits, and they never touch each other. Only the host has the file open,
> so **only the host saves** — which is what prevents Drive conflict
> copies. The relay is not backup: someone saves to Drive at the end of
> every real work session. See [`docs/workflow.md`](./docs/workflow.md).

---

## Repository layout (Debate Relay parts)

```
relay/                 relay source (upstream, unmodified) + Dockerfile
render.yaml            one-click Deploy-to-Render blueprint
dashboard/             static coach dashboard + Supabase schema/RLS
docs/
  setup.md             35-minute coach walkthrough
  workflow.md          rooms vs. Drive, who saves, team conventions
  findings.md          the verified findings, expanded
  troubleshooting.md   the traps + an error-to-cause table
```

---

## The dashboard

One page that answers: *is my relay up, which sessions exist, which are
dying, am I running out of space* — without SQL. It's a **static site**
(no backend, no build) that reads Supabase through the public **anon key
under Row-Level Security**, so it can see room *metadata* but never
document ciphertext. Adding a session keeps only the room ID from a share
code and **discards the encryption key** — making it structurally unable
to read student work. See [`dashboard/`](./dashboard/).

Policies shipped in [`dashboard/schema.sql`](./dashboard/schema.sql):
`relay_rooms` SELECT-only, `dashboard_registry` SELECT+INSERT, everything
else no access (ciphertext stays private).

---

## Roadmap

- **v1 — Metadata dashboard.** *(this repo)* Static page, anon key,
  read-only.
- **v1.1 — End-session action.** Once a privileged token exists that
  isn't already in twenty students' hands. Pruning is done from inside
  CardMirror until then.
- **v2 — Per-student tokens.** A relay-only change: token → `{label,
  role}`. Per-student revocation, coach-only destructive actions,
  attribution, live participant names. *Propose upstream before forking.*
- **v3 — Document viewer.** Decrypt and render room contents. Requires
  reverse-engineering the cipher framing and decoding Loro CRDT state
  (20–40 hrs). Build only if coaches ask — and disclose plainly, because
  it changes the tool from one that *cannot* read student work into one
  that can.

## Open questions

Chromebook save-in-place · post-compaction storage multiplier ·
tournament-weekend load · idle-GC space reclamation. Details in
[`docs/findings.md`](./docs/findings.md#open-questions).
