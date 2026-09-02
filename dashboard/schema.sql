-- Debate Relay dashboard — Supabase setup
-- =========================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor →
-- New query → paste → Run) AFTER the relay has started at least once,
-- so the relay's own tables (relay_rooms, relay_room_updates, …) already
-- exist. The relay creates those automatically on first boot.
--
-- What this does, and why it is safe:
--
--   * Creates dashboard_registry, the label/owner/event names the relay
--     itself never stores (the relay mints anonymous random room IDs).
--   * Turns on Row-Level Security everywhere and grants the browser's
--     `anon` role EXACTLY two things: read relay_rooms, and read+insert
--     dashboard_registry. Nothing else.
--   * Leaves relay_room_updates / relay_room_snapshots / relay_messages
--     unreadable, so document ciphertext is never exposed to the page —
--     not even in encrypted form.
--
-- Why this does NOT break the relay: the relay connects to Postgres as
-- the table OWNER (the `postgres` role in your pooler connection string).
-- Table owners bypass RLS on their own tables, so every relay read and
-- write keeps working. RLS only constrains the `anon` key the dashboard
-- ships in browser JavaScript.

-- 1. The registry the dashboard supplies -----------------------------------
create table if not exists dashboard_registry (
  room_id    text primary key,   -- share-code segment two; joins relay_rooms.id
  label      text not null,       -- human name, e.g. "1AC — Reproductive Services"
  owner      text,                -- who runs it, e.g. "Maya"
  event      text,                -- e.g. "Michigan 2026"
  created_at timestamptz default now()
);
-- NOTE: no foreign key to relay_rooms on purpose. A FK would block the
-- relay's idle-GC deletes and forbid registering a room before its first
-- update lands. The dashboard joins in the browser instead, which also
-- lets it show registered rooms whose live room has already been swept
-- (i.e. "dead" sessions).

-- 2. Lock everything down with RLS -----------------------------------------
alter table relay_rooms          enable row level security;
alter table dashboard_registry   enable row level security;
alter table relay_room_updates   enable row level security;
alter table relay_room_snapshots enable row level security;
alter table relay_messages       enable row level security;

-- 3. Grant the anon role only what the dashboard needs ----------------------
-- Belt-and-suspenders: explicit table grants AND policies. Supabase's
-- default privileges may have already granted anon SELECT on new tables,
-- so we REVOKE on the tables that must stay private.
grant  select          on relay_rooms        to anon;
grant  select, insert  on dashboard_registry to anon;
revoke all             on relay_room_updates   from anon;
revoke all             on relay_room_snapshots from anon;
revoke all             on relay_messages       from anon;

-- 4. Policies (the second gate, once RLS is on) -----------------------------
-- relay_rooms: read-only.
drop policy if exists "dashboard anon reads rooms" on relay_rooms;
create policy "dashboard anon reads rooms"
  on relay_rooms for select to anon using (true);

-- dashboard_registry: read all, and add new entries. No update/delete.
drop policy if exists "dashboard anon reads registry" on dashboard_registry;
create policy "dashboard anon reads registry"
  on dashboard_registry for select to anon using (true);

drop policy if exists "dashboard anon adds registry" on dashboard_registry;
create policy "dashboard anon adds registry"
  on dashboard_registry for insert to anon with check (true);

-- relay_room_updates / relay_room_snapshots / relay_messages: RLS is on
-- and NO policy grants anon anything, so every anon query returns zero
-- rows. Ciphertext stays private. (Ending a session — a DELETE — is done
-- from inside CardMirror in v1; the dashboard never writes to these.)
