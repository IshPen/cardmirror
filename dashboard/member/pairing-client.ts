/**
 * Path B — the dashboard as an invitable "member".
 *
 * The dashboard gets its own pairing identity (a `cmk1.…` member code,
 * X25519 key in IndexedDB — same scheme students already use). A student
 * inviting that code into a session sends a sealed invite to the
 * dashboard's mailbox; the invite carries the share code (roomId + room
 * key) AND the doc title. This module polls that mailbox, unseals invites,
 * and remembers each room's title + key.
 *
 * Goal 1 (see the doc name) needs only the title from the invite — no
 * decryption. Goal 2 (open the doc) uses the stored room key with the
 * viewer decoder. No student-side change: it reuses the existing invite
 * feature, pointed at the dashboard's code.
 *
 * Reuses the app's audited crypto verbatim (web-pairing-crypto,
 * room-invite, collab-crypto), so the dashboard and the app interoperate.
 */
import {
  webOwnPublicCode,
  webOwnRoutingId,
  webOpen,
  type SealedBundle,
} from '../../src/editor/pairing/web-pairing-crypto.js';
import { parseRoomInvite } from '../../src/editor/pairing/room-invite.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';

export interface KnownRoom {
  roomId: string;
  title: string;
  /** base64 of the 32-byte room key (for Goal 2 — opening the doc). */
  keyB64: string;
  at: number;
}

const STORE_KEY = 'debate-relay-known-rooms';

function loadStore(): Record<string, KnownRoom> {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
}
function saveStore(s: Record<string, KnownRoom>): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}
function b64(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

/** This dashboard's shareable member code — give it to students to invite. */
export async function getMemberCode(): Promise<string> {
  return webOwnPublicCode();
}

interface RelayMessage extends SealedBundle { msgId: string; }

async function deleteMessage(base: string, token: string, id: string): Promise<void> {
  try {
    await fetch(`${base}/messages/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch { /* best effort; TTL reaps it anyway */ }
}

/**
 * Poll the relay mailbox for room invites addressed to this dashboard,
 * store any found (roomId → title + key), and return the full known-rooms
 * list. `relayUrl` ends in `/relay`; `token` is a relay bearer (the
 * dashboard's own token from the Tokens panel).
 */
export async function pollInvites(relayUrl: string, token: string): Promise<KnownRoom[]> {
  const base = relayUrl.replace(/\/$/, '');
  const recipient = await webOwnRoutingId();
  const res = await fetch(`${base}/messages?recipient=${encodeURIComponent(recipient)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`mailbox ${res.status}`);
  const data = (await res.json()) as { messages?: RelayMessage[] };

  const store = loadStore();
  for (const m of data.messages || []) {
    let inner: { item?: { type?: unknown; sliceJson?: unknown } } | null = null;
    try {
      inner = (await webOpen(m)) as typeof inner;
    } catch {
      await deleteMessage(base, token, m.msgId); // not for us / stale key
      continue;
    }
    const invite = inner && inner.item ? parseRoomInvite(inner.item as never) : null;
    if (invite) {
      const decoded = decodeShareCode(invite.shareCode);
      if (decoded) {
        store[decoded.roomId] = {
          roomId: decoded.roomId,
          title: invite.title,
          keyB64: b64(decoded.keyBytes),
          at: Date.now(),
        };
      }
    }
    await deleteMessage(base, token, m.msgId);
  }
  saveStore(store);
  return Object.values(store);
}

/** All rooms the dashboard has been invited into (from local storage). */
export function knownRooms(): KnownRoom[] { return Object.values(loadStore()); }

/** One room's stored title + key, if the dashboard has been invited to it. */
export function knownRoom(roomId: string): KnownRoom | undefined { return loadStore()[roomId]; }
