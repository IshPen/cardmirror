-- ════════════════════════════════════════════════════════════════════
--  CardBridge — anonymous usage metrics  (MAINTAINER's CENTRAL project)
-- ════════════════════════════════════════════════════════════════════
--  Run this in a DEDICATED Supabase project you own JUST for telemetry —
--  NOT a coach's project, and NOT one holding any relay/document data.
--
--  It stores only ANONYMOUS counters (a random install id + numeric event
--  props). The public `anon` key may INSERT but NEVER SELECT, so no one can
--  read anyone's events with the key shipped in the browser. You (the owner)
--  read aggregates via the Supabase SQL editor / service role.
--
--  After running this, paste THIS project's URL + anon key into the two
--  constants at the top of dashboard/telemetry.js. Until then, telemetry is
--  a complete no-op in the dashboard.
-- ════════════════════════════════════════════════════════════════════

create table if not exists usage_events (
  id          bigint generated always as identity primary key,
  anon_id     text not null,                 -- random per-install id (no PII)
  session_id  text,                          -- random per browser session
  event       text not null,                 -- 'app_open' | 'heartbeat' | 'session_added' | 'doc_opened' | ...
  props       jsonb default '{}'::jsonb,     -- numeric/boolean counters ONLY
  app_version text,
  created_at  timestamptz default now()
);
create index if not exists usage_events_anon_idx on usage_events (anon_id);
create index if not exists usage_events_created_idx on usage_events (created_at);

alter table usage_events enable row level security;
grant insert on usage_events to anon;                    -- write-only for the public key
revoke select, update, delete on usage_events from anon; -- (no read/modify)
drop policy if exists "anon can insert usage" on usage_events;
create policy "anon can insert usage"
  on usage_events for insert to anon with check (true);
-- No SELECT policy for anon → the public key can never read events back.

-- ── Aggregates for YOU (owner), run in the SQL editor ────────────────
--  Unique installs (≈ coaches; multi-browser slightly over-counts):
--    select count(distinct anon_id) as installs from usage_events;
--
--  Sessions managed per install (latest heartbeat each):
--    select distinct on (anon_id) anon_id, (props->>'sessions')::int as sessions
--    from usage_events where event = 'heartbeat'
--    order by anon_id, created_at desc;
--
--  Daily active installs:
--    select date_trunc('day', created_at) as day, count(distinct anon_id) as active
--    from usage_events group by 1 order by 1;
--
--  Feature adoption (share of installs that turned each on):
--    select count(distinct anon_id) filter (where (props->>'syncEnabled')::bool) as sync,
--           count(distinct anon_id) filter (where (props->>'sharedIdentity')::bool) as shared_code,
--           count(distinct anon_id) filter (where (props->>'viewerUsed')::bool) as opened_a_doc
--    from usage_events;
