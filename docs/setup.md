# Setup — a 35-minute coach walkthrough

You are going to stand up a free, always-on collaboration relay for your
team. No credit card, no server to babysit. At the end you will have two
values to hand out: a **relay URL** and a **relay token**.

The order matters. Do the database first, because the relay needs its
connection string at deploy time.

---

## What you'll end up with

- A **relay** on Render's free tier that stores and forwards encrypted
  edits (and never reads them).
- A **Postgres database** on Supabase's free tier that keeps those edits
  permanently (Render's own free Postgres is deleted after 30 days —
  don't use it).
- A **keepalive** on UptimeRobot so the relay never goes to sleep.
- Optionally, the **coach dashboard** to see it all at a glance.

Total cost: **$0**. Credit cards required: **none**.

---

## Before you start

- You need the **full CardMirror desktop build** on every machine.
  **CardMirror Lite has no collaboration** — the Collaboration settings
  tab does not exist in it.
- Every machine must run the **same CardMirror version**. Older builds
  can't read the current session format, and the failure looks exactly
  like a broken relay.
- Have a browser, a GitHub account (for the Render one-click button), and
  15 minutes of uninterrupted attention for the connection-string step —
  that's the one place people slip.

---

## Step 1 — Create the database (Supabase) · ~10 min

1. Go to <https://supabase.com>, sign up (GitHub login is fine), and
   **New project**. Pick a name and a strong database password —
   **save the password**, you'll need it in a moment.
2. Wait for the project to finish provisioning (~2 min).
3. Go to **Project Settings → Database → Connection string**.
4. Select the **Session pooler** tab. **This is the load-bearing
   choice.** Copy that URI. It contains `pooler.supabase.com`.

   > ⚠️ **Do NOT use "Direct connection."** Direct resolves to an
   > IPv6-only host; Render connects over IPv4. The failure is
   > *silent* — the relay just never becomes healthy — and it will cost
   > you an hour. If your string does not say `pooler`, you have the
   > wrong one.

5. Replace `[YOUR-PASSWORD]` in the copied string with the database
   password from step 1. Keep this final string handy for Step 2.

---

## Step 2 — Deploy the relay (Render) · ~10 min

1. Push this repository to your own GitHub account, or use the public
   repo directly — **no fork required** to deploy.
2. Go to <https://render.com>, sign up, and choose **New → Blueprint**.
3. Point it at the repository. Render reads [`render.yaml`](../render.yaml)
   and proposes a single web service, `debate-relay`, on the free plan.
4. It will **prompt for `DATABASE_URL`** (that's the `sync: false` field).
   Paste the Session pooler string from Step 1. It does **not** prompt
   for `RELAY_TOKEN` — Render generates a unique random one for you.
5. Click **Apply / Deploy**. First build takes a few minutes.
6. Wait until the service shows **Live** and the health check at
   `/relay/health` is passing.

Now copy your two values:

- **Relay URL:** your service's URL with `/relay` appended, e.g.
  `https://debate-relay.onrender.com/relay`.
- **Relay token:** Render → your service → **Environment** →
  `RELAY_TOKEN` → reveal and copy.

---

## Step 3 — Keep it awake (UptimeRobot) · ~5 min

Render's free tier sleeps after ~15 minutes idle, and waking takes ~60s —
long enough to look broken mid-session. A free pinger prevents it.

1. Go to <https://uptimerobot.com> and sign up.
2. **Add New Monitor** → type **HTTP(s)**.
3. URL = your relay URL **+ `/health`**, e.g.
   `https://debate-relay.onrender.com/relay/health`.
4. Monitoring interval = **5 minutes**. Save.

That's it — the relay now stays warm 24/7.

---

## Step 4 — Point CardMirror at your relay · ~2 min per machine

On **every** machine (full desktop build):

1. **Settings → Collaboration.**
   - If you don't see this tab, you're on **Lite** — install the full
     build.
2. **Custom relay URL** = your relay URL (ending in `/relay`).
3. **Custom relay token** = the `RELAY_TOKEN` value.
4. Save. Repeat, *identically*, on each machine. A single typo here is
   indistinguishable from a dead relay.

Test it: on one machine start a session and copy the share code; on a
second machine, join with it. If the document appears, you're done.

> **Web editor note:** use a **desktop-width window**. Narrow windows
> switch CardMirror to a mobile layout that has no collaboration.

---

## Step 5 (optional) — The coach dashboard · ~8 min

1. In Supabase → **SQL Editor → New query**, paste the contents of
   [`../dashboard/schema.sql`](../dashboard/schema.sql) and **Run**. This
   creates the registry table and locks down the anon key with
   Row-Level Security. It does **not** affect the relay.
2. Open [`../dashboard/index.html`](../dashboard/) (locally, or host the
   `dashboard/` folder — see its README).
3. On the connect screen paste:
   - **Relay base URL** (ends in `/relay`)
   - **Supabase project URL** (Settings → API → *Project URL*)
   - **Supabase anon key** (Settings → API → *anon public*)

   > Paste the **anon** key only — never the service-role key, never a
   > connection string.

---

## Sharing with your team

Give each student **two things**: the relay URL and the relay token, for
their **Settings → Collaboration**. Then read
[`workflow.md`](./workflow.md) together — especially *who saves*.

> **Share codes are credentials.** A code carries the room's encryption
> key — read *and* write. Never post one in a group chat.
