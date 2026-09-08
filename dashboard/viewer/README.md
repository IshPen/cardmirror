# v3 — Room viewer (opt-in)

> **The UI is folded into the main dashboard** — the **Open** button on
> Sessions rows renders a room's document. The standalone viewer page was
> removed. This folder now holds the shared decoder (`resolve-name.ts`,
> `getRoomDoc`/`docToHtml`/`renderDocument`/`docOutline`), the live read-only
> room sync (`live-room.ts` → `startLiveRoom`, reused from the relay's
> `RoomStream`), the committed bundle (`dist/viewer.mjs`) the main dashboard
> imports, and `enable-viewer.sql`.
>
> **Rendering** injects the editor's real `src/editor/style.css` into an
> isolated iframe for native fidelity. **Live sync** (`Go live`) streams a
> room's updates and swaps the `#editor` innerHTML in place (preserving
> scroll) — read-only; it never posts, so it cannot alter a student's doc.
> **Editing** (`editor.ts` → `mountEditor`, EXPERIMENTAL) mounts a real
> ProseMirror editor bound to a live `CollabSession` inside the viewer iframe;
> local edits and **inline comments** (native `comment_range` mark + the
> collab-comments CRDT sync) flow back to the room. It is **off by default**
> behind a warning — it writes to live student docs, so verify it with two
> clients before real use.

Decrypts and renders a room's document **in the coach's browser** — the
name (first `pocket`/H1) and the full content. Requires a key (from an
invite or a pasted share code).

> **Read this first.** v1/v2 cannot read student work. This can. It
> decrypts document content using the room key from a share code you
> paste; the key stays in your browser and is never stored in Supabase,
> and the relay stays blind — but the capability is real. Enable it
> deliberately, and tell your team it exists.

## What it does and doesn't do

- **Does:** given a room's **share code** (which carries the key), fetch
  that room's encrypted bytes from Supabase, decrypt locally, and show
  the topmost H1 as the name.
- **Doesn't:** it can only name rooms you hold a share code for — the
  same rooms you could register in the main dashboard. It is *not*
  automatic naming of every live room (students create rooms and hold the
  keys; the relay never sees them). See the roadmap in the top-level
  `README.debate-relay.md`.

## How the pipeline works

1. `decodeShareCode` → `{ roomId, keyBytes }` (segment three is the key).
2. Fetch `relay_room_snapshots` + `relay_room_updates` for that room
   (anon key; **ciphertext only** — see `enable-viewer.sql`).
3. Decrypt each blob (AES-256-GCM, WebCrypto) with the room key.
4. `importBatch` into a `LoroDoc`, convert with `loro-prosemirror`, read
   the first `pocket` node's text (CardMirror's H1).

Core decoder: `../../src/tools/collab-extract-h1.ts` (unit-tested in
`tests/collab/extract-h1.test.ts`). The browser wrapper is
`resolve-name.ts`. The built bundle is verified end-to-end in
`tests/collab/viewer-bundle.test.ts`.

## Setup

1. **Enable ciphertext access** (once): run
   [`enable-viewer.sql`](./enable-viewer.sql) in Supabase → SQL Editor.
   This grants the anon key SELECT on the encrypted snapshot/update
   tables. It is reversible (see the bottom of that file).
2. **Build the bundle:** from the repo root,
   ```sh
   npm install
   npm run build:viewer
   ```
   This produces `dashboard/viewer/dist/viewer.mjs` (~4.5 MB; bundles
   `loro-crdt`'s WASM inline). It's git-ignored — rebuild as needed.
3. **Serve it** — the WASM-bearing module needs `http(s)`, so it will
   **not** work opened from `file://` (unlike the main dashboard). Any
   static server works, e.g.:
   ```sh
   npx serve dashboard/viewer      # then open the printed URL
   ```
   or host `dashboard/viewer/` on Netlify / GitHub Pages.
4. Open `index.html`, paste your Supabase URL + anon key (prefilled from
   the main dashboard if you've used it), paste one or more **share
   codes**, and click **Resolve names**.

## Notes

- A "wrong key / share code" result means the GCM tag failed — the key in
  that code doesn't match that room.
- First resolve loads the ~1.5 MB (gzipped) decoder; subsequent ones are
  instant.
- **Next step (not built):** auto-naming registered rooms inside the main
  dashboard by remembering their keys client-side. That would fold this
  into the Sessions table instead of a separate page.
