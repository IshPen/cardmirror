-- ════════════════════════════════════════════════════════════════════
--  Debate Relay — ONE-TIME Supabase setup  (run this whole file once)
-- ════════════════════════════════════════════════════════════════════
--  Supabase → SQL Editor → New query → paste ALL of this → Run.
--
--  This replaces the old three-script dance (schema.sql + relay-tokens.sql
--  + enable-viewer.sql). It is SAFE to run before OR after the relay's
--  first boot, and safe to re-run — every step that touches a relay-owned
--  table is guarded so it's a no-op until that table exists.
--
--  What it sets up:
--    1. dashboard_registry — the friendly label/owner/event names you add
--       (the relay only mints anonymous room IDs).
--    2. Row-Level Security everywhere, granting the browser's public `anon`
--       key EXACTLY what the dashboard needs and nothing more.
--    3. The doc VIEWER: anon read of the ENCRYPTED room bytes so the
--       dashboard can open/preview docs it holds a key for. The blobs stay
--       AES-256-GCM ciphertext — unreadable without the room key, which
--       lives only in the coach's browser. (Privacy note at section 3.)
--    4. relay_tokens — optional DB-backed per-student tokens so you can
--       add/remove students from the dashboard with no redeploy.
--
--  Why this never breaks the relay: the relay connects as the table OWNER
--  (the `postgres` role in your pooler URL), and owners bypass RLS on their
--  own tables. RLS only constrains the public `anon` key the dashboard
--  ships in browser JavaScript.
-- ════════════════════════════════════════════════════════════════════

-- Helper: enable RLS on a relay-owned table only if it exists yet.
create or replace function _dr_secure(tbl text) returns void language plpgsql as $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = tbl) then
    execute format('alter table public.%I enable row level security', tbl);
  end if;
end $$;

-- Helper: grant anon SELECT + a read policy on a relay-owned table (guarded).
create or replace function _dr_anon_read(tbl text, policy_name text) returns void language plpgsql as $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = tbl) then
    execute format('grant select on public.%I to anon', tbl);
    execute format('drop policy if exists %I on public.%I', policy_name, tbl);
    execute format('create policy %I on public.%I for select to anon using (true)', policy_name, tbl);
  end if;
end $$;

-- 1 ── The dashboard's own registry table ────────────────────────────
create table if not exists dashboard_registry (
  room_id    text primary key,   -- share-code segment two; joins relay_rooms.id
  label      text not null,       -- e.g. "1AC — Reproductive Services"
  owner      text,                -- e.g. "Maya"
  event      text,                -- e.g. "Michigan 2026"
  created_at timestamptz default now()
);
alter table dashboard_registry enable row level security;
grant select, insert on dashboard_registry to anon;
drop policy if exists "dashboard anon reads registry" on dashboard_registry;
create policy "dashboard anon reads registry"
  on dashboard_registry for select to anon using (true);
drop policy if exists "dashboard anon adds registry" on dashboard_registry;
create policy "dashboard anon adds registry"
  on dashboard_registry for insert to anon with check (true);

-- 2 ── Lock down the relay's own tables, expose only room metadata ───
select _dr_secure('relay_rooms');
select _dr_secure('relay_messages');
select _dr_secure('relay_room_updates');
select _dr_secure('relay_room_snapshots');
select _dr_secure('relay_room_participants');

-- Metadata the dashboard shows (room list + live participant labels).
select _dr_anon_read('relay_rooms',             'dashboard anon reads rooms');
select _dr_anon_read('relay_room_participants', 'dashboard anon reads participants');

-- The mailbox stays fully private (no policy → anon sees zero rows).
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='relay_messages') then
    execute 'revoke all on public.relay_messages from anon';
  end if;
end $$;

-- 3 ── Doc viewer: expose the ENCRYPTED room bytes to the anon key ────
--  PRIVACY: this lets anyone with the anon key DOWNLOAD the ciphertext.
--  It stays E2E-encrypted (AES-256-GCM); the room key is never in Supabase
--  — the dashboard only ever holds it in the coach's browser. This is the
--  deliberate step that lets the dashboard open/preview/edit docs it was
--  invited to. Tell your team the viewer exists. To turn it OFF later, run
--  the four lines at the very bottom of this file.
select _dr_anon_read('relay_room_snapshots', 'viewer anon reads snapshots');
select _dr_anon_read('relay_room_updates',   'viewer anon reads updates');

-- 4 ── DB-backed per-student tokens (optional but recommended) ───────
--  Lets the Tokens panel add/remove students instantly (no Render edit,
--  no redeploy). The relay reads this table when it has rows and ignores
--  the RELAY_TOKENS env var; empty table = falls back to env. To USE the
--  in-dashboard "Sync to relay" button you also need a coach login:
--    Supabase → Authentication → Users → Add user → email + password,
--    tick "Auto Confirm User".
create table if not exists relay_tokens (
  token      text primary key,
  label      text,
  role       text not null default 'student' check (role in ('student', 'coach')),
  created_at timestamptz default now()
);
alter table relay_tokens enable row level security;
revoke all on relay_tokens from anon;                       -- public key: nothing
grant select, insert, update, delete on relay_tokens to authenticated;
drop policy if exists "coach manages tokens" on relay_tokens;
create policy "coach manages tokens"
  on relay_tokens for all to authenticated using (true) with check (true);

-- Tidy up the helpers.
drop function if exists _dr_secure(text);
drop function if exists _dr_anon_read(text, text);

-- ✅ Done. If you ran this before the relay's first boot, just re-run it
--    once the relay is Live so the guarded relay-table steps take effect.

-- ── To turn the doc VIEWER off again (re-lock the ciphertext): ───────
-- drop policy if exists "viewer anon reads snapshots" on relay_room_snapshots;
-- drop policy if exists "viewer anon reads updates"   on relay_room_updates;
-- revoke select on relay_room_snapshots from anon;
-- revoke select on relay_room_updates   from anon;
