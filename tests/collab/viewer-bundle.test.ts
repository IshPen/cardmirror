/**
 * Smoke test of the BUILT v3 viewer bundle (dashboard/viewer/dist/viewer.mjs):
 * proves the shipped artifact — bundled loro-crdt WASM and all — decrypts a
 * room's blobs and extracts the H1, driving it exactly as the browser would
 * (Supabase REST → base64 ciphertext rows). `fetch` is mocked; no network.
 *
 * Requires the bundle to exist: `npm run build:viewer` first. Skips (does not
 * fail) if it's missing, so the suite stays green on a fresh checkout.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { updateLoroToPmState } from 'loro-prosemirror';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  generateRoomKeyBytes,
  importRoomKey,
  encryptBlob,
  bytesToBase64,
} from '../../src/editor/collab/collab-crypto.js';

const BUNDLE = path.resolve(__dirname, '../../dashboard/viewer/dist/viewer.mjs');

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

describe.skipIf(!existsSync(BUNDLE))('built viewer bundle', () => {
  it('resolves the H1 through the shipped bundle (mocked Supabase)', async () => {
    const keyBytes = generateRoomKeyBytes();
    const key = await importRoomKey(keyBytes);
    const pmDoc = schema.node('doc', null, [
      schema.node('pocket', null, [schema.text('Biotech DA')]),
      schema.node('paragraph', null, [schema.text('body')]),
    ]);
    const sealed = await encryptBlob(key, seedSnapshot(pmDoc));
    const sealedB64 = bytesToBase64(sealed);

    // Mock the two REST calls resolve-name makes: a snapshot row + no updates.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.includes('relay_room_snapshots') ? [{ blob: sealedB64 }] : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));

    const { resolveRoomName } = await import(/* @vite-ignore */ BUNDLE);
    const name = await resolveRoomName({
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'anon',
      roomId: 'abc123',
      keyBytes,
    });
    expect(name).toBe('Biotech DA');
    vi.unstubAllGlobals();
  });
});
