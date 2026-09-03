"""Unit tests for v2 per-student-token identity resolution.

Pure-logic tests — no database, no network. They import the relay module
(which needs a DATABASE_URL set, but never connects) and exercise the
token map parser, the identity resolver, and the coach-only guard.

Run:  python -m pytest relay/test_identity.py   (or)   python relay/test_identity.py
"""
import os

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://u:p@localhost:5432/none")
os.environ.setdefault("RELAY_TOKEN", "shared-secret")

import server  # noqa: E402
from server import Identity, _parse_token_map, _resolve_identity, _require_coach  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def _expect_http(status, fn, *args):
    try:
        fn(*args)
    except HTTPException as e:
        assert e.status_code == status, f"expected {status}, got {e.status_code}"
        return
    raise AssertionError(f"expected HTTPException({status}), none raised")


def test_parse_token_map():
    assert _parse_token_map("") is None
    assert _parse_token_map("   ") is None
    m = _parse_token_map('{"tokA": {"label": "Maya", "role": "student"}, "tokC": {"label": "Coach", "role": "coach"}}')
    assert m["tokA"] == Identity("Maya", "student")
    assert m["tokC"] == Identity("Coach", "coach")
    # role defaults to student when omitted
    assert _parse_token_map('{"t": {"label": "X"}}')["t"] == Identity("X", "student")
    # bad role rejected
    try:
        _parse_token_map('{"t": {"role": "admin"}}')
        raise AssertionError("bad role should raise")
    except ValueError:
        pass
    # non-object rejected
    try:
        _parse_token_map('["not", "an", "object"]')
        raise AssertionError("array should raise")
    except ValueError:
        pass


def test_single_token_mode():
    server._db_token_map = None
    server._TOKEN_MAP = None
    os.environ["RELAY_TOKEN"] = "shared-secret"
    # valid → unnamed coach (full privileges, unchanged from original relay)
    assert _resolve_identity("Bearer shared-secret") == Identity(None, "coach")
    # wrong / missing → 401
    _expect_http(401, _resolve_identity, "Bearer nope")
    _expect_http(401, _resolve_identity, None)
    _expect_http(401, _resolve_identity, "Basic shared-secret")
    # destructive actions stay open in single-token mode
    _require_coach(Identity(None, "coach"))  # no raise


def test_db_token_precedence():
    # DB tokens (relay_tokens table) win over env RELAY_TOKENS when present.
    server._TOKEN_MAP = {"envtok": Identity("EnvUser", "student")}
    server._db_token_map = {
        "dbstudent": Identity("Zayn", "student"),
        "dbcoach": Identity("Coach", "coach"),
    }
    assert _resolve_identity("Bearer dbstudent") == Identity("Zayn", "student")
    assert _resolve_identity("Bearer dbcoach") == Identity("Coach", "coach")
    _expect_http(401, _resolve_identity, "Bearer envtok")  # env ignored while DB active
    _expect_http(403, _require_coach, Identity("Zayn", "student"))  # guard uses DB map
    _require_coach(Identity("Coach", "coach"))
    # Empty table (None) falls back to env tokens.
    server._db_token_map = None
    assert _resolve_identity("Bearer envtok") == Identity("EnvUser", "student")


def test_multi_token_mode():
    server._db_token_map = None
    server._TOKEN_MAP = {
        "tokA": Identity("Maya", "student"),
        "tokC": Identity("Coach Lee", "coach"),
    }
    assert _resolve_identity("Bearer tokA") == Identity("Maya", "student")
    assert _resolve_identity("Bearer tokC") == Identity("Coach Lee", "coach")
    _expect_http(401, _resolve_identity, "Bearer unknown")
    _expect_http(401, _resolve_identity, None)
    # coach guard: students blocked (403), coaches allowed
    _expect_http(403, _require_coach, Identity("Maya", "student"))
    _require_coach(Identity("Coach Lee", "coach"))  # no raise


def test_single_token_ignores_map_none_guard():
    # Even a 'student' identity is unreachable in single-token mode, but the
    # guard must not raise when no map is configured.
    server._db_token_map = None
    server._TOKEN_MAP = None
    _require_coach(Identity("Someone", "student"))  # no raise (map is None)


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
            passed += 1
    print(f"\n{passed} test(s) passed")
