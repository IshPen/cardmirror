# Workflow — rooms vs. Drive, and who saves

The single most important idea in this whole stack:

> **Drive stores files. The relay carries edits. They never touch each
> other.**

Get that right and nothing else bites you. Get it wrong and you get Drive
conflict copies and confusion about where the "real" file is. So read
this once, as a team.

---

## The two halves

**Google Shared Drive is permanent storage.** A `.cmir` file lives there
like any document. A student opens it from a synced Drive folder exactly
like a local file.

**The relay is a live change log, not a file.** When two people work at
once, their edits flow through a *room* on the relay — encrypted, and
invisible to the server. The relay is **not backup**. It holds an
encrypted session log, and idle rooms are deleted after 7 days.

---

## Who saves: the one rule

**Only the host has the file open, so only the host saves.**

- The **host** opens the `.cmir` from Drive and **starts a session**.
  They send a **share code** to a partner.
- The **joiner** receives the whole document *through the room*. They do
  **not** open a file and do **not** save to Drive.
- At the end of a real work session, **the host saves once** back to
  Drive.

This is what prevents Drive conflict copies: only one machine ever writes
the file. Two people saving the "same" document from two machines is
exactly how you get `document (1).cmir`.

> If the original host isn't around to save, whoever is in the room can
> **Save As** a fresh copy to Drive and make that the new canonical file.
> Just agree on which file is canonical afterward.

---

## What happens when people come and go

These behaviors are verified on live hardware (see
[`findings.md`](./findings.md)); they're what make asynchronous partner
work possible.

- **The host can leave — even power off — and the room lives on.** A
  joiner keeps editing. When the host returns, they pick up those edits.
- **Reopening rejoins the live room.** You get your partner's edits made
  while you were away, not a stale local draft.
- **Ending a session is safe.** Whoever remains keeps the work as an
  editable local document, protected by CardMirror's crash-recovery
  journaling even if unsaved. Saving is about making work *visible to
  teammates*, not about preventing loss.

So: **saving ≠ safety, saving = visibility.** The relay and the local
journal keep the work; saving to Drive is how a teammate gets the final
version tomorrow.

---

## Team conventions worth adopting

- **End every real session with a save to Drive.** The relay is not
  backup. Make it a reflex: last thing before you close, host saves.
- **One canonical file per doc.** Decide who "owns" saving each file so
  two people don't both Save As.
- **Everyone on the same CardMirror version.** A version mismatch reads
  like a broken relay. Update together.
- **Treat share codes like passwords.** They grant read *and* write.
  Send them one-to-one (DM), never to a group channel. If a code leaks,
  end the session and start a new one — a new code, new key.
- **Desktop-width windows in the web editor.** Narrow = mobile layout =
  no collaboration.
- **Sessions hold up to 10 people**, enforced when you connect. An
  eleventh join is refused (HTTP 409). For a working group that's plenty;
  it's not a lecture hall.

---

## Chromebook students

Chromebook students run the **web editor** and can fully **join**
sessions and edit. Whether they can *save a file back into a Drive-mounted
location* (versus getting a download) is an
[open question](./findings.md#open-questions) still being tested. Until
that's settled, the safe pattern is: **a Windows/Mac host owns the file
and saves; Chromebook partners join and edit.** Nobody loses work either
way — the host's save is the file of record.
