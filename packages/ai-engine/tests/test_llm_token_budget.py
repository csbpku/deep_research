from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest

from ai_engine.llm import token_budget


class _Cursor:
    def __init__(self, row: tuple[int] | None = None) -> None:
        self.row = row

    async def fetchone(self) -> tuple[int] | None:
        return self.row


class _FakeConnection:
    user_used = 0
    platform_used = 0
    statements: list[tuple[str, tuple[object, ...] | None]] = []

    @classmethod
    async def connect(cls, _dsn: str) -> _FakeConnection:
        return cls()

    async def __aenter__(self) -> _FakeConnection:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    @asynccontextmanager
    async def transaction(self):
        yield

    async def execute(
        self, query: str, params: tuple[object, ...] | None = None
    ) -> _Cursor:
        type(self).statements.append((query, params))
        if 'SUM(CASE WHEN "status"' in query and '"userId"' in query:
            return _Cursor((type(self).user_used,))
        if 'SUM(CASE WHEN "status"' in query:
            return _Cursor((type(self).platform_used,))
        return _Cursor()


@pytest.fixture(autouse=True)
def _reset_budget_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "LLM_TOKEN_BUDGET_USER_LIMIT",
        "LLM_TOKEN_BUDGET_USER_PERIOD_DAYS",
        "LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT",
        "LLM_TOKEN_BUDGET_RESERVATION_TTL_SECONDS",
        "DATABASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    _FakeConnection.user_used = 0
    _FakeConnection.platform_used = 0
    _FakeConnection.statements = []


def test_budget_defaults_are_disabled() -> None:
    settings = token_budget.token_budget_settings()
    assert settings.user_limit == 0
    assert settings.platform_daily_limit == 0
    assert settings.user_period_days == 30
    assert not settings.enabled


def test_call_reservation_estimate_includes_prompt_and_max_output() -> None:
    estimate = token_budget.estimate_call_tokens(
        user_prompt="hello 世界",
        system_prompt="system",
        max_output_tokens=32,
    )
    assert estimate == token_budget.count_text_tokens("hello 世界system") + 32


async def test_disabled_budget_does_not_require_database() -> None:
    assert await token_budget.reserve_llm_tokens(
        operation="test", requested_tokens=10
    ) is None


async def test_enabled_budget_fails_closed_without_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "1000")
    with pytest.raises(token_budget.TokenBudgetUnavailable, match="DATABASE_URL"):
        await token_budget.reserve_llm_tokens(operation="test", requested_tokens=10)


async def test_reservation_checks_both_scopes_and_persists_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://budget-test")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_USER_LIMIT", "100")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_USER_PERIOD_DAYS", "7")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "500")
    monkeypatch.setattr(token_budget.psycopg, "AsyncConnection", _FakeConnection)
    user_id = "11111111-1111-1111-1111-111111111111"

    reservation = await token_budget.reserve_llm_tokens(
        operation="reader.ask", requested_tokens=10, user_id=user_id
    )

    assert reservation is not None
    inserts = [q for q, _ in _FakeConnection.statements if "INSERT INTO" in q]
    assert len(inserts) == 1
    selects = [(q, p) for q, p in _FakeConnection.statements if "SUM(CASE WHEN" in q]
    assert len(selects) == 2
    assert selects[0][1] is not None and selects[0][1][0] == user_id
    period_start = selects[0][1][1]
    assert isinstance(period_start, datetime)
    assert period_start.tzinfo == timezone.utc


async def test_user_limit_rejects_before_inserting_reservation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://budget-test")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_USER_LIMIT", "100")
    monkeypatch.setattr(token_budget.psycopg, "AsyncConnection", _FakeConnection)
    _FakeConnection.user_used = 95

    with pytest.raises(token_budget.TokenBudgetExceeded) as caught:
        await token_budget.reserve_llm_tokens(
            operation="reader.ask",
            requested_tokens=10,
            user_id="11111111-1111-1111-1111-111111111111",
        )

    assert caught.value.scope == "user"
    assert caught.value.details() == {
        "scope": "user", "used": 95, "limit": 100, "requested": 10
    }
    assert not any("INSERT INTO" in q for q, _ in _FakeConnection.statements)


async def test_platform_limit_rejects_before_inserting_reservation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://budget-test")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "200")
    monkeypatch.setattr(token_budget.psycopg, "AsyncConnection", _FakeConnection)
    _FakeConnection.platform_used = 195

    with pytest.raises(token_budget.TokenBudgetExceeded) as caught:
        await token_budget.reserve_llm_tokens(
            operation="radar.score", requested_tokens=10
        )

    assert caught.value.scope == "platform_daily"
    assert not any("INSERT INTO" in q for q, _ in _FakeConnection.statements)


async def test_settlement_records_actual_usage_and_release_frees_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://budget-test")
    monkeypatch.setattr(token_budget.psycopg, "AsyncConnection", _FakeConnection)
    reservation = token_budget.TokenReservation("11111111-1111-1111-1111-111111111111", 100)

    await token_budget.settle_llm_tokens(reservation, 42)
    update = next((q, p) for q, p in _FakeConnection.statements if "UPDATE" in q)
    assert update[1] == ("settled", 42, reservation.id)

    _FakeConnection.statements = []
    await token_budget.release_llm_tokens(reservation)
    update = next((q, p) for q, p in _FakeConnection.statements if "UPDATE" in q)
    assert update[1] == ("released", None, reservation.id)


async def test_multi_call_task_reserves_once_and_settles_aggregate_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://budget-test")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_USER_LIMIT", "5000")
    monkeypatch.setattr(token_budget.psycopg, "AsyncConnection", _FakeConnection)
    user_id = "11111111-1111-1111-1111-111111111111"

    async with token_budget.reserve_llm_token_task(
        operation="reading.answer.full_page",
        estimated_tokens=2400,
        user_id=user_id,
    ) as task:
        assert token_budget.current_budget_task() is task
        task.record(320, 180)
        task.record(640, 260)

    inserts = [q for q, _params in _FakeConnection.statements if "INSERT INTO" in q]
    settlements = [
        params for query, params in _FakeConnection.statements
        if 'SET "status" = %s' in query
    ]
    assert len(inserts) == 1
    assert len(settlements) == 1
    assert settlements[0] is not None and settlements[0][:2] == ("settled", 1400)
    assert token_budget.current_budget_task() is None


def test_budget_identity_is_scoped_and_restored() -> None:
    user_id = "11111111-1111-1111-1111-111111111111"
    assert token_budget.current_budget_user() is None
    with token_budget.bind_budget_user(user_id):
        assert token_budget.current_budget_user() == user_id
    assert token_budget.current_budget_user() is None
