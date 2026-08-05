from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any

from ai_engine.radar.candidate_postprocessor import score_missing_candidates
from ai_engine.radar.distilled_scorer import default_score
from ai_engine.scoring.scoring_profiles import get_profile


class _Cursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows or []

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        return _Cursor(self.rows if sql.lstrip().startswith("SELECT") else [])


class _Pool:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.connection_value = _Connection(rows)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


async def test_score_missing_candidates_scores_approved_share_content() -> None:
    pool = _Pool([{
        "id": "summary-1",
        "title": "Shared article",
        "body": "short summary",
        "url": "https://example.com/article",
        "publishedAt": None,
        "originalMarkdown": "full fetched article",
        "sourceType": "web_share",
    }])
    calls: list[tuple[str, str, str | None]] = []

    async def fake_scorer(title: str, content: str, **kwargs: Any):  # type: ignore[no-untyped-def]
        calls.append((title, content, kwargs.get("source_type")))
        return replace(
            default_score(get_profile("news")),
            total=70.0,
            effective_total=68.0,
            ranking_score=66.0,
            tier="deep_read",
            is_default=False,
        )

    scored = await score_missing_candidates(
        pool, limit=5, concurrency=1, scorer=fake_scorer,
    )

    assert scored == 1
    assert calls == [("Shared article", "full fetched article", "web_share")]
    select_sql = pool.connection_value.executions[0][0]
    assert '"share_submissions"' in select_sql
    update_sql, update_params = pool.connection_value.executions[1]
    assert '"distilledScore"' in update_sql
    assert update_params[1] == 66.0


async def test_score_missing_candidates_leaves_default_score_retryable() -> None:
    pool = _Pool([{
        "id": "summary-2",
        "title": "Shared article",
        "body": "summary",
        "url": "https://example.com/article",
        "publishedAt": None,
        "originalMarkdown": None,
        "sourceType": "web_share",
    }])

    async def fallback_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return default_score(get_profile("news"))

    scored = await score_missing_candidates(pool, scorer=fallback_scorer)

    assert scored == 0
    assert len(pool.connection_value.executions) == 1
