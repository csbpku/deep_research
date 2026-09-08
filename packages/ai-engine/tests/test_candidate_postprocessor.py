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
        "originalMarkdown": "full fetched article with enough technical detail " * 30,
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
            tier_score=58.0,
            tier="deep_read",
            is_default=False,
        )

    scored = await score_missing_candidates(
        pool, limit=5, concurrency=1, scorer=fake_scorer,
    )

    assert scored == 1
    assert calls == [("Shared article", "full fetched article with enough technical detail " * 30, "web_share")]
    select_sql = pool.connection_value.executions[0][0]
    assert '"share_submissions"' in select_sql
    update_sql, update_params = pool.connection_value.executions[1]
    assert '"distilledScore"' in update_sql
    assert update_params[1] == 58.0


async def test_score_missing_candidates_leaves_default_score_retryable() -> None:
    pool = _Pool([{
        "id": "summary-2",
        "title": "Shared article",
        "body": "summary",
        "url": "https://example.com/article",
        "publishedAt": None,
        "originalMarkdown": "complete source article " * 60,
        "sourceType": "web_share",
    }])

    async def fallback_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return default_score(get_profile("news"))

    scored = await score_missing_candidates(pool, scorer=fallback_scorer)

    assert scored == 0
    assert len(pool.connection_value.executions) == 1


async def test_score_missing_candidates_defers_short_content_even_on_rescore() -> None:
    pool = _Pool([{
        "id": "summary-short",
        "title": "Short placeholder",
        "body": "A short feed description " * 12,
        "url": "https://example.com/short",
        "publishedAt": None,
        "originalMarkdown": "A short feed description " * 12,
        "tags": [],
        "sourceType": "rss",
    }])
    calls = 0

    async def unexpected_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        return default_score(get_profile("news"))

    scored = await score_missing_candidates(
        pool,
        rescore=True,
        scorer=unexpected_scorer,
    )

    assert scored == 0
    assert calls == 0
    assert len(pool.connection_value.executions) == 2
    update_sql, update_params = pool.connection_value.executions[1]
    assert "content_pending" in update_sql
    assert '"distilledScore" = NULL' in update_sql
    assert update_params == (None, "summary-short")
    assert "fetch_failed_shell" in update_sql


async def test_score_missing_candidates_allows_limited_abstract_for_triage() -> None:
    pool = _Pool([{
        "id": "summary-abstract",
        "title": "Abstract-only paper",
        "body": "abstract",
        "url": "https://arxiv.org/abs/2608.00001",
        "publishedAt": None,
        "originalMarkdown": "A useful paper abstract with technical evidence. " * 12,
        "tags": [],
        "sourceType": "arxiv",
    }])

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return replace(
            default_score(get_profile("paper")),
            total=52.0,
            effective_total=52.0,
            ranking_score=52.0,
            tier_score=52.0,
            tier="skim",
            is_default=False,
        )

    scored = await score_missing_candidates(
        pool, scorer=fake_scorer,
    )

    assert scored == 1
    update_sql, update_params = pool.connection_value.executions[1]
    assert "低置信度初筛" in str(update_params)
    assert "content_pending" in update_sql


async def test_score_missing_candidates_retries_complete_content_pending_row() -> None:
    content = (
        "Complete repository documentation with architecture and tests. " * 50
        + "\nTroubleshooting explains how to handle access denied errors."
    )
    pool = _Pool([{
        "id": "summary-ready",
        "title": "acme/ready-repo",
        "body": "old summary",
        "url": "https://github.com/acme/ready-repo",
        "publishedAt": None,
        "originalMarkdown": content,
        "tags": ["content_pending"],
        "sourceType": "github",
    }])
    calls = 0

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        return replace(
            default_score(get_profile("engineering")),
            total=70.0,
            effective_total=68.0,
            ranking_score=66.0,
            tier_score=58.0,
            tier="deep_read",
            is_default=False,
        )

    scored = await score_missing_candidates(pool, scorer=fake_scorer)

    assert scored == 1
    assert calls == 1
    update_sql = pool.connection_value.executions[1][0]
    assert "array_remove" in update_sql
    assert "content_pending" in update_sql
    update_params = pool.connection_value.executions[1][1]
    assert not str(update_params[4]).startswith("抓取失败:")


async def test_score_missing_candidates_tags_scored_shell_as_fetch_failure() -> None:
    pool = _Pool([{
        "id": "summary-shell",
        "title": "Airtop marketing page",
        "body": "mark by airtop " * 120,
        "url": "https://example.com/redirect",
        "publishedAt": None,
        "originalMarkdown": "mark by airtop " * 120,
        "tags": ["content_pending"],
        "sourceType": "web_share",
    }])

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return replace(
            default_score(get_profile("news")),
            total=30.0,
            effective_total=30.0,
            ranking_score=30.0,
            tier_score=30.0,
            tier="noise",
            is_default=False,
        )

    scored = await score_missing_candidates(pool, scorer=fake_scorer)

    assert scored == 1
    update_sql, update_params = pool.connection_value.executions[1]
    assert "fetch_failed_shell" in update_sql
    assert "'fetch_failed_shell') END" in update_sql
    assert "抓取失败: 推广/重定向页" in str(update_params[4])
