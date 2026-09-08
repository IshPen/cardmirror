/**
 * Structural heading / tag commands — EXTRACTED verbatim from
 * `src/editor/ribbon-commands.ts` so the dashboard viewer bundle can use them
 * without pulling in `ribbon-commands.ts`'s heavy transitive imports (settings,
 * toast, host, transclusion, card-cutter, `@cardcutter/browser`, ...).
 *
 * The transforms themselves are pure ProseMirror. Only two branches present in
 * the original are stubbed here, because the dashboard editor has NO
 * transclusion zones and NO right-click "select similar" shadow selection:
 *
 *   - `blockedByZoneLevel(...)`            → `return false;`  (no zones)
 *   - `bulkReapplyStructuralOnShadow(...)` → `return false;`  (no shadow sel)
 *   - `bulkReplaceStructuralOnShadow(...)` → `return false;`  (no shadow sel)
 *
 * `structuralBaseDepth` and `isZoneBottomBreakout` are pure and kept as-is;
 * they harmlessly return 0 / false when there's no `transclusion_ref`.
 *
 * Everything else is copied byte-for-byte from the source to preserve behavior.
 */

import { Fragment, type Node as PMNode, type ResolvedPos, type MarkType } from 'prosemirror-model';
import {
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import { newHeadingId } from '../../src/schema/ids.js';

type HeadingTypeName = 'pocket' | 'hat' | 'block';

const DOC_HEADINGS = new Set<string>(['pocket', 'hat', 'block']);
const CONTAINER_HEAD = new Set<string>(['tag', 'analytic']);
/** Body-slot textblocks that can appear as non-head children of a
 *  card or analytic_unit. When the cursor is in one of these and
 *  the user invokes a heading hotkey (F4-F7 / Mod-F7), the command
 *  splits the surrounding container at that body slot — the slot
 *  becomes the new heading; preceding body slots stay in the
 *  original container; following body slots lift out. */
const SPLITTABLE_BODY_SLOTS = new Set<string>(['card_body', 'cite_paragraph', 'undertag']);

/** Textblock types whose doc-level instances can be converted to
 *  a heading / tag / analytic / undertag in place. Body slots
 *  (cite_paragraph, undertag, card_body) can legally appear at doc
 *  level (per the schema's BLOCK_CONTENT) — e.g., after a card
 *  dissolve lifts them out — and the heading hotkeys should treat
 *  them like a plain paragraph. */
const DOC_LEVEL_CONVERTIBLE = new Set<string>([
  'paragraph',
  'cite_paragraph',
  'undertag',
  'card_body',
  'pocket',
  'hat',
  'block',
]);

/** Direct-formatting marks. Stripped when F8/F9/F10 ADD a named
 *  style — the named style's typography (cite 13pt bold, underline
 *  style, emphasis decorations) replaces direct overrides. F9 also
 *  strips these on toggle-off when
 *  `clearFormattingOnNamedStyleToggleOff` is true (Verbatim parity
 *  for "press F9 twice to clear formatting").
 *
 *  `underline_direct` is intentionally NOT in this set even though
 *  it IS technically direct formatting: F9's apply pass writes
 *  underline_direct for structural-block segments, so this strip
 *  must not run in the same pass or it would erase the just-added
 *  mark. F9's toggle-off pass removes underline_direct explicitly
 *  via `tr.removeMark(..., directMark)` so it's still cleared.
 *  Promotion strips (F4–F7) include underline_direct explicitly
 *  through `PROMOTION_STRIP_MARK_NAMES`.
 *
 *  `link` is excluded — semantic content, not formatting. */
const DIRECT_FORMATTING_MARK_NAMES = [
  'font_size',
  'font_color',
  'font_family',
  'bold',
  // The structural-bold override (a word unbolded inside a tag/heading).
  // Clearing direct formatting or promoting text restores the block's
  // default bold, so it belongs here alongside `bold`.
  'bold_off',
  'italic',
  'strikethrough',
  'highlight',
  'shading',
] as const;

/** All marks stripped when body text is promoted into a structural
 *  block (F4–F7 / Mod-F7 / Mod-F8). The structural block's own
 *  typography applies — named-style marks (cite_mark / underline_mark
 *  / emphasis_mark / undertag_mark / analytic_mark) and any direct
 *  formatting lose meaning. `link` is preserved (semantic content);
 *  `pilcrow_marker` is also preserved (post-condense markers shouldn't
 *  silently vanish when their paragraph is restyled). */
const PROMOTION_STRIP_MARK_NAMES = [
  ...DIRECT_FORMATTING_MARK_NAMES,
  'underline_direct',
  'cite_mark',
  'underline_mark',
  'emphasis_mark',
  'undertag_mark',
  'analytic_mark',
] as const;
const PROMOTION_STRIP_SET = new Set<string>(PROMOTION_STRIP_MARK_NAMES);

function stripPromotionMarksOnTr(
  tr: Transaction,
  from: number,
  to: number,
): void {
  for (const name of PROMOTION_STRIP_MARK_NAMES) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

/** Strip promotion-affected marks from every text/inline node in a
 *  fragment, returning a new fragment. Use this when building NEW
 *  structural nodes from existing body content (e.g., wrapping a
 *  paragraph in a card+tag — the tag should get clean content). */
function stripPromotionMarksOnFragment(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    const newMarks = child.marks.filter((m) => !PROMOTION_STRIP_SET.has(m.type.name));
    out.push(child.mark(newMarks));
  });
  return Fragment.fromArray(out);
}

