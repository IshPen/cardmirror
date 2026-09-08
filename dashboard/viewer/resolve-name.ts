/**
 * v3 viewer core: resolve a live room's display name from its content —
 * the topmost H1 — entirely in the coach's browser.
 *
 * Flow: fetch the room's encrypted snapshot + update log from Supabase
 * (anon key, ciphertext only — see enable-viewer.sql), decrypt with the
 * room key the coach pasted (share code), Loro-decode, read the first H1.
 * The key never leaves this function's caller; nothing is written back.
 *
 * This module is bundled (Vite) with loro-crdt's WASM, so the built
 * output must be SERVED over http(s) — WASM will not load from file://.
 */
/// <reference path="./vite-raw.d.ts" />
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import {
  firstHeadingFromEncrypted,
  docFromEncrypted,
  firstHeading,
} from '../../src/tools/collab-extract-h1.js';
import { schema } from '../../src/schema/index.js';
import { collectHeadings } from '../../src/editor/headings.js';
import {
  importRoomKey,
  base64ToBytes,
  decodeShareCode,
} from '../../src/editor/collab/collab-crypto.js';
// The editor's real stylesheet, inlined at build time. This is what makes
// the viewer match native CardMirror: highlights, emphasis, heading sizes,
// card layout — all live in these global `.pmd-*` classes and `:root` vars.
// Fonts are referenced by relative url() that won't resolve in the iframe,
// but each @font-face carries local() fallbacks (Calibri→Carlito, etc.), so
// common document fonts still render; the custom accessibility fonts fall
// back to the system stack. (Cosmetic-only; structure/colour are exact.)
import EDITOR_CSS from '../../src/editor/style.css?raw';

export interface ResolveOpts {
  supabaseUrl: string;
  anonKey: string;
  roomId: string;
  /** 32-byte room key (share-code segment three). */
  keyBytes: Uint8Array;
}

interface BlobRow {
  blob: string;
}

