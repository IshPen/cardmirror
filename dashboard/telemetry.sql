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

-- ── Let YOU read (for the analytics dashboard) ───────────────────────
--  A signed-in Supabase Auth user in THIS project may SELECT. Create ONE
--  user for yourself (Authentication → Users → Add user, Auto Confirm) and
--  then **DISABLE public sign-ups** (Authentication → Providers → Email →
--  turn off "Allow new users to sign up") so nobody else can read.
grant select on usage_events to authenticated;
drop policy if exists "owner reads usage" on usage_events;
create policy "owner reads usage"
  on usage_events for select to authenticated using (true);
--  (Tighter alternative — restrict to your email instead of any authed user:)
--    using ((auth.jwt() ->> 'email') = 'you@example.com')

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
--
--  ── Per-coach & per-document (pseudonymous hashes in props) ──────────
--  props->>'coach' = a stable one-way hash per coach (spans their devices).
--  props->>'doc'   = a stable one-way hash per document, on 'doc_seen' events.
--
--  Unique coaches (better than installs — dedups a coach's browsers):
--    select count(distinct props->>'coach') from usage_events where props ? 'coach';
--
--  Team size + sessions per coach (latest heartbeat each):
--    select distinct on (props->>'coach')
--           props->>'coach' as coach, (props->>'team')::int as team_members,
--           (props->>'sessions')::int as sessions
--    from usage_events where event = 'heartbeat' and props ? 'coach'
--    order by props->>'coach', created_at desc;
--
--  Unique documents created across the whole fleet:
--    select count(distinct props->>'doc') from usage_events where event = 'doc_seen';
--
--  Documents per coach (most active teams):
--    select props->>'coach' as coach, count(distinct props->>'doc') as docs
--    from usage_events where event = 'doc_seen' group by 1 order by 2 desc;
--
--  Engagement events per coach (opened / went live / exported):
--    select props->>'coach' as coach,
--           count(*) filter (where event='doc_opened')   as opened,
--           count(*) filter (where event='went_live')     as live,
--           count(*) filter (where event='doc_exported')  as exported
--    from usage_events where props ? 'coach' group by 1;
