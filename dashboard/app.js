/* Debate Relay — coach dashboard.
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
  const setDot = (cls) => { for (const el of [$('health-dot'), $('health-dot-lg')]) { el.className = 'dot ' + cls; } };
  $('health-text').textContent = 'Checking…';
  $('health-detail').textContent = '';
  try {
    const base = config.relay.replace(/\/$/, '');
    const t0 = performance.now();
    const res = await fetch(base + '/health', { cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      setDot('ok');
      $('health-text').textContent = 'Relay is up';
      $('health-detail').textContent = `${base}/health · responded in ${ms} ms`;
    } else {
      setDot('bad');
      $('health-text').textContent = 'Relay responded, but not healthy';
      $('health-detail').textContent = `HTTP ${res.status}`;
    }
  } catch (e) {
    setDot('bad');
    $('health-text').textContent = 'Relay is unreachable';
    $('health-detail').textContent = String(e.message || e) +
      ' — if it was idle, Render may be waking it (~60s). Try Refresh.';
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
  renderSessions(registry, byId, partsByRoom);
  renderStale(rooms, registry);
  renderStorage(rooms);
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
  push(reg.owner);
  if (room) push(room.created_by);
  for (const p of parts) push(p);
  return names;
}

// A mailto ✉️ button asking a room's people for the share code — or a
// disabled hint when nobody's emailable yet.
function askButton(reg, room, parts) {
  const people = roomPeople(reg, room, parts);
  if (!people.length) {
    return '<a class="btn-ask disabled" title="No named people on this room yet (needs per-student tokens or a registered owner)">✉️ Ask</a>';
  }
  const roster = rosterMap();
  const known = people.map((n) => roster.get(n.toLowerCase())).filter(Boolean);
  const missing = people.filter((n) => !roster.get(n.toLowerCase()));
  if (!known.length) {
    return `<a class="btn-ask disabled" title="No email on file for: ${esc(people.join(', '))} — add them in Settings → Roster">✉️ Ask</a>`;
  }
  const label = reg.label || 'your session';
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
  return `<a class="btn-ask" href="${esc(href)}" title="${esc(title)}">✉️ Ask</a>`;
}

function renderSessions(registry, byId, partsByRoom) {
  const body = $('sessions-body');
  if (!registry.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">No sessions registered yet. Click “+ Add session”.</td></tr>';
    $('sessions-note').textContent = '';
    return;
  }
  registry.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  const rows = registry.map((reg) => {
    const room = byId.get(reg.room_id);
    const live = room && !room.tombstoned;
    const last = live ? parseUtc(room.last_activity) : null;
    const status = live
      ? '<span class="status-live">live</span>'
      : '<span class="status-dead">dead</span>';
    const parts = live ? (partsByRoom.get(reg.room_id) || []) : [];
    const partCell = parts.length
      ? esc(parts.map((p) => p || 'anon').join(', '))
      : (live ? '<span class="muted">none connected</span>' : '—');
    return `<tr>
      <td>${esc(reg.label)}<div class="room-id">${esc(reg.room_id.slice(0, 8))}…</div></td>
      <td>${esc(reg.owner) || '—'}</td>
      <td>${esc(reg.event) || '—'}</td>
      <td>${live ? (esc(room.created_by) || '<span class="muted">—</span>') : '—'}</td>
      <td>${partCell}</td>
      <td>${live ? fmtBytes(room.bytes_used) : '—'}</td>
      <td>${live ? esc(fmtAgo(last)) : '—'}</td>
      <td>${status}${live ? ' ' + askButton(reg, room, parts) : ''}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');
  const liveCount = registry.filter((r) => { const m = byId.get(r.room_id); return m && !m.tombstoned; }).length;
  const unregistered = [...byId.values()].filter((r) => !r.tombstoned && !registry.some((x) => x.room_id === r.id)).length;
  $('sessions-note').textContent =
    `${liveCount} live · ${registry.length - liveCount} dead` +
    (unregistered ? ` · ${unregistered} live room${unregistered > 1 ? 's' : ''} not registered here` : '');
}

function renderStale(rooms, registry) {
  const labelOf = new Map(registry.map((r) => [r.room_id, r.label]));
  const stale = rooms
    .filter((r) => !r.tombstoned)
    .map((r) => ({ r, remaining: IDLE_GC_DAYS - daysSince(parseUtc(r.last_activity)) }))
    .filter((x) => x.remaining <= STALE_DAYS)
    .sort((a, b) => a.remaining - b.remaining);

  const body = $('stale-body');
  if (!stale.length) {
    body.innerHTML = '<tr><td colspan="3" class="muted">Nothing approaching deletion. 🎉</td></tr>';
    return;
  }
  body.innerHTML = stale.map(({ r, remaining }) => {
    const idle = IDLE_GC_DAYS - remaining;
    const cls = remaining <= 1 ? 'status-warn' : '';
    const name = labelOf.get(r.id) || `<span class="room-id">${esc(r.id.slice(0, 8))}… (unregistered)</span>`;
    return `<tr>
      <td>${labelOf.has(r.id) ? esc(labelOf.get(r.id)) : name}</td>
      <td>${idle.toFixed(1)} days</td>
      <td class="${cls}">${remaining <= 0 ? 'due now' : remaining.toFixed(1) + ' days'}</td>
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
// JSON to paste into Render. It also keeps the ✉️ Ask roster in sync.
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
  // Keep the ✉️ Ask roster in sync: every person with an email.
  config.roster = list.filter((p) => p.email).map((p) => `${p.name} = ${p.email}`).join('\n');
  saveConfig(config);
}

function relayTokensJson() {
  const map = {};
  for (const p of team()) map[p.token] = { label: p.name, role: p.role };
  return JSON.stringify(map);
}

function renderTeam() {
  const body = $('team-body');
  const list = team();
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No one added yet.</td></tr>';
    return;
  }
  body.innerHTML = list.map((p, i) => `<tr>
    <td>${esc(p.name)}</td>
    <td>${esc(p.email) || '—'}</td>
    <td>${esc(p.role)}</td>
    <td class="mono">${esc(p.token.slice(0, 22))}…</td>
    <td><a class="btn-ask" data-rm="${i}">remove</a></td>
  </tr>`).join('');
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
  if (!name) { err.textContent = 'Name is required.'; err.classList.remove('hidden'); return; }
  if (team().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    err.textContent = 'Someone with that name is already on the list.'; err.classList.remove('hidden'); return;
  }
  persistTeam([...team(), { name, email, role, token: genToken(name) }]);
  $('tk-name').value = ''; $('tk-email').value = '';
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

function openTokens() { renderTeam(); $('tk-status').textContent = ''; $('tk-error').classList.add('hidden'); $('tokens-modal').classList.remove('hidden'); }
function closeTokens() { $('tokens-modal').classList.add('hidden'); }

// ── Wiring ───────────────────────────────────────────────────────────
function showConfig() {
  if (config) {
    $('cfg-relay').value = config.relay || '';
    $('cfg-supabase').value = config.supabase || '';
    $('cfg-anon').value = config.anon || '';
    $('cfg-roster').value = config.roster || '';
  }
  $('dashboard').classList.add('hidden');
  $('config-panel').classList.remove('hidden');
}
function showDashboard() {
  $('config-panel').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
}

function refreshAll() {
  if (!config) return;
  refreshHealth();
  refreshData();
}

document.addEventListener('DOMContentLoaded', () => {
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
  $('add-btn').onclick = openAdd;
  $('add-cancel').onclick = closeAdd;
  $('add-save').onclick = submitAdd;
  $('cfg-cancel').onclick = () => { if (config) showDashboard(); };
  $('add-code').addEventListener('input', () => {
    const id = parseShareCode($('add-code').value);
    $('add-parsed').textContent = id ? `Room ID kept: ${id.slice(0, 12)}…  (key discarded)` : '';
  });
  $('cfg-save').onclick = () => {
    const cfg = {
      relay: $('cfg-relay').value.trim(),
      supabase: $('cfg-supabase').value.trim(),
      anon: $('cfg-anon').value.trim(),
      roster: $('cfg-roster').value.trim(),
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
