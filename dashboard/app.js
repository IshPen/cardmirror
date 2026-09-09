/* CardBridge — coach command center.
 *
 * A static page. Talks to two things:
 *   1. The relay's public GET /relay/health  (no auth).
 *   2. Supabase's REST API with the ANON key + Row-Level Security.
 *
 * It never sees a Postgres connection string and never reads ciphertext:
 * RLS only lets the anon key read relay_rooms and read/insert
 * dashboard_registry (see schema.sql).
 */
'use strict';

// ── Constants from the relay / findings ──────────────────────────────
const FREE_TIER_BYTES = 500 * 1024 * 1024; // Supabase free tier
const DB_MULTIPLIER    = 3.5;               // measured DB growth ÷ content bytes (findings §3)
const IDLE_GC_DAYS     = 7;                 // ROOM_IDLE_GC in the relay
const STALE_DAYS       = 2;                 // "approaching" = this many days or fewer remaining
const NOMINAL_ROOM     = 1.5 * 1024 * 1024; // fallback avg content size when no rooms yet

const CFG_KEY = 'debate-relay-dashboard-config';

// ── Config (localStorage) ────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); }
  catch { return null; }
}
function saveConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

let config = loadConfig();

// ── Small helpers ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// The relay stores naive UTC timestamps; make sure JS parses them as UTC.
function parseUtc(s) {
  if (!s) return null;
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(s);
  return new Date(hasZone ? s : s + 'Z');
}
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
}
function daysSince(date) {
  if (!date) return Infinity;
  return (Date.now() - date.getTime()) / 86400000;
}
function fmtAgo(date) {
  if (!date) return '—';
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Supabase REST ────────────────────────────────────────────────────
function sbHeaders() {
  return { apikey: config.anon, Authorization: 'Bearer ' + config.anon };
}
async function sbGet(path) {
  const res = await fetch(config.supabase.replace(/\/$/, '') + '/rest/v1/' + path, { headers: sbHeaders() });
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}
async function sbInsert(table, row) {
  const res = await fetch(config.supabase.replace(/\/$/, '') + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}

// ── Health ───────────────────────────────────────────────────────────
async function refreshHealth() {
  const setDot = (cls) => { for (const el of [$('health-dot'), $('health-dot-lg'), $('health-dot-side'), $('ribbon-dot')]) { if (el) el.className = 'dot ' + cls; } };
  const setMini = (t) => { for (const id of ['health-mini', 'health-side-sub']) { const m = $(id); if (m) m.textContent = t; } };
  const setLabel = (t) => { for (const id of ['ribbon-health', 'health-side']) { const m = $(id); if (m) m.textContent = t; } };
  $('health-text').textContent = 'Checking…';
  $('health-detail').textContent = '';
  setMini('checking…'); setLabel('Relay');
  try {
    const base = config.relay.replace(/\/$/, '');
    const t0 = performance.now();
    const res = await fetch(base + '/health', { cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      setDot('ok'); setLabel('Live');
      $('health-text').textContent = 'Relay is up';
      $('health-detail').textContent = `${base}/health · responded in ${ms} ms`;
      setMini(`up · ${ms} ms`);
    } else {
      setDot('bad'); setLabel('Degraded');
      $('health-text').textContent = 'Relay responded, but not healthy';
      $('health-detail').textContent = `HTTP ${res.status}`;
      setMini(`HTTP ${res.status}`);
    }
  } catch (e) {
    setDot('bad'); setLabel('Down');
    $('health-text').textContent = 'Relay is unreachable';
    $('health-detail').textContent = String(e.message || e) +
      ' — if it was idle, Render may be waking it (~60s). Try Refresh.';
    setMini('unreachable');
  }
}

// ── Rooms + registry ─────────────────────────────────────────────────
async function refreshData() {
  let rooms, registry;
  try {
    [rooms, registry] = await Promise.all([
      sbGet('relay_rooms?select=id,created_at,last_activity,bytes_used,tombstoned,created_by'),
      sbGet('dashboard_registry?select=room_id,label,owner,event,created_at'),
    ]);
  } catch (e) {
    const msg = `<tr><td colspan="8" class="error">${esc(e.message || e)}</td></tr>`;
    $('sessions-body').innerHTML = msg;
    $('stale-body').innerHTML = `<tr><td colspan="3" class="error">${esc(e.message || e)}</td></tr>`;
    $('storage-text').textContent = 'Could not load storage.';
    return;
  }

  // v2 attribution: live participants. Best-effort — a v1 relay has no
  // participants table/policy yet, so tolerate a failure and show blanks.
  const partsByRoom = new Map();
  try {
    const parts = await sbGet('relay_room_participants?select=room_id,label');
    for (const p of parts) {
      if (!partsByRoom.has(p.room_id)) partsByRoom.set(p.room_id, []);
      partsByRoom.get(p.room_id).push(p.label);
    }
  } catch { /* pre-v2 relay: no participants read-model yet */ }

  const byId = new Map(rooms.map((r) => [r.id, r]));
  _lastData = { rooms, registry, partsByRoom };
  renderSessions(registry, byId, partsByRoom);
  renderStale(rooms, registry);
  renderStorage(rooms);
  renderStats(rooms, partsByRoom);
  renderOverviewLive(rooms, registry, partsByRoom);
  renderPresence(rooms, registry, partsByRoom);
  renderActivityFeed(rooms, registry, partsByRoom);
  renderHeatmap(rooms);
  renderTeamView(rooms, registry, partsByRoom);
}
let _lastData = null;

// ── Monitoring: shared helpers ───────────────────────────────────────
function liveRooms(rooms) { return rooms.filter((r) => !r.tombstoned); }
function isLive(room) {
  return !room.tombstoned && daysSince(parseUtc(room.last_activity)) < IDLE_GC_DAYS;
}
// Distinct people currently connected (across all live rooms).
function onlineNames(partsByRoom) {
  const set = new Set();
  for (const list of partsByRoom.values()) for (const n of list) if (n && n !== 'anon') set.add(n);
  return [...set];
}
// group tag for a member name, from the Tokens-panel team list.
function groupOf(name) {
  if (!name) return '';
  const m = team().find((t) => (t.name || '').toLowerCase() === name.toLowerCase());
  return (m && m.group) || '';
}

function renderStats(rooms, partsByRoom) {
  const live = liveRooms(rooms).filter(isLive);
  const bytes = liveRooms(rooms).reduce((s, r) => s + (r.bytes_used || 0), 0);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('stat-live', live.length);
  set('stat-online', onlineNames(partsByRoom).length);
  set('stat-rooms', liveRooms(rooms).length);
  set('stat-storage', fmtBytes(bytes * DB_MULTIPLIER));
  set('ribbon-online', onlineNames(partsByRoom).length);
}

// Overview hero: the most-recently-active live sessions, with owner initials.
function renderOverviewLive(rooms, registry, partsByRoom) {
  const el = $('ov-live-list');
  if (!el) return;
  const labelOf = new Map(registry.map((r) => [r.room_id, { label: r.label, owner: r.owner }]));
  const live = liveRooms(rooms).filter(isLive)
    .sort((a, b) => parseUtc(b.last_activity) - parseUtc(a.last_activity));
  if (!live.length) {
    el.innerHTML = '<span class="ov-empty">No sessions are live right now.</span>';
    return;
  }
  const initial = (s) => (s || '·').trim().charAt(0).toUpperCase() || '·';
  el.innerHTML = live.slice(0, 4).map((r) => {
    const meta = labelOf.get(r.id) || {};
    const name = meta.label || (r.id.slice(0, 8) + '…');
    const who = meta.owner || r.created_by || '';
    return `<div class="ov-live-row"><span class="pav">${esc(initial(who || name))}</span>` +
      `<span class="nm">${esc(name)}</span>` +
      `<span class="rt">${esc(fmtAgo(parseUtc(r.last_activity)))}</span></div>`;
  }).join('');
}

// Who's online now — chips grouped by person, showing which rooms they're in.
function renderPresence(rooms, registry, partsByRoom) {
  const el = $('presence-list');
  if (!el) return;
  const labelOf = new Map(registry.map((r) => [r.room_id, r.label]));
  // person → set of room labels they're connected to
  const byPerson = new Map();
  for (const [roomId, list] of partsByRoom) {
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !isLive(room)) continue;
    const where = labelOf.get(roomId) || (roomId.slice(0, 8) + '…');
    for (const n of list) {
      const name = n || 'anon';
      if (!byPerson.has(name)) byPerson.set(name, new Set());
      byPerson.get(name).add(where);
    }
  }
  if (!byPerson.size) {
    el.innerHTML = '<span class="muted small">Nobody is connected to a session right now.</span>';
    return;
  }
  el.innerHTML = [...byPerson.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, rooms2]) =>
      `<span class="chip"><span class="dot ok"></span>${esc(name)}` +
      `<span class="chip-sub">${rooms2.size === 1 ? esc([...rooms2][0]) : rooms2.size + ' sessions'}</span></span>`)
    .join('');
}

