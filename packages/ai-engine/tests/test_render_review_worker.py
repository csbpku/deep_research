from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.radar import render_review_worker as rw


class _Cursor:
    def __init__(
        self,
        row: dict[str, Any] | None = None,
        rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.row = row
        self.rows = rows if rows is not None else ([row] if row else [])

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(
        self,
        row: dict[str, Any] | None = None,
        rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.row = row
        self.rows = rows
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        return _Cursor(self.row, self.rows)


class _Pool:
    def __init__(
        self,
        row: dict[str, Any] | None = None,
        rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.connection_value = _Connection(row, rows)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


@pytest.mark.asyncio
async def test_queue_render_review_is_limited_to_approved_high_value_enrichment() -> None:
    pool = _Pool({"id": "summary-1"})

    queued = await rw.queue_render_review(pool, summary_id="summary-1")

    assert queued is True
    sql, params = pool.connection_value.executions[0]
    assert '"renderReviewStatus" = \'queued\'' in sql
    assert '"renderReviewClaimId" = NULL' in sql
    assert '"distilledTier" IN (\'collection\', \'deep_read\')' in sql
    assert '"contentReviewStatus" IN (\'approved\', \'needs_manual_review\')' in sql
    assert 'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\'' in sql
    assert params[1] == "summary-1"


@pytest.mark.asyncio
async def test_run_render_review_persists_browser_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool()
    claims = iter([("summary-1", 1, "sha-1", "claim-1"), None])
    persisted: list[tuple[str, int, str, dict[str, Any]]] = []

    async def fake_claim(_: Any) -> tuple[str, int, str, str] | None:
        return next(claims)

    async def fake_recover(_: Any, *, limit: int) -> int:
        assert limit == 50
        return 0

    async def fake_script(*, summary_id: str, round_number: int) -> dict[str, Any]:
        assert summary_id == "summary-1"
        assert round_number == 1
        return {
            "status": "needs_manual_review",
            "summary": "移动端表格溢出",
            "findings": [{"code": "table_overflow"}],
        }

    async def fake_persist(
        _: Any,
        *,
        summary_id: str,
        round_number: int,
        claim_id: str,
        expected_sha256: str | None,
        result: dict[str, Any],
    ) -> str:
        assert expected_sha256 == "sha-1"
        assert claim_id == "claim-1"
        persisted.append((summary_id, round_number, claim_id, result))
        return "needs_manual_review"

    monkeypatch.setattr(rw, "_claim_next", fake_claim)
    monkeypatch.setattr(rw, "recover_stale_render_reviews", fake_recover)
    monkeypatch.setattr(rw, "_run_browser_script", fake_script)
    monkeypatch.setattr(rw, "_persist_result", fake_persist)

    result = await rw.run_render_review_once(pool, limit=2)

    assert result == {"claimed": 1, "approved": 0, "manual": 1, "unavailable": 0}
    assert persisted[0][0:2] == ("summary-1", 1)
    assert persisted[0][2] == "claim-1"


@pytest.mark.asyncio
async def test_recover_stale_render_reviews_requeues_first_round_and_closes_exhausted_rows() -> None:
    pool = _Pool(rows=[{"id": "stale-1"}, {"id": "stale-2"}])

    recovered = await rw.recover_stale_render_reviews(pool, limit=10)

    assert recovered == 2
    sql, params = pool.connection_value.executions[0]
    assert "WITH stale AS" in sql
    assert '"renderReviewStatus" = \'reviewing\'' in sql
    assert '"renderReviewClaimId" IS NULL' in sql
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert '"renderReviewRound" >= 2' in sql
    assert '"renderReviewClaimId" = NULL' in sql
    assert any("WORKER_LOST" in str(value) for value in params)
    assert params[0] == 10


@pytest.mark.asyncio
async def test_claim_next_generates_a_unique_render_review_token() -> None:
    pool = _Pool({
        "id": "summary-1",
        "renderReviewRound": 1,
        "originalSha256": "sha-1",
        "renderReviewClaimId": "claim-1",
    })

    claimed = await rw._claim_next(pool)

    assert claimed == ("summary-1", 1, "sha-1", "claim-1")
    sql, _ = pool.connection_value.executions[0]
    assert '"renderReviewClaimId" = gen_random_uuid()' in sql
    assert '"renderReviewClaimId"' in sql.split("RETURNING", 1)[1]


@pytest.mark.asyncio
async def test_persist_result_requires_the_current_render_claim() -> None:
    pool = _Pool({"id": "summary-1"})
    claim_id = "11111111-1111-4111-8111-111111111111"

    status = await rw._persist_result(
        pool,
        summary_id="summary-1",
        round_number=1,
        claim_id=claim_id,
        expected_sha256="sha-1",
        result={"status": "approved", "summary": "ok"},
    )

    assert status == "approved"
    sql, params = pool.connection_value.executions[0]
    assert '"renderReviewClaimId" = %s::uuid' in sql
    assert params[-2:] == (claim_id, "sha-1")


@pytest.mark.asyncio
async def test_persist_result_discards_a_late_worker_result() -> None:
    pool = _Pool()

    status = await rw._persist_result(
        pool,
        summary_id="summary-1",
        round_number=1,
        claim_id="11111111-1111-4111-8111-111111111111",
        expected_sha256="sha-1",
        result={"status": "approved"},
    )

    assert status is None


@pytest.mark.asyncio
async def test_retry_render_review_preserves_round_for_second_review() -> None:
    pool = _Pool({"id": "summary-1"})

    queued = await rw.retry_render_review(pool, summary_id="summary-1")

    assert queued is True
    sql, params = pool.connection_value.executions[0]
    assert '"renderReviewStatus" = \'queued\'' in sql
    assert '"renderReviewRound" < %s' in sql
    assert params[-1] == 2


def test_render_review_disabled_by_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RADAR_RENDER_REVIEW_ENABLED", "0")
    assert rw.render_review_enabled() is False


def test_stale_render_review_minutes_has_a_bounded_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RADAR_RENDER_REVIEW_STALE_MINUTES", "invalid")
    assert rw._stale_review_minutes() == 30

    monkeypatch.setenv("RADAR_RENDER_REVIEW_STALE_MINUTES", "1")
    assert rw._stale_review_minutes() == 5

    monkeypatch.setenv("RADAR_RENDER_REVIEW_STALE_MINUTES", "45")
    assert rw._stale_review_minutes() == 45
