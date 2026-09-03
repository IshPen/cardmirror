/**
 * v3 building block: derive a display name for a collaboration room from
 * its document content — the topmost H1 (a `pocket` node) — given the
 * room's Loro CRDT bytes.
 *
 * This is the decode half of the "H1 as the room's name" idea. It runs
 * anywhere WebCrypto + the loro-crdt WASM are available (browser, Electron
 * renderer, Node), so a dashboard that HOLDS THE ROOM KEY can decrypt the
 * relay's stored snapshot client-side and read a name from it. The key
 * never leaves the caller; the relay stays blind.
 *
 * Headings in CardMirror are distinct node TYPES, not a `level` attribute:
 * `pocket` = H1, `hat` = H2, `block` = H3. The topmost pocket in document
 * order is the H1.
 */
import { LoroDoc } from 'loro-crdt';
import { createNodeFromLoroObj } from 'loro-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { decryptBlob } from '../editor/collab/collab-crypto.js';

/** Mirror of collab-session's mark-expansion config. Must be applied
 *  before importing bytes, or text marks decode wrong. Kept local so this
 *  tool doesn't pull in the whole session module. */
function configTextStyle(doc: LoroDoc): void {
  doc.configTextStyle(
    Object.fromEntries(
      Object.entries(schema.marks).map(([name, type]) => [
        name,
        { expand: type.spec.inclusive !== false ? ('after' as const) : ('none' as const) },
      ]),
    ) as never,
  );
}

/**
 * Rebuild the full ProseMirror document from a Loro snapshot (plus any
 * tail update blobs). Blobs are Loro's native export format — the exact
 * bytes the relay stores, once decrypted.
 */
export function docFromLoro(
  snapshot: Uint8Array,
  increments: readonly Uint8Array[] = [],
): PMNode {
  const doc = new LoroDoc();
  configTextStyle(doc);
  doc.importBatch([snapshot, ...increments]);
  return createNodeFromLoroObj(schema, doc.getMap('doc') as never, new Map()) as PMNode;
}

/** The topmost H1 (`pocket`) text of a rebuilt document, or null. */
export function firstHeading(pm: PMNode): string | null {
  let title: string | null = null;
  pm.descendants((node) => {
    if (title !== null) return false; // already found; stop descending
    if (node.type.name === 'pocket') {
      title = node.textContent;
      return false;
    }
    return true;
  });
  return title;
}

/**
 * Rebuild the document from Loro bytes and return the text of the topmost
 * H1, or null if the document has no H1.
 */
export function firstHeadingFromLoro(
  snapshot: Uint8Array,
  increments: readonly Uint8Array[] = [],
): string | null {
  return firstHeading(docFromLoro(snapshot, increments));
}

/** Decrypt sealed room blobs, then rebuild the full document. */
export async function docFromEncrypted(
  key: CryptoKey,
  sealedSnapshot: Uint8Array,
  sealedIncrements: readonly Uint8Array[] = [],
): Promise<PMNode> {
  const snapshot = await decryptBlob(key, sealedSnapshot);
  const increments: Uint8Array[] = [];
  for (const sealed of sealedIncrements) increments.push(await decryptBlob(key, sealed));
  return docFromLoro(snapshot, increments);
}

/**
 * Decrypt sealed room blobs (AES-256-GCM, 12-byte IV ‖ ciphertext+tag —
 * the same envelope collab-crypto seals with) using the room key, then
 * extract the topmost H1. `key` is a WebCrypto AES-GCM CryptoKey imported
 * from the 32 bytes carried in the share code.
 */
export async function firstHeadingFromEncrypted(
  key: CryptoKey,
  sealedSnapshot: Uint8Array,
  sealedIncrements: readonly Uint8Array[] = [],
): Promise<string | null> {
  return firstHeading(await docFromEncrypted(key, sealedSnapshot, sealedIncrements));
}