// Activity feed — recent room events (created + last active) newest first.
function renderActivityFeed(rooms, registry, partsByRoom) {
  const el = $('activity-feed');
  if (!el) return;
  const labelOf = new Map(registry.map((r) => [r.room_id, r.label]));
  const nameFor = (r) => labelOf.get(r.id) || (r.id.slice(0, 8) + '…');
  const events = [];
  for (const r of rooms) {
    if (r.tombstoned) continue;
    if (r.created_at) {
      events.push({ t: parseUtc(r.created_at), kind: 'created',
        html: `<strong>${esc(r.created_by || 'Someone')}</strong> started <strong>${esc(nameFor(r))}</strong>` });
    }
    if (r.last_activity && r.last_activity !== r.created_at) {
      const live = isLive(r);
      const parts = partsByRoom.get(r.id) || [];
      events.push({ t: parseUtc(r.last_activity), kind: live ? 'live' : 'idle',
        html: `<strong>${esc(nameFor(r))}</strong> ${live ? 'was active' : 'went idle'}` +
          (live && parts.length ? ` · ${esc(parts.join(', '))} connected` : '') });
    }
  }
  events.sort((a, b) => (b.t ? b.t.getTime() : 0) - (a.t ? a.t.getTime() : 0));
  const top = events.slice(0, 40);
  if (!top.length) { el.innerHTML = '<li class="muted small">No activity yet.</li>'; return; }
  el.innerHTML = top.map((e) => {
    const dot = e.kind === 'live' ? 'live' : e.kind === 'idle' ? 'warn' : '';
    return `<li><span class="feed-when">${esc(fmtAgo(e.t))}</span>` +
      `<span class="feed-dot ${dot}"></span><span>${e.html}</span></li>`;
  }).join('');
}

// Activity heatmap — 8 weeks × 7 days, shaded by room-activity count per day.
function renderHeatmap(rooms) {
  const el = $('heatmap');
  if (!el) return;
  const DAY = 86400000;
  const now = Date.now();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = today.getTime() - 55 * DAY; // 8 weeks back, aligned below
  const counts = new Map(); // dayIndex (0..55) → count
  const bump = (ts) => {
    if (!ts) return;
    const d = ts.getTime();
    if (d < start || d > now) return;
    const idx = Math.floor((d - start) / DAY);
    counts.set(idx, (counts.get(idx) || 0) + 1);
  };
  for (const r of rooms) { bump(parseUtc(r.created_at)); if (r.last_activity !== r.created_at) bump(parseUtc(r.last_activity)); }
  const max = Math.max(1, ...counts.values());
  const level = (c) => (!c ? '' : c >= max * 0.75 ? 'h4' : c >= max * 0.5 ? 'h3' : c >= max * 0.25 ? 'h2' : 'h1');
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // 8 columns (weeks) × 7 rows (days). start aligned to Monday.
  const startDow = (new Date(start).getDay() + 6) % 7; // 0=Mon
  let html = '';
  for (let row = 0; row < 7; row++) {
    html += `<div class="heat-row"><span class="heat-label">${DOW[row]}</span>`;
    for (let col = 0; col < 8; col++) {
      const idx = col * 7 + row - startDow;
      const c = idx >= 0 && idx <= 55 ? (counts.get(idx) || 0) : -1;
      const title = c < 0 ? '' : `${c} event${c === 1 ? '' : 's'}`;
      html += `<span class="heat-cell ${c < 0 ? '' : level(c)}" title="${title}"></span>`;
    }
    html += '</div>';
  }
  html += '<div class="heat-legend">Less <span class="heat-cell"></span><span class="heat-cell h1"></span>' +
    '<span class="heat-cell h2"></span><span class="heat-cell h3"></span><span class="heat-cell h4"></span> More</div>';
  el.innerHTML = html;
}

