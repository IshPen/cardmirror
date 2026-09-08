/**
 * Live room sync for the dashboard viewer (read-only).
 *
 * Keeps a local LoroDoc in step with a live co-editing room so the coach
 * watches edits appear in real time — the same decrypt-and-rebuild pipeline
 * the static viewer uses, driven by the relay's authenticated room stream
 * instead of a one-shot Supabase fetch.
 *
 * Transport is reused verbatim from the app (RoomsClient + RoomStream, which
 * are fetch-based — EventSource can't send the bearer). This module NEVER
 * posts: it only catches up and applies inbound updates, so it cannot alter a
 * student's document. Editing (write-back) is a separate, opt-in path built on
 * CollabSession — deliberately not wired here.
 *
 * Bundled (Vite) with loro-crdt's WASM; must be SERVED over http(s).
 */
import { LoroDoc } from 'loro-crdt';
import { createNodeFromLoroObj } from 'loro-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { importRoomKey, decryptBlob } from '../../src/editor/collab/collab-crypto.js';
import { RoomsClient, RoomStream } from '../../src/editor/collab/room-client.js';
import { docToHtml, renderDocument, docOutline, type OutlineItem } from './resolve-name.js';

/** Mirror of collab-session's mark-expansion config — MUST be applied before
 *  importing bytes or text marks decode wrong (identical to the app's). */
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

export interface LiveOpts {
  /** Relay base URL including the `/relay` prefix. */
  relayUrl: string;
  /** A relay bearer (the dashboard's own token). */
  token: string;
  roomId: string;
  /** 32-byte room key (share-code segment three). */
  keyBytes: Uint8Array;
}

export interface LiveSnapshot {
  /** Full self-contained iframe page (first render). */
  page: string;
  /** Bare content fragment (subsequent in-place updates — preserves scroll). */
  fragment: string;
  outline: OutlineItem[];
  title: string | null;
  /** True on the very first emit (caller sets srcdoc; later emits swap the
   *  #editor innerHTML in place so the iframe doesn't reload). */
  first: boolean;
}

export type LiveStatus = 'connecting' | 'live' | 'offline' | 'ended' | 'full' | 'error';

export interface LiveCallbacks {
  onDoc: (snap: LiveSnapshot) => void;
  onStatus: (status: LiveStatus, detail?: string) => void;
}

export interface LiveHandle {
  stop: () => void;
}

function firstPocket(node: PMNode): string | null {
  let title: string | null = null;
  node.descendants((n) => {
    if (title !== null) return false;
    if (n.type.name === 'pocket') { title = n.textContent; return false; }
    return true;
  });
  return title;
}

/**
 * Join a live room read-only. Resolves once the initial state is loaded (the
 * first onDoc has fired); keeps streaming until `stop()`. Rejects if the
 * initial catch-up can't reach the relay (bad token / URL / asleep).
 */
export async function startLiveRoom(opts: LiveOpts, cbs: LiveCallbacks): Promise<LiveHandle> {
  const key = await importRoomKey(opts.keyBytes);
  const doc = new LoroDoc();
  configTextStyle(doc);

  const client = new RoomsClient({
    baseUrl: () => opts.relayUrl.replace(/\/$/, ''),
    token: () => opts.token,
  });

  let lastSeq = 0;
  let haveSnap = 0;
  let firstEmitted = false;
  let stopped = false;

  async function applySealed(sealed: Uint8Array): Promise<void> {
    doc.importBatch([await decryptBlob(key, sealed)]);
  }

  function emit(): void {
    if (stopped) return;
    const node = createNodeFromLoroObj(schema, doc.getMap('doc') as never, new Map()) as PMNode;
    const fragment = docToHtml(node);
    cbs.onDoc({
      page: firstEmitted ? '' : renderDocument(node),
      fragment,
      outline: docOutline(node),
      title: firstPocket(node),
      first: !firstEmitted,
    });
    firstEmitted = true;
  }

  // One catch-up pass (snapshot + tail), paging until drained.
  async function catchUp(): Promise<void> {
    for (;;) {
      const res = await client.fetchUpdates(opts.roomId, lastSeq, { haveSnap });
      if (res.snapshot) {
        await applySealed(res.snapshot.blob);
        haveSnap = res.snapshot.coversThroughSeq;
      } else if (res.snapCovers > haveSnap) {
        haveSnap = res.snapCovers;
      }
      for (const u of res.updates) await applySealed(u.blob);
      lastSeq = res.lastSeq;
      if (!res.more) break;
    }
  }

  cbs.onStatus('connecting');
  await catchUp(); // strict: a join that can't reach the relay must throw
  emit();

  const stream = new RoomStream({
    baseUrl: () => opts.relayUrl.replace(/\/$/, ''),
    token: () => opts.token,
    roomId: opts.roomId,
    callbacks: {
      onHello: () => {
        cbs.onStatus('live');
        // Heal any frames shed before the stream attached.
        void catchUp().then(emit).catch(() => {});
      },
      onUpdate: (u) => {
        void (async () => {
          try {
            if (u.seq > lastSeq) lastSeq = u.seq;
            await applySealed(u.blob);
            emit();
          } catch { /* undecryptable/duplicate frame — next catch-up heals it */ }
        })();
      },
      onPresence: () => { /* cursors not shown in read-only view */ },
      onDown: () => cbs.onStatus('offline'),
      onEnded: () => { cbs.onStatus('ended'); },
      onFull: () => cbs.onStatus('full'),
    },
  });
  stream.start();

  return {
    stop() {
      stopped = true;
      stream.stop();
    },
  };
}
