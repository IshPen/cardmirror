-- Debate Relay dashboard — v3 viewer: OPT-IN ciphertext exposure
-- ================================================================
-- Run this ONLY if you are enabling the H1/name viewer. It is separate
-- from schema.sql on purpose: it loosens the privacy posture.
--
-- WHAT IT DOES: grants the browser anon key SELECT on the encrypted
-- room bytes (relay_room_snapshots + relay_room_updates) so the viewer
-- can fetch them. These blobs stay AES-256-GCM ciphertext — unreadable
-- without the room key, which the viewer only ever has in the coach's
-- browser (from a pasted share code) and never stores in Supabase.
--
-- WHAT IT MEANS: before this, the anon key could see zero document
-- bytes, even encrypted. After this, anyone with the anon key can
-- download the ciphertext. That is safe ONLY because it is end-to-end
-- encrypted and the keys are never here — but it is a deliberate step
-- toward a tool that CAN read student work (given a key). Disclose it.
--
-- TO REVERSE: run the `revoke` / `drop policy` lines at the bottom.

-- Expose the encrypted snapshot (compacted state) ...
alter table relay_room_snapshots enable row level security;  -- already on; harmless
grant select on relay_room_snapshots to anon;
drop policy if exists "viewer anon reads snapshots" on relay_room_snapshots;
create policy "viewer anon reads snapshots"
  on relay_room_snapshots for select to anon using (true);

-- ... and the encrypted update log (needed for rooms with no snapshot yet;
-- a freshly-created room's seed lives here until a client compacts it).
alter table relay_room_updates enable row level security;    -- already on; harmless
grant select on relay_room_updates to anon;
drop policy if exists "viewer anon reads updates" on relay_room_updates;
create policy "viewer anon reads updates"
  on relay_room_updates for select to anon using (true);

-- ── To turn the viewer OFF again, run these four lines: ──────────────
-- drop policy if exists "viewer anon reads snapshots" on relay_room_snapshots;
-- drop policy if exists "viewer anon reads updates"   on relay_room_updates;
-- revoke select on relay_room_snapshots from anon;
-- revoke select on relay_room_updates   from anon;