// Per-member view — aggregates attribution (created_by + live participants).
function renderTeamView(rooms, registry, partsByRoom) {
  const body = $('team-view-body');
  if (!body) return;
  const stats = new Map(); // name → {created, inSessions:Set, bytes, last, online}
  const get = (name) => {
    if (!stats.has(name)) stats.set(name, { created: 0, inSessions: new Set(), bytes: 0, last: null, online: false });
    return stats.get(name);
  };
  const touch = (s, t) => { const d = parseUtc(t); if (d && (!s.last || d > s.last)) s.last = d; };
  for (const r of rooms) {
    if (r.tombstoned) continue;
    if (r.created_by) { const s = get(r.created_by); s.created++; s.bytes += r.bytes_used || 0; touch(s, r.last_activity || r.created_at); }
  }
  for (const [roomId, list] of partsByRoom) {
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !isLive(room)) continue;
    for (const n of list) { if (!n || n === 'anon') continue; const s = get(n); s.inSessions.add(roomId); s.online = true; touch(s, room.last_activity); }
  }
  // include roster/team members with no attribution yet
  for (const m of team()) if (m.name && m.role !== 'coach') get(m.name);

  // group filter options
  const groups = [...new Set(team().map((m) => m.group).filter(Boolean))].sort();
  const sel = $('team-group-filter');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">All groups</option>' + groups.map((g) => `<option${g === cur ? ' selected' : ''}>${esc(g)}</option>`).join('');
  }
  const filter = (sel && sel.value) || '';

  const rowsArr = [...stats.entries()]
    .filter(([name]) => !filter || groupOf(name) === filter)
    .sort((a, b) => (b[1].online - a[1].online) || (b[1].created - a[1].created) || a[0].localeCompare(b[0]));
  if (!rowsArr.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">No attributed members yet. Per-person tokens (Tokens panel) label who created/joined each room.</td></tr>';
    return;
  }
  body.innerHTML = rowsArr.map(([name, s]) => {
    const g = groupOf(name);
    return `<tr>
      <td><strong>${esc(name)}</strong></td>
      <td>${g ? `<span class="group-badge">${esc(g)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="num">${s.created}</td>
      <td class="num">${s.inSessions.size || '—'}</td>
      <td class="num">${s.bytes ? fmtBytes(s.bytes) : '—'}</td>
      <td>${s.last ? esc(fmtAgo(s.last)) : '<span class="muted">—</span>'}</td>
      <td>${s.online ? '<span class="status-live">● online</span>' : '<span class="status-dead">offline</span>'}</td>
    </tr>`;
  }).join('');
}

// ── Path B (member invites) + doc viewer ─────────────────────────────
// The member + viewer bundles need http (WASM / IndexedDB / ES modules),
// so they load lazily and fail gracefully from file://. Rooms the
// dashboard has been invited to are persisted by the member bundle in
// localStorage; we read that store directly so titles/keys show even
// before the bundle loads.
const KNOWN_ROOMS_KEY = 'debate-relay-known-rooms';
let _memberMod = null;
let _viewerMod = null;

async function loadMember() { return (_memberMod ||= await import('./member/dist/member.mjs')); }
async function loadViewer() { return (_viewerMod ||= await import('./viewer/dist/viewer.mjs')); }
function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

function knownRoomsStore() {
  try { return JSON.parse(localStorage.getItem(KNOWN_ROOMS_KEY) || '{}') || {}; } catch { return {}; }
}
function knownRoom(roomId) { return knownRoomsStore()[roomId]; }

// ── New-invite notifications ─────────────────────────────────────────
// When a student shares a doc with the dashboard, a new entry lands in the
// known-rooms store. We alert the coach in-page (a dismissible banner) and,
// if they've granted permission, via a desktop notification. This is the
// zero-setup path — it fires only while the dashboard is open. (Emailing the
// coach when the dashboard is CLOSED needs a server-side sender; see the
// opt-in relay hook + RELAY_NOTIFY_* env in relay/README.md.)
const NOTIFIED_KEY = 'debate-relay-notified-rooms';
function notifiedList() {
  try { return JSON.parse(localStorage.getItem(NOTIFIED_KEY) || 'null'); } catch { return null; }
}
function saveNotified(ids) { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids)); }

// Compare the current known-rooms against the set we've already announced and
// surface anything new. First run ever seeds the baseline silently so we don't
// announce rooms invited before this feature existed.
function announceNewInvites() {
  const known = knownRoomsStore();
  const ids = Object.keys(known);
  const prev = notifiedList();
  if (prev === null) { saveNotified(ids); return; } // baseline, no burst
  const seen = new Set(prev);
  const fresh = ids.filter((id) => !seen.has(id));
  if (!fresh.length) return;
  for (const id of fresh) {
    const title = (known[id] && known[id].title) || 'Untitled document';
    showInviteNotice(id, title);
    desktopNotify(title);
  }
  saveNotified(ids);
}

function showInviteNotice(roomId, title) {
  const stack = $('notice-stack');
  if (!stack) return;
  const bar = document.createElement('div');
  bar.className = 'notice';
  const msg = document.createElement('span');
  msg.className = 'notice-msg';
  msg.textContent = 'New document shared: ' + title;
  const open = document.createElement('button');
  open.className = 'btn small';
  open.textContent = 'Open';
  open.onclick = () => { bar.remove(); openDoc(roomId); };
  const dismiss = document.createElement('button');
  dismiss.className = 'btn ghost small';
  dismiss.textContent = 'Dismiss';
  dismiss.onclick = () => bar.remove();
  bar.append(msg, open, dismiss);
  stack.appendChild(bar);
}

function desktopNotify(title) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('CardBridge — new document shared', { body: title });
    }
  } catch { /* notifications unsupported / blocked */ }
}

// Poll the mailbox for new invites (needs the dashboard's own relay token).
async function pollMemberInvites() {
  if (!config || !config.relay || !config.relaytoken) return;
  try {
    const m = await loadMember();
    await m.pollInvites(config.relay, config.relaytoken);
  } catch { /* file:// or offline — persisted invites still display */ }
  announceNewInvites();
}

// Emailable people = team members (name + email) plus roster entries not
// already covered. De-duped by lowercased email.
function emailablePeople() {
  const out = [];
  const seen = new Set();
  const add = (name, email) => {
    const e = (email || '').trim();
    if (!e || !e.includes('@') || seen.has(e.toLowerCase())) return;
    seen.add(e.toLowerCase());
    out.push({ name: (name || e).trim(), email: e });
  };
  for (const m of team()) if (m.role !== 'coach') add(m.name, m.email);
  for (const m of team()) if (m.role === 'coach') add(m.name, m.email);
  for (const { name, email } of rosterMap().values()) add(name, email);
  return out;
}

// Populate the "Request access" recipient picker from the roster/team.
function fillRequestRecipients() {
  const sel = $('member-request-to');
  if (!sel) return;
  const people = emailablePeople();
  if (!people.length) {
    sel.innerHTML = '<option value="">No emails yet — add people in Tokens / Roster</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML =
    people.map((p) => `<option value="${esc(p.email)}">${esc(p.name)} &lt;${esc(p.email)}&gt;</option>`).join('') +
    (people.length > 1 ? `<option value="${esc(people.map((p) => p.email).join(','))}">— Everyone (${people.length}) —</option>` : '');
}

// Build a "please share to the dashboard" mailto carrying the member code.
function buildRequestMailto(emails, name, code) {
  const who = name && !name.includes(',') && !name.includes('@') ? name : 'there';
  const subject = 'Access request: share your CardMirror document with your coach';
  const body =
    `Hi ${who},\n\n` +
    `Your coach is requesting access to view your debate document in CardMirror. ` +
    `Nothing is shared until you invite — this just lets your coach see the document's ` +
    `name and open it while your session is live.\n\n` +
    `One-time setup — add your coach's dashboard code:\n` +
    `  1. In CardMirror, open Settings → Collaboration.\n` +
    `  2. Add a contact / member code and paste this code:\n\n` +
    `     ${code}\n\n` +
    `  3. Save it (name it “Coach” or “Dashboard”).\n\n` +
    `Then, whenever you want to share:\n` +
    `  • Be in a live session on the document.\n` +
    `  • Invite the “Coach” / “Dashboard” contact.\n\n` +
    `That's it — your coach will then see the doc and can open it.\n`;
  return `mailto:${emails}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Member-code modal.
async function showMember() {
  $('member-modal').classList.remove('hidden');
  $('member-status').textContent = '';
  $('member-request-status').textContent = '';
  $('member-note').classList.add('hidden');
  $('member-code').textContent = '…';
  fillRequestRecipients();
  $('member-routing').textContent = '…';
  try {
    const m = await loadMember();
    $('member-code').textContent = await m.getMemberCode();
    m.getRoutingId().then((r) => { $('member-routing').textContent = r; }).catch(() => {});
  } catch {
    $('member-code').textContent = '(unavailable)';
    $('member-routing').textContent = '(unavailable)';
    $('member-note').textContent =
      'Serve the dashboard over http to enable the member identity — it can’t run from a file://. ' +
      'Try: python -m http.server 8000, then open http://localhost:8000/dashboard/';
    $('member-note').classList.remove('hidden');
  }
}

// Ask the browser for desktop-notification permission (needs a user gesture,
// hence a button). Once granted, announceNewInvites() will pop native alerts.
async function enableDesktopAlerts() {
  const status = $('member-status');
  if (typeof Notification === 'undefined') { status.textContent = 'This browser has no notification support.'; return; }
  if (Notification.permission === 'granted') { status.textContent = 'Desktop alerts already on.'; return; }
  if (Notification.permission === 'denied') { status.textContent = 'Alerts are blocked — enable them in your browser’s site settings.'; return; }
  try {
    const p = await Notification.requestPermission();
    status.textContent = p === 'granted' ? 'Desktop alerts on — you’ll be notified when a doc is shared.' : 'Alerts not enabled.';
  } catch { status.textContent = 'Could not request notification permission.'; }
}

// Open the coach's mail client with a pre-filled "share to the dashboard"
// request. Needs the member code (shown above) and a picked recipient.
function sendAccessRequest() {
  const sel = $('member-request-to');
  const emails = sel && sel.value;
  const code = ($('member-code').textContent || '').trim();
  const status = $('member-request-status');
  if (!emails) { status.textContent = 'Pick a student first (or add emails in Tokens / Roster).'; return; }
  if (!code || code === '…' || code === '(unavailable)') {
    status.textContent = 'Member code isn’t ready — serve the dashboard over http, then reopen this panel.';
    return;
  }
  const picked = sel.options[sel.selectedIndex];
  const name = picked && picked.text.includes('<') ? picked.text.split('<')[0].trim() : '';
  window.location.href = buildRequestMailto(emails, name, code);
  status.textContent = 'Opening your email client…';
}
function closeMember() { $('member-modal').classList.add('hidden'); }

// Doc viewer modal. Renders the decrypted doc inside an <iframe> so the
// editor's real stylesheet (global .pmd-* / body / #editor rules) reproduces
// native CardMirror formatting without leaking into the dashboard page. A
// heading outline rail navigates it; "Go live" streams edits in real time.
let _viewerRoomId = null;      // room currently open
let _liveHandle = null;        // active live subscription (null = static)
let _liveFrame = null;         // the live iframe
let _liveFrameReady = false;   // its load event fired
let _liveFragment = '';        // latest #editor innerHTML awaiting apply

function showViewerMsg(html) {
  $('viewer-body').innerHTML = '<div class="viewer-msg">' + html + '</div>';
}
function makeViewerFrame() {
  const body = $('viewer-body');
  body.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.className = 'viewer-frame';
  frame.setAttribute('sandbox', 'allow-same-origin'); // styles/fonts, no scripts
  frame.setAttribute('title', 'Document preview');
  body.appendChild(frame);
  return frame;
}
function showViewerDoc(fullHtmlPage) {
  makeViewerFrame().srcdoc = fullHtmlPage;
}
function viewerFrame() {
  return _liveFrame || $('viewer-body').querySelector('iframe');
}

// Heading outline rail. Ids match the schema's data-id on each heading, so a
// click scrolls the rendered iframe to that heading.
// Which heading levels (1=Pocket … 4=Tag/Analytic) show in the nav rail.
const NAV_LEVELS_KEY = 'debate-relay-nav-levels';
function navLevels() {
  try { return JSON.parse(localStorage.getItem(NAV_LEVELS_KEY) || 'null') || { 1: true, 2: true, 3: true, 4: true }; }
  catch { return { 1: true, 2: true, 3: true, 4: true }; }
}
let _lastOutline = [];
function buildOutline(entries) {
  _lastOutline = entries || [];
  const nav = $('viewer-outline');
  const levels = navLevels();
  const shown = _lastOutline.filter((e) => levels[e.level || 1]);
  if (!shown.length) {
    nav.innerHTML = '<p class="muted small">No headings</p>';
    return;
  }
  nav.innerHTML = '';
  for (const e of shown) {
    const a = document.createElement('a');
    a.className = 'outline-item lvl' + (e.level || 1);
    // Empty heading (e.g. a blank pocket): keep an indented filler row, not
    // an "(untitled)" label.
    if (e.text && e.text.trim()) a.textContent = e.text;
    else { a.innerHTML = '&nbsp;'; a.classList.add('outline-empty'); }
    if (e.id) a.onclick = () => scrollToHeading(e.id);
    else a.classList.add('disabled');
    nav.appendChild(a);
  }
}
function toggleNavLevel(lvl) {
  const levels = navLevels();
  levels[lvl] = !levels[lvl];
  localStorage.setItem(NAV_LEVELS_KEY, JSON.stringify(levels));
  const btn = document.querySelector('.lvl-toggle[data-lvl="' + lvl + '"]');
  if (btn) btn.classList.toggle('active', levels[lvl]);
  buildOutline(_lastOutline);
}
function initNavLevelToggles() {
  const levels = navLevels();
  for (const btn of document.querySelectorAll('.lvl-toggle')) {
    const lvl = +btn.dataset.lvl;
    btn.classList.toggle('active', !!levels[lvl]);
    btn.onclick = () => toggleNavLevel(lvl);
  }
}

// Comments panel (populated by the editor's onComments callback while editing).
function renderComments(comments) {
  const list = $('comments-list');
  if (!list) return;
  if (!comments || !comments.length) {
    list.innerHTML = '<p class="muted small">No comments yet. In Edit mode, select text and click Comment.</p>';
    return;
  }
  list.innerHTML = '';
  for (const c of comments) {
    const div = document.createElement('div');
    div.className = 'comment-item';
    div.innerHTML =
      '<div class="comment-meta"><span class="comment-author">' + esc(c.author) + '</span>' +
      (c.date ? '<span class="comment-date">' + esc(new Date(c.date).toLocaleString()) + '</span>' : '') + '</div>' +
      (c.snippet ? '<div class="comment-snippet">“' + esc(c.snippet) + '”</div>' : '') +
      '<div class="comment-text">' + esc(c.text || '(no text)') + '</div>';
    list.appendChild(div);
  }
}
function toggleComments() {
  const panel = $('viewer-comments');
  if (!panel) return;
  const show = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  const btn = $('viewer-comments-btn');
  if (btn) btn.classList.toggle('primary', show);
}
function scrollToHeading(id) {
  const frame = viewerFrame();
  try {
    const doc = frame && frame.contentDocument;
    const el = doc && doc.querySelector('[data-id="' + (window.CSS ? CSS.escape(id) : id) + '"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch { /* cross-doc access raced a reload — ignore */ }
}

async function openDoc(roomId) {
  stopLive();
  closeHistory();
  teardownEdit();
  editRestoreChrome();
  _viewerRoomId = roomId;
  const kr = knownRoom(roomId);
  $('viewer-title').textContent = (kr && kr.title) || 'Document';
  $('viewer-modal').classList.remove('hidden');
  $('viewer-outline').innerHTML = '';
  renderComments([]); // populated by the editor while editing
  setLiveStatus(null);
  const canLive = !!(kr && kr.keyB64 && config && config.relay && config.relaytoken);
  $('viewer-live-btn').classList.toggle('hidden', !canLive);
  $('viewer-live-btn').textContent = '● Go live';
  // Edit (experimental) needs a key + the dashboard's relay token, same as live.
  $('viewer-edit-btn').classList.toggle('hidden', !canLive);
  // "Note" is available when we captured the author's pairing code on invite.
  $('viewer-note-btn').classList.toggle('hidden', !(kr && kr.senderCode && config && config.relaytoken));
  $('viewer-note-bar').classList.add('hidden');
  showViewerMsg('<span class="muted">Loading… (first open downloads the ~1.5 MB decoder)</span>');
  try {
    if (!kr || !kr.keyB64) throw new Error('No key for this room — it must invite the dashboard first.');
    const v = await loadViewer();
    const doc = await v.getRoomDoc({
      supabaseUrl: config.supabase, anonKey: config.anon,
      roomId, keyBytes: b64ToBytes(kr.keyB64),
    });
    if (_viewerRoomId !== roomId) return; // user moved on while decoding
    if (doc.empty) {
      showViewerMsg('<span class="muted">No content returned. Either the room is empty, ' +
        'or <code>dashboard/viewer/enable-viewer.sql</code> hasn’t been run in Supabase (it grants read ' +
        'access to the encrypted bytes).</span>');
      return;
    }
    if (doc.title) $('viewer-title').textContent = doc.title;
    buildOutline(doc.outline);
    // `document` is the fully-styled iframe page; fall back to the bare
    // fragment for an older bundle that predates it.
    if (doc.document) showViewerDoc(doc.document);
    else showViewerMsg(doc.html);
  } catch (e) {
    showViewerMsg(
      '<span class="error">' + esc(String(e.message || e)) + '</span>' +
      '<div class="muted small" style="margin-top:8px">If a module failed to load, serve the dashboard over http. ' +
      'If it says permission/denied, run <code>dashboard/viewer/enable-viewer.sql</code> in Supabase.</div>');
  }
}

// ── Live sync ────────────────────────────────────────────────────────
const LIVE_STATUS_TEXT = {
  connecting: '○ connecting…', live: '● live', offline: '● offline (retrying)',
  ended: '■ session ended', full: '■ room full', error: '■ live error',
};
function setLiveStatus(status, detail) {
  const el = $('viewer-live-status');
  if (!status) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.className = 'live-badge live-' + status;
  el.textContent = LIVE_STATUS_TEXT[status] || status;
  if (detail) el.title = detail;
}
function applyLiveFragment() {
  if (!_liveFrame || !_liveFrameReady) return;
  try {
    const ed = _liveFrame.contentDocument && _liveFrame.contentDocument.getElementById('editor');
    if (ed) ed.innerHTML = _liveFragment;
  } catch { /* frame reloading — the next emit re-applies */ }
}
function onLiveDoc(snap) {
  if (snap.title) $('viewer-title').textContent = snap.title;
  buildOutline(snap.outline);
  _liveFragment = snap.fragment;
  if (snap.first) {
    _liveFrame = makeViewerFrame();
    _liveFrameReady = false;
    _liveFrame.addEventListener('load', () => { _liveFrameReady = true; applyLiveFragment(); });
    _liveFrame.srcdoc = snap.page; // full page already carries this content
  } else {
    applyLiveFragment(); // swap #editor in place — preserves scroll
  }
}
async function goLive() {
  const roomId = _viewerRoomId;
  const kr = roomId && knownRoom(roomId);
  if (!kr || !kr.keyB64) return;
  if (_liveHandle) { stopLive(); $('viewer-live-btn').textContent = '● Go live'; return; }
  if (!config.relaytoken) { setLiveStatus('error', 'No dashboard relay token (add a Dashboard entry in Tokens).'); return; }
  setLiveStatus('connecting');
  $('viewer-live-btn').textContent = '■ Stop live';
  try {
    const v = await loadViewer();
    const handle = await v.startLiveRoom(
      { relayUrl: config.relay, token: config.relaytoken, roomId, keyBytes: b64ToBytes(kr.keyB64) },
      { onDoc: onLiveDoc, onStatus: setLiveStatus },
    );
    if (_viewerRoomId !== roomId) { handle.stop(); return; } // moved on mid-connect
    _liveHandle = handle;
  } catch (e) {
    setLiveStatus('error', String(e.message || e));
    $('viewer-live-btn').textContent = '● Go live';
  }
}
function stopLive() {
  if (_liveHandle) { try { _liveHandle.stop(); } catch { /* already gone */ } }
  _liveHandle = null;
  _liveFrame = null;
  _liveFrameReady = false;
  _liveFragment = '';
  setLiveStatus(null);
}
function closeViewer() {
  stopLive();
  closeHistory();
  teardownEdit();
  editRestoreChrome();
  _viewerRoomId = null;
  $('viewer-modal').classList.add('hidden');
}

// ── Viewer tools: export, PDF, backup, history ───────────────────────
function roomOpts(roomId) {
  const kr = roomId && knownRoom(roomId);
  if (!kr || !kr.keyB64) return null;
  return { supabaseUrl: config.supabase, anonKey: config.anon, roomId, keyBytes: b64ToBytes(kr.keyB64) };
}

async function exportViewerDocx() {
  const opts = roomOpts(_viewerRoomId);
  if (!opts) { setLiveStatus('error', 'No key for this room — it must invite the dashboard first.'); return; }
  const btn = $('viewer-docx-btn'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Exporting…';
  try {
    const v = await loadViewer();
    await v.downloadRoomDocx(opts, $('viewer-title').textContent || 'document');
  } catch (e) {
    setLiveStatus('error', String(e.message || e));
    alert('Could not export: ' + (e.message || e));
  } finally { btn.disabled = false; btn.textContent = old; }
}

function printViewerPDF() {
  const f = viewerFrame();
  try {
    if (f && f.contentWindow) { f.contentWindow.focus(); f.contentWindow.print(); }
    else window.print();
  } catch { window.print(); }
}

// Version history scrubber.
let _hist = null, _histFrame = null, _histReady = false, _histFragment = '', _histTimer = null;
function swapFrameEditor(frame, html) {
  try { const ed = frame && frame.contentDocument && frame.contentDocument.getElementById('editor'); if (ed) ed.innerHTML = html; } catch { /* reloading */ }
}
async function openHistory() {
  const opts = roomOpts(_viewerRoomId);
  if (!opts) { setLiveStatus('error', 'No key for this room — it must invite the dashboard first.'); return; }
  stopLive();
  $('viewer-live-btn').classList.add('hidden');
  $('viewer-history-bar').classList.remove('hidden');
  $('hist-label').textContent = 'Loading history…';
  try {
    const v = await loadViewer();
    _hist = await v.loadHistory(opts);
    const slider = $('hist-slider');
    slider.max = String(_hist.count - 1);
    slider.value = String(_hist.count - 1);
    renderHistAt(_hist.count - 1, true);
  } catch (e) {
    $('hist-label').textContent = 'History unavailable: ' + (e.message || e) +
      ' (needs enable-viewer.sql).';
  }
}
function renderHistAt(i, first) {
  if (!_hist) return;
  const idx = Math.max(0, Math.min(_hist.count - 1, +i));
  const step = _hist.at(idx);
  if (step.title) $('viewer-title').textContent = step.title;
  buildOutline(step.outline);
  const t = _hist.times[idx];
  // created_at is naive UTC — parseUtc appends 'Z' so it renders in the coach's
  // local timezone (else it'd read as local and be hours off).
  const when = idx === 0 ? 'start (compacted)' : (t ? parseUtc(t).toLocaleString() : 'revision ' + idx);
  $('hist-label').textContent = `${when}  ·  ${idx + 1}/${_hist.count}`;
  _histFragment = step.fragment;
  if (first) {
    _histFrame = makeViewerFrame();
    _histReady = false;
    _histFrame.addEventListener('load', () => { _histReady = true; swapFrameEditor(_histFrame, _histFragment); });
    _histFrame.srcdoc = step.page;
  } else if (_histReady) {
    swapFrameEditor(_histFrame, _histFragment);
  }
}
function toggleHistPlay() {
  if (_histTimer) { clearInterval(_histTimer); _histTimer = null; $('hist-play').textContent = '▶'; return; }
  if (!_hist) return;
  $('hist-play').textContent = '⏸';
  _histTimer = setInterval(() => {
    const slider = $('hist-slider');
    let v = +slider.value + 1;
    if (v > _hist.count - 1) { v = _hist.count - 1; toggleHistPlay(); }
    slider.value = String(v); renderHistAt(v, false);
  }, 600);
}
function closeHistory() {
  if (_histTimer) { clearInterval(_histTimer); _histTimer = null; }
  if ($('hist-play')) $('hist-play').textContent = '▶';
  _hist = null; _histFrame = null; _histReady = false; _histFragment = '';
  const bar = $('viewer-history-bar'); if (bar) bar.classList.add('hidden');
  const live = $('viewer-live-btn'); if (live) live.classList.remove('hidden');
}
function exitHistoryToDoc() {
  closeHistory();
  if (_viewerRoomId) openDoc(_viewerRoomId); // reopen the current (latest) doc
}

async function backupAll() {
  const store = knownRoomsStore();
  const ids = Object.keys(store).filter((id) => store[id] && store[id].keyB64);
  const status = $('backup-status');
  status.classList.remove('hidden');
  if (!ids.length) {
    status.textContent = 'No openable docs yet — students must invite the dashboard into their sessions first.';
    return;
  }
  const entries = ids.map((id) => ({ opts: roomOpts(id), title: store[id].title || id.slice(0, 8) }));
  const btn = $('backup-btn'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Backing up…';
  status.textContent = `Exporting 0/${entries.length}…`;
  try {
    const v = await loadViewer();
    const ymd = new Date().toISOString().slice(0, 10);
    const res = await v.backupAllDocx(entries, ymd, (p) => {
      status.textContent = `Exporting ${p.done}/${p.total}…` + (p.ok ? '' : ` (skipped ${p.name})`);
    });
    status.textContent = `Backed up ${res.ok} doc(s)${res.failed ? `, ${res.failed} skipped` : ''} — downloaded debate-relay-backup-${ymd}.zip.`;
  } catch (e) {
    status.textContent = 'Backup failed: ' + (e.message || e);
  } finally { btn.disabled = false; btn.textContent = old; }
}

// Send a plain-text note to the author (arrives in their CardMirror Receive
// pill). Available when we captured their pairing code from an invite.
function toggleNoteBar() {
  const bar = $('viewer-note-bar');
  const showing = !bar.classList.contains('hidden');
  bar.classList.toggle('hidden', showing);
  if (!showing) { $('note-status').textContent = ''; $('note-text').focus(); }
}
async function sendNoteNow() {
  const kr = _viewerRoomId && knownRoom(_viewerRoomId);
  const status = $('note-status');
  if (!kr || !kr.senderCode) { status.textContent = 'No author code for this room (they must invite the dashboard first).'; return; }
  if (!config.relaytoken) { status.textContent = 'Needs the dashboard relay token (Tokens → Dashboard entry).'; return; }
  const text = $('note-text').value.trim();
  if (!text) { status.textContent = 'Type a note first.'; return; }
  const btn = $('note-send'); btn.disabled = true; status.textContent = 'Sending…';
  try {
    const m = await loadMember();
    const ok = await m.sendNote(config.relay, config.relaytoken, kr.senderCode, text, 'Coach');
    status.textContent = ok ? '✓ Sent — appears in their Receive pill.' : 'The relay rejected the note.';
    if (ok) $('note-text').value = '';
  } catch (e) { status.textContent = 'Failed: ' + (e.message || e); }
  finally { btn.disabled = false; }
}

// ── Editable mode (EXPERIMENTAL) ─────────────────────────────────────
// Writes to the LIVE shared document. Reuses CardMirror's audited collab
// session; still, verify with two windows before real use.
let _editHandle = null;
const EDIT_WARNING =
  'Experimental — editing writes to the LIVE shared document.\n\n' +
  'Your edits and inline comments sync to everyone in the session in real time. ' +
  'This has not been battle-tested; try it with two windows before using it on ' +
  'real work, and keep CardMirror as the source of truth.\n\nStart editing?';
function setEditStatus(status, detail) {
  const el = $('edit-status');
  if (!el) return;
  el.className = 'live-badge live-' + status;
  el.textContent = status === 'live' ? '● editing (synced)'
    : status === 'connecting' ? '○ connecting…' : status;
  if (detail) el.title = detail;
}
function editRestoreChrome() {
  $('viewer-edit-bar').classList.add('hidden');
  $('viewer-edit-btn').textContent = 'Edit';
  $('viewer-history-btn').classList.remove('hidden');
  $('viewer-live-btn').classList.remove('hidden');
}
async function teardownEdit() {
  if (_editHandle) { const h = _editHandle; _editHandle = null; try { await h.stop(); } catch { /* down */ } }
}
async function exitEdit() {
  await teardownEdit();
  editRestoreChrome();
  if (_viewerRoomId) openDoc(_viewerRoomId); // back to the read-only render
}
async function startEdit() {
  if (_editHandle) { exitEdit(); return; }
  const opts = roomOpts(_viewerRoomId);
  if (!opts) { setLiveStatus('error', 'No key for this room — it must invite the dashboard first.'); return; }
  if (!config.relaytoken) { setLiveStatus('error', 'Needs the dashboard relay token (Tokens → Dashboard entry).'); return; }
  if (!window.confirm(EDIT_WARNING)) return;
  stopLive(); closeHistory();
  $('viewer-history-btn').classList.add('hidden');
  $('viewer-live-btn').classList.add('hidden');
  $('viewer-edit-bar').classList.remove('hidden');
  $('viewer-edit-btn').textContent = 'Stop editing';
  setEditStatus('connecting');
  const frame = makeViewerFrame();
  try {
    const v = await loadViewer();
    const handle = await v.mountEditor(
      frame,
      { relayUrl: config.relay, token: config.relaytoken, roomId: _viewerRoomId, keyBytes: opts.keyBytes },
      { onStatus: setEditStatus, onOutline: buildOutline, onComments: renderComments },
    );
    if (!$('viewer-body').contains(frame)) { await handle.stop(); return; } // moved on mid-connect
    _editHandle = handle;
  } catch (e) {
    setEditStatus('error', String(e.message || e));
    showViewerMsg('<span class="error">Could not start editing: ' + esc(String(e.message || e)) + '</span>' +
      '<div class="muted small" style="margin-top:8px">Serve over http; the room must be live and reachable.</div>');
    editRestoreChrome();
  }
}
function addCommentFlow() {
  if (!_editHandle) return;
  const input = $('comment-text');
  const text = (input.value || '').trim();
  if (!_editHandle.hasSelection()) { setEditStatus('live', 'Select text in the document first, then Comment.'); return; }
  if (!text) { input.focus(); return; }
  if (_editHandle.addComment(text)) { input.value = ''; setEditStatus('live', 'Comment added — synced to the session.'); }
}
function applyHeading(type) {
  if (!_editHandle) return;
  const cap = type[0].toUpperCase() + type.slice(1);
  const r = _editHandle.setHeading(type);
  setEditStatus('live', r === 'converted'
    ? cap + ' applied.'
    : 'Couldn’t convert here — click into a paragraph, heading, tag, or card line first.');
}
function applyTag() {
  if (!_editHandle) return;
  setEditStatus('live', _editHandle.setTag() ? 'Tag / card applied.' : 'Couldn’t make a tag here.');
}
function clearFormattingFlow() {
  if (!_editHandle) return;
  setEditStatus('live', _editHandle.clearFormatting() ? 'Formatting cleared.' : 'Nothing to clear here.');
}
function applyFmt(name, attrs) {
  if (_editHandle) _editHandle.applyMark(name, attrs);
}
function applyHighlight() {
  if (!_editHandle) return;
  const color = ($('fmt-hl-color') && $('fmt-hl-color').value) || 'yellow';
  _editHandle.setHighlight(color);
}

// ── Roster + "Ask for access" (mailto) ───────────────────────────────
// The relay only knows names (v2 labels / registry owner), never emails.
// The coach supplies a name→email roster, kept in this browser only.
function rosterMap() {
  const map = new Map();
  for (const line of (config.roster || '').split('\n')) {
    const m = line.match(/^\s*(.+?)\s*[=:,]\s*(.+?)\s*$/);
    if (m && m[2].includes('@')) map.set(m[1].toLowerCase(), { name: m[1], email: m[2] });
  }
  return map;
}

// Everyone associated with a room: registry owner + v2 creator + participants.
function roomPeople(reg, room, parts) {
  const names = [];
  const push = (n) => {
    if (n && n !== 'anon' && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  };
  if (reg) push(reg.owner);
  if (room) push(room.created_by);
  for (const p of parts) push(p);
  return names;
}

// A mailto ✉️ button asking a room's people for the share code — or a
// disabled hint when nobody's emailable yet.
function askButton(reg, room, parts) {
  const people = roomPeople(reg, room, parts);
  if (!people.length) {
    return '<a class="btn-ask disabled" title="No named people on this room yet (needs per-student tokens or a registered owner)">Ask</a>';
  }
  const roster = rosterMap();
  const known = people.map((n) => roster.get(n.toLowerCase())).filter(Boolean);
  const missing = people.filter((n) => !roster.get(n.toLowerCase()));
  if (!known.length) {
    return `<a class="btn-ask disabled" title="No email on file for: ${esc(people.join(', '))} — add them in Settings → Roster">Ask</a>`;
  }
  const label = (reg && reg.label) || 'your session';
  const subject = `CardMirror: access to “${label}”`;
  const body =
    `Hi ${known.map((k) => k.name).join(', ')},\n\n` +
    `Could you give me access to the doc you're working on (“${label}”)? In CardMirror, ` +
    `open Settings → Collaboration and send me the share code for this session.\n\nThanks!`;
  const href =
    `mailto:${known.map((k) => k.email).join(',')}` +
    `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const title = missing.length
    ? `Emailing ${known.map((k) => k.name).join(', ')} · no email on file for: ${missing.join(', ')}`
    : `Email ${known.map((k) => k.name).join(', ')}`;
  return `<a class="btn-ask" href="${esc(href)}" title="${esc(title)}">Ask</a>`;
}

function renderSessions(registry, byId, partsByRoom) {
  const body = $('sessions-body');
  const regById = new Map(registry.map((r) => [r.room_id, r]));

  // Every live room (registered or not) + registered rooms that have died.
  const entries = [];
  for (const room of byId.values()) {
    if (!room.tombstoned) entries.push({ live: true, room, reg: regById.get(room.id), roomId: room.id });
  }
  for (const reg of registry) {
    const room = byId.get(reg.room_id);
    if (!room || room.tombstoned) entries.push({ live: false, room: null, reg, roomId: reg.room_id });
  }

  if (!entries.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">No rooms yet. Start a session in CardMirror (or “+ Add session”).</td></tr>';
    $('sessions-note').textContent = '';
    return;
  }

  const labelText = (e) => (e.reg && e.reg.label) || '';
  entries.sort((a, b) => (b.live - a.live) || labelText(a).localeCompare(labelText(b)) || a.roomId.localeCompare(b.roomId));

  const rows = entries.map((e) => {
    const { live, room, reg, roomId } = e;
    const last = live ? parseUtc(room.last_activity) : null;
    const status = live ? '<span class="status-live">live</span>' : '<span class="status-dead">dead</span>';
    const parts = live ? (partsByRoom.get(roomId) || []) : [];
    const partCell = parts.length
      ? esc(parts.map((p) => p || 'anon').join(', '))
      : (live ? '<span class="muted">none connected</span>' : '—');
    // Name priority: registry label → doc name from an invite → unnamed.
    const kr = knownRoom(roomId);
    const labelCell = reg
      ? esc(reg.label)
      : (kr && kr.title
          ? `${esc(kr.title)} <span class="muted small">(from invite)</span>`
          : `<span class="muted">(unnamed)</span> <a class="btn-ask" data-name="${esc(roomId)}">name</a>`);
    const openBtn = (kr && kr.keyB64) ? ` <a class="btn-open" data-open="${esc(roomId)}">Open</a>` : '';
    return `<tr>
      <td>${labelCell}<div class="room-id">${esc(roomId.slice(0, 8))}…</div></td>
      <td>${(reg && esc(reg.owner)) || '—'}</td>
      <td>${(reg && esc(reg.event)) || '—'}</td>
      <td>${live ? (esc(room.created_by) || '<span class="muted">—</span>') : '—'}</td>
      <td>${partCell}</td>
      <td>${live ? fmtBytes(room.bytes_used) : '—'}</td>
      <td>${live ? esc(fmtAgo(last)) : '—'}</td>
      <td>${status}${live ? ' ' + askButton(reg, room, parts) : ''}${openBtn}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');

  // "name" a still-unregistered live room (we already know its room id; no
  // share code needed — this only stores a label, never a key).
  body.querySelectorAll('[data-name]').forEach((a) => {
    a.onclick = async () => {
      const label = prompt('Name this room:');
      if (!label || !label.trim()) return;
      try {
        await sbInsert('dashboard_registry', { room_id: a.dataset.name, label: label.trim() });
        await refreshData();
      } catch (err) { alert('Could not save: ' + (err.message || err)); }
    };
  });

  // "Open" a room the dashboard holds a key for (via an invite).
  body.querySelectorAll('[data-open]').forEach((a) => {
    a.onclick = () => openDoc(a.dataset.open);
  });

  const liveCount = entries.filter((e) => e.live).length;
  const named = entries.filter((e) => e.live && e.reg).length;
  $('sessions-note').textContent =
    `${liveCount} live (${named} named) · ${entries.length - liveCount} dead`;
}

function renderStale(rooms, registry) {
  const labelOf = new Map(registry.map((r) => [r.room_id, r.label]));
  const stale = rooms
    .filter((r) => !r.tombstoned)
    .map((r) => ({ r, remaining: IDLE_GC_DAYS - daysSince(parseUtc(r.last_activity)) }))
    .filter((x) => x.remaining <= STALE_DAYS)
    .sort((a, b) => a.remaining - b.remaining);

  const ownerOf = new Map(registry.map((r) => [r.room_id, r.owner]));
  const body = $('stale-body');
  if (!stale.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">Nothing approaching deletion.</td></tr>';
    return;
  }
  const roster = rosterMap();
  body.innerHTML = stale.map(({ r, remaining }) => {
    const idle = IDLE_GC_DAYS - remaining;
    const cls = remaining <= 1 ? 'status-warn' : '';
    const label = labelOf.get(r.id);
    const name = label
      ? esc(label)
      : `<span class="room-id">${esc(r.id.slice(0, 8))}… (unregistered)</span>`;
    // Nudge: email whoever owns/created it, if we have their address.
    const person = ownerOf.get(r.id) || r.created_by;
    const known = person && roster.get(String(person).toLowerCase());
    let nudge = '';
    if (known) {
      const subject = `CardMirror: “${label || 'your session'}” is about to be auto-deleted`;
      const daysTxt = remaining <= 0 ? 'today' : `in ~${remaining.toFixed(0)} day(s)`;
      const bodyTxt = `Hi ${known.name},\n\nYour session “${label || r.id.slice(0, 8)}” has been idle and the relay ` +
        `will auto-delete it ${daysTxt}. Open it in CardMirror (or end it) to keep or clear it.\n\nThanks!`;
      const href = `mailto:${known.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyTxt)}`;
      nudge = `<a class="btn-ask" href="${esc(href)}" title="Email ${esc(known.name)}">Remind</a>`;
    } else if (person) {
      nudge = `<a class="btn-ask disabled" title="No email on file for ${esc(person)} — add in Settings → Roster">Remind</a>`;
    }
    return `<tr>
      <td>${name}</td>
      <td>${idle.toFixed(1)} days</td>
      <td class="${cls}">${remaining <= 0 ? 'due now' : remaining.toFixed(1) + ' days'}</td>
      <td>${nudge}</td>
    </tr>`;
  }).join('');
}

function renderStorage(rooms) {
  const contentBytes = rooms.filter((r) => !r.tombstoned).reduce((s, r) => s + (r.bytes_used || 0), 0);
  const roomCount = rooms.filter((r) => !r.tombstoned).length;
  const estDb = contentBytes * DB_MULTIPLIER;
  const pct = Math.min(100, (estDb / FREE_TIER_BYTES) * 100);

  const fill = $('storage-fill');
  fill.style.width = pct.toFixed(1) + '%';
  fill.className = 'meter-fill' + (pct > 90 ? ' crit' : pct > 70 ? ' warn' : '');

  $('storage-text').innerHTML =
    `Est. <strong>${fmtBytes(estDb)}</strong> of ${fmtBytes(FREE_TIER_BYTES)} used ` +
    `(${pct.toFixed(1)}%) across ${roomCount} live room${roomCount === 1 ? '' : 's'}.`;
  const rbStore = $('ribbon-storage'); if (rbStore) rbStore.textContent = fmtBytes(estDb);

  const avg = roomCount ? contentBytes / roomCount : NOMINAL_ROOM;
  const remainingContent = FREE_TIER_BYTES / DB_MULTIPLIER - contentBytes;
  const roomsLeft = Math.max(0, Math.floor(remainingContent / avg));
  $('storage-estimate').innerHTML =
    `Content stored: ${fmtBytes(contentBytes)} · applying the measured ×${DB_MULTIPLIER} on-disk multiplier. ` +
    `Roughly <strong>${roomsLeft}</strong> more room${roomsLeft === 1 ? '' : 's'} of the current average ` +
    `(${fmtBytes(avg)}) would fit.`;
}

// ── Add session ──────────────────────────────────────────────────────
// Share code: cmshare2.<roomId>.<key>.<major>.<minor>.<patch>
// Keep segment two (roomId). DISCARD segment three (the encryption key).
function parseShareCode(code) {
  const parts = (code || '').trim().split('.');
  if (parts.length < 2 || !parts[1]) return null;
  return parts[1]; // room id only — never store parts[2]
}

function openAdd() {
  $('add-code').value = '';
  $('add-label').value = '';
  $('add-owner').value = '';
  $('add-event').value = '';
  $('add-parsed').textContent = '';
  $('add-error').classList.add('hidden');
  $('add-modal').classList.remove('hidden');
  $('add-code').focus();
}
function closeAdd() { $('add-modal').classList.add('hidden'); }

async function submitAdd() {
  const err = $('add-error');
  err.classList.add('hidden');
  const roomId = parseShareCode($('add-code').value);
  const label = $('add-label').value.trim();
  if (!roomId) { err.textContent = 'That does not look like a share code (need at least cmshare2.<roomId>…).'; err.classList.remove('hidden'); return; }
  if (!label) { err.textContent = 'A label is required.'; err.classList.remove('hidden'); return; }
  try {
    await sbInsert('dashboard_registry', {
      room_id: roomId,
      label,
      owner: $('add-owner').value.trim() || null,
      event: $('add-event').value.trim() || null,
    });
    closeAdd();
    await refreshData();
  } catch (e) {
    // Duplicate primary key → already registered.
    err.textContent = /duplicate|conflict|409/i.test(String(e.message))
      ? 'That room is already registered.'
      : String(e.message || e);
    err.classList.remove('hidden');
  }
}

// ── Team tokens (client-side generator; env-JSON model) ──────────────
// The dashboard can't write Render env, so this manages the people list
// locally, generates per-person tokens, and hands you the RELAY_TOKENS
// JSON to paste into Render. It also keeps the Ask roster in sync.
const SEASON = String(new Date().getFullYear()).slice(2); // e.g. "26"

function genToken(name) {
  const slug = (name || '').replace(/[^A-Za-z0-9]/g, '') || 'user';
  const rand = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${slug}${SEASON}-${rand}`;
}

function team() { return (config && config.team) || []; }

function persistTeam(list) {
  if (!config) config = { relay: '', supabase: '', anon: '' };
  config.team = list;
  // Keep the Ask roster in sync: every person with an email.
  config.roster = list.filter((p) => p.email).map((p) => `${p.name} = ${p.email}`).join('\n');
  // Auto-wire the dashboard's own poll token from a "Dashboard" entry.
  const dash = list.find((p) => /dashboard/i.test(p.name));
  if (dash) config.relaytoken = dash.token;
  saveConfig(config);
}

function relayTokensJson() {
  const map = {};
  for (const p of team()) map[p.token] = { label: p.name, role: p.role };
  return JSON.stringify(map);
}

// ── Coach auth + Sync-to-relay (v2.1 DB-backed tokens) ────────────────
// Signs the coach in via Supabase Auth (no new dependency — plain REST),
// then writes the whole team to the relay_tokens table as an authenticated
// user. The relay picks it up within ~30s. No Render, no redeploy.
const AUTH_KEY = 'debate-relay-auth';
function authToken() { try { return localStorage.getItem(AUTH_KEY) || null; } catch { return null; } }
function setAuthToken(t) { try { t ? localStorage.setItem(AUTH_KEY, t) : localStorage.removeItem(AUTH_KEY); } catch {} }
function authStatusText() { return authToken() ? 'Signed in ✓' : 'Not signed in'; }

async function coachSignIn(email, password) {
  if (!config || !config.supabase || !config.anon) throw new Error('Configure Supabase first (Settings).');
  if (!email || !password) throw new Error('Email and password required.');
  const res = await fetch(config.supabase.replace(/\/$/, '') + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: config.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Sign-in failed: ' + (await res.text()).slice(0, 140));
  const data = await res.json();
  if (!data.access_token) throw new Error('Sign-in returned no token.');
  setAuthToken(data.access_token);
}

async function syncTokensToRelay() {
  const jwt = authToken();
  if (!jwt) throw new Error('Sign in as the coach first.');
  const rows = team().map((p) => ({ token: p.token, label: p.name, role: p.role }));
  if (!rows.length) throw new Error('Add at least one person first.');
  const base = config.supabase.replace(/\/$/, '') + '/rest/v1/relay_tokens';
  const headers = { apikey: config.anon, Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' };
  // 1) Upsert everyone on the list (no empty window: we add before pruning).
  let res = await fetch(base, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  if (res.status === 401) { setAuthToken(null); throw new Error('Session expired — sign in again.'); }
  if (!res.ok) throw new Error('Sync failed (' + res.status + '): ' + (await res.text()).slice(0, 140));
  // 2) Remove anyone no longer on the list. Tokens are URL-safe ([A-Za-z0-9-]).
  const keep = rows.map((r) => r.token).join(',');
  res = await fetch(base + '?token=not.in.(' + keep + ')', { method: 'DELETE', headers });
  if (!res.ok) throw new Error('Prune failed (' + res.status + '): ' + (await res.text()).slice(0, 140));
  return rows.length;
}

function renderTeam() {
  const body = $('team-body');
  const list = team();
  // Keep the group autocomplete fresh from existing groups.
  const dl = $('tk-group-list');
  if (dl) dl.innerHTML = [...new Set(list.map((p) => p.group).filter(Boolean))].sort()
    .map((g) => `<option value="${esc(g)}">`).join('');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No one added yet.</td></tr>';
    return;
  }
  body.innerHTML = list.map((p, i) => `<tr>
    <td>${esc(p.name)}</td>
    <td>${esc(p.email) || '—'}</td>
    <td>${esc(p.role)}</td>
    <td>${p.group ? `<span class="group-badge">${esc(p.group)}</span>` : '<span class="muted">—</span>'}</td>
    <td class="mono">${esc(p.token.slice(0, 22))}…</td>
    <td><a class="btn-ask" data-cp="${i}">copy</a> <a class="btn-ask" data-rm="${i}">remove</a></td>
  </tr>`).join('');
  body.querySelectorAll('[data-cp]').forEach((b) => {
    b.onclick = async () => {
      const ok = await copyText(team()[+b.dataset.cp].token);
      $('tk-status').textContent = ok ? `Copied ${team()[+b.dataset.cp].name}'s token — paste into their CardMirror.` : team()[+b.dataset.cp].token;
    };
  });
  body.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => { const l = team().slice(); l.splice(+b.dataset.rm, 1); persistTeam(l); renderTeam(); };
  });
}

