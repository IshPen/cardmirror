-- Debate Relay dashboard — v2.1 DB-backed tokens (no more copy-paste)
-- =================================================================
-- Lets the dashboard manage relay tokens directly, so adding/removing a
-- student is instant — no editing RELAY_TOKENS in Render, no redeploy.
--
-- HOW IT FITS TOGETHER:
--   * The relay CREATES the relay_tokens table itself on the next deploy
--     (v2.1 relay). When that table has any rows, the relay uses it as the
--     source of truth and IGNORES the RELAY_TOKENS env var. Empty table =
--     falls back to env exactly as before. So nothing breaks mid-migration.
--   * The dashboard writes to this table as an AUTHENTICATED (coach)
--     Supabase user. The public anon key can neither read nor write it.
--   * The relay reads it as the table owner (bypasses RLS).
--
-- BEFORE THIS WORKS you also need a coach login:
--   Supabase → Authentication → Users → Add user → set an email + password
--   and tick "Auto Confirm User". That's the account you sign in with in
--   the dashboard's Tokens panel.
--
-- Run this ONCE in Supabase → SQL Editor, AFTER deploying the v2.1 relay
-- (so relay_tokens exists). The guard makes it a safe no-op if not.

create table if not exists relay_tokens (
  token      text primary key,
  label      text,
  role       text not null default 'student' check (role in ('student', 'coach')),
  created_at timestamptz default now()
);

alter table relay_tokens enable row level security;

-- Secrets: the anon key gets NOTHING. Only signed-in coaches manage tokens.
revoke all on relay_tokens from anon;
grant select, insert, update, delete on relay_tokens to authenticated;

drop policy if exists "coach manages tokens" on relay_tokens;
create policy "coach manages tokens"
  on relay_tokens for all to authenticated
  using (true) with check (true);

-- Tighten later (optional): restrict to specific coach accounts by
-- checking auth.uid() / auth.email() in the policy instead of `true`.
