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
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { createNodeFromLoroObj, LoroUndoPlugin, undo, redo } from 'loro-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { setHeading as cmSetHeading, setTag as cmSetTag, clearToNormal as cmClearToNormal } from './structural-commands.js';
import { docOutline, type OutlineItem } from './resolve-name.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import {
  commentsKey,
  commentsPlugin,
  addThreadMeta,
  newCommentId,
  getCommentsState,
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
  "font-family:'Calibri','Carlito','Times New Roman','Tinos',serif;font-size:var(--pmd-size-normal,11pt);" +
  '--pmd-color-undertag:#555;--pmd-emphasis-box-size:1pt;outline:none}' +
  '.pmd-pocket,.pmd-hat,.pmd-block,.pmd-card,.pmd-analytic-unit{content-visibility:visible}' +
  '.pmd-comment-range{background:color-mix(in srgb,#f59e0b 20%,transparent);border-bottom:2px solid #f59e0b}' +
  '</style></head><body><div id="editor" class="pmd-viewer-doc pmd-emphasis-bold pmd-emphasis-box"></div></body></html>';

// Heading/tag conversion + clear-to-plain-text use CardMirror's REAL commands,
// extracted verbatim into structural-commands.ts (ribbon-commands.ts itself
// can't be bundled — it transitively imports @cardcutter/browser). These handle
// every case the app does: doc-level blocks, converting/dissolving a card's
// tag, splitting a card at a body slot, and demoting anything to plain text.

// Inline mark toggles (bold/italic/cite/underline/emphasis/highlight). Safe —
// pure toggleMark, no structure change, works anywhere including inside cards.
// The named-style marks (cite/underline/emphasis) exclude each other in the
// schema, so toggling one clears the others automatically. Simpler than the
// app's context-aware variants (which pick body-vs-structural marks and strip
// direct formatting); the core apply/remove behaviour matches.
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'cyan', 'magenta', 'red', 'blue', 'none'];
function markCommand(name: string, attrs?: Record<string, unknown>): Command {
  const type = schema.marks[name];
  return type ? toggleMark(type, attrs) : () => false;
}
/** Highlight is different from a plain toggle: applying a new colour must
 *  REPLACE any existing highlight on the range (not stack). Remove then add;
 *  'none' just removes. Needs a non-empty selection. */