function addPerson() {
  const err = $('tk-error');
  err.classList.add('hidden');
  const name = $('tk-name').value.trim();
  const email = $('tk-email').value.trim();
  const role = $('tk-role').value;
  const group = ($('tk-group') && $('tk-group').value.trim()) || '';
  if (!name) { err.textContent = 'Name is required.'; err.classList.remove('hidden'); return; }
  if (team().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    err.textContent = 'Someone with that name is already on the list.'; err.classList.remove('hidden'); return;
  }
  persistTeam([...team(), { name, email, role, group, token: genToken(name) }]);
  $('tk-name').value = ''; $('tk-email').value = ''; if ($('tk-group')) $('tk-group').value = '';
  renderTeam();
  $('tk-status').textContent = 'Added. Copy RELAY_TOKENS and paste it into Render to apply.';
}

async function copyText(str) {
  try { await navigator.clipboard.writeText(str); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

function openTokens() {
  renderTeam();
  $('tk-status').textContent = '';
  $('tk-error').classList.add('hidden');
  $('tk-auth-status').textContent = authStatusText();
  $('tokens-modal').classList.remove('hidden');
}
function closeTokens() { $('tokens-modal').classList.add('hidden'); }

// ── Setup wizard (connect screen) ────────────────────────────────────
function setWizStatus(id, state, msg) {
  const el = $(id);
  if (!el) return;
  el.className = 'wiz-status ' + (state || '');
  el.textContent = msg || '';
}
async function testSupabase() {
  const url = ($('cfg-supabase').value || '').trim();
  const key = ($('cfg-anon').value || '').trim();
  if (!url || !key) { setWizStatus('supabase-status', 'fail', 'Enter the Project URL and anon key first.'); return; }
  setWizStatus('supabase-status', 'testing', 'Testing…');
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/relay_rooms?select=id&limit=1',
      { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (res.ok) { setWizStatus('supabase-status', 'ok', '✓ Connected — tables + RLS look good.'); return; }
    if (res.status === 401) { setWizStatus('supabase-status', 'fail', 'Key rejected (401) — double-check the anon key.'); return; }
    const t = (await res.text()).slice(0, 120);
    setWizStatus('supabase-status', 'fail', `HTTP ${res.status} — did you run setup.sql? ${t}`);
  } catch {
    setWizStatus('supabase-status', 'fail', 'Could not reach Supabase — check the Project URL.');
  }
}
async function testRelay() {
  const url = ($('cfg-relay').value || '').trim();
  if (!url) { setWizStatus('relay-status', 'fail', 'Enter the relay URL first.'); return; }
  const note = /\/relay\/?$/.test(url) ? '' : ' (tip: it should end in /relay)';
  setWizStatus('relay-status', 'testing', 'Testing…' + note);
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/health', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) setWizStatus('relay-status', 'ok', '✓ Relay is up.' + note);
    else setWizStatus('relay-status', 'fail', `Responded HTTP ${res.status}${note || ' — check the URL ends in /relay.'}`);
  } catch {
    setWizStatus('relay-status', 'fail', 'Unreachable — if it was idle, Render may be waking it (~60s). Retry.');
  }
}
function genDashboardToken() {
  const rand = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  $('cfg-relaytoken').value = 'Dashboard' + String(new Date().getFullYear()).slice(2) + '-' + rand;
  setWizStatus('token-status', 'ok', 'Generated — add it to your relay’s RELAY_TOKENS with role "coach", or paste your shared RELAY_TOKEN instead.');
}

// ── Wiring ───────────────────────────────────────────────────────────
function showConfig() {
  if (config) {
    $('cfg-relay').value = config.relay || '';
    $('cfg-supabase').value = config.supabase || '';
    $('cfg-anon').value = config.anon || '';
    $('cfg-relaytoken').value = config.relaytoken || '';
    $('cfg-roster').value = config.roster || '';
  }
  $('app-shell').classList.add('hidden');
  $('config-panel').classList.remove('hidden');
}
function showDashboard() {
  $('config-panel').classList.add('hidden');
  $('app-shell').classList.remove('hidden');
}

// Sidebar view switching. Each .nav-item[data-view] reveals the matching
// .view[data-view]; content is always in the DOM (rendering is unaffected).
const VIEW_TITLES = { overview: 'Overview', sessions: 'Sessions', activity: 'Activity', team: 'Team' };
const VIEW_KICKERS = { overview: 'Team Overview', sessions: 'Live & stored rooms', activity: 'What changed', team: 'People & attribution' };
function switchView(view) {
  for (const el of document.querySelectorAll('.nav-item')) el.classList.toggle('active', el.dataset.view === view);
  for (const el of document.querySelectorAll('.view')) el.classList.toggle('active', el.dataset.view === view);
  const title = $('view-title');
  if (title) title.textContent = VIEW_TITLES[view] || 'Dashboard';
  const kicker = $('view-kicker');
  if (kicker) kicker.textContent = VIEW_KICKERS[view] || 'CardBridge';
}
function wireNav() {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.onclick = () => switchView(el.dataset.view);
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchView(el.dataset.view); } };
  }
}

