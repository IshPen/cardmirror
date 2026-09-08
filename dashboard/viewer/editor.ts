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
import { EditorState, type Command, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { createNodeFromLoroObj, LoroUndoPlugin, undo, redo } from 'loro-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { newHeadingId } from '../../src/schema/ids.js';
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

// Convert the cursor's DOC-LEVEL block to a heading (Pocket/Hat/Block) — the
// common outline case of CardMirror's setHeading, replicated so we don't bundle
// the app-coupled ribbon-commands (it pulls the whole editor + card cutter).
// Only doc-level blocks convert (a no-op INSIDE a card — tag/card-body
// conversion is card structural surgery, a later batch).
const DOC_LEVEL_CONVERTIBLE = ['paragraph', 'cite_paragraph', 'undertag', 'card_body', 'pocket', 'hat', 'block'];
const DOC_HEADINGS = ['pocket', 'hat', 'block'];
/** Returns a conversion transaction, or null when the cursor's doc-level block
 *  can't become `typeName` (already is, or is inside a card). */
function headingTr(state: EditorState, typeName: string): Transaction | null {
  const { $from } = state.selection;
  const node = $from.depth >= 1 ? $from.node(1) : null; // direct child of doc
  if (!node || !DOC_LEVEL_CONVERTIBLE.includes(node.type.name) || node.type.name === typeName) return null;
  const target = schema.nodes[typeName];
  if (!target) return null;
  const id = DOC_HEADINGS.includes(node.type.name)
    ? ((node.attrs['id'] as string | null) ?? newHeadingId())
    : newHeadingId();
  return state.tr.setNodeMarkup($from.before(1), target, { id }).scrollIntoView();
}
/** Keymap form: converts when possible, ALWAYS claims the key so the browser
 *  doesn't act on F4–F6 (e.g. F5 reload) while the editor is focused. */
function setDocHeading(typeName: string): Command {
  return (state, dispatch) => {
    const tr = headingTr(state, typeName);
    if (tr && dispatch) dispatch(tr);
    return true;
  };
}

/** Clear formatting (F12): strip all inline marks across the selection (or the
 *  cursor's block) AND convert a doc-level heading back to a plain paragraph —
 *  CardMirror's "clear back to plain text". Marks are stripped even inside a
 *  card; the heading→paragraph part is doc-level only. */
function clearFormattingTr(state: EditorState): Transaction | null {
  const sel = state.selection;
  const $from = sel.$from;
  let tr = state.tr;
  let changed = false;
  const mFrom = sel.empty ? $from.start($from.depth) : sel.from;
  const mTo = sel.empty ? $from.end($from.depth) : sel.to;
  if (mTo > mFrom) { tr = tr.removeMark(mFrom, mTo, null); changed = true; }
  const node = $from.depth >= 1 ? $from.node(1) : null;
  const para = schema.nodes['paragraph'];
  if (node && DOC_HEADINGS.includes(node.type.name) && para) {
    tr = tr.setNodeMarkup($from.before(1), para, {});
    changed = true;
  }
  return changed ? tr.scrollIntoView() : null;
}
function clearFormattingCmd(): Command {
  return (state, dispatch) => {
    const tr = clearFormattingTr(state);
    if (tr && dispatch) dispatch(tr);
    return true; // claim F12
  };
}

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
export type HeadingResult = 'converted' | 'already' | 'in-card' | 'none';
export interface EditHandle {
  /** Add an inline comment on the current selection. Returns false if nothing
   *  is selected. The comment syncs to peers through the shared doc. */
  addComment: (text: string) => boolean;
  /** Convert the cursor's doc-level block to a heading (pocket/hat/block).
   *  Reports what happened so the UI can explain (e.g. 'in-card'). */
  setHeading: (typeName: string) => HeadingResult;
  /** Clear formatting (F12): strip marks + heading→paragraph. */
  clearFormatting: () => boolean;
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
    // LoroSyncPlugin MUST be first — it observes every transaction. Undo/redo
    // uses Loro's CRDT undo manager (reverts only THIS peer's edits — plain
    // prosemirror-history is unsafe once remote edits interleave), matching the
    // app's collab keymap. Heading F-keys run before baseKeymap.
    plugins: [
      ...session.plugins(),
      LoroUndoPlugin({ doc: session.loroDoc }),
      commentSync.plugin,
      commentsPlugin,
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      keymap({
        F4: setDocHeading('pocket'), F5: setDocHeading('hat'), F6: setDocHeading('block'),
        F12: clearFormattingCmd(),
      }),
      keymap(baseKeymap),
    ],
  });
  view = new EditorView(mount, { state });

  // Some F-keys are browser-reserved (F5 reload, F7 caret) and would fire
  // before ProseMirror's keymap. Claim F4–F7 at capture phase inside the
  // iframe so the editor's bindings win; propagation still reaches PM.
  try {
    idoc.addEventListener('keydown', (e: KeyboardEvent) => {
      if (/^F([4-7]|12)$/.test(e.key)) e.preventDefault();
    }, true);
  } catch { /* older browsers */ }

  session.start();       // begin streaming + outbound flushing
  commentSync.pull();    // load any existing comment threads from the shared map
  cbs.onStatus('live');

  return {
    hasSelection() { return !!(view && !view.state.selection.empty); },
    setHeading(typeName) {
      if (!view) return 'none';
      const { $from } = view.state.selection;
      const node = $from.depth >= 1 ? $from.node(1) : null;
      if (!node) return 'none';
      if (node.type.name === typeName) return 'already';
      if (!DOC_LEVEL_CONVERTIBLE.includes(node.type.name)) return 'in-card';
      const tr = headingTr(view.state, typeName);
      if (!tr) return 'none';
      view.dispatch(tr);
      view.focus();
      return 'converted';
    },
    clearFormatting() {
      if (!view) return false;
      const tr = clearFormattingTr(view.state);
      if (!tr) return false;
      view.dispatch(tr);
      view.focus();
      return true;
    },
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
