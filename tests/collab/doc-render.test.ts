// @vitest-environment jsdom
/**
 * Goal 2 proof: rebuild a full document from Loro bytes and serialize it
 * to HTML with the schema's toDOM rules (what the doc viewer renders).
 */
import { describe, it, expect } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { updateLoroToPmState } from 'loro-prosemirror';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { docFromLoro } from '../../src/tools/collab-extract-h1.js';
import { docToHtml } from '../../dashboard/viewer/resolve-name.js';

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

function seedSnapshot(pmDoc: PMNode): Uint8Array {
  const doc = new LoroDoc();
  configTextStyle(doc);
  updateLoroToPmState(doc as never, new Map(), EditorState.create({ doc: pmDoc }));
  doc.commit();
  return doc.export({ mode: 'snapshot' });
}

describe('doc render (Goal 2)', () => {
  it('rebuilds a document and serializes it to HTML', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('pocket', null, [schema.text('Reproductive Services 1AC')]),
      schema.node('paragraph', null, [schema.text('Some body text here.')]),
      schema.node('hat', null, [schema.text('Contention One')]),
    ]);
    const node = docFromLoro(seedSnapshot(pmDoc));
    const html = docToHtml(node);
    expect(html).toContain('Reproductive Services 1AC');
    expect(html).toContain('Some body text here.');
    expect(html).toContain('Contention One');
    expect(html).toMatch(/<h1/i); // pocket → h1
  });

  it('renders empty content without throwing', () => {
    const node = docFromLoro(seedSnapshot(schema.node('doc', null, [])));
    expect(typeof docToHtml(node)).toBe('string');
  });
});
