from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any

from ai_engine.radar.candidate_postprocessor import score_missing_candidates
from ai_engine.radar.distilled_scorer import default_score
from ai_engine.scoring.scoring_profiles import get_profile


class _Cursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None, rowcount: int = 1) -> None:
        self.rows = rows or []
        self.rowcount = rowcount

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.executions: list[tuple[str, tuple[Any, ...]]] = []
        self.update_rowcount = 1

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        return _Cursor(
            self.rows if sql.lstrip().startswith("SELECT") else [],
            self.update_rowcount,
        )


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
    assert 'WHEN %s::text IS NULL THEN NULL' in update_sql
    assert 'WHEN %s OR %s::text IS NULL OR %s THEN NULL' in update_sql
    assert update_params[1] == 58.0


async def test_only_unscored_filters_pending_scored_rows_and_guards_update() -> None:
    pool = _Pool([{
        "id": "summary-unscored",
        "title": "Unscored radar",
        "body": "Technical content about a working implementation. " * 40,
        "url": "https://example.com/article",
        "sourceType": "rss",
    }])

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return replace(
            default_score(get_profile("news")),
            tier="skim",
            is_default=False,
        )

    scored = await score_missing_candidates(
        pool, only_unscored=True, suppress_enrichment=True, scorer=fake_scorer,
    )
    assert scored == 1
    select_sql = pool.connection_value.executions[0][0]
    update_sql = pool.connection_value.executions[1][0]
    assert 'WHERE s."distilledScore" IS NULL' in select_sql
    assert "score_pending_after_enrichment" not in select_sql
    assert 'WHERE "id" = %s AND "distilledScore" IS NULL' in update_sql

    # Another worker saved a score while the LLM was running.
    pool.connection_value.update_rowcount = 0
    assert await score_missing_candidates(
        pool, only_unscored=True, suppress_enrichment=True, scorer=fake_scorer,
    ) == 0


async def test_rescoring_enriched_repo_uses_github_profile_and_signals() -> None:
    pool = _Pool([{
        "id": "summary-repo",
        "title": "Fission-AI/OpenSpec",
        "body": "repo summary",
        "url": "https://github.com/Fission-AI/OpenSpec",
        "publishedAt": None,
        "originalMarkdown": (
            "# OpenSpec\n\n"
            "## Architecture\nThe parser builds a workflow graph.\n\n"
            "## Tests\npytest and benchmark evaluation are included.\n"
        ) * 20,
        "originalKind": "github_repo",
        "originalMeta": {
            "stars": 68_000,
            "tree": [
                {"path": ".github/workflows/ci.yml"},
                {"path": "src/parser.py"},
                {"path": "tests/test_parser.py"},
            ],
        },
        "enrichmentStatus": "ready",
        "readerQualityStatus": "ready",
        "sourceType": "rss",
    }])
    calls: list[dict[str, Any]] = []

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        calls.append(kwargs)
        return replace(
            default_score(get_profile("engineering")),
            total=70.0,
            effective_total=70.0,
            ranking_score=70.0,
            tier_score=70.0,
            tier="deep_read",
            is_default=False,
        )

    scored = await score_missing_candidates(
        pool,
        rescore=True,
        concurrency=1,
        scorer=fake_scorer,
    )

    assert scored == 1
    assert calls[0]["source_type"] == "github"
    assert calls[0]["profile"].id == "engineering"
    assert calls[0]["structured_signals"]["stars"] == 68_000
    assert calls[0]["structured_signals"]["hasCiAction"] is True
    assert calls[0]["structured_signals"]["hasTests"] is True


async def test_external_reading_rescore_preserves_high_tier_without_enrichment() -> None:
    pool = _Pool([{
        "id": "summary-external",
        "title": "acme/external-repo",
        "body": "A useful external reading brief. " * 80,
        "url": "https://github.com/acme/external-repo",
        "publishedAt": None,
        "originalMarkdown": None,
        "tags": ["external_reading"],
        "originalKind": "github_repo",
        "originalMeta": None,
        "enrichmentStatus": None,
        "readerQualityStatus": None,
        "sourceType": "github",
    }])

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return replace(
            default_score(get_profile("engineering")),
            total=80.0,
            effective_total=80.0,
            ranking_score=80.0,
            tier_score=80.0,
            tier="deep_read",
            is_default=False,
        )

    scored = await score_missing_candidates(pool, scorer=fake_scorer)

    assert scored == 1
    update_sql, update_params = pool.connection_value.executions[1]
    assert 'WHEN %s THEN NULL' in update_sql
    assert update_params[2] == "deep_read"
    assert str(update_params[5]).startswith("补评分：全文未缓存")
    assert update_params[6] is False
    assert update_params[7] is True
    assert update_params[9] is False
    assert update_params[-1] == "summary-external"