/** Direct character-formatting marks cleared when a structural style is
 *  re-pressed on a block that's already that type — resetting it toward the
 *  style's canonical look. `indent` is reset alongside these; `spacing` is
 *  intentionally preserved. */
const REAPPLY_CLEAR_MARK_NAMES = ['font_size', 'font_color'] as const;

/** Mark types for `REAPPLY_CLEAR_MARK_NAMES` that exist in the schema. */
function reapplyClearMarkTypes(): MarkType[] {
  return REAPPLY_CLEAR_MARK_NAMES.map((n) => schema.marks[n]).filter(
    (m): m is MarkType => !!m,
  );
}

/** Return a copy of a textblock with its `indent` attr reset to 0 and every
 *  direct font-size / font-color mark stripped from its inline content (type,
 *  spacing, and other attrs preserved). Returns the same node reference when
 *  nothing changes, so callers can cheaply detect a no-op. */
function clearReapplyFormatting(node: PMNode): PMNode {
  const markTypes = reapplyClearMarkTypes();
  let contentChanged = false;
  const out: PMNode[] = [];
  node.content.forEach((inline) => {
    let marks = inline.marks;
    for (const mt of markTypes) if (mt.isInSet(marks)) marks = mt.removeFromSet(marks);
    if (marks !== inline.marks) {
      contentChanged = true;
      out.push(inline.mark(marks));
    } else {
      out.push(inline);
    }
  });
  const indentChanged = (node.attrs['indent'] ?? 0) !== 0;
  if (!contentChanged && !indentChanged) return node;
  const attrs = indentChanged ? { ...node.attrs, indent: 0 } : node.attrs;
  return node.type.create(
    attrs,
    contentChanged ? Fragment.fromArray(out) : node.content,
    node.marks,
  );
}

/**
 * Bulk same-type re-press over a right-click "select all of this style"
 * shadow selection. STUBBED for the dashboard viewer: there is no shadow
 * selection here, so this never fires — the caller falls through to the
 * normal cursor / selection logic.
 */
function bulkReapplyStructuralOnShadow(
  _state: EditorState,
  _dispatch: ((tr: Transaction) => void) | undefined,
  _targetType: string,
): boolean {
  return false;
}

/**
 * Depth of the enclosing live zone (`transclusion_ref`), or 0 at the real doc
 * level. A zone is structurally a mini-doc (same BLOCK_CONTENT), so the
 * structural commands measure their `depth === 1/2` gates and their
 * `before/after/node/index(...)` math relative to this base — behaving
 * identically inside a zone as at the doc root, with new headings/cards landing
 * INSIDE the zone. base 0 → unchanged doc-level behavior.
 */
function structuralBaseDepth($from: ResolvedPos): number {
  for (let d = 1; d <= $from.depth; d++) {
    if ($from.node(d).type.name === 'transclusion_ref') return d;
  }
  return 0;
}

/**
 * True when the cursor is at the very END of a live zone's LAST content — the
 * end of the last body of the zone's last card / analytic_unit. A structural
 * heading key there BREAKS OUT: the new head/card lands after the zone
 * (splitContainerAtBody), cutting off the section, and the level ceiling is
 * exempt (the heading is leaving the zone). Anywhere else, the key stays in.
 */
