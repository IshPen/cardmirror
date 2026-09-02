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

**It cannot read document contents** — by construction. It talks to
Supabase with the public **anon key** under Row-Level Security, which is
allowed to read only room *metadata* (`relay_rooms`) and the names you
add (`dashboard_registry`). Ciphertext tables stay unreadable. And when
you add a session, the dashboard keeps only the room ID from the share
code and **throws the encryption key away** — see below.

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
