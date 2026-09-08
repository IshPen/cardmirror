# Coach dashboard

One page that answers: **is my relay up, which sessions exist, which are
dying, and am I running out of space** — without logging into Supabase or
writing SQL.

It is a static site: three files (`index.html`, `styles.css`, `app.js`)
plus `schema.sql`. No backend, no build step. Open `index.html` locally,
or host the folder on GitHub Pages / Netlify drop / any static host. A
sidebar switches between four **views** (Overview / Sessions / Activity /
Team); a light/dark toggle sits in the header.

## What it can and can't do

| View / feature | Shows |
|---|---|
| **Overview** | KPI tiles (live sessions, online now, total rooms, storage), relay **Health** (from `GET /relay/health`), **Storage** vs. the 500 MB free tier, and **who's online now** presence chips |
| **Sessions** | Every registered room (label, owner, event, size, last activity, live/dead), **Add session** (paste a share code), **Backup all** (see below), and a **Stale** table with a per-room "Remind" mailto nudge |
| **Activity** | An **activity feed** (room created / active / idle, newest first) and an 8-week **activity heatmap** |
| **Team** | Per-member attribution (rooms created, in-sessions, storage, last active, online) from `created_by` + live participants, filterable by **group** |
| **Ask for access** | On each live room, emails the people on it (`mailto:`) to ask for the share code |
| **Member** (Path B) | Shows the dashboard's own member code; students *invite* it into a session and it learns the doc name. Also: **request access** email, desktop-alert toggle |
| **Open** | Renders the decrypted document with **native CardMirror styling** (isolated iframe), a **heading outline** rail, a **Go live** read-only stream, **.docx** / **PDF** export, a **version-history** scrubber, and a **Note** bar that sends a plain-text note to the author (arrives in their CardMirror Receive pill) |
| **Backup all** | Exports every openable doc to `.docx` and downloads one `.zip` (skips rooms without a key) |
| **New-invite alerts** | A banner (and desktop notification, if enabled). Server-side email is opt-in — see `relay/README.md` |
| **Tokens** | Per-person relay tokens with name / email / **group** / role; Sync-to-relay or Copy RELAY_TOKENS |

Content features (Open, export, history, backup, notes) work only on rooms
the dashboard **holds a key for** — i.e. ones a student invited it into.
Everything else is metadata and works for every room.

### Core vs. served-only features

The **core** (Health, Sessions, Stale, Storage, Add session, Tokens,
✉️ Ask) works by opening `index.html` as a local file — no build, no
server. Two features need the dashboard to be **served over http**
(`python -m http.server 8000`, then `http://localhost:8000/dashboard/`),
because they use browser features (WASM, IndexedDB, ES modules) that
browsers block on `file://`:

- **Member** (Path B): the dashboard gets its own `cmk1.…` member code.
  A student who **invites** that code into a session hands the dashboard
  the room's key + doc title — so its name appears in Sessions and you can
  **Open** it. Give the dashboard its own relay token first: add a
  **"Dashboard"** entry in the Tokens panel (auto-wires the poll token),
  or paste one under Settings → Dashboard relay token.
- **Open** (doc viewer): decrypts and renders a room's document in the
  browser. Requires running `viewer/enable-viewer.sql` once (grants anon
  read of the *encrypted* bytes). The prebuilt bundles are committed, so
  no `npm` is needed — just serve the folder.

**It cannot read document contents without a key** — by construction. It talks to
Supabase with the public **anon key** under Row-Level Security, which is
allowed to read only room *metadata* (`relay_rooms`) and the names you
add (`dashboard_registry`). Ciphertext tables stay unreadable. And when
you add a session, the dashboard keeps only the room ID from the share
code and **throws the encryption key away** — see below.

## Asking a student for access (✉️ Ask)

The dashboard never has document keys, so it can't read a doc on its own.
The **✉️ Ask** button on each live room is a one-click request: it opens
your email client pre-filled to the people working on that room, asking
them to send you the session's share code (which you can then read with
the [viewer](./viewer/)).

It knows *who* from v2 attribution (`created_by` + live participants) and
the room's registered owner. It knows their *email* from a **roster** you
enter in **Settings → Roster** — one `Name = email` per line, e.g.:

```
Maya = maya@school.edu
Alex = alex@school.edu
```

The roster lives in your browser (localStorage) only — it is **never**
sent to Supabase. If a room's people aren't in the roster (or aren't
named yet — single-token mode has no names), the button is disabled with
a tooltip explaining who's missing.

## Managing relay tokens (Tokens panel)

The **Tokens** button (top bar) opens a people manager. Add/remove team
members (name, email, role); each gets a per-person token like
`ZaynHaniff26-<random>` — the readable prefix is just a label, the random
suffix is the actual secret. The list lives in **this browser only**.

There are two ways to apply changes:

