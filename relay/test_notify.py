"""Unit tests for the opt-in invite email notification (RELAY_NOTIFY_*).

Pure-logic tests — no database, no network. They import the relay module
(which needs a DATABASE_URL set, but never connects) and check that the
notifier is INERT unless fully configured, respects the watched-routes
filter, and applies its per-recipient cooldown. The actual HTTP send is
monkeypatched — no email ever leaves the test.

Run:  python -m pytest relay/test_notify.py
"""
import os

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://u:p@localhost:5432/none")
os.environ.setdefault("RELAY_TOKEN", "shared-secret")

import server  # noqa: E402


class _ImmediateThread:
    """Runs the target synchronously so the test can observe the send."""
    def __init__(self, target, args=(), daemon=None):
        self._target, self._args = target, args

    def start(self):
        self._target(*self._args)


def _configure(monkeypatch, routes=None):
    monkeypatch.setattr(server, "NOTIFY_EMAIL", "coach@example.com")
    monkeypatch.setattr(server, "NOTIFY_FROM", "relay@example.com")
    monkeypatch.setattr(server, "NOTIFY_RESEND_KEY", "re_test")
    monkeypatch.setattr(server, "NOTIFY_ROUTES", set(routes or []))
    monkeypatch.setattr(server, "_last_notify", {})
    monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
    sent = []
    monkeypatch.setattr(server, "_send_notify_email", lambda r: sent.append(r))
    return sent


def test_inert_by_default():
    # With no RELAY_NOTIFY_* env, the notifier is disabled and a call is a
    # no-op that must not raise.
    assert server._notify_enabled() is False
    server._maybe_notify_invite("routing-abc")  # must not raise


def test_disabled_when_partially_configured(monkeypatch):
    monkeypatch.setattr(server, "NOTIFY_EMAIL", "coach@example.com")
    monkeypatch.setattr(server, "NOTIFY_FROM", "")
    monkeypatch.setattr(server, "NOTIFY_RESEND_KEY", "re_test")
    assert server._notify_enabled() is False


def test_fires_for_watched_route(monkeypatch):
    sent = _configure(monkeypatch, routes=["watched"])
    server._maybe_notify_invite("watched")
    assert sent == ["watched"]


def test_ignores_unwatched_route(monkeypatch):
    sent = _configure(monkeypatch, routes=["watched"])
    server._maybe_notify_invite("someone-else")
    assert sent == []


def test_empty_routes_watches_everyone(monkeypatch):
    sent = _configure(monkeypatch, routes=[])
    server._maybe_notify_invite("any-recipient")
    assert sent == ["any-recipient"]


def test_cooldown_suppresses_repeat(monkeypatch):
    sent = _configure(monkeypatch, routes=["watched"])
    server._maybe_notify_invite("watched")
    server._maybe_notify_invite("watched")  # within cooldown → suppressed
    assert sent == ["watched"]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
