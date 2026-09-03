# Path B — the dashboard as an invitable member

> **The UI is folded into the main dashboard** (the **Member** button and the
> **Open** action on Sessions rows). The standalone page was removed. This
> folder now holds the shared implementation (`pairing-client.ts`) and its
> committed bundle (`dist/member.mjs`) that the main dashboard imports.


Instead of pasting share codes, students **invite the dashboard** into a
session (CardMirror's normal invite), and the dashboard automatically
learns the doc's **name** — and its key, so the doc can be opened later.
No student-side change: it reuses the existing invite feature, pointed at
the dashboard's own member code.

## How it works

1. The dashboard has its own pairing identity — a `cmk1.…` **member
   code** (X25519 key in this browser's IndexedDB, the same scheme
   students use).
2. A student adds that code once and **invites** it during a session.
   CardMirror seals an invite — containing the share code (roomId + room
   key) **and the doc title** — to the dashboard's mailbox.
3. This page polls the mailbox (`GET /relay/messages`), unseals invites,
   and remembers each room's title + key.
   - **Goal 1 (see the name):** the title rides in the invite — no
     decryption needed.
   - **Goal 2 (open the doc):** the stored key + the viewer decoder render
     the content. *(Wiring the "Open" button is the next step.)*

Core: [`pairing-client.ts`](./pairing-client.ts), reusing the app's audited
crypto (`web-pairing-crypto`, `room-invite`, `collab-crypto`). Proven end
to end in `tests/pairing/dashboard-member.test.ts` (a student seals an
invite → the dashboard recovers the title + key).

## Setup

1. **Build:** `npm install && npm run build:member` → `dist/member.mjs`
   (~6 KB, git-ignored). No WASM.
2. **Serve** `dashboard/member/` over http (IndexedDB + ES modules don't
   work from `file://`), e.g. `npx serve dashboard/member`.
3. Open the page. Copy its **member code** and give it to students; each
   adds it once in CardMirror and invites it when they want you to see a
   doc.
4. Enter the **relay URL** and a **dashboard relay token** (add a
   "Dashboard" entry in the main dashboard's Tokens panel — the dashboard
   needs its own token to poll the mailbox). Click **Poll for invites**;
   the page auto-polls every 30s while open.

## Notes

- **Keep it open/refreshed.** Mailbox invites expire after ~3 hours if
  never caught; once caught, the key is kept forever (in this browser's
  localStorage).
- The identity is **per browser**. Using a different browser/profile = a
  different member code (students would re-invite it).
- Receiving an invite does **not** occupy one of the room's 10 participant
  slots — the dashboard only reads the mailbox.
- Like the viewer, this can read student work (given a key). It's opt-in
  and consent-based (students choose to invite it) — disclose it.