function isZoneBottomBreakout($from: ResolvedPos, base: number): boolean {
  if (base === 0) return false;
  if ($from.depth !== base + 2) return false; // a body inside a container in the zone
  if (!SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false; // at the body's end
  const zone = $from.node(base);
  const container = $from.node(base + 1);
  return (
    $from.index(base) === zone.childCount - 1 && // container is the zone's last child
    $from.index(base + 1) === container.childCount - 1 // body is the container's last
  );
}

/**
 * Inside a live zone, refuse to create a heading higher-rank than the zone's
 * highest existing heading. STUBBED for the dashboard viewer: there are no
 * live zones, so nothing is ever blocked.
 */
function blockedByZoneLevel(
  _$from: ResolvedPos,
  _base: number,
  _newType: string,
  _view: EditorView | undefined,
): boolean {
  return false;
}

function stripIndentAtDepth(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  depth: number,
): boolean {
  if (!dispatch) return true;
  const $from = state.selection.$from;
  const node = $from.node(depth);
  const pos = $from.before(depth);
  let tr = state.tr;
  if ((node.attrs['indent'] ?? 0) !== 0) {
    tr = tr.setNodeMarkup(pos, null, { ...node.attrs, indent: 0 });
  }
  const start = pos + 1;
  const end = start + node.content.size;
  for (const mt of reapplyClearMarkTypes()) tr = tr.removeMark(start, end, mt);
  // No-op (already canonical): consume the key without dispatching an empty
  // transaction that would burn an undo step.
  if (!tr.docChanged) return true;
  dispatch(tr);
  return true;
}

/**
 * F4 / F5 / F6 — convert the current paragraph or heading to the target
 * doc-level heading type.
 */
export function setHeading(typeName: HeadingTypeName): Command {
  return (state, dispatch, view) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, {
        mode: 'heading',
        headingType: typeName,
      });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, typeName)) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'heading', headingType: typeName })) return true;
    const $from = state.selection.$from;
    const base = structuralBaseDepth($from);
    // A live zone can't gain a heading that outranks its highest — block F4–F6
    // for pocket/hat/block above the zone's ceiling (cards are always fine). A
    // bottom-edge break-out is exempt: that heading lands OUTSIDE the zone.
    if (!isZoneBottomBreakout($from, base) && blockedByZoneLevel($from, base, typeName, view)) {
      return true;
    }

    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname === typeName) {
        return stripIndentAtDepth(state, dispatch, base + 1);
      }
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      // Preserve the existing id when converting between heading
      // types (pocket↔hat↔block); body slots get a fresh id.
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      const tr = state.tr.setNodeMarkup(
        $from.before(base + 1),
        schema.nodes[typeName]!,
        { id },
      );
      // The promoted heading takes its identity from the structural
      // type's CSS, so any prior named-style / direct formatting marks
      // on the source content are stripped.
      const contentFrom = $from.before(base + 1) + 1;
      const contentTo = contentFrom + parent.content.size;
      stripPromotionMarksOnTr(tr, contentFrom, contentTo);
      dispatch(tr.scrollIntoView());
      return true;
    }

    if ($from.depth === base + 2 && CONTAINER_HEAD.has($from.parent.type.name)) {
      return dissolveContainerToHeading(state, dispatch, typeName);
    }

    if ($from.depth === base + 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
      return splitContainerAtBody(state, dispatch, { mode: 'heading', headingType: typeName });
    }

    return false;
  };
}

/**
 * F7 — convert the current paragraph or heading to a tag, wrapping in
 * a card. On an analytic-anchor, convert the analytic_unit to a card.
 */
export function setTag(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'tag' });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, 'tag')) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'tag' })) return true;
    const $from = state.selection.$from;

    const base = structuralBaseDepth($from);
    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      // Strip promotion-affected marks from the source content before
      // wrapping it — body-only named-style marks and direct overrides
      // don't belong on a tag's text.
      const cleanContent = stripPromotionMarksOnFragment(parent.content);
      const tagNode = schema.nodes['tag']!.create({ id }, cleanContent);
      const cardNode = schema.nodes['card']!.create(null, [tagNode]);
      const from = $from.before(base + 1);
      const to = $from.after(base + 1);
      let tr = state.tr.replaceWith(from, to, cardNode);
      // After replace: parent → card@from → tag@(from+1) → content@(from+2)
      const cursorPos = from + 2 + Math.min($from.parentOffset, parent.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      // No scrollIntoView — wrapping in a card adds vertical chrome
      // (tag margin + card padding), so following the new selection
      // produces a jarring viewport scroll even when the cursor is
      // already visible. F4–F6 use setNodeMarkup and don't shift
      // layout, so their behavior matches without explicit suppression.
      dispatch(tr);
      return true;
    }

    if ($from.depth === base + 2 && $from.parent.type.name === 'tag') {
      return stripIndentAtDepth(state, dispatch, base + 2);
    }

    if (
      $from.depth === base + 2 &&
      $from.parent.type.name === 'analytic' &&
      $from.node(base + 1).type.name === 'analytic_unit' &&
      $from.node(base + 1).firstChild === $from.parent
    ) {
      return convertAnalyticUnitToCard(state, dispatch);
    }

    if ($from.depth === base + 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
      return splitContainerAtBody(state, dispatch, { mode: 'tag' });
    }

    return false;
  };
}

