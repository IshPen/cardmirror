/// <reference path="./vite-raw.d.ts" />
/**
 * EXPERIMENTAL editable co-editing view for the dashboard.
 *
 * Mounts a real ProseMirror editor, bound to a live CollabSession, inside the
 * viewer iframe (same isolation the read-only viewer uses). Local edits flow
 * back to the room automatically via LoroSyncPlugin → the session's outbound
 * queue. A coach can also drop an inline comment on a selection, which syncs
 * through the same CRDT (students see it in CardMirror, no client change).
 *
 * ⚠️ This WRITES to live student documents. A binding bug can lose work. It is
 * off by default and must be verified with two live clients before real use.
 * Reuses CardMirror's audited modules verbatim (CollabSession, LoroSyncPlugin,
 * comments plugin + collab-comments sync) to keep correctness risk minimal.
 */
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { createNodeFromLoroObj } from 'loro-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import {
  commentsKey,
  commentsPlugin,
  addThreadMeta,
  newCommentId,
  type Thread,
  type Comment,
} from '../../src/editor/comments-plugin.js';
import { installCommentsSync } from '../../src/editor/collab/collab-comments.js';
import EDITOR_CSS from '../../src/editor/style.css?raw';

// Empty editor page (same isolation as the read-only viewer): editor CSS +
// an empty #editor that ProseMirror mounts into. Comment ranges get an amber
// underline so the coach sees where their comments landed.
const EDITOR_PAGE =
  '<!doctype html><html data-theme="light"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<style>' + EDITOR_CSS + '</style>' +
  '<style>html,body{margin:0;background:#fff}' +
  "#editor{max-width:8.5in;margin:0 auto;padding:24px 32px 96px;color:#111;" +
  "font-family:'Calibri','Carlito','Times New Roman','Tinos',serif;--pmd-color-undertag:#555;outline:none}" +
  '.pmd-pocket,.pmd-hat,.pmd-block,.pmd-card,.pmd-analytic-unit{content-visibility:visible}' +
  '.pmd-comment-range{background:color-mix(in srgb,#f59e0b 20%,transparent);border-bottom:2px solid #f59e0b}' +
  '</style></head><body><div id="editor" class="pmd-viewer-doc"></div></body></html>';

export interface EditOpts {
  relayUrl: string;
  token: string;
  roomId: string;
  keyBytes: Uint8Array;
}
export type EditStatus = 'connecting' | 'live' | 'offline' | 'ended' | 'full' | 'error';
export interface EditCallbacks {
  onStatus: (status: EditStatus, detail?: string) => void;
}
export interface EditHandle {
  /** Add an inline comment on the current selection. Returns false if nothing
   *  is selected. The comment syncs to peers through the shared doc. */
  addComment: (text: string) => boolean;
  /** True while text is selected (for enabling the comment control). */
  hasSelection: () => boolean;
  stop: () => Promise<void>;
}

/**
 * Join a room and mount an editable, comment-capable editor into `iframe`.
 * Resolves once mounted (after the initial catch-up). Rejects if the relay is
 * unreachable. The caller owns the iframe element (created empty).
 */
export async function mountEditor(
  iframe: HTMLIFrameElement,
  opts: EditOpts,
  cbs: EditCallbacks,
): Promise<EditHandle> {
  const client = new RoomsClient({
    baseUrl: () => opts.relayUrl.replace(/\/$/, ''),
    token: () => opts.token,
  });
  cbs.onStatus('connecting');

  // Join first (strict catch-up throws if the relay is unreachable).
  const session = await CollabSession.join({
    roomId: opts.roomId,
    keyBytes: opts.keyBytes,
    client,
    callbacks: {
      onStatus: (s) => cbs.onStatus(s.connected ? 'live' : 'offline'),
      onEnded: () => cbs.onStatus('ended'),
      onFull: () => cbs.onStatus('full'),
      onAuthRejected: () => cbs.onStatus('error', 'relay rejected the dashboard token'),
    },
  });

  // Mount the iframe shell, then bind ProseMirror to its #editor element.
  await new Promise<void>((resolve) => {
    iframe.addEventListener('load', () => resolve(), { once: true });
    iframe.srcdoc = EDITOR_PAGE;
  });
  const idoc = iframe.contentDocument;
  const mount = idoc && idoc.getElementById('editor');
  if (!mount) throw new Error('Editor surface failed to mount.');

  const pmNode = createNodeFromLoroObj(schema, session.loroDoc.getMap('doc') as never, new Map()) as PMNode;

  let view: EditorView | null = null;
  const commentSync = installCommentsSync(session.loroDoc, () => view);

  const state = EditorState.create({
    schema,
    doc: pmNode,
    // LoroSyncPlugin MUST be first — it observes every transaction.
    plugins: [...session.plugins(), commentSync.plugin, commentsPlugin, history(), keymap(baseKeymap)],
  });
  view = new EditorView(mount, { state });

  session.start();       // begin streaming + outbound flushing
  commentSync.pull();    // load any existing comment threads from the shared map
  cbs.onStatus('live');

  return {
    hasSelection() { return !!(view && !view.state.selection.empty); },
    addComment(text) {
      if (!view) return false;
      const sel = view.state.selection;
      if (sel.empty) return false;
      const ct = schema.marks['comment_range'];
      if (!ct) return false;
      const threadId = newCommentId();
      const root: Comment = {
        id: threadId,
        author: 'Coach',
        initials: 'C',
        date: new Date().toISOString(),
        text: String(text),
        kind: 'human',
        parentId: null,
      };
      const thread: Thread = { id: threadId, comments: [root] };
      const tr = view.state.tr;
      tr.addMark(sel.from, sel.to, ct.create({ threadId }));
      tr.setMeta(commentsKey, addThreadMeta(thread));
      view.dispatch(tr);
      return true;
    },
    async stop() {
      try { session.flush(); } catch { /* best effort */ }
      try { await session.stop(); } catch { /* already down */ }
      try { commentSync.dispose(); } catch { /* noop */ }
      try { view && view.destroy(); } catch { /* noop */ }
      view = null;
    },
  };
}
