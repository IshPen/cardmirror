# Findings

These came from testing Debate Relay on live hardware, and are not
documented anywhere else. They are the reason this repo is worth reading —
the setup steps you can reconstruct; these you can't.

---

## Rooms survive the host leaving

Force-killing the machine that *created* a session does not end the room.
A joiner can connect and edit while the host's machine is powered off, and
the host picks up those edits on return.

**Why it matters:** this makes asynchronous shared editing real. Partners
work whenever they want, independently, in the same document — not just in
a synchronous "we're both online now" window.

## Ending a session is safe

Whoever remains keeps the work as an **editable local document**, backed
by CardMirror's crash-recovery journaling even if it was never saved.

**Why it matters:** saving is about making work *visible to teammates*,
not about preventing loss. Nobody has to panic about ending a session.

## Reopening rejoins the live room

Confirmed: a partner's edits made while you were closed are **present when
you return**, rather than a stale local draft overwriting them.

**Why it matters:** it's safe to close and come back. The room, not your
last local state, is the source of truth while a session is live.

## Storage runs about 3.5× document size

A 1.5 MB file produced ~5.3 MB of database growth — roughly a **3.5×**
multiplier.

**Caveat:** measured *before* client-side compaction had run, so steady
state is likely lower. On a 500 MB free tier that's roughly **30–40
concurrent documents** with comfortable headroom — far more than a
program needs. (The dashboard's Storage panel uses this 3.5× figure to
estimate on-disk usage from the relay's reported content bytes.)

## Session capacity is 10

Enforced **at stream connect**, returning **HTTP 409** to the eleventh
participant. Plenty for a working group; not a lecture hall.

---

## Traps that cost hours

- **CardMirror Lite has no collaboration.** The Collaboration settings
  tab does not exist in it. Install the full desktop build.
- **Supabase: use the Session pooler string, not Direct connection.**
  Direct resolves IPv6-only; Render connects over IPv4. The failure is
  *silent* until the last step.
- **All machines must run the same CardMirror version.** Older builds
  can't read the current session format, and the failure looks exactly
  like a broken relay.
- **The web editor needs a desktop-layout window.** Narrow windows switch
  to mobile layout, which has no collaboration.
- **Share codes are credentials.** The code carries the room's encryption
  key — read *and* write. Never in a group chat.

See [`troubleshooting.md`](./troubleshooting.md) for the error-to-cause
table.

---

## Open questions

Honest unknowns, not hidden bugs. Each is a small experiment away from an
answer.

- **Chromebook save-in-place.** Can the web editor save back to a
  Drive-mounted location, or does it produce a download? Determines
  whether Chromebook students *own* files or only join sessions. A
  ten-minute test.
- **Post-compaction storage.** Re-measure `relay_room_updates` after a
  week of real editing to establish the *steady-state* multiplier rather
  than the pre-compaction 3.5×.
- **Tournament-weekend load.** Behavior with eight-plus concurrent rooms
  and heavy churn is untested.
- **Idle GC reclamation.** Confirm that expired rooms actually free
  database space on the sweep, closing the loop on storage management.