- **Sync to relay (recommended — instant, no redeploy).** Sign in as the
  coach (Supabase Auth) in the panel, then **Sync to relay**. This writes
  the whole list to the `relay_tokens` table; the relay picks it up within
  ~30s. One-time setup: run [`relay-tokens.sql`](./relay-tokens.sql) and
  create a coach login (Supabase → Authentication → Add user, auto-confirm).
- **Copy RELAY_TOKENS (fallback).** Edit the list → **Copy RELAY_TOKENS**
  → paste into Render → Environment → `RELAY_TOKENS` → Save (one redeploy).

Either way, tokens look like `ZaynHaniff26-<random>` (readable prefix,
random secret), the list lives in this browser, and the panel keeps the
✉️ Ask **roster** in sync automatically.

> Switching to multi-token mode (env or DB) stops the old shared token
> working, so every machine must move to its own per-person token.

## Working across devices (encrypted cloud sync)

By default everything the dashboard remembers — your token list, the ✉️
roster, doc **names**, and the room **keys** it has learned — lives in the
browser you set it up in. To carry it to another laptop or your phone, the
**Tokens** panel has a **Sync across devices** box that reuses your coach
sign-in.

Once you sign in there, the dashboard:

- stores your **non-secret** UI prefs (theme, nav levels) as plaintext in a
  per-coach `dashboard_state` row (Row-Level Security → only you can read it);
- **encrypts your secrets** (tokens, roster, doc names, room keys) in the
  browser with AES-256-GCM, using a key derived from your **login password**,
  and stores only the ciphertext. Supabase — which also holds the encrypted
  docs — never sees your room keys in the clear, so **end-to-end encryption
  still holds** even though both sit in one database.

Sign in on any device and your state is restored (union-merged, so two
devices never clobber each other). Two caveats:

- **Forget the password → the vault can't be decrypted.** If you've *changed*
  your Supabase password since, sign-in offers to re-initialise sync from the
  current device.
- The dashboard's **member identity is not synced** — it's a non-extractable
  key by design. So *receiving a brand-new invite* is pinned to whichever
  device the student invited; the instant you receive it, that room's key
  syncs to your other devices and **Open works everywhere**.

Needs section 5 of [`setup.sql`](./setup.sql) (the `dashboard_state` table)
and the same coach login as token sync.

## Setup (≈10 minutes)

1. **Supabase** — create a free project, then in **SQL Editor** paste and run
   [`setup.sql`](./setup.sql) **once**. That single script does everything:
   `dashboard_registry`, Row-Level Security, the doc viewer's ciphertext read,
   and the optional DB-backed `relay_tokens` table. (It replaces the old
   `schema.sql` + `relay-tokens.sql` + `enable-viewer.sql` trio — those still
   exist for reference. It's guarded, so it's safe to run before *or* after the
   relay's first boot, and to re-run.)
2. **Relay** — deploy it with the **Deploy to Render** button (see
   [`../docs/setup.md`](../docs/setup.md)); paste the Supabase pooler
   connection string as `DATABASE_URL`.
3. **Dashboard** — open it (hosted, see below, or `index.html`). The connect
   screen is a **guided wizard**: paste your Supabase Project URL + anon key and
   your relay URL, hit **Test** on each (it live-checks the connection and the
   relay's `/health`), optionally **Generate** a dashboard token, then **Save**.
   Everything is stored in your browser's localStorage only.

> Paste the **anon** key, never the service-role key and never a Postgres
> connection string. A connection string in browser JavaScript is a
> public database.

## The share-code split (why the dashboard can't read work)

A share code looks like:

```
cmshare2.930cd67c….NgE0QEdJ….1.0.0
             │           │
      segment two   segment three
      = room ID     = encryption key
```

"Add session" splits on periods and stores **segment two only** — the
room ID, which joins to `relay_rooms.id`. Segment three, the key, is
discarded. That makes it structurally impossible for this page to
decrypt student work, which is the correct default. Reversing it is a
deliberate v3 decision (a document viewer), not a config toggle.

## Hosting the dashboard (so coaches just open a URL)

Serving it over **https** (not `file://`) is what makes the Member / viewer /
editing features work — those bundles need a real origin. Options:

- **GitHub Pages (recommended):** this fork ships a workflow,
  [`.github/workflows/dashboard-pages.yml`](../.github/workflows/dashboard-pages.yml),
  that publishes `dashboard/` to Pages on every push that touches it. **One-time:**
  repo owner → **Settings → Pages → Build and deployment → Source: "GitHub
  Actions"**. The dashboard then lives at
  `https://<your-user>.github.io/<repo>/`. (A repo has one Pages site; the
  upstream redirect-stub workflow only fires on `web-redirect/**` changes, so on
  this fork the dashboard is what stays live — delete `deploy-pages.yml` to be
  certain.)
- Or drag the `dashboard/` folder onto <https://app.netlify.com/drop>.
- Or, for a quick local run, `python -m http.server 8000` then open
  `http://localhost:8000/dashboard/` (opening `index.html` as a file works for
  the core panels but not Member/viewer/editing).
