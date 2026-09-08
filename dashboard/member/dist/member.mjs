const w = "cmk1.", K = new TextEncoder().encode("cardmirror-pairing-v1"), x = "cardmirror-web-pairing", f = "keys", h = "x25519-v1";
function d(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  let n = "";
  for (const r of e) n += String.fromCharCode(r);
  return btoa(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function y(t) {
  const e = t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - t.length % 4) % 4);
  return Uint8Array.from(atob(e), (n) => n.charCodeAt(0));
}
function C(t) {
  const e = t.trim(), n = e.startsWith(w) ? e.slice(w.length) : e;
  return y(n);
}
async function E(t) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: d(t) },
    { name: "X25519" },
    !1,
    []
  );
}
async function B(t) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", t));
}
async function S(t) {
  const e = await B(C(t));
  return d(e.subarray(0, 16));
}
async function v(t, e, n, r) {
  const o = await crypto.subtle.deriveBits({ name: "X25519", public: e }, t, 256), c = new Uint8Array(n.length + r.length);
  c.set(n, 0), c.set(r, n.length);
  const s = await crypto.subtle.importKey("raw", o, "HKDF", !1, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: c, info: K },
    s,
    { name: "AES-GCM", length: 256 },
    !1,
    ["encrypt", "decrypt"]
  );
}
let p = null;
function P() {
  return new Promise((t, e) => {
    const n = indexedDB.open(x, 1);
    n.onupgradeneeded = () => {
      n.result.objectStoreNames.contains(f) || n.result.createObjectStore(f, { keyPath: "id" });
    }, n.onsuccess = () => t(n.result), n.onerror = () => e(n.error ?? new Error("indexedDB open failed"));
  });
}
function _(t) {
  return new Promise((e, n) => {
    const r = t.transaction(f, "readonly").objectStore(f).get(h);
    r.onsuccess = () => e(r.result), r.onerror = () => n(r.error ?? new Error("indexedDB get failed"));
  });
}
function D(t, e) {
  return new Promise((n, r) => {
    const o = t.transaction(f, "readwrite");
    o.objectStore(f).put(e), o.oncomplete = () => n(), o.onerror = () => r(o.error ?? new Error("indexedDB put failed"));
  });
}
async function j(t) {
  const e = await crypto.subtle.generateKey({ name: "X25519" }, !1, [
    "deriveBits"
  ]), n = await crypto.subtle.exportKey("jwk", e.publicKey), r = y(n.x ?? "");
  return await D(t, { id: h, keyPair: e, pubRaw: r.buffer }), { keyPair: e, pubRaw: r };
}
async function A() {
  if (p) return p;
  const t = await P();
  try {
    const e = await _(t);
    return e?.keyPair?.privateKey && e.pubRaw ? (p = { keyPair: e.keyPair, pubRaw: new Uint8Array(e.pubRaw) }, p) : (p = await j(t), p);
  } finally {
    t.close();
  }
}
async function m() {
  const { pubRaw: t } = await A();
  return w + d(t);
}
async function I() {
  return S(await m());
}
async function N(t, e) {
  const n = C(e), r = await E(n), o = await crypto.subtle.generateKey({ name: "X25519" }, !1, [
    "deriveBits"
  ]), c = await crypto.subtle.exportKey("jwk", o.publicKey), s = y(c.x ?? ""), u = await v(o.privateKey, r, s, n), a = crypto.getRandomValues(new Uint8Array(12)), l = new TextEncoder().encode(JSON.stringify(t)), i = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: a }, u, l)
  ), O = i.subarray(0, i.length - 16), k = i.subarray(i.length - 16);
  return { epk: d(s), iv: d(a), ct: d(O), tag: d(k) };
}
async function $(t) {
  const { keyPair: e, pubRaw: n } = await A(), r = y(t.epk), o = await E(r), c = await v(e.privateKey, o, r, n), s = y(t.ct), u = y(t.tag), a = new Uint8Array(s.length + u.length);
  a.set(s, 0), a.set(u, s.length);
  const l = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: y(t.iv) },
    c,
    a
  );
  return JSON.parse(new TextDecoder().decode(l));
}
const T = "room-invite";
function U(t) {
  if (t.type !== T) return null;
  const e = t.sliceJson;
  if (!e || typeof e != "object") return null;
  const n = e.shareCode;
  if (typeof n != "string" || !/^cmshare[12]\./.test(n)) return null;
  const r = e.title;
  return { shareCode: n, title: typeof r == "string" ? r : "" };
}
const M = 32, F = "cmshare1", J = "cmshare2";
function X(t) {
  const e = atob(t), n = new Uint8Array(e.length);
  for (let r = 0; r < e.length; r++) n[r] = e.charCodeAt(r);
  return n;
}
function H(t) {
  const e = t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - t.length % 4) % 4);
  return X(e);
}
function Y(t) {
  const e = t.trim().split("."), n = e.length >= 4 && e[0] === J;
  if (!n && (e.length !== 3 || e[0] !== F)) return null;
  const r = e[1];
  if (!/^[0-9a-f]{16,64}$/.test(r)) return null;
  const o = n ? e.slice(3).join(".") : void 0;
  if (n && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(o)) return null;
  try {
    const c = H(e[2]);
    return c.byteLength !== M ? null : n ? { roomId: r, keyBytes: c, minVersion: o } : { roomId: r, keyBytes: c };
  } catch {
    return null;
  }
}
const R = "debate-relay-known-rooms";
function g() {
  try {
    return JSON.parse(localStorage.getItem(R) || "{}");
  } catch {
    return {};
  }
}
function z(t) {
  localStorage.setItem(R, JSON.stringify(t));
}
function G(t) {
  let e = "";
  for (const n of t) e += String.fromCharCode(n);
  return btoa(e);
}
async function V() {
  return m();
}
async function q() {
  return I();
}
async function b(t, e, n) {
  try {
    await fetch(`${t}/messages/${encodeURIComponent(n)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${e}` }
    });
  } catch {
  }
}
async function L(t, e) {
  const n = t.replace(/\/$/, ""), r = await I(), o = await fetch(`${n}/messages?recipient=${encodeURIComponent(r)}`, {
    headers: { Authorization: `Bearer ${e}` }
  });
  if (!o.ok) throw new Error(`mailbox ${o.status}`);
  const c = await o.json(), s = g();
  for (const u of c.messages || []) {
    let a = null;
    try {
      a = await $(u);
    } catch {
      await b(n, e, u.msgId);
      continue;
    }
    const l = a && a.item ? U(a.item) : null;
    if (l) {
      const i = Y(l.shareCode);
      i && (s[i.roomId] = {
        roomId: i.roomId,
        title: l.title,
        keyB64: G(i.keyBytes),
        at: Date.now(),
        senderCode: typeof a?.senderCode == "string" ? a.senderCode : s[i.roomId]?.senderCode,
        senderName: typeof a?.senderName == "string" && a.senderName ? a.senderName : s[i.roomId]?.senderName
      });
    }
    await b(n, e, u.msgId);
  }
  return z(s), Object.values(s);
}
async function W(t, e, n, r, o = "Coach") {
  const c = t.replace(/\/$/, ""), s = {
    senderCode: await m(),
    senderName: o,
    item: {
      label: "Coach note",
      type: "text",
      // A ProseMirror slice CardMirror can insert (paragraph of text).
      sliceJson: { content: [{ type: "paragraph", content: [{ type: "text", text: String(r) }] }] }
    }
  }, u = await N(s, n), a = { v: 1, recipientCode: await S(n), sentAt: Date.now(), ...u };
  return (await fetch(`${c}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${e}`, "Content-Type": "application/json" },
    body: JSON.stringify(a)
  })).ok;
}
function Z() {
  return Object.values(g());
}
function Q(t) {
  return g()[t];
}
export {
  V as getMemberCode,
  q as getRoutingId,
  Q as knownRoom,
  Z as knownRooms,
  L as pollInvites,
  W as sendNote
};
