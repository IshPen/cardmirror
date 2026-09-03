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
import { firstHeadingFromEncrypted } from '../../src/tools/collab-extract-h1.js';
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
 * Returns the room's topmost H1 text, or null if the document has no H1
 * (or the room has no bytes yet). Throws on a Supabase/decrypt failure —
 * a GCM tag failure here means the wrong key (wrong share code).
 */
export async function resolveRoomName(opts: ResolveOpts): Promise<string | null> {
  const key = await importRoomKey(opts.keyBytes);
  const id = encodeURIComponent(opts.roomId);

  // Snapshot (0 or 1 row) is the compacted state; updates are everything
  // after it (or the whole seed, for a room not yet compacted).
  const [snapRows, updRows] = await Promise.all([
    sbRows(opts.supabaseUrl, opts.anonKey, `relay_room_snapshots?room_id=eq.${id}&select=blob`),
    sbRows(opts.supabaseUrl, opts.anonKey, `relay_room_updates?room_id=eq.${id}&select=blob&order=id.asc`),
  ]);

  // The relay stores base64(ciphertext); decode to the sealed bytes.
  const sealedUpdates = updRows.map((r) => base64ToBytes(r.blob));

  if (snapRows.length) {
    return firstHeadingFromEncrypted(key, base64ToBytes(snapRows[0]!.blob), sealedUpdates);
  }
  if (sealedUpdates.length) {
    // No snapshot yet: the first update blob seeds the doc, the rest apply
    // on top. importBatch treats snapshot/update blobs uniformly.
    return firstHeadingFromEncrypted(key, sealedUpdates[0]!, sealedUpdates.slice(1));
  }
  return null; // room exists but has no content bytes
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
