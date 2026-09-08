const b = "cmk1.", B = new TextEncoder().encode("cardmirror-pairing-v1"), x = "cardmirror-web-pairing", f = "keys", I = "x25519-v1";
function d(e) {
  const t = e instanceof Uint8Array ? e : new Uint8Array(e);
  let n = "";
  for (const r of t) n += String.fromCharCode(r);
  return btoa(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function y(e) {
  const t = e.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - e.length % 4) % 4);
  return Uint8Array.from(atob(t), (n) => n.charCodeAt(0));
}
function v(e) {
  const t = e.trim(), n = t.startsWith(b) ? t.slice(b.length) : t;
  return y(n);
}
async function R(e) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: d(e) },
    { name: "X25519" },
    !1,
    []
  );
}
async function D(e) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", e));
}
async function h(e) {
  const t = await D(v(e));
  return d(t.subarray(0, 16));
}
async function O(e, t, n, r) {
  const o = await crypto.subtle.deriveBits({ name: "X25519", public: t }, e, 256), c = new Uint8Array(n.length + r.length);
  c.set(n, 0), c.set(r, n.length);
  const s = await crypto.subtle.importKey("raw", o, "HKDF", !1, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: c, info: B },
    s,
    { name: "AES-GCM", length: 256 },
    !1,
    ["encrypt", "decrypt"]
  );
}
let p = null;
function P() {
  return new Promise((e, t) => {
    const n = indexedDB.open(x, 1);
    n.onupgradeneeded = () => {
      n.result.objectStoreNames.contains(f) || n.result.createObjectStore(f, { keyPath: "id" });
    }, n.onsuccess = () => e(n.result), n.onerror = () => t(n.error ?? new Error("indexedDB open failed"));
  });
}
function T(e) {
  return new Promise((t, n) => {
    const r = e.transaction(f, "readonly").objectStore(f).get(I);
    r.onsuccess = () => t(r.result), r.onerror = () => n(r.error ?? new Error("indexedDB get failed"));
  });
}
function U(e, t) {
  return new Promise((n, r) => {
    const o = e.transaction(f, "readwrite");
    o.objectStore(f).put(t), o.oncomplete = () => n(), o.onerror = () => r(o.error ?? new Error("indexedDB put failed"));
  });
}
async function j(e) {
  const t = await crypto.subtle.generateKey({ name: "X25519" }, !1, [
    "deriveBits"
  ]), n = await crypto.subtle.exportKey("jwk", t.publicKey), r = y(n.x ?? "");
  return await U(e, { id: I, keyPair: t, pubRaw: r.buffer }), { keyPair: t, pubRaw: r };
}
async function A() {
  if (p) return p;
  const e = await P();
  try {
    const t = await T(e);
    return t?.keyPair?.privateKey && t.pubRaw ? (p = { keyPair: t.keyPair, pubRaw: new Uint8Array(t.pubRaw) }, p) : (p = await j(e), p);
  } finally {
    e.close();
  }
}
async function w() {
  const { pubRaw: e } = await A();
  return b + d(e);
}
async function K() {
  return h(await w());
}
async function k(e, t) {
  const n = v(t), r = await R(n), o = await crypto.subtle.generateKey({ name: "X25519" }, !1, [
    "deriveBits"
  ]), c = await crypto.subtle.exportKey("jwk", o.publicKey), s = y(c.x ?? ""), u = await O(o.privateKey, r, s, n), a = crypto.getRandomValues(new Uint8Array(12)), l = new TextEncoder().encode(JSON.stringify(e)), i = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: a }, u, l)
  ), m = i.subarray(0, i.length - 16), g = i.subarray(i.length - 16);
  return { epk: d(s), iv: d(a), ct: d(m), tag: d(g) };
}
async function M(e) {
  const { keyPair: t, pubRaw: n } = await A(), r = y(e.epk), o = await R(r), c = await O(t.privateKey, o, r, n), s = y(e.ct), u = y(e.tag), a = new Uint8Array(s.length + u.length);
  a.set(s, 0), a.set(u, s.length);
  const l = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: y(e.iv) },
    c,
    a
  );
  return JSON.parse(new TextDecoder().decode(l));
}
const N = "room-invite", S = "0.1.0-beta.8";
function H(e) {
  return {
    label: e.title || "Collaboration session",
    type: N,
    sliceJson: { shareCode: e.shareCode, title: e.title }
  };
}
function J(e) {
  if (e.type !== N) return null;
  const t = e.sliceJson;
  if (!t || typeof t != "object") return null;
  const n = t.shareCode;
  if (typeof n != "string" || !/^cmshare[12]\./.test(n)) return null;
  const r = t.title;
  return { shareCode: n, title: typeof r == "string" ? r : "" };
}
const F = 32, X = "cmshare1", _ = "cmshare2";
function V(e) {
  let t = "";
  for (let r = 0; r < e.length; r += 32768)
    t += String.fromCharCode(...e.subarray(r, r + 32768));
  return btoa(t);
}
function z(e) {
  const t = atob(e), n = new Uint8Array(t.length);
  for (let r = 0; r < t.length; r++) n[r] = t.charCodeAt(r);
  return n;
}
function Y(e) {
  return V(e).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function G(e) {
  const t = e.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - e.length % 4) % 4);
  return z(t);
}
function q(e, t, n) {
  return `${_}.${e}.${Y(t)}.${n}`;
}
function L(e) {
  const t = e.trim().split("."), n = t.length >= 4 && t[0] === _;
  if (!n && (t.length !== 3 || t[0] !== X)) return null;
  const r = t[1];
  if (!/^[0-9a-f]{16,64}$/.test(r)) return null;
  const o = n ? t.slice(3).join(".") : void 0;
  if (n && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(o)) return null;
  try {
    const c = G(t[2]);
    return c.byteLength !== F ? null : n ? { roomId: r, keyBytes: c, minVersion: o } : { roomId: r, keyBytes: c };
  } catch {
    return null;
  }
}
const $ = "debate-relay-known-rooms";
function C() {
  try {
    return JSON.parse(localStorage.getItem($) || "{}");
  } catch {
    return {};
  }
}
function W(e) {
  localStorage.setItem($, JSON.stringify(e));
}
function Z(e) {
  let t = "";
  for (const n of e) t += String.fromCharCode(n);
  return btoa(t);
}
async function ee() {
  return w();
}
async function te() {
  return K();
}
async function E(e, t, n) {
  try {
    await fetch(`${e}/messages/${encodeURIComponent(n)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${t}` }
    });
  } catch {
  }
}
async function ne(e, t) {
  const n = e.replace(/\/$/, ""), r = await K(), o = await fetch(`${n}/messages?recipient=${encodeURIComponent(r)}`, {
    headers: { Authorization: `Bearer ${t}` }
  });
  if (!o.ok) throw new Error(`mailbox ${o.status}`);
  const c = await o.json(), s = C();
  for (const u of c.messages || []) {
    let a = null;
    try {
      a = await M(u);
    } catch {
      await E(n, t, u.msgId);
      continue;
    }
    const l = a && a.item ? J(a.item) : null;
    if (l) {
      const i = L(l.shareCode);
      i && (s[i.roomId] = {
        roomId: i.roomId,
        title: l.title,
        keyB64: Z(i.keyBytes),
        at: Date.now(),
        senderCode: typeof a?.senderCode == "string" ? a.senderCode : s[i.roomId]?.senderCode,
        senderName: typeof a?.senderName == "string" && a.senderName ? a.senderName : s[i.roomId]?.senderName
      });
    }
    await E(n, t, u.msgId);
  }
  return W(s), Object.values(s);
}
async function re(e, t, n, r, o = "Coach") {
  const c = e.replace(/\/$/, ""), s = {
    senderCode: await w(),
    senderName: o,
    item: {
      label: "Coach note",
      type: "text",
      // A ProseMirror slice CardMirror can insert (paragraph of text).
      sliceJson: { content: [{ type: "paragraph", content: [{ type: "text", text: String(r) }] }] }
    }
  }, u = await k(s, n), a = { v: 1, recipientCode: await h(n), sentAt: Date.now(), ...u };
  return (await fetch(`${c}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(a)
  })).ok;
}
async function oe(e, t, n, r, o, c, s = "Coach") {
  const u = e.replace(/\/$/, ""), a = q(r, o, S), l = H({ shareCode: a, title: c }), i = {
    minReceiverVersion: S,
    senderCode: await w(),
    senderName: s,
    item: l
  }, m = await k(i, n), g = { v: 1, recipientCode: await h(n), sentAt: Date.now(), ...m };
  return (await fetch(`${u}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(g)
  })).ok;
}
function ae() {
  return Object.values(C());
}
function se(e) {
  return C()[e];
}
export {
  ee as getMemberCode,
  te as getRoutingId,
  se as knownRoom,
  ae as knownRooms,
  ne as pollInvites,
  re as sendNote,
  oe as sendRoomInvite
};