async function sbRows(url: string, anonKey: string, pathAndQuery: string): Promise<BlobRow[]> {
  const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/' + pathAndQuery, {
    headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

/**
 * Fetch a room's encrypted bytes and split them into a leading blob +
 * increments for importBatch. Snapshot (0 or 1 row) is the compacted
 * state; updates are everything after it (or the whole seed if the room
 * hasn't compacted). Returns null when the room has no bytes at all.
 */
async function fetchSealed(
  opts: ResolveOpts,
): Promise<{ head: Uint8Array; tail: Uint8Array[] } | null> {
  const id = encodeURIComponent(opts.roomId);
  const [snapRows, updRows] = await Promise.all([
    sbRows(opts.supabaseUrl, opts.anonKey, `relay_room_snapshots?room_id=eq.${id}&select=blob`),
    sbRows(opts.supabaseUrl, opts.anonKey, `relay_room_updates?room_id=eq.${id}&select=blob&order=id.asc`),
  ]);
  const sealedUpdates = updRows.map((r) => base64ToBytes(r.blob));
  if (snapRows.length) return { head: base64ToBytes(snapRows[0]!.blob), tail: sealedUpdates };
  if (sealedUpdates.length) return { head: sealedUpdates[0]!, tail: sealedUpdates.slice(1) };
  return null;
}

/**
 * Returns the room's topmost H1 text, or null if the document has no H1
 * (or the room has no bytes yet). Throws on a Supabase/decrypt failure —
 * a GCM tag failure here means the wrong key (wrong share code).
 */
export async function resolveRoomName(opts: ResolveOpts): Promise<string | null> {
  const key = await importRoomKey(opts.keyBytes);
  const sealed = await fetchSealed(opts);
  if (!sealed) return null;
  return firstHeadingFromEncrypted(key, sealed.head, sealed.tail);
}

/** Serialize a rebuilt CardMirror document to the schema's toDOM HTML —
 *  the bare content fragment, no stylesheet. Browser/jsdom only (needs
 *  `document`). Kept for callers that embed the fragment themselves; the
 *  viewer uses `renderDocument` (below) for native-styled output. */
export function docToHtml(node: PMNode): string {
  const serializer = DOMSerializer.fromSchema(schema);
  const fragment = serializer.serializeFragment(node.content);
  const div = document.createElement('div');
  div.appendChild(fragment);
  return div.innerHTML;
}

/** Minimal page chrome around the editor CSS: a centered document column
 *  on white, plus fallbacks for the few vars the editor otherwise sets from
 *  JS settings (undertag colour), and disabling `content-visibility` so
 *  headings/cards aren't lazy-skipped inside a short scrolling iframe. */
const VIEWER_BASE_CSS = `
  html, body { margin: 0; background: #fff; }
  #editor {
    max-width: 8.5in;
    margin: 0 auto;
    padding: 24px 32px 96px;
    color: #111;
    font-family: 'Calibri', 'Carlito', 'Times New Roman', 'Tinos', serif;
    --pmd-color-undertag: #555;
  }
  .pmd-pocket, .pmd-hat, .pmd-block, .pmd-card, .pmd-analytic-unit {
    content-visibility: visible;
  }
`;

/** Render a rebuilt document as a COMPLETE, self-contained HTML page that
 *  reproduces native CardMirror styling — the editor's own stylesheet plus
 *  a `#editor.ProseMirror` wrapper (the class the CSS scopes some rules to).
 *  Meant to be dropped into an `<iframe srcdoc>` so the editor's global
 *  rules stay isolated from the dashboard. */
export function renderDocument(node: PMNode): string {
  const body = docToHtml(node);
  return (
    '<!doctype html><html data-theme="light"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + EDITOR_CSS + '</style>' +
    '<style>' + VIEWER_BASE_CSS + '</style>' +
    '</head><body><div id="editor" class="ProseMirror pmd-viewer-doc">' +
    body +
    '</div></body></html>'
  );
}

export interface OutlineItem {
  id: string | null;
  text: string;
  type: string;
  level: number;
}

/** Flat heading outline (pocket/hat/block/…) for the viewer's nav rail. The
 *  ids match the `data-id` the schema toDOM stamps on each heading, so the
 *  caller can scroll the rendered iframe to `[data-id="…"]`. */
export function docOutline(node: PMNode): OutlineItem[] {
  return collectHeadings(node, { skipCite: true }).map((h) => ({
    id: h.id,
    text: h.text,
    type: h.type,
    level: h.level,
  }));
}

export interface RoomDoc {
  title: string | null;
  /** Bare content fragment (schema toDOM), no styling. */
  html: string;
  /** Complete self-contained HTML page for an `<iframe srcdoc>` — native
   *  CardMirror styling. Empty string when the room has no content. */
  document: string;
  /** Heading outline for the nav rail. */
  outline: OutlineItem[];
  empty: boolean;
}

/**
 * Fetch, decrypt, and render a room's whole document — the viewer's Goal 2.
 * Returns both the bare `html` fragment and a fully-styled `document` page
 * (for an iframe). `empty` is true when the room has no content yet.
 */
export async function getRoomDoc(opts: ResolveOpts): Promise<RoomDoc> {
  const key = await importRoomKey(opts.keyBytes);
  const sealed = await fetchSealed(opts);
  if (!sealed) return { title: null, html: '', document: '', outline: [], empty: true };
  const node = await docFromEncrypted(key, sealed.head, sealed.tail);
  return {
    title: firstHeading(node),
    html: docToHtml(node),
    document: renderDocument(node),
    outline: docOutline(node),
    empty: false,
  };
}

/** Rebuild a room's ProseMirror document node (or null when empty). Used by
 *  the export/history tools that need the node itself, not rendered HTML. */
export async function getRoomNode(opts: ResolveOpts): Promise<PMNode | null> {
  const key = await importRoomKey(opts.keyBytes);
  const sealed = await fetchSealed(opts);
  if (!sealed) return null;
  return docFromEncrypted(key, sealed.head, sealed.tail);
}

/** Low-level fetch of a room's sealed snapshot + tail (exported for the
 *  history tool, which needs per-update timestamps of its own). */
export { fetchSealed as fetchSealedBlobs };

/** Convenience: render a doc straight from a pasted share code. */
export async function getRoomDocFromShareCode(
  supabaseUrl: string,
  anonKey: string,
  shareCode: string,
): Promise<RoomDoc & { roomId: string }> {
  const decoded = decodeShareCode(shareCode);
  if (!decoded) throw new Error('That does not look like a share code.');
  const doc = await getRoomDoc({ supabaseUrl, anonKey, roomId: decoded.roomId, keyBytes: decoded.keyBytes });
  return { ...doc, roomId: decoded.roomId };
}

/** Convenience: resolve straight from a pasted share code. */
export async function resolveRoomNameFromShareCode(
  supabaseUrl: string,
  anonKey: string,
  shareCode: string,
): Promise<{ roomId: string; name: string | null }> {
  const decoded = decodeShareCode(shareCode);
  if (!decoded) throw new Error('That does not look like a share code.');
  const name = await resolveRoomName({
    supabaseUrl,
    anonKey,
    roomId: decoded.roomId,
    keyBytes: decoded.keyBytes,
  });
  return { roomId: decoded.roomId, name };
}

// Live read-only room sync + outline (see live-room.ts). Re-exported here so
// the dashboard imports one bundle entry. (ES module cycle with live-room is
// runtime-only — both sides call each other's functions lazily.)
export {
  startLiveRoom,
  type LiveOpts,
  type LiveHandle,
  type LiveSnapshot,
  type LiveStatus,
} from './live-room.js';

// Export (.docx), backup zip, and version-history scrubber (see viewer-tools.ts).
export {
  downloadRoomDocx,
  roomToDocx,
  backupAllDocx,
  loadHistory,
  type BackupEntry,
  type BackupProgress,
  type RoomHistory,
  type HistoryStep,
} from './viewer-tools.js';
