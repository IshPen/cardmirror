// ── Anonymous usage metrics (privacy-first, opt-out) ─────────────────
// Sends ANONYMOUS, aggregate-only events to a central CardBridge telemetry
// Supabase project (maintainer-owned, separate from any coach's relay data).
//
// WHAT IS SENT: a random install id, a random per-session id, an event name,
// and a strict allowlist of NUMERIC/BOOLEAN counters. That's it.
// WHAT IS NEVER SENT: emails, names, Supabase/relay URLs, anon keys, relay
// tokens, room ids, share codes, document content, IP-derived identity — none
// of it. The payload is built from an allowlist, so nothing else can leak in.
//
// Insert-only under RLS: the public key can WRITE events but can never READ
// them back, so no coach can see another's activity. Respects Do-Not-Track and
// a local opt-out. Failures are swallowed — telemetry never disrupts the app.
//
// MAINTAINER SETUP (one-time): create a DEDICATED Supabase project just for
// telemetry, run dashboard/telemetry.sql in it, then paste that project's URL
// and ANON (public) key below. Until both are filled, telemetry is a NO-OP.
window.DRTelemetry = (function () {
  const TELEMETRY_URL = 'https://yyflcwfeybahkyicykxp.supabase.co'; // e.g. 'https://abcd.supabase.co'   ← maintainer fills
  const TELEMETRY_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl5Zmxjd2ZleWJhaGt5aWN5a3hwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MjgyMTAsImV4cCI6MjEwNDUwNDIxMH0.1RHfRVi-xSK_k7XOBfN2Fq9jGCD1WRGUgRYqw28sfIo'; // that project's ANON (public) key   ← maintainer fills

  // Origin guard: only pages served from these hostnames report, so forks and
  // local copies (which still carry the public key) never pollute your metrics.
  // Set to [] to disable the guard. Forking to your own Pages? put YOUR host
  // here (and your own TELEMETRY_URL/KEY above). Add 'localhost' to test locally.
  const TELEMETRY_HOSTS = ['ishpen.github.io'];

  const APP_VERSION = 'cardbridge-2026-09';
  const ID_KEY = 'cardbridge-anon-id';
  const OPTOUT_KEY = 'cardbridge-telemetry-optout';

  let _sessionId = null;

  function configured() { return !!(TELEMETRY_URL && TELEMETRY_KEY); }
  function isOptedOut() { try { return localStorage.getItem(OPTOUT_KEY) === '1'; } catch { return true; } }
  function dntOn() {
    const d = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    return d === '1' || d === 'yes';
  }
  function originOk() {
    if (!TELEMETRY_HOSTS.length) return true; // guard disabled
    try { return TELEMETRY_HOSTS.indexOf(location.hostname) !== -1; } catch { return false; }
  }
  function enabled() { return configured() && originOk() && !isOptedOut() && !dntOn(); }

  function anonId() {
    try {
      let id = localStorage.getItem(ID_KEY);
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2));
        localStorage.setItem(ID_KEY, id);
      }
      return id;
    } catch { return 'anon'; }
  }
  function sessionId() {
    if (!_sessionId) _sessionId = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2));
    return _sessionId;
  }

  // Strict allowlist — ONLY these keys, and only if numeric/boolean, are sent.
  const ALLOWED = new Set([
    'sessions', 'liveSessions', 'rooms', 'team', 'knownDocs', 'online',
    'syncEnabled', 'sharedIdentity', 'viewerUsed', 'signedIn',
  ]);
  function clean(props) {
    const out = {};
    if (props) for (const k of Object.keys(props)) {
      if (!ALLOWED.has(k)) continue;
      const v = props[k];
      if (typeof v === 'number' && isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  }

  async function track(event, props) {
    if (!enabled()) return;
    try {
      await fetch(TELEMETRY_URL.replace(/\/$/, '') + '/rest/v1/usage_events', {
        method: 'POST',
        headers: { apikey: TELEMETRY_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify([{
          anon_id: anonId(),
          session_id: sessionId(),
          event: String(event || '').slice(0, 40),
          props: clean(props),
          app_version: APP_VERSION,
        }]),
        keepalive: true,
      });
    } catch { /* never disrupt the app */ }
  }

  function optOut() { try { localStorage.setItem(OPTOUT_KEY, '1'); } catch {} }
  function optIn() { try { localStorage.removeItem(OPTOUT_KEY); } catch {} }

  return { track, optOut, optIn, isOptedOut, configured, enabled };
})();
