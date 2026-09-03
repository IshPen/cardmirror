# Proposal — Per-student relay tokens (identity & attribution)

**Status:** implemented locally in this fork (relay + dashboard); not
proposed upstream (local-only workflow) · **Target:** `relay/server.py` ·
**Client changes:** none · **Encryption model:** untouched

> Implementation notes: `Identity`, `_parse_token_map`, `_resolve_identity`,
> `require_identity`, and `_require_coach` live in `relay/server.py`;
> `relay_rooms.created_by` + the `relay_room_participants` table carry
> attribution; the dashboard reads both. Unit + endpoint tests in
> `relay/test_identity.py` and `relay/test_endpoints.py`.

This proposes replacing the relay's single shared bearer token with an
optional **map of tokens → identities**, so a self-hoster can hand each
person their own token and the relay can attribute room creation and
live participation to a name. It is designed to be **fully
backwards-compatible** — a deployment that sets nothing new behaves
exactly as today — which is why it's worth proposing upstream rather than
forking.

---

## 1. Motivation

Today `require_relay_token` (server.py:387) compares the incoming
`Authorization: Bearer …` against one env value, `RELAY_TOKEN`, and
stores nothing. Consequences:

- **No attribution.** The relay records no association between any token
  and any room, edit, or stream. `relay_rooms` is just
  `id, created_at, last_activity, bytes_used, tombstoned`.
- **No revocation.** One shared secret; you can't cut off one person
  without rotating everyone.
- **No roles.** Every holder can do everything, including
  `DELETE /relay/rooms/{id}` (end any session).

For a twenty-person squad a coach wants: *who started this room, who's in
it right now, revoke one student, and let only a coach end sessions.*

## 2. Design principles (the upstream contract)

1. **No client change.** CardMirror already exposes a "Custom relay
   token" field. Per-student tokens are just different config values.
   The wire protocol (`Bearer <token>`) is unchanged.
2. **Backwards-compatible by default.** If the new `RELAY_TOKENS` config
   is absent, the relay uses `RELAY_TOKEN` exactly as today — one shared
   token, no roles enforced, `DELETE` open to any holder. Existing
   self-hosters upgrade with zero behavior change.
3. **Encryption untouched.** Tokens are auth + attribution only. The
   relay still sees only ciphertext. Identity **labels are operator-
   assigned** (names the coach types into config), never derived from
   document contents — so this does not move the tool any closer to
   reading student work.
4. **Additive schema.** New nullable column + one new table. No
   migration of existing rows; no destructive changes.

## 3. Configuration

Keep `RELAY_TOKEN` working. Add an optional `RELAY_TOKENS` holding JSON:

```jsonc
// RELAY_TOKENS (env var; JSON object of token → identity)
{
  "s3cret-maya-…":  { "label": "Maya",  "role": "student" },
  "s3cret-alex-…":  { "label": "Alex",  "role": "student" },
  "s3cret-coach-…": { "label": "Coach Lee", "role": "coach" }
}
```

- `role ∈ {"student", "coach"}`. `coach` may perform destructive actions
  (end session); `student` may not.
- **Resolution order:** if `RELAY_TOKENS` is set, match against it (each
  entry compared with `hmac.compare_digest`, no early-exit on value). If
  it's unset, fall back to the single `RELAY_TOKEN` and treat every
  caller as an **unnamed coach** — i.e. today's behavior precisely.
- **Revocation** = remove a token from `RELAY_TOKENS` and let the
  platform restart (Render redeploys in ~1 min). *(A DB-backed token
  store for zero-restart revocation is a possible follow-up; env-based is
  deliberately the v2 floor to keep the change small and stateless.)*

## 4. Behavior changes, endpoint by endpoint

Introduce a dependency that **returns** an identity instead of returning
`None`:

```python
@dataclass
class Identity:
    label: str | None   # None in single-token mode
    role: str           # "coach" in single-token mode

def require_identity(authorization = Header(None)) -> Identity: ...
```

| Endpoint | Change |
|---|---|
| `POST /relay/rooms` | Stamp `created_by = identity.label` on the new `RelayRoom`. |
| `GET /relay/rooms/{id}/stream` | On connect, insert a `relay_room_participants` row `(room_id, sid, label, connected_at)`; delete it on disconnect. The participant cap (server.py:772) is unchanged. |
| `DELETE /relay/rooms/{id}` | Require `identity.role == "coach"` **when `RELAY_TOKENS` is configured**; unchanged (open) in single-token mode. |
| All other room/message routes | Swap `require_relay_token` → `require_identity`; no functional change. |

