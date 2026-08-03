from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError
from ai_engine.radar.models import RadarCandidate, RadarSource, RepoActivity, RepoActivityItem
from ai_engine.radar.source_manager import fetch_source as dispatch_source
from ai_engine.radar.sync_runner import (
    _NAV_NOISE_PATTERNS,
    _clean_content,
    _generate_brief_with_retry,
    _is_low_quality_content,
    run_radar_sync,
)
from ai_engine.contracts.states import AI_JOB_STATUS


class _Cursor:
    def __init__(self, row: dict[str, Any] | None = None, rows: list[dict[str, Any]] | None = None) -> None:
        self.row = row
        self.rows = rows or []

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self, sources: list[dict[str, Any]]) -> None:
        self.sources = sources
        self.executions: list[tuple[str, tuple[Any, ...]]] = []
        self.canonical_urls: set[str] = set()

    @asynccontextmanager
    async def transaction(self):  # type: ignore[no-untyped-def]
        yield

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        if 'FROM "radar_sources" WHERE "enabled"' in sql:
            return _Cursor(rows=self.sources)
        if 'SELECT "id" FROM "summaries"' in sql:
            canonical = str(params[0])
            return _Cursor({"id": "existing"} if canonical in self.canonical_urls else None)
        if 'INSERT INTO "summaries"' in sql:
            canonical = str(params[4])
            if canonical in self.canonical_urls:
                return _Cursor(None)
            self.canonical_urls.add(canonical)
            return _Cursor({"id": str(params[0])})
        if 'INSERT INTO "radar_sync_runs"' in sql:
            return _Cursor()
        return _Cursor()

    async def commit(self) -> None:
        return None


class _Pool:
    def __init__(self, sources: list[dict[str, Any]]) -> None:
        self.connection_value = _Connection(sources)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _source(source_id: str = "source-1", source_type: str = "rss") -> dict[str, Any]:
    return {
        "id": source_id,
        "name": source_type,
        "sourceType": source_type,
        "config": {},
    }


def _candidate(url: str = "https://example.com/item") -> RadarCandidate:
    return RadarCandidate(
        title="LLM agent update",
        url=url,
        snippet="RAG update",
        published_at=datetime.now(timezone.utc),
        content_origin="rss",
        tags=("ai",),
    )


def _repo_digest_candidate() -> RadarCandidate:
    """One tracked repo carrying issues/PRs/releases from the last 24h."""
    activity = RepoActivity(
        repo="acme/agent",
        issues=(
            RepoActivityItem(
                kind="issue",
                number="42",
                title="Fix agent crash on retries",
                url="https://github.com/acme/agent/issues/42",
                state="open",
                author="alice",
                comments=5,
                labels=("bug",),
                created_at="2026-07-30T12:00:00Z",
                updated_at="2026-07-30T12:00:00Z",
                body="Agent crash repro and proposed fix.",
            ),
        ),
        prs=(
            RepoActivityItem(
                kind="pr",
                number="101",
                title="Add MCP tool registry",
                url="https://github.com/acme/agent/pull/101",
                state="open",
                author="bob",
                comments=3,
                created_at="2026-07-30T13:00:00Z",
                updated_at="2026-07-30T13:00:00Z",
                body="Adds registry with tool schemas.",
            ),
        ),
        releases=(
            RepoActivityItem(
                kind="release",
                number="v2.0",
                title="v2.0",
                url="https://github.com/acme/agent/releases/tag/v2.0",
                state="published",
                author="alice",
                created_at="2026-07-30T14:00:00Z",
                updated_at="2026-07-30T14:00:00Z",
                published_at="2026-07-30T14:00:00Z",
                body="Release with new agent runtime.",
            ),
        ),
    )
    return RadarCandidate(
        title="acme/agent 24h GitHub 动态",
        url="https://github.com/acme/agent?digest=2026-07-31",
        snippet="acme/agent 24h GitHub 动态",
        published_at=datetime.now(timezone.utc),
        content_origin="api",
        tags=("github", "tracked", "acme/agent", "repo_digest"),
        source_quality_hint=0.90,
        repo_activity=activity,
    )


def _document(url: str = "https://example.com/item") -> FetchedDocument:
    body = (
        "A new study on hierarchical planning in LLM agents with "
        "retrieval-augmented generation. The authors evaluate sparse and "
        "dense retrieval over a mixed corpus and report that structured "
        "prompting improves task completion while cutting token waste. "
        "This matters for production agents that must stay within a budget."
    ) * 2
    return FetchedDocument(
        url=url,
        final_ip="93.184.216.34",
        status=200,
        headers={"content-type": "text/html"},
        content=f"<title>LLM agent update</title><p>{body}</p>".encode(),
        content_type="text/html",
        elapsed_ms=5,
        redirect_count=0,
    )


