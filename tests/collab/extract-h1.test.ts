/**
 * v3 proof-of-concept: prove the full "H1 as room name" pipeline —
 * seal a document with the room key (AES-256-GCM), then decrypt and
 * Loro-decode it and read back the topmost H1 (`pocket`) text. This is
 * exactly what a key-holding dashboard would do to name a live room.
 */
import { describe, it, expect } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { updateLoroToPmState } from 'loro-prosemirror';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  generateRoomKeyBytes,
  importRoomKey,
  encryptBlob,
} from '../../src/editor/collab/collab-crypto.js';
import {
  firstHeadingFromLoro,
  firstHeadingFromEncrypted,
} from '../../src/tools/collab-extract-h1.js';

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

/** Seed a fresh room from a ProseMirror doc and export the snapshot bytes
 *  (the same seed path the host uses in collab-session). No editor view. */
function seedSnapshot(pmDoc: PMNode): Uint8Array {
  const doc = new LoroDoc();
  configTextStyle(doc);
  updateLoroToPmState(doc as never, new Map(), EditorState.create({ doc: pmDoc }));
  doc.commit();
  return doc.export({ mode: 'snapshot' });
}

const docWithH1 = (title: string): PMNode =>
  schema.node('doc', null, [
    schema.node('pocket', null, [schema.text(title)]),
    schema.node('paragraph', null, [schema.text('body copy')]),
  ]);

describe('v3 H1 extraction', () => {
  it('reads the topmost H1 from a Loro snapshot', () => {
    const snap = seedSnapshot(docWithH1('Reproductive Services 1AC'));
    expect(firstHeadingFromLoro(snap)).toBe('Reproductive Services 1AC');
  });

  it('returns null when the document has no H1', () => {
    const snap = seedSnapshot(
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('no heading here')]),
      ]),
    );
    expect(firstHeadingFromLoro(snap)).toBeNull();
  });

  it('picks the FIRST H1 when several exist', () => {
    const snap = seedSnapshot(
      schema.node('doc', null, [
        schema.node('pocket', null, [schema.text('First')]),
        schema.node('pocket', null, [schema.text('Second')]),
      ]),
    );
    expect(firstHeadingFromLoro(snap)).toBe('First');
  });

  it('decrypts a sealed snapshot then extracts the H1 (full pipeline)', async () => {
    const key = await importRoomKey(generateRoomKeyBytes());
    const sealed = await encryptBlob(key, seedSnapshot(docWithH1('Taxes DA')));
    expect(await firstHeadingFromEncrypted(key, sealed)).toBe('Taxes DA');
  });

  it('applies tail update blobs on top of the snapshot', () => {
    // Snapshot with an initial H1, then an update that inserts a new
    // first heading — the decoder should see the post-update document.
    const base = new LoroDoc();
    configTextStyle(base);
    updateLoroToPmState(
      base as never,
      new Map(),
      EditorState.create({ doc: docWithH1('Original') }),
    );
    base.commit();
    const snapshot = base.export({ mode: 'snapshot' });
    const versionBefore = base.version();

    updateLoroToPmState(
      base as never,
      new Map(),
      EditorState.create({ doc: docWithH1('Edited Title') }),
    );
    base.commit();
    const update = base.export({ mode: 'update', from: versionBefore });

    expect(firstHeadingFromLoro(snapshot, [update])).toBe('Edited Title');
  });
});