/**
 * Mod-F7 — same as F7 but produces analytic_unit / analytic instead of
 * card / tag. cite_paragraph and analytic following children get folded
 * into card_body (text preserved, custom type lost) because analytic_unit
 * only allows analytic + (card_body | undertag)*.
 */
export function setAnalytic(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'analytic' });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, 'analytic')) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'analytic' })) return true;
    const $from = state.selection.$from;

    const base = structuralBaseDepth($from);
    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      const cleanContent = stripPromotionMarksOnFragment(parent.content);
      const analyticNode = schema.nodes['analytic']!.create({ id }, cleanContent);
      const unitNode = schema.nodes['analytic_unit']!.create(null, [analyticNode]);
      const from = $from.before(base + 1);
      const to = $from.after(base + 1);
      let tr = state.tr.replaceWith(from, to, unitNode);
      // parent → analytic_unit@from → analytic@(from+1) → content@(from+2)
      const cursorPos = from + 2 + Math.min($from.parentOffset, parent.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      dispatch(tr);
      return true;
    }

    if (
      $from.depth === base + 2 &&
      $from.parent.type.name === 'analytic' &&
      $from.node(base + 1).type.name === 'analytic_unit' &&
      $from.node(base + 1).firstChild === $from.parent
    ) {
      return stripIndentAtDepth(state, dispatch, base + 2);
    }

    if (
      $from.depth === base + 2 &&
      $from.parent.type.name === 'tag' &&
      $from.node(base + 1).type.name === 'card' &&
      $from.node(base + 1).firstChild === $from.parent
    ) {
      return convertCardToAnalyticUnit(state, dispatch);
    }

    if ($from.depth === base + 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
      return splitContainerAtBody(state, dispatch, { mode: 'analytic' });
    }

    return false;
  };
}

/**
 * Mod-F8 — convert the current paragraph to an undertag.
 *
 * Undertag is a body-level type (no outline level, no id) that's
 * valid both at doc root and inside card / analytic_unit. So unlike
 * setTag/setAnalytic, cursors inside card_body / cite_paragraph
 * stay in place: just the node type changes, the card structure is
 * preserved. Cursors at a tag or analytic anchor still dissolve
 * the surrounding container, since [undertag, …] isn't valid as
 * card / analytic_unit content.
 */
export function setUndertag(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'undertag' });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, 'undertag')) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'undertag' })) return true;
    const $from = state.selection.$from;

    const base = structuralBaseDepth($from);
    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname === 'undertag') return stripIndentAtDepth(state, dispatch, base + 1);
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const tr = state.tr.setNodeMarkup(
        $from.before(base + 1),
        schema.nodes['undertag']!,
        null,
      );
      const contentFrom = $from.before(base + 1) + 1;
      const contentTo = contentFrom + parent.content.size;
      stripPromotionMarksOnTr(tr, contentFrom, contentTo);
      dispatch(tr.scrollIntoView());
      return true;
    }

    if ($from.depth === base + 2) {
      const pname = $from.parent.type.name;
      if (pname === 'undertag') return stripIndentAtDepth(state, dispatch, base + 2);
      if (pname === 'card_body' || pname === 'cite_paragraph') {
        if (!dispatch) return true;
        const parent = $from.parent;
        const tr = state.tr.setNodeMarkup(
          $from.before(base + 2),
          schema.nodes['undertag']!,
          null,
        );
        const contentFrom = $from.before(base + 2) + 1;
        const contentTo = contentFrom + parent.content.size;
        stripPromotionMarksOnTr(tr, contentFrom, contentTo);
        dispatch(tr.scrollIntoView());
        return true;
      }
      if (pname === 'tag' || pname === 'analytic') {
        return dissolveContainerToUndertag(state, dispatch);
      }
    }

    return false;
  };
}