async function refreshAll() {
  if (!config) return;
  refreshHealth();
  await pollMemberInvites(); // refresh invited-room titles/keys (if configured)
  refreshData();
}

// Theme (light/dark), persisted in this browser. Unset = follow the OS.
const THEME_KEY = 'debate-relay-theme';
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) applyTheme(saved);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme')
    || (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}
initTheme();

document.addEventListener('DOMContentLoaded', () => {
  $('theme-btn').onclick = toggleTheme;
  wireNav();
  const gf = $('team-group-filter');
  if (gf) gf.onchange = () => { if (_lastData) renderTeamView(_lastData.rooms, _lastData.registry, _lastData.partsByRoom); };
  $('settings-btn').onclick = showConfig;
  $('refresh-btn').onclick = refreshAll;
  $('tokens-btn').onclick = openTokens;
  $('tk-close').onclick = closeTokens;
  $('tk-add').onclick = addPerson;
  $('tk-copy-tokens').onclick = async () => {
    if (!team().length) { $('tk-status').textContent = 'Add at least one person first.'; return; }
    const ok = await copyText(relayTokensJson());
    $('tk-status').textContent = ok
      ? 'RELAY_TOKENS copied. Paste it into Render → Environment → RELAY_TOKENS → Save.'
      : 'Copy failed — here it is to copy manually:\n' + relayTokensJson();
  };
  $('tk-copy-roster').onclick = async () => {
    const ok = await copyText(config?.roster || '');
    $('tk-status').textContent = ok ? 'Roster copied (also auto-synced to Settings → Roster).' : (config?.roster || '(empty)');
  };
  $('tk-signin').onclick = async () => {
    $('tk-status').textContent = 'Signing in…';
    try {
      await coachSignIn($('tk-email-auth').value.trim(), $('tk-password').value);
      $('tk-password').value = '';
      $('tk-auth-status').textContent = authStatusText();
      $('tk-status').textContent = 'Signed in. Click “Sync to relay” to push your token list.';
    } catch (e) { $('tk-status').textContent = String(e.message || e); }
  };
  $('tk-sync').onclick = async () => {
    $('tk-status').textContent = 'Syncing…';
    try {
      const n = await syncTokensToRelay();
      $('tk-status').textContent = `Synced ${n} token(s) to the relay. Takes effect within ~30s — no redeploy.`;
    } catch (e) { $('tk-status').textContent = String(e.message || e); }
    $('tk-auth-status').textContent = authStatusText();
  };
  $('member-btn').onclick = showMember;
  $('member-close').onclick = closeMember;
  $('member-request-btn').onclick = sendAccessRequest;
  $('member-notify').onclick = enableDesktopAlerts;
  $('member-copy').onclick = async () => {
    const ok = await copyText($('member-code').textContent || '');
    $('member-status').textContent = ok ? 'Member code copied — give it to students to invite.' : '';
  };
  $('member-poll').onclick = async () => {
    $('member-status').textContent = 'Polling…';
    await pollMemberInvites();
    refreshData();
    $('member-status').textContent = 'Checked for invites. Any new rooms now show in Sessions.';
  };
  $('viewer-close').onclick = closeViewer;
  $('viewer-live-btn').onclick = goLive;
  $('viewer-comments-btn').onclick = toggleComments;
  const ss = $('sessions-search');
  if (ss) ss.oninput = () => {
    const q = (ss.value || '').toLowerCase();
    for (const tr of document.querySelectorAll('#sessions-body tr')) {
      tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    }
  };
  initNavLevelToggles();
  $('viewer-docx-btn').onclick = exportViewerDocx;
  $('viewer-pdf-btn').onclick = printViewerPDF;
  $('viewer-history-btn').onclick = openHistory;
  $('hist-slider').oninput = (e) => renderHistAt(e.target.value, false);
  $('hist-play').onclick = toggleHistPlay;
  $('hist-close').onclick = exitHistoryToDoc;
  $('backup-btn').onclick = backupAll;
  $('viewer-edit-btn').onclick = startEdit;
  $('edit-close').onclick = exitEdit;
  $('comment-add').onclick = addCommentFlow;
  $('head-pocket').onclick = () => applyHeading('pocket');
  $('head-hat').onclick = () => applyHeading('hat');
  $('head-block').onclick = () => applyHeading('block');
  $('head-tag').onclick = applyTag;
  $('head-clear').onclick = clearFormattingFlow;
  $('fmt-bold').onclick = () => applyFmt('bold');
  $('fmt-italic').onclick = () => applyFmt('italic');
  $('fmt-underline').onclick = () => applyFmt('underline_mark');
  $('fmt-cite').onclick = () => applyFmt('cite_mark');
  $('fmt-emphasis').onclick = () => applyFmt('emphasis_mark');
  $('fmt-highlight').onclick = applyHighlight;
  // Changing the colour re-highlights the current selection immediately.
  if ($('fmt-hl-color')) $('fmt-hl-color').onchange = applyHighlight;
  // Keep the editor's selection when clicking a toolbar button: preventing the
  // mousedown default stops focus leaving the iframe (which would collapse the
  // selection, so mark/clear ops had nothing to act on).
  for (const id of ['fmt-bold', 'fmt-italic', 'fmt-underline', 'fmt-cite', 'fmt-emphasis',
    'fmt-highlight', 'head-pocket', 'head-hat', 'head-block', 'head-tag', 'head-clear', 'comment-add']) {
    const b = $(id); if (b) b.onmousedown = (e) => e.preventDefault();
  }
  $('comment-text').onkeydown = (e) => { if (e.key === 'Enter') addCommentFlow(); };
  $('viewer-note-btn').onclick = toggleNoteBar;
  $('note-send').onclick = sendNoteNow;
  $('note-cancel').onclick = () => $('viewer-note-bar').classList.add('hidden');
  $('note-text').onkeydown = (e) => { if (e.key === 'Enter') sendNoteNow(); };
  $('add-btn').onclick = openAdd;
  $('add-cancel').onclick = closeAdd;
  $('add-save').onclick = submitAdd;
  $('cfg-cancel').onclick = () => { if (config) showDashboard(); };
  if ($('test-supabase')) $('test-supabase').onclick = testSupabase;
  if ($('test-relay')) $('test-relay').onclick = testRelay;
  if ($('gen-token')) $('gen-token').onclick = genDashboardToken;
  $('add-code').addEventListener('input', () => {
    const id = parseShareCode($('add-code').value);
    $('add-parsed').textContent = id ? `Room ID kept: ${id.slice(0, 12)}…  (key discarded)` : '';
  });
  $('cfg-save').onclick = () => {
    const cfg = {
      ...(config || {}), // preserve team / relaytoken / etc.
      relay: $('cfg-relay').value.trim(),
      supabase: $('cfg-supabase').value.trim(),
      anon: $('cfg-anon').value.trim(),
      roster: $('cfg-roster').value.trim(),
      // Field overrides the auto-wired token only when non-empty.
      relaytoken: $('cfg-relaytoken').value.trim() || (config && config.relaytoken) || '',
    };
    if (!cfg.relay || !cfg.supabase || !cfg.anon) { alert('Relay URL, Supabase URL and anon key are required.'); return; }
    config = cfg;
    saveConfig(cfg);
    showDashboard();
    refreshAll();
  };

  if (config) { showDashboard(); refreshAll(); }
  else { showConfig(); }

  // Auto-refresh every 60s while the tab is open.
  setInterval(() => { if (config && !document.hidden) refreshAll(); }, 60000);
});
