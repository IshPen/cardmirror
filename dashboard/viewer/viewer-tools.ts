/**
 * Viewer tools bundled for the dashboard: document export (.docx), a
 * "back up everything" zip, and a version-history scrubber.
 *
 * All run in the coach's browser on rooms the dashboard holds a key for.
 * Export reuses CardMirror's own `toDocx` (pure TS, fflate). History reads the
 * ordered, timestamped update log (Supabase anon, ciphertext) and rebuilds the
 * document as of any point. Read-only throughout — nothing is written back.
 */
import { LoroDoc } from 'loro-crdt';
import { createNodeFromLoroObj } from 'loro-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { zipSync, strToU8 } from 'fflate';
import { schema } from '../../src/schema/index.js';
import { importRoomKey, base64ToBytes, decryptBlob } from '../../src/editor/collab/collab-crypto.js';
import { toDocx } from '../../src/export/index.js';
import { getRoomNode, docToHtml, renderDocument, docOutline, type OutlineItem, type ResolveOpts } from './resolve-name.js';

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

function safeName(s: string): string {
  return (s || 'document').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
}

/** Rebuild a room and serialize it to .docx bytes. */
export async function roomToDocx(opts: ResolveOpts): Promise<Uint8Array> {
  const node = await getRoomNode(opts);
  if (!node) throw new Error('Room has no content to export.');
  return toDocx(node);
}

/** Trigger a browser download of a blob. */
function download(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Export one room straight to a downloaded .docx. */
export async function downloadRoomDocx(opts: ResolveOpts, title: string | null): Promise<void> {
  download(await roomToDocx(opts), safeName(title || 'document') + '.docx', DOCX_MIME);
}

export interface BackupEntry { opts: ResolveOpts; title: string | null; }
export interface BackupProgress { done: number; total: number; name: string; ok: boolean; error?: string; }

/**
 * Export every given room to .docx and download a single .zip. `onProgress`
 * reports each doc as it finishes; failed rooms are skipped (reported, not
 * fatal) so one bad key doesn't sink the whole backup.
 */
export async function backupAllDocx(
  entries: BackupEntry[],
  stampYmd: string,
  onProgress?: (p: BackupProgress) => void,
): Promise<{ ok: number; failed: number }> {
  const files: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  let ok = 0, failed = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    let base = safeName(e.title || `room-${i + 1}`);
    let name = base + '.docx';
    let n = 2;
    while (usedNames.has(name)) name = `${base} (${n++}).docx`;
    usedNames.add(name);
    try {
      files[name] = await roomToDocx(e.opts);
      ok++;
      onProgress?.({ done: i + 1, total: entries.length, name, ok: true });
    } catch (err) {
      failed++;
      onProgress?.({ done: i + 1, total: entries.length, name, ok: false, error: String((err as Error).message || err) });
    }
  }
  if (ok === 0) throw new Error('Nothing could be exported (no readable rooms).');
  // A tiny manifest so the folder is self-describing.
  files['_manifest.txt'] = strToU8(
    `Debate Relay backup ${stampYmd}\n${ok} document(s) exported, ${failed} skipped.\n`,
  );
  const zipped = zipSync(files, { level: 6 });
  download(zipped, `debate-relay-backup-${stampYmd}.zip`, 'application/zip');
  return { ok, failed };
}

// ── Version history ──────────────────────────────────────────────────
interface HistRow { blob: string; created_at?: string }

async function sbRows(url: string, anonKey: string, pathAndQuery: string): Promise<HistRow[]> {
  const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/' + pathAndQuery, {
    headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

export interface HistoryStep {
  page: string;      // full iframe page for this revision
  fragment: string;  // #editor innerHTML (in-place swap)
  title: string | null;
  outline: OutlineItem[];
}

export interface RoomHistory {
  /** Number of scrub positions (0 = seed/compacted state, then one per update). */
  count: number;
  /** ISO timestamps per position ('' for the seed). */
  times: string[];
  /** Rebuild the document as of position `index` (0..count-1). */
  at: (index: number) => HistoryStep;
}

/**
 * Load a room's full history for scrubbing. Decrypts the snapshot + every
 * update once, then `at(i)` rebuilds the doc from the seed plus the first `i`
 * updates. Requires enable-viewer.sql (anon read of the ciphertext tables).
 */
export async function loadHistory(opts: ResolveOpts): Promise<RoomHistory> {
  const key = await importRoomKey(opts.keyBytes);
  const id = encodeURIComponent(opts.roomId);
  const [snapRows, updRows] = await Promise.all([
    sbRows(opts.supabaseUrl, opts.anonKey, `relay_room_snapshots?room_id=eq.${id}&select=blob`),
    sbRows(opts.supabaseUrl, opts.anonKey, `relay_room_updates?room_id=eq.${id}&select=blob,created_at&order=id.asc`),
  ]);
  // Seed = snapshot if present, else the first update.
  const seedSealed = snapRows.length ? base64ToBytes(snapRows[0]!.blob)
    : updRows.length ? base64ToBytes(updRows[0]!.blob) : null;
  if (!seedSealed) throw new Error('Room has no history yet.');
  const tailRows = snapRows.length ? updRows : updRows.slice(1);

  const seed = await decryptBlob(key, seedSealed);
  const tail: Uint8Array[] = [];
  for (const r of tailRows) tail.push(await decryptBlob(key, base64ToBytes(r.blob)));

  const times = ['', ...tailRows.map((r) => r.created_at || '')];
  const count = tail.length + 1;

  const at = (index: number): HistoryStep => {
    const i = Math.max(0, Math.min(count - 1, index));
    const doc = new LoroDoc();
    configTextStyle(doc);
    doc.importBatch([seed, ...tail.slice(0, i)]);
    const node = createNodeFromLoroObj(schema, doc.getMap('doc') as never, new Map()) as PMNode;
    let title: string | null = null;
    node.descendants((n) => { if (title !== null) return false; if (n.type.name === 'pocket') { title = n.textContent; return false; } return true; });
    return { page: renderDocument(node), fragment: docToHtml(node), title, outline: docOutline(node) };
  };

  return { count, times, at };
}
