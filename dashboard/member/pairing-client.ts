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
  webSeal,
  webRoutingId,
  webOpen,
  type SealedBundle,
} from '../../src/editor/pairing/web-pairing-crypto.js';
import {
  parseRoomInvite,
  buildRoomInviteItem,
  ROOM_INVITE_MIN_VERSION,
} from '../../src/editor/pairing/room-invite.js';
import { decodeShareCode, encodeShareCode } from '../../src/editor/collab/collab-crypto.js';

export interface KnownRoom {
  roomId: string;
  title: string;
  /** base64 of the 32-byte room key (for Goal 2 — opening the doc). */
  keyB64: string;
  at: number;
  /** The inviting student's pairing public code (cmk1.…), captured from the
   *  sealed invite — lets the coach send them a note back. */
  senderCode?: string;
  /** Their display name, if the invite carried one. */
  senderName?: string;
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

/** This dashboard's mailbox routing id (SHA256(pubkey)[0:16], base64url) —
 *  what the relay sees as `recipientCode`. Used to configure a server-side
 *  email notification (RELAY_NOTIFY_ROUTES) for invites to this dashboard. */
export async function getRoutingId(): Promise<string> {
  return webOwnRoutingId();
}

interface RelayMessage extends SealedBundle { msgId: string; }

/** Shape of an unsealed pairing payload we care about (invite item + sender). */
interface UnsealedInner {
  item?: { type?: unknown; sliceJson?: unknown };
  senderCode?: unknown;
  senderName?: unknown;
}

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
    let inner: UnsealedInner | null = null;
    try {
      inner = (await webOpen(m)) as UnsealedInner;
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
          senderCode: typeof inner?.senderCode === 'string' ? inner.senderCode : store[decoded.roomId]?.senderCode,
          senderName: typeof inner?.senderName === 'string' && inner.senderName ? inner.senderName : store[decoded.roomId]?.senderName,
        };
      }
    }
    await deleteMessage(base, token, m.msgId);
  }
  saveStore(store);
  return Object.values(store);
}

/**
 * Send a plain-text note to a student, sealed to their pairing code — it
 * arrives in their CardMirror "Receive" pill as a text item (no client
 * change). `recipientPublicCode` is the student's cmk1.… code (captured on
 * their invite; see KnownRoom.senderCode). `token` is the dashboard's relay
 * bearer. Returns true when the relay accepted it.
 */
export async function sendNote(
  relayUrl: string,
  token: string,
  recipientPublicCode: string,
  text: string,
  senderName = 'Coach',
): Promise<boolean> {
  const base = relayUrl.replace(/\/$/, '');
  const inner = {
    senderCode: await webOwnPublicCode(),
    senderName,
    item: {
      label: 'Coach note',
      type: 'text',
      // A ProseMirror slice CardMirror can insert (paragraph of text).
      sliceJson: { content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text) }] }] },
    },
  };
  const bundle = await webSeal(inner, recipientPublicCode);
  const body = { v: 1 as const, recipientCode: await webRoutingId(recipientPublicCode), sentAt: Date.now(), ...bundle };
  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

/**
 * Share a room to a student's machine: seals a ROOM INVITE (the share code +
 * title) to their pairing code and posts it to the mailbox. It arrives in
 * their CardMirror as a normal invite → they open the doc. `keyBytes` is the
 * 32-byte room key (the dashboard holds it from having been invited).
 * Returns true when the relay accepted it.
 */
export async function sendRoomInvite(
  relayUrl: string,
  token: string,
  recipientPublicCode: string,
  roomId: string,
  keyBytes: Uint8Array,
  title: string,
  senderName = 'Coach',
): Promise<boolean> {
  const base = relayUrl.replace(/\/$/, '');
  const shareCode = encodeShareCode(roomId, keyBytes, ROOM_INVITE_MIN_VERSION);
  const item = buildRoomInviteItem({ shareCode, title });
  const inner = {
    minReceiverVersion: ROOM_INVITE_MIN_VERSION,
    senderCode: await webOwnPublicCode(),
    senderName,
    item,
  };
  const bundle = await webSeal(inner, recipientPublicCode);
  const body = { v: 1 as const, recipientCode: await webRoutingId(recipientPublicCode), sentAt: Date.now(), ...bundle };
  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

/** All rooms the dashboard has been invited into (from local storage). */
export function knownRooms(): KnownRoom[] { return Object.values(loadStore()); }

/** One room's stored title + key, if the dashboard has been invited to it. */
export function knownRoom(roomId: string): KnownRoom | undefined { return loadStore()[roomId]; }
