# Troubleshooting

Start with the error-to-cause table. Most "the relay is broken" reports
are one of the first three rows.

## Error → cause

| What you see | Almost always means | Fix |
|---|---|---|
| Relay never goes **Live** on Render; deploy hangs or health check fails | You used Supabase's **Direct connection** string (IPv6-only) instead of the **Session pooler** | Redeploy with the pooler URI (host contains `pooler.supabase.com`); see [setup Step 1](./setup.md#step-1--create-the-database-supabase--10-min) |
| No **Collaboration** tab in Settings | You're running **CardMirror Lite** | Install the **full desktop build** |
| Session join fails / "can't read session" between machines that both point at the relay | **Version mismatch** — one machine is on an older CardMirror | Update every machine to the **same** version |
| Collaboration controls missing in the **web editor** | Window is in **mobile layout** | Widen to a **desktop-width** window |
| Eleventh person can't join; **HTTP 409** | Session capacity is **10**, enforced at connect | Start a second room, or drop an idle participant |
| First edit after a quiet period is slow (~60s), then fine | Render **cold start** — the instance had gone to sleep | Set up the **UptimeRobot** keepalive ([setup Step 3](./setup.md#step-3--keep-it-awake-uptimerobot--5-min)) |
| Dashboard shows **"Relay is unreachable"** | Relay waking from sleep, or wrong relay URL | Click **Refresh** after ~60s; verify the URL ends in `/relay` |
| Dashboard Supabase error `401` / `permission denied` | Wrong key, or `schema.sql` not run | Paste the **anon** key (Settings → API); run [`schema.sql`](../dashboard/schema.sql) once |
| Duplicate `.cmir (1)` files appearing in Drive | **Two machines saving** the same file | Only the **host** saves — see [workflow.md](./workflow.md#who-saves-the-one-rule) |
| Work "disappeared" after ending a session | It didn't — it's an **editable local doc**, journaled | **Save** it to Drive; ending a session never loses work |

---

## Relay won't deploy or stay up

1. **Confirm the connection string is the pooler.** This is the number
   one cause. The host must contain `pooler.supabase.com`. If it says
   anything about a direct/db host, it's wrong.
2. **Confirm the password is filled in.** Render's `DATABASE_URL` must
   have `[YOUR-PASSWORD]` replaced with your actual Supabase database
   password.
3. **Check the health path.** `GET https://<your-relay>/relay/health`
   should return `{"ok": true}` with no auth. If the domain resolves but
   this 404s, your URL is missing `/relay`.
4. **Single worker only.** If you deployed by hand instead of via
   `render.yaml`, make sure you did **not** pass `--workers` to uvicorn —
   the live-push registry is in-process, and multiple workers break
   pushes.

## Collaboration doesn't work between two machines

Work down this list; it's ordered by how often each is the culprit.

1. **Same build?** Both on the *full* desktop app (not Lite).
2. **Same version?** Update both to identical versions.
3. **Same relay URL and token?** Re-check **Settings → Collaboration** on
   both — character for character. A typo here is indistinguishable from a
   dead relay.
4. **Desktop-width window** if either side is on the web editor.
5. **Relay actually up?** Hit `/relay/health` in a browser.

## Dashboard problems

- **Everything says "unreachable" / errors:** re-open **Settings** in the
  dashboard and re-check all three values. The relay URL ends in
  `/relay`; the Supabase URL is the `…supabase.co` project URL; the key
  is the **anon public** key.
- **`permission denied for table relay_rooms`:** you haven't run
  [`schema.sql`](../dashboard/schema.sql), or you ran it before the relay
  first started (so `relay_rooms` didn't exist yet). Start the relay
  once, then run the SQL.
- **Sessions show as "dead" right after creating them:** the room ID
  didn't match. Re-check that you pasted the **full** share code into
  *Add session* — the dashboard keeps segment two automatically.
- **Storage number looks high:** it's an *estimate* (content bytes ×3.5),
  and pre-compaction. It will read high until steady state; that's
  expected, not a leak.

## When in doubt

Nothing here risks student work. The relay only holds encrypted edits,
CardMirror journals locally, and Drive holds the last save. If a session
gets weird: **end it, save the local doc to Drive, and start fresh** —
new session, new share code.