function dissolveContainerToUndertag(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const head = $from.parent;
  const container = $from.node(base + 1);
  if (container.firstChild !== head) return false;
  if (container.type.name === 'card' && head.type.name !== 'tag') return false;
  if (container.type.name === 'analytic_unit' && head.type.name !== 'analytic') return false;
  if (!dispatch) return true;

  const undertagNode = schema.nodes['undertag']!.create(
    null,
    stripPromotionMarksOnFragment(head.content),
  );
  const nonHeadChildren: PMNode[] = [];
  container.forEach((child, _offset, index) => {
    if (index === 0) return;
    nonHeadChildren.push(child);
  });

  const containerStart = $from.before(base + 1);
  const containerEnd = $from.after(base + 1);

  // If the previous sibling (in the doc or the enclosing zone) is the same
  // container type, absorb [undertag, ...non-head children] into it. Card and
  // analytic_unit both accept undertag in their content, and the non-head
  // children are already valid content, so no per-child rewriting is needed.
  const containerIndex = $from.index(base);
  if (containerIndex > 0) {
    const prev = $from.node(base).child(containerIndex - 1);
    if (prev.type.name === container.type.name) {
      const prevStart = containerStart - prev.nodeSize;
      const newPrev = prev.copy(
        prev.content.append(Fragment.fromArray([undertagNode, ...nonHeadChildren])),
      );
      let tr = state.tr.replaceWith(prevStart, containerEnd, newPrev);
      const cursorPos =
        prevStart + 1 + prev.content.size + 1 +
        Math.min($from.parentOffset, head.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      dispatch(tr.scrollIntoView());
      return true;
    }
  }

  const lifted: PMNode[] = [undertagNode, ...nonHeadChildren.map(liftCardChild)];
  let tr = state.tr.replaceWith(
    containerStart,
    containerEnd,
    Fragment.fromArray(lifted),
  );
  const cursorPos = containerStart + 1 + Math.min($from.parentOffset, head.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Pure node transform: a `card` → the equivalent `analytic_unit`. Tag →
 *  analytic is a same-tier swap (same structural role, just cite/analytic
 *  semantic) so direct formatting on the head is preserved; the card's body
 *  slots map into valid analytic_unit content via `toAnalyticUnitChild`.
 *  Shared by the cursor command and the shadow bulk-replace so both keep the
 *  container intact (rather than dissolving it). */
function cardToAnalyticUnitNode(card: PMNode): PMNode {
  const tag = card.firstChild!;
  const id = (tag.attrs['id'] as string | null) ?? newHeadingId();
  const analyticNode = schema.nodes['analytic']!.create({ id }, tag.content);
  const rest: PMNode[] = [];
  card.forEach((child, _offset, index) => {
    if (index === 0) return;
    rest.push(toAnalyticUnitChild(child));
  });
  // Carry the numbering skeleton (numRole/numRestart) across the swap —
  // card and analytic_unit share the same attr set, and a tag↔analytic
  // restyle must not silently strip a card's number (field bug 2026-07-15).
  return schema.nodes['analytic_unit']!.create(card.attrs, [analyticNode, ...rest]);
}

function convertCardToAnalyticUnit(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const tag = $from.parent;
  const card = $from.node(base + 1);
  if (!dispatch) return true;

  const unitNode = cardToAnalyticUnitNode(card);

  const from = $from.before(base + 1);
  const to = $from.after(base + 1);
  let tr = state.tr.replaceWith(from, to, unitNode);
  const cursorPos = from + 2 + Math.min($from.parentOffset, tag.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr);
  return true;
}

function toAnalyticUnitChild(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'undertag' || t === 'cite_paragraph') return child;
  // analytic_unit content = analytic (card_body | undertag | cite_paragraph)*;
  // a stray analytic (from a card's cite-slot) folds into card_body so
  // the text comes along.
  return schema.nodes['card_body']!.create(null, child.content);
}

type SplitMode =
  | { mode: 'heading'; headingType: HeadingTypeName }
  | { mode: 'tag' }
  | { mode: 'analytic' };

function splitContainerAtBody(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  opts: SplitMode,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const cursorBody = $from.parent;
  if (!SPLITTABLE_BODY_SLOTS.has(cursorBody.type.name)) return false;
  const container = $from.node(base + 1);
  const containerName = container.type.name;
  if (containerName !== 'card' && containerName !== 'analytic_unit') return false;

  let cursorIndex = -1;
  container.forEach((child, _offset, index) => {
    if (cursorIndex === -1 && child === cursorBody) cursorIndex = index;
  });
  if (cursorIndex < 1) return false;

  if (!dispatch) return true;

  const beforeChildren: PMNode[] = [];
  const followingChildren: PMNode[] = [];
  container.forEach((child, _offset, index) => {
    if (index < cursorIndex) beforeChildren.push(child);
    else if (index > cursorIndex) followingChildren.push(child);
  });
  const beforeContainer = container.copy(Fragment.fromArray(beforeChildren));

  let liftedNodes: PMNode[];
  let insideOffset: number;
  const cleanHeadContent = stripPromotionMarksOnFragment(cursorBody.content);
  if (opts.mode === 'heading') {
    const headingType = schema.nodes[opts.headingType]!;
    const newHead = headingType.create({ id: newHeadingId() }, cleanHeadContent);
    const followingLifted = followingChildren.map(liftCardChild);
    liftedNodes = [newHead, ...followingLifted];
    insideOffset = 1;
  } else if (opts.mode === 'tag') {
    const tagNode = schema.nodes['tag']!.create({ id: newHeadingId() }, cleanHeadContent);
    // following children are already valid card content (card_body /
    // undertag / cite_paragraph / analytic), so pass through unchanged.
    const newCard = schema.nodes['card']!.create(null, [tagNode, ...followingChildren]);
    liftedNodes = [newCard];
    insideOffset = 2;
  } else {
    const analyticNode = schema.nodes['analytic']!.create({ id: newHeadingId() }, cleanHeadContent);
    const followingForUnit = followingChildren.map(toAnalyticUnitChild);
    const newUnit = schema.nodes['analytic_unit']!.create(null, [analyticNode, ...followingForUnit]);
    liftedNodes = [newUnit];
    insideOffset = 2;
  }

  const containerFrom = $from.before(base + 1);
  const containerTo = $from.after(base + 1);

  // Zone bottom edge → break OUT: `beforeContainer` stays inside the zone, and
  // the lifted new head/card lands AFTER the zone (outside), cutting off the
  // section. (Anywhere else in the zone, it stays in — the branch below.)
  if (isZoneBottomBreakout($from, base)) {
    const zoneAfter = $from.after(base);
    let tr = state.tr.replaceWith(containerFrom, containerTo, beforeContainer);
    const insertPos = tr.mapping.map(zoneAfter);
    tr = tr.insert(insertPos, Fragment.fromArray(liftedNodes));
    const cursorPos =
      insertPos + insideOffset + Math.min($from.parentOffset, cursorBody.content.size);
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
    dispatch(tr.scrollIntoView());
    return true;
  }

  const replacement = Fragment.fromArray([beforeContainer, ...liftedNodes]);
  let tr = state.tr.replaceWith(containerFrom, containerTo, replacement);

  const cursorPos =
    containerFrom + beforeContainer.nodeSize + insideOffset +
    Math.min($from.parentOffset, cursorBody.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr);
  return true;
}

function dissolveContainerToHeading(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  typeName: HeadingTypeName,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const head = $from.parent;
  const container = $from.node(base + 1);
  // Only dissolve when the head is the container's required anchor.
  if (container.firstChild !== head) return false;
  if (container.type.name === 'card' && head.type.name !== 'tag') return false;
  if (container.type.name === 'analytic_unit' && head.type.name !== 'analytic') return false;

  if (!dispatch) return true;

  const id = (head.attrs['id'] as string | null) ?? newHeadingId();
  const newHeading = schema.nodes[typeName]!.create(
    { id },
    stripPromotionMarksOnFragment(head.content),
  );

  const lifted: PMNode[] = [newHeading];
  container.forEach((child, _offset, index) => {
    if (index === 0) return;
    lifted.push(liftCardChild(child));
  });

  const from = $from.before(base + 1);
  const to = $from.after(base + 1);
  let tr = state.tr.replaceWith(from, to, Fragment.fromArray(lifted));
  const cursorPos = from + 1 + Math.min($from.parentOffset, head.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr.scrollIntoView());
  return true;
}

function liftCardChild(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'cite_paragraph') {
    return schema.nodes['paragraph']!.create(null, child.content);
  }
  if (t === 'analytic') {
    return schema.nodes['analytic_unit']!.create(null, [child]);
  }
  return child;
}

/** Pure node transform: an `analytic_unit` → the equivalent `card`. Reverse
 *  of `cardToAnalyticUnitNode`; the analytic_unit's body slots are already
 *  valid card content, so they pass through unchanged. */
function analyticUnitToCardNode(unit: PMNode): PMNode {
  const analytic = unit.firstChild!;
  const id = (analytic.attrs['id'] as string | null) ?? newHeadingId();
  const tagNode = schema.nodes['tag']!.create({ id }, analytic.content);
  const rest: PMNode[] = [];
  unit.forEach((child, _offset, index) => {
    if (index === 0) return;
    rest.push(child);
  });
  // Same attr carry-through as cardToAnalyticUnitNode (numbering survives).
  return schema.nodes['card']!.create(unit.attrs, [tagNode, ...rest]);
}

function convertAnalyticUnitToCard(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const analytic = $from.parent;
  const unit = $from.node(base + 1);
  if (!dispatch) return true;

  const cardNode = analyticUnitToCardNode(unit);

  const from = $from.before(base + 1);
  const to = $from.after(base + 1);
  let tr = state.tr.replaceWith(from, to, cardNode);
  // After replace: doc → card@from → tag@(from+1) → content@(from+2)
  const cursorPos = from + 2 + Math.min($from.parentOffset, analytic.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  // No scrollIntoView — see setTag() above.
  dispatch(tr);
  return true;
}

// ---- Selection-spanning application ----

type StructuralMode =
  | { mode: 'heading'; headingType: HeadingTypeName }
  | { mode: 'tag' }
  | { mode: 'analytic' }
  | { mode: 'undertag' };

/**
 * Compute the doc-child replacement for restyling everything in `[from, to]`
 * to `opts`'s structural type — the shared core of selection-based apply and
 * the shadow bulk-replace. Returns the contiguous doc-child range to replace
 * and the transformed children, or null when nothing intersects or the
 * transform is a no-op (e.g. the range only touched same-type heads with no
 * font_size to clear).
 */
function computeStructuralReplacement(
  state: EditorState,
  from: number,
  to: number,
  opts: StructuralMode,
): { replaceFrom: number; replaceTo: number; newChildren: PMNode[] } | null {
  if (from === to) return null;
  // A trailing selection boundary that merely sits at the START of the
  // next paragraph — the Ctrl-Shift-Down / Shift-Down-past-block-end shape,
  // which lands `to` at offset 0 of the following textblock — means that
  // paragraph has nothing actually selected in it. Pull `to` back across
  // the block's opening boundary so we don't restyle it too.
  const $to = state.doc.resolve(to);
  if ($to.parentOffset === 0 && to - 1 > from) {
    to -= 1;
  }

  let firstIdx = -1;
  let lastIdx = -1;
  let p = 0;
  state.doc.forEach((child, _offset, idx) => {
    const cStart = p;
    const cEnd = p + child.nodeSize;
    if (cEnd > from && cStart < to) {
      if (firstIdx === -1) firstIdx = idx;
      lastIdx = idx;
    }
    p = cEnd;
  });
  if (firstIdx === -1) return null;

  let replaceFrom = -1;
  let replaceTo = -1;
  const newChildren: PMNode[] = [];
  const originalChildren: PMNode[] = [];
  p = 0;
  state.doc.forEach((child, _offset, idx) => {
    const cStart = p;
    const cEnd = p + child.nodeSize;
    p = cEnd;
    if (idx < firstIdx || idx > lastIdx) return;
    if (idx === firstIdx) replaceFrom = cStart;
    if (idx === lastIdx) replaceTo = cEnd;
    originalChildren.push(child);
    transformDocChild(child, cStart, from, to, opts, newChildren);
  });

  if (newChildren.length === 0) return null;
  // Nothing actually transformed (e.g. the selection only touched
  // same-type heads): report null instead of an identical replace —
  // which would burn an undo step and yank the cursor.
  const unchanged =
    newChildren.length === originalChildren.length &&
    newChildren.every((n, i) => n === originalChildren[i] || n.eq(originalChildren[i]!));
  if (unchanged) return null;
  return { replaceFrom, replaceTo, newChildren };
}

/**
 * Apply a structural-style command to every paragraph the selection
 * touches. Selection is contiguous, so the affected paragraphs are
 * contiguous too. Walk the doc-level slice that contains them, rebuild
 * it once, and dispatch a single replaceWith.
 *
 * Rules per affected node:
 *   - doc-level textblock (paragraph / pocket / hat / block / loose
 *     card_body / cite_paragraph / undertag): convert to the target
 *     style. Heading ids are preserved across heading→heading swaps.
 *   - card / analytic_unit: walk children. Once the first touched
 *     child is hit the container is broken — touched children become
 *     headings/tags/analytics, untouched children that follow lift to
 *     doc level (card_body / cite_paragraph → paragraph, undertag
 *     stays, analytic → analytic_unit). Untouched children that
 *     precede the first touched stay inside the original container.
 */
function applyStructuralToSelection(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  opts: StructuralMode,
): boolean {
  const r = computeStructuralReplacement(
    state,
    state.selection.from,
    state.selection.to,
    opts,
  );
  if (!r) return false;
  if (!dispatch) return true;
  const tr = state.tr.replaceWith(
    r.replaceFrom,
    r.replaceTo,
    Fragment.fromArray(r.newChildren),
  );
  // Place cursor at the first text position inside the new range.
  // Selection.near handles the case where replaceFrom+1 is inside a
  // non-textblock container (card / analytic_unit).
  try {
    tr.setSelection(Selection.near(tr.doc.resolve(r.replaceFrom + 1)));
  } catch {
    /* fallback to default mapped selection */
  }
  dispatch(tr);
  return true;
}

/**
 * Bulk *replace* of one structural style with another over a right-click
 * "select all of this style" shadow selection. STUBBED for the dashboard
 * viewer: there is no shadow selection here, so this never fires.
 */
function bulkReplaceStructuralOnShadow(
  _state: EditorState,
  _dispatch: ((tr: Transaction) => void) | undefined,
  _opts: StructuralMode,
): boolean {
  return false;
}

function transformDocChild(
  child: PMNode,
  childStart: number,
  selFrom: number,
  selTo: number,
  opts: StructuralMode,
  out: PMNode[],
): void {
  const t = child.type.name;

  if (child.isTextblock) {
    // paragraph / pocket / hat / block / loose card_body / cite_paragraph / undertag
    out.push(asTransformed(child, opts));
    return;
  }

  if (t === 'card' || t === 'analytic_unit') {
    let hitTouched = false;
    let preChanged = false;
    const preChildren: PMNode[] = [];
    const liftedChildren: PMNode[] = [];
    child.forEach((g, offset) => {
      const gStart = childStart + 1 + offset;
      const gEnd = gStart + g.nodeSize;
      const inSel = gEnd > selFrom && gStart < selTo;
      // A child the command would re-create as the type it already is
      // (F7 with a selection inside a tag, Mod-F7 on analytic text,
      // Mod-F8 on an undertag) counts as UNTOUCHED: the equivalent
      // cursor gesture is a no-op, and treating it as touched would
      // dissolve the container — orphaning the cite/body that follow.
      // Re-pressing the shortcut on a same-type head still resets it
      // toward canonical (clears indent + direct font-size /
      // font-color marks; see clearReapplyFormatting), mirroring the
      // cursor re-press, but leaves the container intact.
      const sameType = isSameTypeTarget(g, opts);
      const gTouched = inSel && !sameType;
      if (gTouched) {
        hitTouched = true;
        liftedChildren.push(asTransformed(g, opts));
      } else if (hitTouched) {
        liftedChildren.push(liftCardChild(inSel && sameType ? clearReapplyFormatting(g) : g));
      } else {
        const kept = inSel && sameType ? clearReapplyFormatting(g) : g;
        if (kept !== g) preChanged = true;
        preChildren.push(kept);
      }
    });

    if (liftedChildren.length === 0) {
      // No container break. If a same-type head had its formatting reset in
      // place, rebuild the container with the cleaned children; otherwise pass
      // the original through untouched.
      out.push(preChanged ? child.copy(Fragment.fromArray(preChildren)) : child);
      return;
    }
    if (preChildren.length === 0) {
      out.push(...liftedChildren);
      return;
    }
    out.push(child.copy(Fragment.fromArray(preChildren)));
    out.push(...liftedChildren);
    return;
  }

  // Anything else (e.g., nested doc structures not in our schema) — pass through.
  out.push(child);
}

/** True when the transform would re-create the node as the same
 *  structural type it already is. */
function isSameTypeTarget(child: PMNode, opts: StructuralMode): boolean {
  const t = child.type.name;
  return (
    (opts.mode === 'tag' && t === 'tag') ||
    (opts.mode === 'analytic' && t === 'analytic') ||
    (opts.mode === 'undertag' && t === 'undertag') ||
    (opts.mode === 'heading' && t === opts.headingType)
  );
}

function asTransformed(child: PMNode, opts: StructuralMode): PMNode {
  const existingId =
    typeof child.attrs['id'] === 'string' && child.attrs['id']
      ? (child.attrs['id'] as string)
      : null;
  // Selection-based promotion replaces the source paragraph entirely;
  // strip named-style and direct-formatting marks so the new structural
  // block carries only the canonical typography. Exception: tag↔analytic
  // is a same-tier swap (same structural role, different cite/analytic
  // semantic) so direct formatting carries through.
  const sameTierSwap =
    (opts.mode === 'tag' || opts.mode === 'analytic') &&
    (child.type.name === 'tag' || child.type.name === 'analytic');
  const cleanContent = sameTierSwap
    ? child.content
    : stripPromotionMarksOnFragment(child.content);
  if (opts.mode === 'undertag') {
    // Undertag has no id and no wrapping container — at doc level it
    // sits as a sibling, inside a card it sits among the body slots.
    return schema.nodes['undertag']!.create(null, cleanContent);
  }
  const id = existingId ?? newHeadingId();
  if (opts.mode === 'heading') {
    return schema.nodes[opts.headingType]!.create({ id }, cleanContent);
  }
  if (opts.mode === 'tag') {
    const tag = schema.nodes['tag']!.create({ id }, cleanContent);
    return schema.nodes['card']!.create(null, [tag]);
  }
  const a = schema.nodes['analytic']!.create({ id }, cleanContent);
  return schema.nodes['analytic_unit']!.create(null, [a]);
}
