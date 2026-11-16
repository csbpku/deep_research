"""Test configuration — load `.env` if present, set defaults that make
unit tests runnable without a real Postgres.

`DATABASE_URL` is required for the DbJobStore constructor to even return;
we default to the local dev DB so tests that *do* want to hit the DB can.
The `requires_db` pytest marker (declared in pyproject.toml below) skips
tests that hit Postgres when no DB is reachable.
"""

from __future__ import annotations

import os
from pathlib import Path
from collections.abc import Iterator

import pytest

# Load .env so DATABASE_URL is set in test env.
ROOT = Path(__file__).resolve().parent.parent
_ENV_PATH = ROOT / ".env"
if _ENV_PATH.exists():
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key in {"DATABASE_URL", "TEST_DATABASE_URL"} and key not in os.environ:
            os.environ[key] = value

# Sane default if .env doesn't ship DATABASE_URL (CI without local DB).
os.environ.setdefault(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/deep_research"
)
# Default in-memory backend for unit tests; DB tests opt in via marker.
# Force-override: a local `.env` may set JOB_RUNNER_BACKEND=db for runtime;
# setdefault would silently flip the unit suite onto DbJobStore.
os.environ["JOB_RUNNER_BACKEND"] = "memory"
os.environ["AI_ENGINE_ADAPTER"] = "fake"  # tests always use fake adapter
os.environ["LLM_CIRCUIT_ENABLED"] = "false"
os.environ["LLM_QUOTA_STATUS_QUERY_ENABLED"] = "0"
# Never let test clients inherit a developer or production service credential.
os.environ["INTERNAL_SERVICE_TOKEN"] = "test-only-ai-engine-token"


@pytest.fixture(autouse=True)
def isolate_provider_quota_cooldowns() -> Iterator[None]:
    from ai_engine.llm.provider_quota import _cooldowns

    _cooldowns.clear()
    yield
    _cooldowns.clear()

# Clear the vendor fetchers' statefiles before the test session so dedupe
# tests do not see URLs left behind by prior runs. Each test that wants
# explicit state isolation should arrange its own cleanup via monkeypatch.
for p in (
    Path(__file__).resolve().parent.parent / "ai_engine" / "static_docs"
    / ".vendor_news_state.json",
    Path(__file__).resolve().parent.parent / "ai_engine" / "static_docs"
    / ".vendor_changelog_state.json",
):
    if p.exists():
        p.unlink()


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--run-live-llm", action="store_true", default=False,
                     help="Allow explicitly marked paid integration tests (also requires opt-in and budget)")


@pytest.fixture(autouse=True)
def block_unrequested_model_network(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> None:
    """SDK mocks still work; accidental real sockets cannot spend developer keys."""
    import ipaddress
    import socket

    monkeypatch.setenv("LLM_RUNTIME_ENV", "test")
    monkeypatch.setenv("LLM_USAGE_AUDIT_ENABLED", "false")
    if request.node.get_closest_marker("live_llm") is not None:
        if not request.config.getoption("--run-live-llm"):
            pytest.skip("paid integration tests require --run-live-llm")
        if os.environ.get("LLM_ALLOW_LIVE_CALLS") != "1":
            pytest.skip("live_llm requires explicit LLM_ALLOW_LIVE_CALLS=1 and a dedicated credential")
        # Runtime policy still requires a positive daily database budget.
        monkeypatch.setenv("LLM_RUNTIME_ENV", "development")
        return
    from urllib.parse import urlsplit
    model_proxy_ports = {8318, 15721}
    for name in ("OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "MINIMAX_BASE_URL", "DEEPSEEK_BASE_URL"):
        target = urlsplit(os.environ.get(name, ""))
        if target.hostname in {"localhost", "127.0.0.1", "::1"} and target.port:
            model_proxy_ports.add(target.port)
    original = socket.socket.connect
    original_ex = socket.socket.connect_ex

    def permitted(address: object) -> bool:
        if isinstance(address, str):  # Unix domain socket (local Postgres).
            return True
        if not isinstance(address, tuple) or not address:
            return False
        if len(address) > 1 and address[1] in model_proxy_ports:
            return False
        host = str(address[0])
        if host == "localhost":
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False

    def connect(sock: socket.socket, address: object) -> None:
        if not permitted(address):
            raise RuntimeError("Test attempted external network; mock the provider or opt into live_llm")
        original(sock, address)  # type: ignore[arg-type]

    def connect_ex(sock: socket.socket, address: object) -> int:
        if not permitted(address):
            raise RuntimeError("Test attempted external network; mock the provider or opt into live_llm")
        return original_ex(sock, address)  # type: ignore[arg-type]

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
