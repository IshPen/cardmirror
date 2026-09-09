const w = "cmk1.", j = new TextEncoder().encode("cardmirror-pairing-v1"), P = "cardmirror-web-pairing", f = "keys", b = "x25519-v1";
function l(e) {
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
  const t = e.trim(), n = t.startsWith(w) ? t.slice(w.length) : t;
  return y(n);
}
async function x(e) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: l(e) },
    { name: "X25519" },
    !1,
    []
  );
}
async function B(e) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", e));
}
async function I(e) {
  const t = await B(v(e));
  return l(t.subarray(0, 16));
}
async function C(e, t, n, r) {
  const o = await crypto.subtle.deriveBits({ name: "X25519", public: t }, e, 256), a = new Uint8Array(n.length + r.length);
  a.set(n, 0), a.set(r, n.length);
  const c = await crypto.subtle.importKey("raw", o, "HKDF", !1, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: a, info: j },
    c,
    { name: "AES-GCM", length: 256 },
    !1,
    ["encrypt", "decrypt"]
  );
}
let p = null;
function m() {
  return new Promise((e, t) => {
    const n = indexedDB.open(P, 1);
    n.onupgradeneeded = () => {
      n.result.objectStoreNames.contains(f) || n.result.createObjectStore(f, { keyPath: "id" });
    }, n.onsuccess = () => e(n.result), n.onerror = () => t(n.error ?? new Error("indexedDB open failed"));
  });
}
function _(e) {
  return new Promise((t, n) => {
    const r = e.transaction(f, "readonly").objectStore(f).get(b);
    r.onsuccess = () => t(r.result), r.onerror = () => n(r.error ?? new Error("indexedDB get failed"));
  });
}
function g(e, t) {
  return new Promise((n, r) => {
    const o = e.transaction(f, "readwrite");
    o.objectStore(f).put(t), o.oncomplete = () => n(), o.onerror = () => r(o.error ?? new Error("indexedDB put failed"));
  });
}
async function D(e) {
  const t = await crypto.subtle.generateKey({ name: "X25519" }, !1, [
    "deriveBits"
  ]), n = await crypto.subtle.exportKey("jwk", t.publicKey), r = y(n.x ?? "");
  return await g(e, { id: b, keyPair: t, pubRaw: r.buffer }), { keyPair: t, pubRaw: r };
}
async function h() {
  if (p) return p;
  const e = await m();
  try {
    const t = await _(e);
    return t?.keyPair?.privateKey && t.pubRaw ? (p = { keyPair: t.keyPair, pubRaw: new Uint8Array(t.pubRaw) }, p) : (p = await D(e), p);
  } finally {
    e.close();
  }
}
async function k() {
  const { pubRaw: e } = await h();
  return w + l(e);
}
async function R() {
  return I(await k());
}
async function N(e, t) {
  const n = v(t), r = await x(n), o = await crypto.subtle.generateKey({ name: "X25519" }, !1, [
    "deriveBits"
  ]), a = await crypto.subtle.exportKey("jwk", o.publicKey), c = y(a.x ?? ""), u = await C(o.privateKey, r, c, n), s = crypto.getRandomValues(new Uint8Array(12)), d = new TextEncoder().encode(JSON.stringify(e)), i = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: s }, u, d)
  ), A = i.subarray(0, i.length - 16), O = i.subarray(i.length - 16);
  return { epk: l(c), iv: l(s), ct: l(A), tag: l(O) };
}
async function $(e) {
  const { keyPair: t, pubRaw: n } = await h(), r = y(e.epk), o = await x(r), a = await C(t.privateKey, o, r, n), c = y(e.ct), u = y(e.tag), s = new Uint8Array(c.length + u.length);
  s.set(c, 0), s.set(u, c.length);
  const d = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: y(e.iv) },
    a,
    s
  );
  return JSON.parse(new TextDecoder().decode(d));
}
async function T() {
  const { keyPair: e, pubRaw: t } = await h();
  try {
    return { jwk: await crypto.subtle.exportKey("jwk", e.privateKey), code: w + l(t) };
  } catch {
    return null;
  }
}
async function U() {
  const e = await T();
  if (e) return e;
  const t = await crypto.subtle.generateKey({ name: "X25519" }, !0, [
    "deriveBits"
  ]), n = await crypto.subtle.exportKey("jwk", t.publicKey), r = y(n.x ?? ""), o = await m();
  try {
    await g(o, { id: b, keyPair: t, pubRaw: r.buffer }), p = { keyPair: t, pubRaw: r };
  } finally {
    o.close();
  }
  return { jwk: await crypto.subtle.exportKey("jwk", t.privateKey), code: w + l(r) };
}
async function X(e) {
  const t = await crypto.subtle.importKey(
    "jwk",
    e,
    { name: "X25519" },
    !0,
    ["deriveBits"]
  ), n = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: e.x },
    { name: "X25519" },
    !0,
    []
  ), r = y(e.x ?? ""), o = { privateKey: t, publicKey: n }, a = await m();
  try {
    await g(a, { id: b, keyPair: o, pubRaw: r.buffer }), p = { keyPair: o, pubRaw: r };
  } finally {
    a.close();
  }
  return w + l(r);
}
const J = "room-invite";
function M(e) {
  if (e.type !== J) return null;
  const t = e.sliceJson;
  if (!t || typeof t != "object") return null;
  const n = t.shareCode;
  if (typeof n != "string" || !/^cmshare[12]\./.test(n)) return null;
  const r = t.title;
  return { shareCode: n, title: typeof r == "string" ? r : "" };
}
const F = 32, H = "cmshare1", Y = "cmshare2";
function z(e) {
  const t = atob(e), n = new Uint8Array(t.length);
  for (let r = 0; r < t.length; r++) n[r] = t.charCodeAt(r);
  return n;
}
function G(e) {
  const t = e.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - e.length % 4) % 4);
  return z(t);
}
function V(e) {
  const t = e.trim().split("."), n = t.length >= 4 && t[0] === Y;
  if (!n && (t.length !== 3 || t[0] !== H)) return null;
  const r = t[1];
  if (!/^[0-9a-f]{16,64}$/.test(r)) return null;
  const o = n ? t.slice(3).join(".") : void 0;
  if (n && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(o)) return null;
  try {
    const a = G(t[2]);
    return a.byteLength !== F ? null : n ? { roomId: r, keyBytes: a, minVersion: o } : { roomId: r, keyBytes: a };
  } catch {
    return null;
  }
}
const S = "debate-relay-known-rooms";
function K() {
  try {
    return JSON.parse(localStorage.getItem(S) || "{}");
  } catch {
    return {};
  }
}
function q(e) {
  localStorage.setItem(S, JSON.stringify(e));
}
function L(e) {
  let t = "";
  for (const n of e) t += String.fromCharCode(n);
  return btoa(t);
}
async function W() {
  return k();
}
async function Z() {
  return U();
}
async function Q(e) {
  return X(e);
}
async function ee() {
  return R();
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
async function te(e, t) {
  const n = e.replace(/\/$/, ""), r = await R(), o = await fetch(`${n}/messages?recipient=${encodeURIComponent(r)}`, {
    headers: { Authorization: `Bearer ${t}` }
  });
  if (!o.ok) throw new Error(`mailbox ${o.status}`);
  const a = await o.json(), c = K();
  for (const u of a.messages || []) {
    let s = null;
    try {
      s = await $(u);
    } catch {
      await E(n, t, u.msgId);
      continue;
    }
    const d = s && s.item ? M(s.item) : null;
    if (d) {
      const i = V(d.shareCode);
      i && (c[i.roomId] = {
        roomId: i.roomId,
        title: d.title,
        keyB64: L(i.keyBytes),
        at: Date.now(),
        senderCode: typeof s?.senderCode == "string" ? s.senderCode : c[i.roomId]?.senderCode,
        senderName: typeof s?.senderName == "string" && s.senderName ? s.senderName : c[i.roomId]?.senderName
      });
    }
    await E(n, t, u.msgId);
  }
  return q(c), Object.values(c);
}
async function ne(e, t, n, r, o = "Coach") {
  const a = e.replace(/\/$/, ""), c = {
    senderCode: await k(),
    senderName: o,
    item: {
      label: "Coach note",
      type: "text",
      // A ProseMirror slice CardMirror can insert (paragraph of text).
      sliceJson: { content: [{ type: "paragraph", content: [{ type: "text", text: String(r) }] }] }
    }
  }, u = await N(c, n), s = { v: 1, recipientCode: await I(n), sentAt: Date.now(), ...u };
  return (await fetch(`${a}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(s)
  })).ok;
}
function re() {
  return Object.values(K());
}
function oe(e) {
  return K()[e];
}
export {
  Z as exportIdentity,
  W as getMemberCode,
  ee as getRoutingId,
  Q as importIdentity,
  oe as knownRoom,
  re as knownRooms,
  te as pollInvites,
  ne as sendNote
};