The hot paths — `presence` and per-update pushes — are **not** touched;
attribution rides on connect/create, not on cursor moves.

## 5. Schema additions

```sql
-- additive: who created the room (nullable; null in single-token mode)
alter table relay_rooms add column if not exists created_by text;

-- currently-connected participants (rows live only while a stream is open)
create table if not exists relay_room_participants (
  room_id      text not null,
  sid          text not null,
  label        text,
  connected_at timestamptz default now(),
  primary key (room_id, sid)
);
```

`relay_room_participants` mirrors the in-memory `_room_streams` registry
into the DB so a dashboard (which reads Postgres, not relay internals)
can show live names. Rows are deleted on disconnect and swept with the
room; a stale row from an unclean shutdown is harmless (it just shows a
phantom participant until the room is GC'd).

> Single-worker note preserved: `_room_streams` stays the source of truth
> for fan-out; the table is a read-model for observers, written on the
> already-DB-touching connect path (server.py:775), not the hot path.

## 6. What the dashboard gains (v2 dashboard slice)

Purely additive to the existing static page — still anon key + RLS:

- **Sessions** panel gains a **Created by** column (`relay_rooms.created_by`)
  and a **Live participants** cell (labels from `relay_room_participants`).
- New RLS policy: `grant select on relay_room_participants to anon` +
  a SELECT-only policy. Tokens themselves are **never** exposed to the
  dashboard — only the labels they resolve to. "Tracking users" means
  reading names, not secrets.

This also unblocks **v1.1** (end-session button): once a `coach` role
exists, the dashboard can offer `DELETE` guarded by a coach token that
isn't already in twenty students' hands.

## 7. Rollout

1. Land the relay change (backwards-compatible; single-token deployments
   unaffected).
2. Coach sets `RELAY_TOKENS`, hands each student their token for
   **Settings → Collaboration → Custom relay token** (same field as
   today).
3. Run the additive SQL (add column + participants table + anon policy).
4. Ship the dashboard columns.

## 8. Open questions for upstream

- **Config format:** JSON in one env var vs. a mounted file vs.
  `label:role:token` lines. JSON is proposed for unambiguous parsing.
- **`created_by` privacy:** it's an operator-assigned label, but it *is*
  a small new piece of identifying metadata at rest. Document it plainly.
- **Participant read-model:** DB table (proposed, dashboard-friendly) vs.
  a coach-only `GET /relay/rooms/{id}/participants` endpoint (no schema,
  but only readable by something holding a token). The table wins for a
  static anon-key dashboard.
- **Revocation latency:** accept restart-to-revoke for v2, or go
  DB-backed now? Proposed: restart-to-revoke, revisit if coaches need
  instant cutoff.

---

### Appendix — sketch of the core change

```python
# Backwards-compatible identity resolution.
def _load_token_map() -> dict[str, Identity] | None:
    raw = os.getenv("RELAY_TOKENS", "").strip()
    if not raw:
        return None                      # single-token mode → today's behavior
    data = json.loads(raw)
    return {t: Identity(v.get("label"), v.get("role", "student"))
            for t, v in data.items()}

_TOKEN_MAP = _load_token_map()

def require_identity(authorization = Header(None)) -> Identity:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    presented = authorization[len("Bearer "):]
    if _TOKEN_MAP is None:               # ── single-token mode
        expected = os.getenv("RELAY_TOKEN", "")
        if not expected:
            raise HTTPException(500, "RELAY_TOKEN not configured on server")
        if not hmac.compare_digest(presented, expected):
            raise HTTPException(401, "Invalid relay token")
        return Identity(label=None, role="coach")   # unchanged privileges
    for tok, ident in _TOKEN_MAP.items():           # ── multi-token mode
        if hmac.compare_digest(presented, tok):
            return ident
    raise HTTPException(401, "Invalid relay token")
```

`DELETE` guard, only tightened when a map exists:

```python
if _TOKEN_MAP is not None and identity.role != "coach":
    raise HTTPException(403, "coach role required to end a session")
```