async def _safe_fetch(url: str, **kwargs: Any) -> FetchedDocument:
    return _document(url)


async def test_sync_writes_candidate_fields_and_cost() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
    )
    assert result.runs[0].status == "completed"
    assert result.runs[0].total_new == 1
    assert result.runs[0].token_input_total > 0
    insert = next(item for item in pool.connection_value.executions if 'INSERT INTO "summaries"' in item[0])
    sql, params = insert
    assert "'candidate'" in sql
    assert "'daily'" in sql
    assert params[5] == "rss"
    assert params[14] == "1.2"
    assert "仅用于排序，不自动发布" in params[15]


async def test_sync_duplicate_canonical_url_rerun_does_not_insert() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate("https://EXAMPLE.com/item/?utm_source=x#part")]

    kwargs = {
        "adapter": FakeAdapter(),
        "fetchers": {"rss": fetcher},
        "document_fetcher": _safe_fetch,
    }
    first = await run_radar_sync(pool, **kwargs)
    second = await run_radar_sync(pool, **kwargs)
    assert first.runs[0].total_new == 1
    assert second.runs[0].total_new == 0
    assert second.runs[0].total_skipped == 1
    assert second.runs[0].skipped_existing == 1
    assert second.runs[0].skipped_rule_noise == 0
    assert second.runs[0].skipped_distilled_noise == 0
    assert second.runs[0].skipped_conflict == 0


async def test_sync_tracks_default_score_as_fallback_and_skips_noise() -> None:
    from ai_engine.radar.distilled_scorer import default_score

    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    async def default_scorer_fn(title: str, content: str, **kwargs: Any) -> Any:
        return default_score()

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        distilled_scorer=default_scorer_fn,
    )
    run = result.runs[0]
    assert run.fallback_count == 1
    assert run.skipped_distilled_noise == 1
    assert run.total_new == 0


async def test_run_radar_sync_limits_source_concurrency() -> None:
    pool = _Pool([
        _source("rss-1", "rss"),
        _source("gh-1", "github"),
        _source("devto-1", "devto"),
    ])
    active = 0
    max_active = 0

    async def fetcher(url: str) -> Any:
        async def handler(config: dict[str, Any]) -> list[RadarCandidate]:
            return [_candidate(url)]
        return handler

    async def slow_generate(adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any) -> Any:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.1)
        active -= 1
        from ai_engine.ingestion.pipeline import _generate_brief
        return await _generate_brief(adapter, item, canonical, **kwargs)

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={
            "rss": await fetcher("https://example.com/rss"),
            "github": await fetcher("https://example.com/github"),
            "devto": await fetcher("https://example.com/devto"),
        },
        document_fetcher=_safe_fetch,
        generate_brief=slow_generate,
        source_concurrency=2,
    )
    assert max_active <= 2
    assert all(run.total_new == 1 for run in result.runs)


async def test_source_failure_does_not_block_other_source() -> None:
    pool = _Pool([_source("bad", "rss"), _source("good", "github")])

    async def failed(config: dict[str, Any]) -> list[RadarCandidate]:
        raise httpx.TimeoutException("timeout")

    async def good(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate("https://example.com/good")]

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": failed, "github": good},
        document_fetcher=_safe_fetch,
    )
    assert [run.status for run in result.runs] == ["failed", "completed"]
    assert result.runs[1].total_new == 1


async def test_candidate_safe_fetch_failure_makes_run_partial() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    async def blocked(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError("URL_FETCH_BLOCKED", "blocked", host="example.com")

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=blocked,
    )
    assert result.runs[0].status == "partial"
    assert result.runs[0].total_failed == 1
    assert result.runs[0].error_code == "URL_FETCH_BLOCKED"


async def test_generate_failure_isolated_from_next_candidate() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [
            _candidate("https://example.com/one"),
            _candidate("https://example.com/two"),
        ]

    calls = 0

    async def generate(adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("brief timeout")
        from ai_engine.ingestion.pipeline import _generate_brief

        return await _generate_brief(adapter, item, canonical, **kwargs)

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=generate,
    )
    assert result.runs[0].status == "partial"
    assert result.runs[0].total_failed == 1
    assert result.runs[0].total_new == 1


