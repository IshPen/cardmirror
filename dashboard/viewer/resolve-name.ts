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
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import {
  firstHeadingFromEncrypted,
  docFromEncrypted,
  firstHeading,
} from '../../src/tools/collab-extract-h1.js';
import { schema } from '../../src/schema/index.js';
import {
  importRoomKey,
  base64ToBytes,
  decodeShareCode,
} from '../../src/editor/collab/collab-crypto.js';

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

/** Serialize a rebuilt CardMirror document to HTML using the schema's
 *  toDOM rules. Browser/jsdom only (needs `document`). */
export function docToHtml(node: PMNode): string {
  const serializer = DOMSerializer.fromSchema(schema);
  const fragment = serializer.serializeFragment(node.content);
  const div = document.createElement('div');
  div.appendChild(fragment);
  return div.innerHTML;
}

export interface RoomDoc {
  title: string | null;
  html: string;
  empty: boolean;
}

/**
 * Fetch, decrypt, and render a room's whole document to HTML — the
 * viewer's Goal 2. `empty` is true when the room has no content yet.
 */
export async function getRoomDoc(opts: ResolveOpts): Promise<RoomDoc> {
  const key = await importRoomKey(opts.keyBytes);
  const sealed = await fetchSealed(opts);
  if (!sealed) return { title: null, html: '', empty: true };
  const node = await docFromEncrypted(key, sealed.head, sealed.tail);
  return { title: firstHeading(node), html: docToHtml(node), empty: false };
}

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
