/**
 * Path B proof: a student invites the dashboard's member code into a
 * session; the dashboard polls its mailbox and recovers the room's title
 * (Goal 1) and key (Goal 2) — reusing the exact app crypto. No decryption
 * needed for the title; it rides in the invite.
 *
 * Runs in Node with real WebCrypto + fake-indexeddb (same as the pairing
 * tests). localStorage + fetch are stubbed.
 */
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
// Browser has `crypto` global; older Node under vitest may not — polyfill it.
if (!(globalThis as { crypto?: unknown }).crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webSeal, webOwnPublicCode } from '../../src/editor/pairing/web-pairing-crypto.js';
import { buildRoomInviteItem } from '../../src/editor/pairing/room-invite.js';
import {
  generateRoomKeyBytes,
  encodeShareCode,
  base64ToBytes,
} from '../../src/editor/collab/collab-crypto.js';
import { getMemberCode, pollInvites, knownRoom } from '../../dashboard/member/pairing-client.js';

// Minimal localStorage stub.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe('dashboard member (Path B)', () => {
  it('recovers a room title + key from an invite sealed to its member code', async () => {
    // The dashboard's own member code (creates its X25519 identity).
    const memberCode = await getMemberCode();
    expect(memberCode).toMatch(/^cmk1\./);

    // A student builds a real share code and seals a room-invite to the
    // dashboard's code — exactly what CardMirror's invite feature does.
    const roomId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const keyBytes = generateRoomKeyBytes();
    const shareCode = encodeShareCode(roomId, keyBytes, '1.0.0');
    const item = buildRoomInviteItem({ shareCode, title: 'Biotech DA — Michigan 2026' });
    const sealed = await webSeal({ item }, memberCode);

    // The relay mailbox hands the dashboard that sealed bundle on poll.
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'DELETE') return new Response('', { status: 204 });
      if (String(url).includes('/messages?recipient=')) {
        return new Response(JSON.stringify({ messages: [{ ...sealed, msgId: 'm1' }] }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }));

    const rooms = await pollInvites('https://relay.example.com/relay', 'DashboardToken');
    const got = rooms.find((r) => r.roomId === roomId);
    expect(got).toBeTruthy();
    expect(got!.title).toBe('Biotech DA — Michigan 2026'); // Goal 1: name, no decrypt
    // Goal 2: the stored key matches the real room key.
    expect([...base64ToBytes(got!.keyB64)]).toEqual([...keyBytes]);

    // Persisted for later lookup.
    expect(knownRoom(roomId)?.title).toBe('Biotech DA — Michigan 2026');
  });

  it('ignores mailbox messages that are not for us (wrong key)', async () => {
    await getMemberCode();
    // A real, different recipient whose private key we do NOT hold, so
    // webOpen throws and the invite is skipped.
    const kp = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as { x: string };
    const strangerCode = 'cmk1.' + jwk.x;
    const item = buildRoomInviteItem({ shareCode: encodeShareCode('deadbeef'.repeat(4), generateRoomKeyBytes(), '1.0.0'), title: 'Nope' });
    const sealed = await webSeal({ item }, strangerCode);
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'DELETE') return new Response('', { status: 204 });
      return new Response(JSON.stringify({ messages: [{ ...sealed, msgId: 'm2' }] }), { status: 200 });
    }));
    const rooms = await pollInvites('https://relay.example.com/relay', 'DashboardToken');
    expect(rooms.length).toBe(0);
  });
});