async def test_github_tracked_repo_digest_uses_one_combined_activity_brief() -> None:
    """A tracked repo is summarized once over its combined activity.

    Regression: the generic sync path used to fetch the repo HTML page and
    feed the README to the brief LLM, ignoring ``repo_activity`` entirely.
    The digest branch must skip HTML fetching and pass issues/PRs/releases
    together to exactly one per-repo brief call.
    """
    pool = _Pool([_source("tracked-1", "github_tracked")])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_repo_digest_candidate()]

    fetched_urls: list[str] = []

    async def no_html_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        fetched_urls.append(url)
        return _document(url)

    brief_items: list[dict[str, Any]] = []

    async def record_brief(
        adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any
    ) -> Any:
        brief_items.append(item)
        from ai_engine.ingestion.pipeline import _generate_brief

        return await _generate_brief(adapter, item, canonical, **kwargs)

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"github_tracked": fetcher},
        document_fetcher=no_html_fetch,
        generate_brief=record_brief,
    )
    run = result.runs[0]
    assert run.status == "completed"
    assert run.total_new == 1
    assert run.fallback_count == 0
    assert fetched_urls == []
    assert len(brief_items) == 1
    context = brief_items[0]["snippet"]
    assert "# acme/agent" in context
    assert "Fix agent crash on retries" in context
    assert "Add MCP tool registry" in context
    assert "v2.0" in context
    assert "README" not in context

    insert = next(
        item
        for item in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in item[0]
    )
    _, params = insert
    assert params[23].startswith("# acme/agent")
    assert "Add MCP tool registry" in params[23]
    assert params[24] == "github_repo"


async def test_sync_rejects_invalid_trigger() -> None:
    pool = _Pool([])
    import pytest

    with pytest.raises(ValueError, match="cron or admin"):
        await run_radar_sync(pool, triggered_by="machine")


async def test_dispatch_source_configuration_is_passed() -> None:
    source = RadarSource("s", "rss", "rss", {"feedUrl": "https://feed.test"})
    seen: list[dict[str, Any]] = []

    async def handler(config: dict[str, Any]) -> list[RadarCandidate]:
        seen.append(config)
        return []

    await dispatch_source(source, fetchers={"rss": handler})
    assert seen == [{"feedUrl": "https://feed.test"}]


# ───────────── W7 (engineer B): S1 #7 regression ─────────────


async def test_arxiv_source_failure_surfaces_typed_root_cause() -> None:
    """Regression for S1 #7: when the arxiv fetcher fails, the sync
    runner's `error_code` must reflect the *root cause* (e.g. a
    network/timeout/parse error) instead of collapsing everything to
    ``AI_ENGINE_UNAVAILABLE``.
    """
    pool = _Pool([_source("arxiv-1", "arxiv")])

    async def broken_arxiv(config: dict[str, Any]) -> list[RadarCandidate]:
        # Simulate ``fetch_arxiv`` raising a typed RuntimeError when
        # the upstream service is unreachable.
        raise RuntimeError("arxiv_timeout:ReadTimeout")

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"arxiv": broken_arxiv},
        document_fetcher=_safe_fetch,
    )
    assert result.runs[0].status == "failed"
    # The arxiv_timeout prefix must be translated to WORKER_TIMEOUT,
    # NOT AI_ENGINE_UNAVAILABLE — the walkthrough regression that
    # this test pins.
    assert result.runs[0].error_code == "WORKER_TIMEOUT", (
        f"expected WORKER_TIMEOUT, got {result.runs[0].error_code!r}"
    )


# ---------------------------------------------------------------------------
# Week 9 收尾：_clean_content 单元测试
# 行为契约：
#   - 空串 / 短串 → ""
#   - 移除 _NAV_NOISE_PATTERNS 中的所有片段（多次出现也全删）
#   - 多余空白折叠为单空格
#   - 清洗后仍短于 min_len → ""（用 default_score 兜底）
# ---------------------------------------------------------------------------


def test_clean_content_strips_all_navigation_patterns() -> None:
    body = (
        "Skip to main content Skip to content Log in Sign in Try ChatGPT "
        "Try ChatGPT (opens in a new window) Navigation menu Search "
        "Create account Close Add reaction Like Unicorn Jump to Comments "
        "Powered by Algolia Back to Articles "
    )
    # 200+ 字符纯噪音应被完全清空（移除后 < min_len=200）
    assert _clean_content(body) == ""


def test_clean_content_keeps_substantive_text() -> None:
    body = (
        "Skip to main content Log in "
        "A new study on hierarchical planning in LLM agents. " * 5
    )
    cleaned = _clean_content(body)
    assert "Skip to main content" not in cleaned
    assert "Log in" not in cleaned
    assert "hierarchical planning" in cleaned
    assert len(cleaned) >= 200


