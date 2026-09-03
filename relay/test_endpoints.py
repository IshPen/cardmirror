"""Endpoint-wiring tests via FastAPI TestClient — no database required.

These confirm the v2 auth/role dependencies are attached to the right
routes. Auth and role checks resolve BEFORE any DB access, so a rejected
request never touches Postgres; we assert those reject codes. We do NOT
start the app lifespan (no create_all), so we never open a DB connection.

Run:  python relay/test_endpoints.py
"""
import os

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://u:p@localhost:5432/none")
os.environ.setdefault("RELAY_TOKEN", "shared-secret")

import server  # noqa: E402
from server import Identity  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# NOTE: plain TestClient(app) without a `with` block does NOT run lifespan,
# so create_all / the migration never fire and no DB connection is made.
# raise_server_exceptions=False turns a passed-auth-but-no-DB request into a
# 500 response (instead of re-raising), so we can assert it's not 401/403.
client = TestClient(server.app, raise_server_exceptions=False)


def test_health_open():
    r = client.get("/relay/health")
    assert r.status_code == 200 and r.json() == {"ok": True}, r.text


def test_create_requires_auth():
    server._TOKEN_MAP = None
    assert client.post("/relay/rooms").status_code == 401              # no token
    assert client.post("/relay/rooms",
                       headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/relay/rooms/x/stream").status_code == 401       # stream also gated


def test_delete_role_guard_multi_token():
    server._TOKEN_MAP = {
        "tokA": Identity("Maya", "student"),
        "tokC": Identity("Coach Lee", "coach"),
    }
    # student is authenticated but forbidden from ending a session → 403,
    # and this happens before any DB query.
    r = client.delete("/relay/rooms/whatever", headers={"Authorization": "Bearer tokA"})
    assert r.status_code == 403, r.status_code
    # unknown token → 401
    assert client.delete("/relay/rooms/whatever",
                        headers={"Authorization": "Bearer nope"}).status_code == 401
    # coach passes the guard; the only thing left to fail is the DB, so the
    # status is decidedly NOT 401/403 (it surfaces as a 5xx with no DB here).
    r = client.delete("/relay/rooms/whatever", headers={"Authorization": "Bearer tokC"})
    assert r.status_code not in (401, 403), r.status_code


def test_single_token_delete_open():
    # With no map, any valid token may end a session (original behavior).
    server._TOKEN_MAP = None
    os.environ["RELAY_TOKEN"] = "shared-secret"
    r = client.delete("/relay/rooms/whatever",
                     headers={"Authorization": "Bearer shared-secret"})
    assert r.status_code not in (401, 403), r.status_code  # passes auth+guard, DB fails after


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
            passed += 1
    print(f"\n{passed} test(s) passed")
