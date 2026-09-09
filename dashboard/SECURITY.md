# CardBridge — security model & residual risks

CardBridge is a static dashboard + a blind relay on top of CardMirror's
end-to-end-encrypted collaboration. This documents what protects your team's
data, and the risks you're accepting — from an internal review (2026-09).

## What protects your data

- **End-to-end encryption.** Documents are AES-256-GCM encrypted in CardMirror.
  The relay and Supabase only ever store **ciphertext**; keys live in browsers.
- **The dashboard can't read docs by default.** "Add session" keeps only the
  room id and throws the key away. It can only Open a doc a student explicitly
  **invited** it to (which hands it that room's key).
- **Row-Level Security** on Supabase: the public `anon` key is granted the
  minimum — read room *metadata* and the *encrypted* bytes, insert registry
  rows. It **cannot** read the mailbox, tokens, or any coach's vault.
- **The vault** (`dashboard_state`) is scoped to `auth.uid() = user_id`, so a
  coach can only ever read/write **their own** row. Its secrets are encrypted in
  the browser with AES-256-GCM (key = PBKDF2-SHA256, 210k iters, of your login
  password) before upload — Supabase never sees them in the clear.
- **Your password is never stored** — only held in memory to derive the vault
  key, re-entered each session. The auth token lives in `sessionStorage` (clears
  on tab close), not `localStorage`.
- **Telemetry is PII-free** by construction: a strict allowlist sends only
  counts + one-way hashes (see [`TELEMETRY.md`](./TELEMETRY.md)).

## Residual risks you're accepting (by design)

1. **Keep the Supabase project single-coach.** `relay_tokens` grants every
   *signed-in* user of the project full access to all tokens (there's no
   per-owner column). Your project has exactly one Auth user — you — so this is
   safe. **Don't add other Auth users or share the project.** (An email-scoped
   policy is offered in `setup.sql` if you must.)
2. **The anon key exposes all ciphertext + metadata to anyone who has it.** It
   ships in browser JS, so treat it as public. Anyone with it can download every
   room's *encrypted* bytes + history and see live presence/room metadata (who's
   online, who created what, when). Content stays encrypted; this is a
   *metadata* exposure. Turn the viewer off (bottom of `setup.sql`) to re-lock
   the ciphertext if you don't use Open.
3. **"One code across devices" makes the pairing key extractable.** Opt-in only,
   and only the dashboard's own code (never a student's). The trade-off — a
   malicious script on the page could exfiltrate that key — is surfaced with a
   confirmation before you enable it. Leave it off for the tightest posture.
4. **Telemetry is write-spam-able.** The origin guard is a courtesy check
   (client-side, bypassable), not anti-abuse; anyone with the public key can
   POST junk events. They **cannot read** anything back. Keep telemetry in a
   throwaway project so the blast radius is just "drop the table."

## Reporting a vulnerability

This is a noncommercial, best-effort project. If you find a security issue,
open a private report to the maintainer rather than a public issue. Include
steps to reproduce and impact.