def test_clean_content_returns_empty_for_short_input() -> None:
    assert _clean_content("") == ""
    assert _clean_content("short") == ""
    assert _clean_content("a" * 199) == ""


def test_clean_content_collapses_whitespace() -> None:
    body = "A " + ("\n\n\t " * 30) + ("study on retrieval-augmented generation. " * 6)
    cleaned = _clean_content(body)
    assert "  " not in cleaned
    assert "\n" not in cleaned
    assert "\t" not in cleaned


def test_clean_content_threshold_after_cleaning() -> None:
    # 原 250 字符但含大量 nav，洗净后 < 200 → 返回 ""
    body = ("Skip to main content " * 20) + "word " * 30
    assert _clean_content(body) == ""


def test_nav_noise_patterns_list_is_non_empty() -> None:
    # 防止有人意外清空列表导致退化为恒等
    assert len(_NAV_NOISE_PATTERNS) >= 5
    assert all(isinstance(p, str) and p for p in _NAV_NOISE_PATTERNS)


# ───────────── W10: low-quality fallback + 429 retry ─────────────


def test_is_low_quality_content_detects_short_and_cloudflare_text() -> None:
    assert _is_low_quality_content("")
    assert _is_low_quality_content("short")
    assert _is_low_quality_content("x" * 199)
    long_cloudflare = (
        "Just a moment... Enable JavaScript and cookies to continue. "
        "Checking your browser before accessing the site. "
        "Performance & security by Cloudflare."
    ) * 5
    assert _is_low_quality_content(long_cloudflare)
    assert not _is_low_quality_content(
        "A real article about LLM agents with enough body text to summarize. " * 5
    )


async def test_short_content_fallback_skips_llm_and_keeps_raw_text() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    brief_called = False

    async def should_not_be_called(**kwargs: Any) -> Any:
        nonlocal brief_called
        brief_called = True
        raise AssertionError("brief LLM must not run for short content")

    async def short_doc(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=b"<p>Too short to summarize.</p>",
            content_type="text/html",
            elapsed_ms=5,
            redirect_count=0,
        )

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=short_doc,
        generate_brief=should_not_be_called,
    )
    run = result.runs[0]
    assert run.fallback_count == 1
    assert run.total_new == 1
    assert run.token_input_total == 0
    assert run.cost_usd == 0.0
    assert brief_called is False
    insert = next(item for item in pool.connection_value.executions if 'INSERT INTO "summaries"' in item[0])
    sql, params = insert
    assert params[21] == "Too short to summarize."


async def test_cloudflare_content_fallback_keeps_raw_text() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate("https://example.com/producthunt")]

    body = (
        "Just a moment... Enable JavaScript and cookies to continue. "
        "Checking your browser before accessing the site."
    ) * 6

    async def cloudflare_doc(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=body.encode(),
            content_type="text/html",
            elapsed_ms=5,
            redirect_count=0,
        )

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=cloudflare_doc,
    )
    run = result.runs[0]
    assert run.fallback_count == 1
    assert run.total_new == 1
    insert = next(item for item in pool.connection_value.executions if 'INSERT INTO "summaries"' in item[0])
    _, params = insert
    assert params[21] == body.strip()[:2000]


async def test_generate_brief_with_retry_retries_429(monkeypatch: pytest.MonkeyPatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr("asyncio.sleep", fake_sleep)
    calls = 0

    async def flaky_generate(
        adapter: Any, item: dict[str, Any], canonical_url: str, **kwargs: Any
    ) -> Any:
        nonlocal calls
        calls += 1
        if calls < 3:
            return type(
                "Brief",
                (),
                {
                    "status": AI_JOB_STATUS["FAILED"],
                    "error_code": "AI_ENGINE_UNAVAILABLE",
                    "error_message": "HTTP 429 too many requests",
                },
            )()
        return type(
            "Brief",
            (),
            {
                "status": AI_JOB_STATUS["SUCCEEDED"],
                "output_text": "ok",
                "cost": type("Cost", (), {"token_input_total": 1, "token_output_total": 2, "cost_cents": 0.3})(),
            },
        )()

    brief = await _generate_brief_with_retry(
        flaky_generate,
        FakeAdapter(),
        {"title": "x", "snippet": "y"},
        "https://example.com/x",
        timeout_seconds=30.0,
    )
    assert calls == 3
    assert sleeps == [5.0, 10.0]
    assert brief.output_text == "ok"
