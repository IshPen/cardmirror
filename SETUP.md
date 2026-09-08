# Set up Debate Relay in ~20 minutes

A free, always-on, end-to-end-encrypted collaboration relay for your debate
team — plus a coach dashboard to watch it all. **No credit card. No server to
babysit.** Three places to visit, in order.

---

## 1 · Database — Supabase · ~7 min

1. Create a free project at **<https://supabase.com>** (GitHub login is fine).
   Save the database password you set.
2. **Project Settings → Database → Connection string → Session pooler.** Copy
   that URI (it contains `pooler.supabase.com`) and swap in your password.

   > ⚠️ **Use "Session pooler," never "Direct connection."** Direct is
   > IPv6-only; Render is IPv4, and the failure is *silent*. If your string
   > doesn't say `pooler`, you have the wrong one.

3. **SQL Editor → New query**, paste all of
   [`dashboard/setup.sql`](./dashboard/setup.sql), and **Run**. That one script
   sets up everything (room registry, row-level security, the doc viewer's
   encrypted read, and the token table). It's safe to re-run.

---

## 2 · Relay — Render · ~10 min

Click the button, point it at this repo, and paste the connection string from
step 1 when prompted for **`DATABASE_URL`**:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/IshPen/cardmirror)

Render reads [`render.yaml`](./render.yaml) and generates a random `RELAY_TOKEN`
for you. Wait for **Live** and a passing `/relay/health` check. Then note:

- **Relay URL** — your service URL with `/relay` appended, e.g.
  `https://debate-relay.onrender.com/relay`.
- **Relay token** — Render → your service → **Environment** → `RELAY_TOKEN`.

> Render's free tier sleeps after ~15 min idle. Add a free 5-minute
> **<https://uptimerobot.com>** HTTP monitor on your relay URL `+ /health` to
> keep it warm. (Optional but recommended — see
> [`docs/setup.md`](./docs/setup.md) Step 3.)

---

## 3 · Dashboard — open one URL · ~3 min

The coach dashboard is a static site. This fork auto-publishes it to **GitHub
Pages** — one-time: repo owner → **Settings → Pages → Source: "GitHub
Actions"** (workflow: [`dashboard-pages.yml`](./.github/workflows/dashboard-pages.yml)).
It then lives at `https://<your-user>.github.io/cardmirror/`.

Open that URL. A **guided wizard** walks you through connecting:

| Step | Paste | Then |
|------|-------|------|
| ① Supabase | Project URL + **anon** key | **Test connection** → live-reads your rooms |
| ② Relay | Relay URL from step 2 | **Test connection** → checks `/relay/health` |
| ③ Token | — | **Generate** a `Dashboard…` token, then **Save** |

Everything is saved in **your browser only** (localStorage), so future visits
skip the wizard. Nothing is stored server-side.

> Paste the **anon** key — never the service-role key, never a Postgres
> connection string. A connection string in browser JavaScript is a public
> database.

No hosting? Drag `dashboard/` onto <https://app.netlify.com/drop>, or run
`python -m http.server 8000` and open `http://localhost:8000/dashboard/`.

---

## What each piece does

- **Relay (Render):** blind store-and-forward. It only ever sees ciphertext,
  hashed routing codes, and timestamps — never your team's work.
- **Database (Supabase):** keeps encrypted edits permanently and, under
  row-level security with the public anon key, lets the dashboard read *room
  metadata* (and, if you opt in, the *encrypted* bytes the viewer decrypts
  in-browser once a student shares a key).
- **Dashboard (Pages):** health, sessions, storage, presence, activity, per-
  student attribution, token management, and — for rooms a student invites it
  into — a live document viewer with export, history, and notes.

Full walkthrough with screenshots and troubleshooting:
[`docs/setup.md`](./docs/setup.md). Dashboard details:
[`dashboard/README.md`](./dashboard/README.md).
