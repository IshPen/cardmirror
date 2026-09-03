const p = "cmk1.", I = new TextEncoder().encode("cardmirror-pairing-v1"), v = "cardmirror-web-pairing", d = "keys", b = "x25519-v1";
function w(t) {
  const e = t instanceof Uint8Array ? t : new Uint8Array(t);
  let n = "";
  for (const r of e) n += String.fromCharCode(r);
  return btoa(n).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function l(t) {
  const e = t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - t.length % 4) % 4);
  return Uint8Array.from(atob(e), (n) => n.charCodeAt(0));
}
function A(t) {
  const e = t.trim(), n = e.startsWith(p) ? e.slice(p.length) : e;
  return l(n);
}
async function C(t) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: w(t) },
    { name: "X25519" },
    !1,
    []
  );
}
async function O(t) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", t));
}
async function R(t) {
  const e = await O(A(t));
  return w(e.subarray(0, 16));
}
async function k(t, e, n, r) {
  const o = await crypto.subtle.deriveBits({ name: "X25519", public: e }, t, 256), a = new Uint8Array(n.length + r.length);
  a.set(n, 0), a.set(r, n.length);
  const c = await crypto.subtle.importKey("raw", o, "HKDF", !1, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: a, info: I },
    c,
    { name: "AES-GCM", length: 256 },
    !1,
    ["encrypt", "decrypt"]
  );
}
let u = null;
function K() {
  return new Promise((t, e) => {
    const n = indexedDB.open(v, 1);
    n.onupgradeneeded = () => {
      n.result.objectStoreNames.contains(d) || n.result.createObjectStore(d, { keyPath: "id" });
    }, n.onsuccess = () => t(n.result), n.onerror = () => e(n.error ?? new Error("indexedDB open failed"));
  });
}
function _(t) {
  return new Promise((e, n) => {
    const r = t.transaction(d, "readonly").objectStore(d).get(b);
    r.onsuccess = () => e(r.result), r.onerror = () => n(r.error ?? new Error("indexedDB get failed"));
  });
}
function P(t, e) {
  return new Promise((n, r) => {
    const o = t.transaction(d, "readwrite");
    o.objectStore(d).put(e), o.oncomplete = () => n(), o.onerror = () => r(o.error ?? new Error("indexedDB put failed"));
  });
}
async function B(t) {
  const e = await crypto.subtle.generateKey({ name: "X25519" }, !1, [
    "deriveBits"
  ]), n = await crypto.subtle.exportKey("jwk", e.publicKey), r = l(n.x ?? "");
  return await P(t, { id: b, keyPair: e, pubRaw: r.buffer }), { keyPair: e, pubRaw: r };
}
async function h() {
  if (u) return u;
  const t = await K();
  try {
    const e = await _(t);
    return e?.keyPair?.privateKey && e.pubRaw ? (u = { keyPair: e.keyPair, pubRaw: new Uint8Array(e.pubRaw) }, u) : (u = await B(t), u);
  } finally {
    t.close();
  }
}
async function E() {
  const { pubRaw: t } = await h();
  return p + w(t);
}
async function D() {
  return R(await E());
}
async function x(t) {
  const { keyPair: e, pubRaw: n } = await h(), r = l(t.epk), o = await C(r), a = await k(e.privateKey, o, r, n), c = l(t.ct), s = l(t.tag), i = new Uint8Array(c.length + s.length);
  i.set(c, 0), i.set(s, c.length);
  const f = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: l(t.iv) },
    a,
    i
  );
  return JSON.parse(new TextDecoder().decode(f));
}
const j = "room-invite";
function U(t) {
  if (t.type !== j) return null;
  const e = t.sliceJson;
  if (!e || typeof e != "object") return null;
  const n = e.shareCode;
  if (typeof n != "string" || !/^cmshare[12]\./.test(n)) return null;
  const r = e.title;
  return { shareCode: n, title: typeof r == "string" ? r : "" };
}
const $ = 32, T = "cmshare1", F = "cmshare2";
function M(t) {
  const e = atob(t), n = new Uint8Array(e.length);
  for (let r = 0; r < e.length; r++) n[r] = e.charCodeAt(r);
  return n;
}
function H(t) {
  const e = t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - t.length % 4) % 4);
  return M(e);
}
function N(t) {
  const e = t.trim().split("."), n = e.length >= 4 && e[0] === F;
  if (!n && (e.length !== 3 || e[0] !== T)) return null;
  const r = e[1];
  if (!/^[0-9a-f]{16,64}$/.test(r)) return null;
  const o = n ? e.slice(3).join(".") : void 0;
  if (n && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(o)) return null;
  try {
    const a = H(e[2]);
    return a.byteLength !== $ ? null : n ? { roomId: r, keyBytes: a, minVersion: o } : { roomId: r, keyBytes: a };
  } catch {
    return null;
  }
}
const S = "debate-relay-known-rooms";
function m() {
  try {
    return JSON.parse(localStorage.getItem(S) || "{}");
  } catch {
    return {};
  }
}
function X(t) {
  localStorage.setItem(S, JSON.stringify(t));
}
function Y(t) {
  let e = "";
  for (const n of t) e += String.fromCharCode(n);
  return btoa(e);
}
async function J() {
  return E();
}
async function g(t, e, n) {
  try {
    await fetch(`${t}/messages/${encodeURIComponent(n)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${e}` }
    });
  } catch {
  }
}
async function z(t, e) {
  const n = t.replace(/\/$/, ""), r = await D(), o = await fetch(`${n}/messages?recipient=${encodeURIComponent(r)}`, {
    headers: { Authorization: `Bearer ${e}` }
  });
  if (!o.ok) throw new Error(`mailbox ${o.status}`);
  const a = await o.json(), c = m();
  for (const s of a.messages || []) {
    let i = null;
    try {
      i = await x(s);
    } catch {
      await g(n, e, s.msgId);
      continue;
    }
    const f = i && i.item ? U(i.item) : null;
    if (f) {
      const y = N(f.shareCode);
      y && (c[y.roomId] = {
        roomId: y.roomId,
        title: f.title,
        keyB64: Y(y.keyBytes),
        at: Date.now()
      });
    }
    await g(n, e, s.msgId);
  }
  return X(c), Object.values(c);
}
function G() {
  return Object.values(m());
}
function V(t) {
  return m()[t];
}
export {
  J as getMemberCode,
  V as knownRoom,
  G as knownRooms,
  z as pollInvites
};
