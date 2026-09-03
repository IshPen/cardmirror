# Coach dashboard

One page that answers: **is my relay up, which sessions exist, which are
dying, and am I running out of space** — without logging into Supabase or
writing SQL.

It is a static site: three files (`index.html`, `styles.css`, `app.js`)
plus `schema.sql`. No backend, no build step. Open `index.html` locally,
or host the folder on GitHub Pages / Netlify drop / any static host.

## What it can and can't do (v1)

| Panel | Shows |
|---|---|
| **Health** | Green/red from `GET /relay/health` (no auth) |
| **Sessions** | Every registered room: label, owner, event, size, last activity, live/dead |
| **Stale** | Rooms within ~2 days of the 7-day idle deletion |
| **Storage** | Estimated DB usage vs. the 500 MB free tier, plus rooms-remaining |
| **Add session** | Paste a share code, give it a label/owner/event |
| **✉️ Ask for access** | On each live room, emails the people on it (via a `mailto:`) to ask for the share code |
| **Member** (Path B) | Shows the dashboard's own member code; students *invite* it into a session and it learns the doc name |
| **Open** | On rooms the dashboard was invited to, renders the decrypted document |

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

It doesn't talk to Render (a browser can't edit Render's env), so the flow
is: edit the list → **Copy RELAY_TOKENS** → paste into Render →
Environment → `RELAY_TOKENS` → Save (applies on the next deploy).
Removing someone and re-saving revokes them. The panel also keeps the
✉️ Ask **roster** in sync automatically (every person with an email).

> Setting `RELAY_TOKENS` switches the relay to multi-token mode: the old
> shared token stops working, so every machine must move to its own
> per-person token.

## Setup

1. Deploy the relay and create the Supabase database (see
   [`../docs/setup.md`](../docs/setup.md)).
2. In Supabase → **SQL Editor**, run [`schema.sql`](./schema.sql) once.
   It creates `dashboard_registry`, turns on RLS, and grants the anon
   key exactly the two things it needs.
3. Open the dashboard, click through the connect screen, and paste:
   - **Relay base URL** — e.g. `https://debate-relay.onrender.com/relay`
   - **Supabase project URL** — Supabase → Settings → API → *Project URL*
   - **Supabase anon key** — Supabase → Settings → API → *anon public*

   These are stored in your browser's localStorage only.

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

## Hosting on GitHub Pages

This repo's GitHub Pages already serves the app's redirect stub, so the
dashboard is intentionally *not* wired into that deploy. To publish it:

- Easiest: open `dashboard/index.html` from a local clone — it needs no
  server.
- Or drag the `dashboard/` folder onto <https://app.netlify.com/drop>.
- Or enable Pages on your own copy pointed at `/dashboard`.