function highlightCommand(color: string): Command {
  return (state, dispatch) => {
    const type = schema.marks['highlight'];
    if (!type) return false;
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) {
      let tr = state.tr.removeMark(from, to, type);
      if (color !== 'none') tr = tr.addMark(from, to, type.create({ color }));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export interface EditOpts {
  relayUrl: string;
  token: string;
  roomId: string;
  keyBytes: Uint8Array;
}
export type EditStatus = 'connecting' | 'live' | 'offline' | 'ended' | 'full' | 'error';
export interface CommentView {
  id: string;
  author: string;
  text: string;
  date: string;
  /** The text the comment is anchored to (for context in the panel). */
  snippet: string;
}
export interface EditCallbacks {
  onStatus: (status: EditStatus, detail?: string) => void;
  /** Fires with the current heading outline on every doc change (live nav). */
  onOutline?: (outline: OutlineItem[]) => void;
  /** Fires with the current comment threads (for the comments panel). */
  onComments?: (comments: CommentView[]) => void;
}

function collectComments(view: EditorView): CommentView[] {
  const cs = getCommentsState(view.state);
  const ct = schema.marks['comment_range'];
  const out: CommentView[] = [];
  for (const thread of cs.threads.values()) {
    const root = thread.comments[0];
    if (!root) continue;
    let snippet = '';
    if (ct) {
      view.state.doc.descendants((n) => {
        if (snippet.length > 90) return false;
        if (n.isText && n.marks.some((m) => m.type === ct && m.attrs['threadId'] === thread.id)) {
          snippet += n.text || '';
        }
        return true;
      });
    }
    out.push({
      id: thread.id,
      author: root.author || 'Coach',
      text: root.text || '',
      date: root.date || '',
      snippet: snippet.slice(0, 90),
    });
  }
  return out;
}
export type HeadingResult = 'converted' | 'none';
export interface EditHandle {
  /** Add an inline comment on the current selection. Returns false if nothing
   *  is selected. The comment syncs to peers through the shared doc. */
  addComment: (text: string) => boolean;
  /** Convert the cursor's block to a heading (pocket/hat/block) — including
   *  inside cards (dissolve/split), via CardMirror's real setHeading. */
  setHeading: (typeName: string) => HeadingResult;
  /** F7 — wrap the current block into a card+tag (CardMirror's setTag). */
  setTag: () => boolean;
  /** Clear formatting (F12): strip marks + heading→paragraph. */
  clearFormatting: () => boolean;
  /** Toggle an inline mark on the selection (bold/italic/cite_mark/
   *  underline_mark/emphasis_mark). Works inside cards. */
  applyMark: (name: string, attrs?: Record<string, unknown>) => boolean;
  /** Apply/replace a highlight colour on the selection ('none' removes). */
  setHighlight: (color: string) => boolean;
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
      keymap({ 'Mod-b': markCommand('bold'), 'Mod-i': markCommand('italic') }),
      keymap(baseKeymap),
    ],
  });

  const emitOutline = () => { if (view) cbs.onOutline?.(docOutline(view.state.doc)); };
  const emitComments = () => { if (view) cbs.onComments?.(collectComments(view)); };
  view = new EditorView(mount, {
    state,
    dispatchTransaction(tr) {
      if (!view) return;
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) emitOutline();
      // Comments change via edits AND remote sync-load, so emit each tick.
      emitComments();
    },
  });
  emitOutline();  // initial
  emitComments();

  // Direct F-key handling (capture phase, inside the iframe). prosemirror-keymap
  // can miss function keys in a cross-document mount, and the browser reserves
  // several (F5 reload / F7 caret / F11 fullscreen / F12 devtools); dispatching
  // the command here + preventDefault is the reliable path. F12 (devtools) may
  // still win in some browsers — the Clear button covers that.
  const F_COMMANDS: Record<string, () => Command> = {
    F4: () => cmSetHeading('pocket'), F5: () => cmSetHeading('hat'), F6: () => cmSetHeading('block'),
    F7: () => cmSetTag(),
    F8: () => markCommand('cite_mark'), F9: () => markCommand('underline_mark'),
    F10: () => markCommand('emphasis_mark'), F11: () => highlightCommand('yellow'),
    F12: () => cmClearToNormal(),
  };
  try {
    idoc.addEventListener('keydown', (e: KeyboardEvent) => {
      const make = F_COMMANDS[e.key];
      if (!make || !view) return;
      e.preventDefault();
      make()(view.state, view.dispatch.bind(view), view);
    }, true);
  } catch { /* older browsers */ }

  session.start();       // begin streaming + outbound flushing
  commentSync.pull();    // load any existing comment threads from the shared map
  cbs.onStatus('live');

  return {
    hasSelection() { return !!(view && !view.state.selection.empty); },
    setHeading(typeName) {
      if (!view) return 'none';
      const cmd = cmSetHeading(typeName as 'pocket' | 'hat' | 'block');
      const ran = cmd(view.state, view.dispatch.bind(view), view);
      view.focus();
      return ran ? 'converted' : 'none';
    },
    setTag() {
      if (!view) return false;
      const ran = cmSetTag()(view.state, view.dispatch.bind(view), view);
      view.focus();
      return ran;
    },
    clearFormatting() {
      if (!view) return false;
      const ran = cmClearToNormal()(view.state, view.dispatch.bind(view), view);
      view.focus();
      return ran;
    },
    applyMark(name, attrs) {
      if (!view) return false;
      const type = schema.marks[name];
      if (!type) return false;
      const ok = toggleMark(type, attrs)(view.state, view.dispatch.bind(view), view);
      view.focus();
      return ok;
    },
    setHighlight(color) {
      if (!view) return false;
      const ok = highlightCommand(color)(view.state, view.dispatch.bind(view), view);
      view.focus();
      return ok;
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
