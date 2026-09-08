// ── Cross-device cloud sync (encrypted vault) ────────────────────────
// Makes the dashboard's per-browser state follow the coach to any device.
//
// TWO TIERS, by sensitivity:
//   • prefs  — non-secret UI (theme, nav levels). Stored as PLAINTEXT jsonb
//     under Row-Level Security, so only the signed-in coach can read it.
//   • vault  — SECRET material: relay token list (with secrets), the ✉️
//     roster, and known-rooms (doc titles + their decryption keys). This is
//     encrypted CLIENT-SIDE (AES-256-GCM, key = PBKDF2 of the coach's login
//     password) and only the ciphertext is stored. Supabase — which also
//     holds the encrypted documents — therefore never sees the room keys in
//     the clear, so putting both in one database does NOT break end-to-end
//     encryption. Forget the password → the vault can't be decrypted (a real
//     vault); we offer a re-initialise path in that case.
//
// The dashboard's member PRIVATE key is deliberately NOT synced — it's a
// non-extractable WebCrypto key by design. We sync the room keys it has
// already learned (plain bytes), which is all the viewer needs to Open a
// doc. Only *receiving a brand-new invite* stays pinned to one device.
//
// Classic script (no build): exposes window.DRSync. Loaded before app.js.

window.DRSync = (function () {
  const state = {
    configured: false, // have Supabase URL + anon key + a coach JWT
    unlocked: false,    // password in memory + vault decrypted at least once
    busy: false,
    lastPush: 0,
    lastPull: 0,
    error: '',
  };

  let _pw = null;               // coach login password — MEMORY ONLY, never stored
  let _cfg = null;              // { supabaseUrl, anonKey }
  let _jwt = null;              // Supabase Auth access token (RLS is enforced by it)
  let _uid = null;              // coach's auth.users id, decoded from the JWT
  let _salt = null;             // Uint8Array(16) PBKDF2 salt (adopted from cloud or minted)
  let _key = null;              // cached derived AES-GCM CryptoKey
  let _keySalt = '';            // salt the cached key was derived with

  // — base64 (binary-safe) —
  function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
  function fromB64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }
  function b64urlToStr(str) {
    const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
    return atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  }
  function decodeUid(jwt) {
    try { return JSON.parse(b64urlToStr(jwt.split('.')[1])).sub || null; } catch { return null; }
  }

  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function ensureKey() {
    if (!_pw) throw new Error('Vault locked — sign in with your coach password.');
    if (!_salt) _salt = crypto.getRandomValues(new Uint8Array(16));
    const tag = b64(_salt);
    if (_key && _keySalt === tag) return _key;
    _key = await deriveKey(_pw, _salt);
    _keySalt = tag;
    return _key;
  }

  // — public API —

  /** Wire up connection + coach session. Call after a successful sign-in. */
  function configure({ supabaseUrl, anonKey, jwt }) {
    _cfg = { supabaseUrl: supabaseUrl.replace(/\/$/, ''), anonKey };
    _jwt = jwt;
    _uid = decodeUid(jwt);
    state.configured = !!(supabaseUrl && anonKey && _uid);
  }

  /** Hold the coach's login password in memory to derive the vault key. */
  function setPassword(pw) { _pw = pw || null; }

  /** Forget the password + derived key (e.g. on sign-out). */
  function lock() { _pw = null; _key = null; _keySalt = ''; state.unlocked = false; }

  function ready() { return state.configured && !!_pw; }

  /** Read the coach's row. Returns { prefs, vault, fresh }. `fresh` = no row
   *  yet (first device). Throws on a wrong/rotated password (decrypt fail). */
  async function pull() {
    if (!ready()) throw new Error('Not configured.');
    state.busy = true; state.error = '';
    try {
      const url = _cfg.supabaseUrl + '/rest/v1/dashboard_state?select=prefs,vault';
      const res = await fetch(url, { headers: { apikey: _cfg.anonKey, Authorization: 'Bearer ' + _jwt } });
      if (res.status === 401) { state.error = 'expired'; throw new Error('Session expired — sign in again.'); }
      if (!res.ok) throw new Error('Sync read failed (' + res.status + ').');
      const rows = await res.json();
      state.lastPull = Date.now();
      if (!rows.length) return { prefs: null, vault: null, fresh: true };
      const row = rows[0];
      let vault = null;
      if (row.vault) {
        const env = JSON.parse(row.vault);
        _salt = fromB64(env.salt); _key = null; // adopt the cloud salt
        const key = await ensureKey();
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.ct)
        );
        vault = JSON.parse(new TextDecoder().decode(pt));
        state.unlocked = true;
      }
      return { prefs: row.prefs || null, vault, fresh: false };
    } finally { state.busy = false; }
  }

  /** Encrypt the vault + upsert the coach's row (RLS: one row per user). */
  async function push({ prefs, vault }) {
    if (!ready()) throw new Error('Not configured.');
    state.busy = true; state.error = '';
    try {
      const key = await ensureKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(vault || {}))
      );
      const env = JSON.stringify({
        v: 1, salt: b64(_salt), iv: b64(iv), ct: b64(new Uint8Array(ct)),
      });
      const body = [{ user_id: _uid, prefs: prefs || {}, vault: env, updated_at: new Date().toISOString() }];
      const res = await fetch(_cfg.supabaseUrl + '/rest/v1/dashboard_state', {
        method: 'POST',
        headers: {
          apikey: _cfg.anonKey, Authorization: 'Bearer ' + _jwt,
          'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(body),
      });
      if (res.status === 401) { state.error = 'expired'; throw new Error('Session expired — sign in again.'); }
      if (!res.ok) throw new Error('Sync write failed (' + res.status + '): ' + (await res.text()).slice(0, 120));
      state.lastPush = Date.now(); state.unlocked = true;
    } finally { state.busy = false; }
  }

  return { state, configure, setPassword, lock, ready, pull, push };
})();