async def test_transient_external_uses_source_even_when_generated_brief_is_long() -> None:
    brief = "Generated summary with no direct source evidence. " * 25
    source = "Source document records measurements, benchmarks, and limitations. " * 20
    pool = _Pool([{
        "id": "external",
        "title": "Source-backed article",
        "body": brief,
        "interpretation": brief,
        "url": "https://arxiv.org/abs/2609.00001",
        "tags": ["external_reading"],
        "sourceType": "arxiv",
    }])
    calls: list[str] = []

    async def source_input(_: Any, row: dict[str, Any]) -> tuple[str, str]:
        calls.append(row["id"])
        return source, "transient_source"

    async def scorer(title: str, content: str, **kwargs: Any):  # type: ignore[no-untyped-def]
        assert content == source
        return replace(default_score(get_profile("paper")), is_default=False)

    assert await score_missing_candidates(
        pool, only_unscored=True, suppress_enrichment=True,
        transient_input=source_input, scorer=scorer,
    ) == 1
    assert calls == ["external"]
    updates = [params for sql, params in pool.connection_value.executions if sql.startswith("UPDATE")]
    assert len(updates) == 1
    assert "临时读取的来源正文" in updates[0][5]
    assert source not in str(updates[0])


async def test_transient_external_unavailable_leaves_row_unscored_and_untouched() -> None:
    pool = _Pool([{
        "id": "external",
        "title": "Only a generated brief",
        "body": "Generated summary with no direct source evidence. " * 25,
        "interpretation": "Generated summary with no direct source evidence. " * 25,
        "url": "https://arxiv.org/abs/2609.00001",
        "tags": ["external_reading"],
        "sourceType": "arxiv",
    }])

    async def no_source(_: Any, row: dict[str, Any]) -> None:
        return None

    async def no_score(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        raise AssertionError("cannot score a generated brief as source text")

    assert await score_missing_candidates(
        pool, only_unscored=True, transient_input=no_source, scorer=no_score,
    ) == 0
    assert len(pool.connection_value.executions) == 1


async def test_suppressed_enrichment_rescore_keeps_high_tier_for_legacy_row() -> None:
    pool = _Pool([{
        "id": "summary-legacy",
        "title": "Legacy radar item",
        "body": "A detailed technical article. " * 100,
        "url": "https://example.com/article",
        "publishedAt": None,
        "originalMarkdown": "A detailed technical article. " * 100,
        "tags": [],
        "originalKind": "article",
        "originalMeta": None,
        "enrichmentStatus": "manual",
        "readerQualityStatus": None,
        "sourceType": "rss",
    }])

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return replace(
            default_score(get_profile("news")),
            total=80.0,
            effective_total=80.0,
            ranking_score=80.0,
            tier_score=80.0,
            tier="deep_read",
            is_default=False,
        )

    scored = await score_missing_candidates(
        pool,
        rescore=True,
        suppress_enrichment=True,
        scorer=fake_scorer,
    )

    assert scored == 1
    update_sql, update_params = pool.connection_value.executions[1]
    assert '"enrichmentStatus" = CASE ' in update_sql
    assert 'WHEN %s THEN "enrichmentStatus"' in update_sql
    assert 'WHEN %s THEN "enrichmentNextRetryAt"' in update_sql
    assert update_sql.count('WHEN %s THEN NULL') == 1
    assert update_params[2] == "deep_read"
    assert update_params[6] is True
    assert update_params[7] is True
    assert update_params[10] is True
    assert update_params[11] is True
    assert update_params[-1] == "summary-legacy"


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
    assert len(pool.connection_value.executions) == 1


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


async def test_limited_content_cannot_persist_high_value_deliverable_tier() -> None:
    pool = _Pool([{
        "id": "summary-limited-high",
        "title": "Limited source",
        "body": "abstract",
        "url": "https://example.com/limited",
        "publishedAt": None,
        "originalMarkdown": "A limited but scoreable abstract. " * 18,
        "tags": ["content_pending"],
        "sourceType": "rss",
    }])

    async def fake_scorer(*args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return replace(
            default_score(get_profile("news")),
            total=80.0,
            effective_total=80.0,
            ranking_score=80.0,
            tier_score=80.0,
            tier="deep_read",
            is_default=False,
        )

    scored = await score_missing_candidates(pool, scorer=fake_scorer)

    assert scored == 1
    update_sql, update_params = pool.connection_value.executions[1]
    assert '"distilledTier" = %s' in update_sql
    assert '"distilledTargetTier" = %s' in update_sql
    assert update_params[2] == "skim"
    assert update_params[3] == "deep_read"
    assert update_params[7] is False


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
    select_sql = pool.connection_value.executions[0][0]
    assert "score_pending_after_enrichment" in select_sql
    update_sql = pool.connection_value.executions[1][0]
    assert (
        "tag NOT IN ('content_pending', 'fetch_failed_shell', "
        "'score_pending_after_enrichment')"
    ) in update_sql
    assert "content_pending" in update_sql
    update_params = pool.connection_value.executions[1][1]
    assert not str(update_params[5]).startswith("抓取失败:")


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
    assert "ARRAY['fetch_failed_shell', 'tier_' || %s]" in update_sql
    assert "抓取失败: 推广/重定向页" in str(update_params[5])
