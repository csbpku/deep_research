from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError
from ai_engine.radar.models import RadarCandidate, RadarSource, RepoSnapshot
from ai_engine.radar.source_manager import fetch_source as dispatch_source
from ai_engine.radar.sync_runner import (
    _NAV_NOISE_PATTERNS,
    _BriefGenerationError,
    _build_score_reason,
    _clean_content,
    _can_use_candidate_metadata_fallback,
    _content_fetch_failure_reason,
    _create_run,
    _extract_article_content,
    _can_use_github_repo_metadata_fallback,
    _classify_original_kind,
    _finish_run,
    _generate_brief_with_retry,
    _is_low_quality_content,
    _is_fetch_failure_shell,
    _preferred_document_urls,
    _safe_error_code,
    _scoreability,
    _shell_content_label,
    _strip_reasoning_markup,
    browser_reading_mode_enabled,
    RadarSyncResult,
    SourceRunResult,
    run_radar_pipeline,
    _retryable_latest_source_ids,
    _record_sync_diagnostic,
    _usable_feed_excerpt,
    _feed_excerpt_allowed_after_fetch_error,
    run_radar_sync,
)
from ai_engine.contracts.states import AI_JOB_STATUS
from ai_engine.radar.distilled_scorer import compute_score


@pytest.fixture(autouse=True)
def legacy_enrichment_mode_for_existing_sync_contracts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep historical sync tests explicit while production defaults to browser mode."""
    monkeypatch.setenv("RADAR_READING_MODE", "enriched")


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://github.com/openai/codex/issues/37674", "github_issue"),
        ("https://github.com/openai/codex/pull/123", "github_pr"),
        ("https://github.com/microsoft/agent-lightning/releases/tag/v1.0.1", "github_release"),
        ("https://github.com/openai/codex/blob/main/README.md", "github_other"),
        ("https://github.com/openai/codex", "github_repo"),
    ],
)
def test_classifies_github_item_urls_for_radar_boundary(url: str, expected: str) -> None:
    assert _classify_original_kind("rss", url) == expected


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

    @asynccontextmanager
    async def cursor(self, **kwargs: Any):
        connection = self

        class StreamCursor:
            itersize = 20

            async def execute(self, statement: Any) -> None:
                self.result = await connection.execute(statement)

            async def __aiter__(self):  # type: ignore[no-untyped-def]
                for row in self.result.rows:
                    yield row

        yield StreamCursor()

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        if not isinstance(sql, str):
            sql = sql.as_string()
        self.executions.append((sql, params))
        if 'FROM "radar_sources" WHERE "enabled"' in sql:
            return _Cursor(rows=self.sources)
        if 'SELECT "id", "sourceType" FROM "radar_sources"' in sql:
            return _Cursor(rows=self.sources)
        if 'FROM "summaries"' in sql and '"canonicalUrl"' in sql and 'SELECT' in sql:
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


@pytest.mark.parametrize("reading_mode", ["browser", "enriched"])
async def test_content_only_feed_never_persists_through_diagnostic_shell(
    monkeypatch: pytest.MonkeyPatch, reading_mode: str,
) -> None:
    monkeypatch.setenv("RADAR_READING_MODE", reading_mode)
    pool = _Pool([])
    excerpt = "Private feed content " * 100
    candidate = RadarCandidate(title="Title", url="https://example.com/item",
                               snippet=excerpt, feed_excerpt=excerpt, feed_snippet_from_content=True)
    await _record_sync_diagnostic(
        pool, source=RadarSource("source-1", "RSS", "rss", {}), run_id="run-1",
        candidate=candidate, canonical_url=candidate.url, kind="filtered",
        reason_code="PENDING_SCORE", body=excerpt, markdown="unusable page shell",
    )
    inserts = [params for sql, params in pool.connection_value.executions
               if 'INSERT INTO "radar_sync_diagnostics"' in sql]
    assert len(inserts) == 1
    assert inserts[0][7] == "" and inserts[0][8] is None
    assert excerpt[:100] not in str(pool.connection_value.executions)


@pytest.mark.parametrize("reading_mode", ["browser", "enriched"])
async def test_rss_excerpt_survives_timeout_without_persisting_original(
    monkeypatch: pytest.MonkeyPatch, reading_mode: str,
) -> None:
    monkeypatch.setenv("RADAR_READING_MODE", reading_mode)
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_FETCH_RETRIES", 0)
    source = _source()
    source["config"] = {"feedUrl": "https://example.com/feed"}
    pool = _Pool([source])
    feed_text = ("An agent implementation explains measured tradeoffs and latency. " * 120)
    candidate = RadarCandidate(
        title="LLM agent pipeline",
        url="https://example.com/article",
        snippet="A short article summary about agent pipelines.",
        content_origin="rss",
        feed_excerpt=feed_text,
        feed_source_host="example.com",
    )
    seen: dict[str, Any] = {}

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [candidate]

    async def timeout(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError("URL_FETCH_TIMEOUT", "timeout", host="example.com")

    async def brief(adapter: Any, item: dict[str, Any], url: str, **kwargs: Any) -> Any:
        seen["brief"] = item
        return type("Brief", (), {
            "status": AI_JOB_STATUS["SUCCEEDED"],
            "output_text": "文章描述了代理实现中的工程权衡、延迟和可验证的测量结果。" * 3,
            "cost": type("Cost", (), {
                "token_input_total": 1, "token_output_total": 1, "cost_cents": 0,
            })(),
        })()

    async def scorer(title: str, content: str, **kwargs: Any) -> Any:
        seen["scorer_content"] = content
        seen["scorer_kwargs"] = kwargs
        return compute_score({
            "信息增量": 2, "分析深度": 2, "可行动性": 2, "事实可信度": 2,
            "时效性": 2, "表达质量": 2, "综合信号": 2,
            "direct_relevance": 2, "scope_breadth": 1,
        }, source_type="rss")

    result = await run_radar_sync(
        pool, adapter=FakeAdapter(), fetchers={"rss": fetcher},
        document_fetcher=timeout, generate_brief=brief, distilled_scorer=scorer,
    )
    assert result.runs[0].total_new == 1
    assert seen["brief"]["context_is_source_excerpt"] is True
    assert seen["brief"]["snippet"] == feed_text.strip()
    assert "measured tradeoffs" in seen["scorer_content"]
    assert seen["scorer_kwargs"]["content_is_source_excerpt"] is True
    inserts = [entry for entry in pool.connection_value.executions if 'INSERT INTO "summaries"' in entry[0]]
    assert len(inserts) == 1
    params = inserts[0][1]
    assert params[15].startswith("RSS 来源片段初筛")
    assert params[23] is None
    assert "evidence_feed_excerpt" in params[10]
    assert feed_text not in str(pool.connection_value.executions)
    assert feed_text[:120] not in str(pool.connection_value.executions)
    diagnostics = [params for sql, params in pool.connection_value.executions
                   if 'INSERT INTO "radar_sync_diagnostics"' in sql]
    assert any(params[13] == "SOURCE_FEED_EXCERPT" for params in diagnostics)
    assert all(params[7] == "" and params[8] is None for params in diagnostics)


@pytest.mark.parametrize(("feed_host", "response_host", "article_url", "valid"), [
    ("example.com", "www.example.com", "https://www.example.com/a", True),
    ("example.com", "example.com", "https://evil-example.com/a", False),
    ("example.com", "elsewhere.com", "https://example.com/a", False),
    ("medium.com", "medium.com", "https://medium.com/other-author/a", False),
    ("a.example.com", "a.example.com", "https://b.example.com/a", False),
])
def test_feed_evidence_requires_non_shared_exact_publisher_host(
    feed_host: str, response_host: str, article_url: str, valid: bool,
) -> None:
    source = RadarSource(id="s", name="rss", source_type="rss", config={"feedUrl": f"https://{feed_host}/feed"})
    candidate = RadarCandidate(title="An AI engine update", url=article_url, content_origin="rss",
                               feed_source_host=response_host, feed_excerpt="Relevant engineering evidence. " * 30)
    assert bool(_usable_feed_excerpt(source, candidate)) is valid


def test_feed_evidence_requires_reliable_title() -> None:
    source = RadarSource(id="s", name="rss", source_type="rss", config={"feedUrl": "https://example.com/feed"})
    for title in ("", "Untitled", "No title"):
        candidate = RadarCandidate(title=title, url="https://example.com/a", content_origin="rss",
                                   feed_source_host="example.com", feed_excerpt="Evidence " * 100)
        assert _usable_feed_excerpt(source, candidate) == ""


def test_wrapped_rate_limit_cannot_use_feed_evidence() -> None:
    original = SafeFetchError("UPSTREAM_RATE_LIMITED", "rate limited")
    wrapper = RuntimeError("wrapper")
    wrapper.__cause__ = original
    assert not _feed_excerpt_allowed_after_fetch_error(wrapper)


@pytest.mark.parametrize("code", ["URL_FETCH_BLOCKED", "UPSTREAM_RATE_LIMITED", "CONTENT_TYPE_REJECTED"])
async def test_cross_site_content_only_feed_cannot_bypass_rejection(
    monkeypatch: pytest.MonkeyPatch, code: str,
) -> None:
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_FETCH_RETRIES", 0)
    source = _source()
    source["config"] = {"feedUrl": "https://aggregator.example/feed"}
    pool = _Pool([source])
    excerpt = "Feed source commentary mistakenly linked to another publication. " * 40
    candidate = RadarCandidate(title="LLM agent update", url="https://publisher.example/a", content_origin="rss",
                               snippet=excerpt[:2000], feed_excerpt=excerpt,
                               feed_source_host="aggregator.example", feed_snippet_from_content=True)

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [candidate]

    async def rejected(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError(code, "rejected", host="publisher.example")

    async def unexpected(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("Unrelated feed evidence must not be scored as the article")

    await run_radar_sync(pool, adapter=FakeAdapter(), fetchers={"rss": fetcher},
                         document_fetcher=rejected, generate_brief=unexpected,
                         distilled_scorer=unexpected)
    assert not any('INSERT INTO "summaries"' in sql for sql, _ in pool.connection_value.executions)
    assert excerpt[:100] not in str(pool.connection_value.executions)


@pytest.mark.parametrize("code", ["URL_FETCH_BLOCKED", "UPSTREAM_RATE_LIMITED", "CONTENT_TYPE_REJECTED"])
async def test_rss_feed_excerpt_cannot_bypass_safety_or_rate_limit(
    monkeypatch: pytest.MonkeyPatch, code: str,
) -> None:
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_FETCH_RETRIES", 0)
    source = _source()
    source["config"] = {"feedUrl": "https://example.com/feed"}
    pool = _Pool([source])
    candidate = RadarCandidate(
        title="LLM agent update", url="https://example.com/item", content_origin="rss",
        snippet="Useful abstract that must not bypass a blocked URL.",
        feed_excerpt="An agent paper with useful engineering details. " * 30,
        feed_source_host="example.com",
    )

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [candidate]

    async def rejected(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError(code, "rejected", host="example.com")

    async def unexpected(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("A blocked original URL must not enter model processing")

    await run_radar_sync(
        pool, adapter=FakeAdapter(), fetchers={"rss": fetcher},
        document_fetcher=rejected, generate_brief=unexpected, distilled_scorer=unexpected,
    )
    assert not any('INSERT INTO "summaries"' in sql for sql, _ in pool.connection_value.executions)


@pytest.mark.parametrize("challenge", ["prove your humanity", "complete the challenge"])
async def test_fetched_challenge_never_uses_feed_fallback(
    monkeypatch: pytest.MonkeyPatch, challenge: str,
) -> None:
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_FETCH_RETRIES", 0)
    source = _source()
    source["config"] = {"feedUrl": "https://example.com/feed"}
    pool = _Pool([source])
    candidate = RadarCandidate(
        title="LLM agent update", url="https://example.com/item", content_origin="rss",
        snippet="A useful but limited feed summary about LLM agents.",
        feed_excerpt="Longer article feed excerpt with engineering detail. " * 30,
        feed_source_host="example.com",
    )

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [candidate]

    async def blocked(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(url=url, final_ip="93.184.216.34", status=200, headers={},
                               content=challenge.encode(), content_type="text/html", elapsed_ms=1)

    async def unexpected(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("A verification shell cannot be scored")

    result = await run_radar_sync(pool, adapter=FakeAdapter(), fetchers={"rss": fetcher},
                                  document_fetcher=blocked, generate_brief=unexpected, distilled_scorer=unexpected)
    assert result.runs[0].total_failed == 1
    assert result.runs[0].error_code == "URL_FETCH_BLOCKED"
    assert not any('INSERT INTO "summaries"' in sql for sql, _ in pool.connection_value.executions)


async def test_verification_shell_in_feed_never_becomes_source_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_FETCH_RETRIES", 0)
    pool = _Pool([_source()])
    candidate = RadarCandidate(
        title="LLM agent update", url="https://example.com/item", content_origin="rss",
        snippet="short", feed_excerpt="Checking your browser before accessing the site. " * 50,
    )

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [candidate]

    async def timeout(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError("URL_FETCH_TIMEOUT", "timeout", host="example.com")

    async def unexpected(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("A verification shell cannot be scored")

    await run_radar_sync(pool, adapter=FakeAdapter(), fetchers={"rss": fetcher},
                         document_fetcher=timeout, generate_brief=unexpected,
                         distilled_scorer=unexpected)
    assert not any('INSERT INTO "summaries"' in sql for sql, _ in pool.connection_value.executions)


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


@pytest.mark.parametrize(
    ("source_type", "url", "expected_profile", "expected_source_type"),
    [
        ("rss", "https://platform.openai.com/docs/guides/agents", "engineering", "rss"),
        ("vendor_news", "https://docs.anthropic.com/en/docs/agents", "engineering", "vendor_news"),
        ("rss", "https://openai.com/index/agents", "news", "rss"),
        ("github", "https://github.com/openai/codex", "engineering", "github"),
        ("arxiv", "https://arxiv.org/abs/2401.00001", "paper", "arxiv"),
    ],
)
async def test_sync_routes_each_new_score_by_source_and_document_url(
    source_type: str, url: str, expected_profile: str, expected_source_type: str,
) -> None:
    """New sync decisions agree with repair while existing scores are retained."""
    pool = _Pool([_source(source_type=source_type)])
    seen: list[tuple[str, str, str]] = []

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate(url)]

    async def score(title: str, content: str, **kwargs: Any) -> Any:
        profile = kwargs["profile"]
        seen.append((profile.id, kwargs["source_type"], kwargs["url"]))
        return compute_score(
            {
                "信息增量": 3,
                "分析深度": 3,
                "可行动性": 3,
                "事实可信度": 3,
                "时效性": 3,
                "表达质量": 3,
                "综合信号": 3,
                "direct_relevance": 3,
                "relevance_evidence": "substantive source",
            },
            profile=profile,
            source_type=kwargs["source_type"],
        )

    kwargs = {
        "adapter": FakeAdapter(),
        "fetchers": {source_type: fetcher},
        "document_fetcher": _safe_fetch,
        "distilled_scorer": score,
    }
    first = await run_radar_sync(pool, **kwargs)
    second = await run_radar_sync(pool, **kwargs)

    assert first.runs[0].total_new == 1
    assert seen == [(expected_profile, expected_source_type, url)]
    _, params = next(
        entry for entry in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in entry[0]
    )
    assert params[20] == expected_profile
    assert second.runs[0].skipped_existing == 1
    assert len(seen) == 1


async def test_sync_keeps_discovery_url_when_article_mentions_github_repo() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        del config
        return [_candidate("https://example.com/article-about-agents")]

    async def fetch_article(url: str, **kwargs: Any) -> FetchedDocument:
        del kwargs
        document = _document(url)
        github_link = b"<p>Implementation: https://github.com/acme/agent</p>"
        return FetchedDocument(
            url=document.url,
            final_ip=document.final_ip,
            status=document.status,
            headers=document.headers,
            content=document.content + github_link,
            content_type=document.content_type,
            elapsed_ms=document.elapsed_ms,
            redirect_count=document.redirect_count,
        )

    await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=fetch_article,
    )

    _sql, params = next(
        item for item in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in item[0]
    )
    assert params[3] == "https://example.com/article-about-agents"
    assert params[4] == "https://example.com/article-about-agents"


async def test_sync_keeps_useful_short_judgement_instead_of_clearing_it() -> None:
    pool = _Pool([_source()])
    judgement = "这项工作提出可复现的代理工具调用流程，并比较了资源消耗与失败边界。"

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    async def short_brief(*args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        return type("Brief", (), {
            "status": AI_JOB_STATUS["SUCCEEDED"],
            "output_text": judgement,
            "cost": type("Cost", (), {
                "token_input_total": 10, "token_output_total": 10, "cost_cents": 0,
            })(),
        })()

    await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=short_brief,
    )
    _, params = next(
        item for item in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in item[0]
    )
    assert params[21] == judgement


async def test_sync_persists_high_score_as_target_but_only_skim_deliverable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # This assertion exercises the historical enrichment contract. Browser
    # reading is the production default now, so make the legacy mode explicit
    # instead of coupling the test to the rollout default.
    monkeypatch.setenv("RADAR_READING_MODE", "enriched")
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate("https://example.com/high-value")]

    async def high_score(title: str, content: str, **kwargs: Any) -> Any:
        del title, content, kwargs
        return compute_score(
            {
                "信息增量": 3,
                "分析深度": 3,
                "可行动性": 3,
                "事实可信度": 3,
                "时效性": 3,
                "表达质量": 3,
                "综合信号": 3,
                "direct_relevance": 3,
                "relevance_evidence": "substantive source",
            },
            source_type="rss",
        )

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        distilled_scorer=high_score,
    )

    assert result.runs[0].total_new == 1
    insert_sql, params = next(
        item for item in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in item[0]
    )
    assert '"distilledTargetTier"' in insert_sql
    assert params[18] == "skim"
    assert params[19] in {"deep_read", "collection"}
    assert params[25] is True
    assert params[27] is not None
    assert params[28] == "pending"
    assert params[29] == "pending"
    assert insert_sql.count("%s") == len(params)


async def test_create_run_initializes_lease_and_heartbeat() -> None:
    pool = _Pool([])
    source = RadarSource(
        id="source-1",
        name="RSS",
        source_type="rss",
        config={},
    )

    run_id = await _create_run(pool, source, "cron")

    sql, params = next(
        item
        for item in pool.connection_value.executions
        if 'INSERT INTO "radar_sync_runs"' in item[0]
    )
    assert '"lockedBy", "heartbeatAt", "leaseExpiresAt"' in sql
    assert params[:3] == (run_id, "source-1", "cron")
    assert params[3] == f"radar:{run_id}"
    assert isinstance(params[4], int)
    assert params[4] >= 60


async def test_existing_github_repo_is_deduplicated_without_tracked_repo_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.radar import enrichment_worker

    pool = _Pool([_source("github-source", "github")])
    enrichment_calls: list[str] = []
    snapshot = RepoSnapshot(
        owner_repo="acme/agent",
        description="Updated description",
        stars=123,
        forks=45,
        open_issues=6,
        default_branch="main",
        pushed_at="2026-08-07T01:00:00Z",
        github_updated_at="2026-08-07T02:00:00Z",
        sha256="a" * 64,
    )

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [RadarCandidate(
            title="acme/agent",
            url="https://github.com/acme/agent",
            snippet="Updated description",
            repo_snapshot=snapshot,
        )]

    async def unexpected_inline_enrichment(*args: Any, **kwargs: Any) -> None:
        enrichment_calls.append(str(kwargs.get("summary_id", "")))

    monkeypatch.setattr(
        enrichment_worker,
        "enrich_github_candidate",
        unexpected_inline_enrichment,
    )
    pool.connection_value.canonical_urls.add("https://github.com/acme/agent")
    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"github": fetcher},
        document_fetcher=_safe_fetch,
    )

    assert result.runs[0].skipped_existing == 1
    assert not any(
        'radar_tracked_repos' in sql
        or 'radar_github_activities' in sql
        or 'radar_github_signals' in sql
        for sql, _params in pool.connection_value.executions
    )
    assert enrichment_calls == []


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


async def test_sync_tracks_default_score_as_fallback_and_keeps_pending_row() -> None:
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
    assert run.skipped_distilled_noise == 0
    assert run.total_new == 1
    assert any(
        'INSERT INTO "radar_sync_diagnostics"' in sql
        and params[13] == "PENDING_SCORE"
        for sql, params in pool.connection_value.executions
    )


async def test_sync_scores_limited_abstract_instead_of_default() -> None:
    pool = _Pool([_source()])
    content_calls: list[str] = []

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    async def abstract_document(url: str, **kwargs: Any) -> FetchedDocument:
        body = (
            "A focused abstract about hierarchical LLM agents with "
            "retrieval-augmented generation. It reports sparse and dense "
            "retrieval results, structured prompting, token budgets, and "
            "production deployment tradeoffs. "
        ) * 3
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=f"<html><body><p>{body}</p></body></html>".encode(),
            content_type="text/html",
            elapsed_ms=5,
            redirect_count=0,
        )

    async def score_abstract(
        title: str,
        content: str,
        **kwargs: Any,
    ) -> Any:
        content_calls.append(content)
        return compute_score(
            {
                "信息增量": 1,
                "分析深度": 1,
                "可行动性": 1,
                "事实可信度": 1,
                "时效性": 1,
                "表达质量": 1,
                "综合信号": 1,
                "direct_relevance": 1,
                "relevance_evidence": "abstract covers retrieval and agents",
            },
            source_type="rss",
        )

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=abstract_document,
        distilled_scorer=score_abstract,
    )

    assert result.runs[0].total_new == 0
    assert result.runs[0].skipped_distilled_noise == 1
    assert len(content_calls) == 1
    assert 300 <= len(content_calls[0]) < 1000
    assert not any(
        sql.startswith('INSERT INTO "radar_sync_diagnostics"') and 'PENDING_SCORE' in params
        for sql, params in pool.connection_value.executions
    )
    assert not any('INSERT INTO "summaries"' in sql for sql, _ in pool.connection_value.executions)
    assert any('NOISE_NOT_STORED' in sql for sql, _ in pool.connection_value.executions)


async def test_new_noise_with_prior_research_url_is_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    from ai_engine.radar import sync_runner
    from unittest.mock import AsyncMock

    pool = _Pool([_source()])
    monkeypatch.setattr(sync_runner, '_noise_has_references', AsyncMock(return_value=True))

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    async def score_noise(title: str, content: str, **kwargs: Any) -> Any:
        return compute_score(dict.fromkeys(
            ('信息增量', '分析深度', '可行动性', '事实可信度', '时效性', '表达质量', '综合信号'), 1))

    result = await run_radar_sync(pool, triggered_by='admin', adapter=FakeAdapter(),
                                  fetchers={'rss': fetcher}, document_fetcher=_safe_fetch,
                                  distilled_scorer=score_noise)
    assert result.runs[0].total_new == 1
    assert result.runs[0].skipped_distilled_noise == 0
    assert not any(sql.startswith('INSERT INTO radar_sync_diagnostics') and 'NOISE_NOT_STORED' in sql
                   for sql, _ in pool.connection_value.executions)


async def test_github_repo_metadata_fallback_still_gets_one_distilled_score() -> None:
    """A blocked repo page must not bypass the repo's tier decision."""
    pool = _Pool([_source("github-source", "github")])
    calls: list[tuple[str, str, dict[str, Any]]] = []

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [
            RadarCandidate(
                title="acme/agent",
                url="https://github.com/acme/agent",
                snippet="An agent runtime with durable workflows and CLI tooling.",
                content_origin="api",
                tags=("github", "repository"),
                repo_signals={"stars": 1200, "forks": 80, "openIssues": 4},
            )
        ]

    async def blocked_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=b"<html><body>Just a moment</body></html>",
            content_type="text/html",
            elapsed_ms=1,
            redirect_count=0,
        )

    async def score_repo(
        title: str,
        content: str,
        **kwargs: Any,
    ) -> Any:
        calls.append((title, content, kwargs))
        return compute_score(
            {
                "信息增量": 1,
                "分析深度": 1,
                "可行动性": 1,
                "事实可信度": 1,
                "时效性": 1,
                "表达质量": 1,
                "综合信号": 1,
                "direct_relevance": 1,
                "relevance_evidence": "仓库描述包含运行时和 CLI",
            },
            source_type="github",
            structured_signals=kwargs.get("structured_signals"),
        )

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"github": fetcher},
        document_fetcher=blocked_fetch,
        distilled_scorer=score_repo,
    )

    assert result.runs[0].total_new == 0
    assert result.runs[0].skipped_distilled_noise == 1
    assert not any('INSERT INTO "summaries"' in sql for sql, _ in pool.connection_value.executions)
    assert len(calls) == 1
    assert "acme/agent" in calls[0][1]
    assert calls[0][2]["structured_signals"]["stars"] == 1200
    assert not any(
        sql.startswith('INSERT INTO "radar_sync_diagnostics"') and 'PENDING_SCORE' in params
        for sql, params in pool.connection_value.executions
    )


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


async def test_run_radar_sync_limits_candidate_concurrency() -> None:
    pool = _Pool([_source()])
    active = 0
    max_active = 0

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [
            _candidate(f"https://example.com/item-{index}")
            for index in range(6)
        ]

    async def slow_generate(
        adapter: Any,
        item: dict[str, Any],
        canonical: str,
        **kwargs: Any,
    ) -> Any:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.05)
        active -= 1
        from ai_engine.ingestion.pipeline import _generate_brief

        return await _generate_brief(adapter, item, canonical, **kwargs)

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=slow_generate,
        candidate_concurrency=2,
    )

    assert max_active == 2
    assert result.runs[0].total_new == 6


async def test_run_radar_pipeline_enriches_only_current_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.radar import enrichment_worker, sync_runner

    pool = _Pool([_source("source-1", "rss")])
    sync_result = RadarSyncResult(
        batch_id="batch-1",
        runs=(
            SourceRunResult(
                run_id="run-1",
                source_id="source-1",
                status="completed",
                total_fetched=2,
                total_new=2,
                total_skipped=0,
                total_failed=0,
                token_input_total=0,
                token_output_total=0,
                cost_usd=0,
            ),
        ),
    )
    captured: dict[str, object] = {}

    async def fake_sync(pool: Any, **kwargs: Any) -> RadarSyncResult:
        return sync_result

    async def fake_enrichment(pool: Any, **kwargs: Any) -> int:
        captured["enrichment"] = kwargs
        return 2

    monkeypatch.setattr(sync_runner, "run_radar_sync", fake_sync)
    monkeypatch.setattr(
        enrichment_worker,
        "run_enrichment_for_pending",
        fake_enrichment,
    )
    result = await run_radar_pipeline(pool, triggered_by="admin")

    assert result.enriched_count == 2
    assert captured["enrichment"] == {
        "limit": 2,
        "sync_run_ids": ("run-1",),
    }


async def test_browser_reading_mode_uses_full_text_transiently_without_persisting_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sync may read full text for scoring while Reader remains the reading surface."""
    monkeypatch.setenv("RADAR_READING_MODE", "browser")
    assert browser_reading_mode_enabled()
    pool = _Pool([_source(source_type="github")])
    full_text = (
        "The repository implements a production-grade agent runtime with "
        "documented architecture, tested execution paths, and operational "
        "tradeoffs. "
    ) * 8
    fetched_urls: list[str] = []
    scored_content: list[str] = []

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate("https://github.com/acme/browser-reading")]

    async def high_score(title: str, content: str, **kwargs: Any) -> Any:
        del title, kwargs
        scored_content.append(content)
        return compute_score(
            {
                "信息增量": 3,
                "分析深度": 3,
                "可行动性": 3,
                "事实可信度": 3,
                "时效性": 3,
                "表达质量": 3,
                "综合信号": 3,
                "direct_relevance": 3,
                "relevance_evidence": "repository metadata and project signals",
            },
            source_type="github",
        )

    async def fetch_full_source(url: str, **kwargs: Any) -> FetchedDocument:
        del kwargs
        fetched_urls.append(url)
        html = f'<article class="markdown-body"><p>{full_text}</p></article>'
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=html.encode(),
            content_type="text/html",
            elapsed_ms=5,
            redirect_count=0,
        )

    result = await run_radar_pipeline(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"github": fetcher},
        document_fetcher=fetch_full_source,
        distilled_scorer=high_score,
    )

    assert result.enriched_count == 0
    assert result.enrichment_error is None
    assert fetched_urls == ["https://github.com/acme/browser-reading"]
    assert len(scored_content) == 1
    assert "production-grade agent runtime" in scored_content[0]
    insert_sql, insert_params = next(
        item for item in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in item[0]
    )
    assert "external_reading" in insert_params[10]
    assert insert_params[18] in {"deep_read", "collection"}
    assert insert_params[18] == insert_params[19]
    assert "originalMarkdown" in insert_sql
    assert insert_params[23] is None
    # The content kind describes the source shape, not whether the full text
    # is cached, so external reading mode must still record it.  Without it
    # the platform cannot tell a repository from a web page and hides
    # repository-only reading entry points.
    assert insert_params[24] == "github_repo"
    assert insert_params[25] is False
    assert insert_params[26] is None
    assert insert_params[27] is None
    assert "CASE WHEN %s THEN now() ELSE NULL END" in insert_sql
    assert insert_sql.count("%s") == len(insert_params)
    assert full_text not in str(insert_params)


async def test_browser_reading_mode_fetches_arxiv_full_html_for_scoring(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RADAR_READING_MODE", "browser")
    pool = _Pool([_source("arxiv-source", "arxiv")])
    abstract = (
        "This paper evaluates retrieval-augmented agents on a benchmark, "
        "compares sparse and dense retrieval, reports measured task results, "
        "and discusses limitations and deployment tradeoffs. "
    ) * 5
    full_paper = (
        "## Method\n\nThe full paper describes its evaluation protocol, "
        "dataset construction, baseline comparisons, ablations, and "
        "limitations beyond the abstract. "
    ) * 12
    scored_content: list[str] = []

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        del config
        return [RadarCandidate(
            title="Evaluating Retrieval-Augmented Agents",
            url="https://arxiv.org/abs/2609.12345",
            snippet=abstract,
            published_at=datetime.now(timezone.utc),
            content_origin="arxiv",
        )]

    async def high_score(title: str, content: str, **kwargs: Any) -> Any:
        del title, kwargs
        scored_content.append(content)
        return compute_score(
            {
                "信息增量": 3,
                "分析深度": 3,
                "可行动性": 3,
                "事实可信度": 3,
                "时效性": 3,
                "表达质量": 3,
                "综合信号": 3,
                "direct_relevance": 3,
                "relevance_evidence": "The abstract reports benchmark comparisons and limitations.",
            },
            source_type="arxiv",
        )

    fetched_urls: list[str] = []

    async def fetch_full_paper(url: str, **kwargs: Any) -> FetchedDocument:
        del kwargs
        fetched_urls.append(url)
        html = f"<html><body><article>{full_paper}</article></body></html>"
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=html.encode(),
            content_type="text/html",
            elapsed_ms=5,
            redirect_count=0,
        )

    await run_radar_pipeline(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"arxiv": fetcher},
        document_fetcher=fetch_full_paper,
        distilled_scorer=high_score,
    )

    assert len(scored_content) == 1
    assert fetched_urls
    assert fetched_urls[0] == "https://arxiv.org/html/2609.12345"
    assert "full paper describes its evaluation protocol" in scored_content[0]
    _insert_sql, insert_params = next(
        item for item in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in item[0]
    )
    assert "external_reading" in insert_params[10]
    assert insert_params[18] == insert_params[19]
    assert not insert_params[15].startswith("来源摘要初筛：")
    assert insert_params[23] is None
    assert insert_params[24] == "arxiv"
    assert insert_params[27] is None
    assert full_paper not in str(insert_params)


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


def test_source_retry_uses_latest_result_per_source() -> None:
    completed = SourceRunResult(
        run_id="run-2",
        source_id="source-1",
        status="completed",
        total_fetched=1,
        total_new=1,
        total_skipped=0,
        total_failed=0,
        token_input_total=0,
        token_output_total=0,
        cost_usd=0,
    )
    failed = SourceRunResult(
        run_id="run-1",
        source_id="source-1",
        status="failed",
        total_fetched=0,
        total_new=0,
        total_skipped=0,
        total_failed=1,
        token_input_total=0,
        token_output_total=0,
        cost_usd=0,
        error_code="UPSTREAM_RATE_LIMITED",
    )
    assert _retryable_latest_source_ids([failed, completed]) == set()


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
    finish = next(
        params for sql, params in pool.connection_value.executions
        if 'UPDATE "radar_sync_runs" SET "status" = %s' in sql
    )
    assert "SafeFetchError/URL_FETCH_BLOCKED@example.com x1" in str(finish[10])


async def test_candidate_transport_failure_opens_host_circuit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One unreachable host must not create one failure per candidate."""
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [
            _candidate("https://example.com/one"),
            _candidate("https://example.com/two"),
        ]

    async def unavailable(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError("URL_FETCH_DNS", "dns failed", host="example.com")

    monkeypatch.setattr(
        "ai_engine.radar.sync_runner.RADAR_FETCH_RETRY_BACKOFF_SECONDS", 0.0,
    )
    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=unavailable,
    )

    run = result.runs[0]
    assert run.total_failed == 1
    assert run.total_skipped == 1
    assert run.status == "partial"


async def test_source_transport_failure_retries_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool([_source()])
    calls = 0

    async def flaky_fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise httpx.ConnectError("temporary DNS/connect failure")
        return []

    monkeypatch.setattr(
        "ai_engine.radar.sync_runner.RADAR_FETCH_RETRY_BACKOFF_SECONDS", 0.0,
    )
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_FETCH_RETRIES", 2)
    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": flaky_fetcher},
    )
    assert calls == 3
    assert result.runs[0].status == "completed"


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
    # A transient brief failure now degrades to the fetched snippet/body so
    # the candidate is retained instead of counting as a source failure.
    assert result.runs[0].status == "completed"
    assert result.runs[0].total_failed == 0
    assert result.runs[0].fallback_count >= 1
    assert result.runs[0].total_new == 2


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


@pytest.mark.parametrize(
    ("failure", "expected_code"),
    [
        ("arxiv_timeout:ReadTimeout", "WORKER_TIMEOUT"),
        ("arxiv_http_error:406", "UPSTREAM_HTTP_ERROR"),
    ],
)
async def test_arxiv_source_failure_surfaces_typed_root_cause(
    failure: str,
    expected_code: str,
) -> None:
    """Regression for S1 #7: when the arxiv fetcher fails, the sync
    runner's `error_code` must reflect the *root cause* (e.g. a
    network/timeout/parse error) instead of collapsing everything to
    ``AI_ENGINE_UNAVAILABLE``.
    """
    pool = _Pool([_source("arxiv-1", "arxiv")])

    async def broken_arxiv(config: dict[str, Any]) -> list[RadarCandidate]:
        # Simulate ``fetch_arxiv`` raising a typed RuntimeError when
        # the upstream service is unreachable.
        raise RuntimeError(failure)

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"arxiv": broken_arxiv},
        document_fetcher=_safe_fetch,
    )
    assert result.runs[0].status == "failed"
    assert result.runs[0].error_code == expected_code, (
        f"expected {expected_code}, got {result.runs[0].error_code!r}"
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


def test_strip_reasoning_markup_before_persisting_brief() -> None:
    assert _strip_reasoning_markup(
        "<think>internal reasoning</think>\n这是最终摘要。"
    ) == "这是最终摘要。"
    assert _strip_reasoning_markup("<think>truncated reasoning") == ""


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


def test_github_repo_metadata_can_survive_blocked_detail_page() -> None:
    source = RadarSource(
        id="source-1",
        name="GitHub Trending",
        source_type="github_trending",
        config={},
    )
    candidate = RadarCandidate(
        title="owner/repo",
        url="https://github.com/owner/repo",
        snippet="A useful open-source project · Language: Python · Stars: 2,000 · +300 stars daily",
        published_at=datetime.now(timezone.utc),
        content_origin="web",
    )
    assert _can_use_candidate_metadata_fallback(source, candidate)
    assert _can_use_github_repo_metadata_fallback(source, candidate)

    rss_source = RadarSource(
        id="source-rss",
        name="RSS",
        source_type="rss",
        config={},
    )
    rss_candidate = RadarCandidate(
        title="A useful article",
        url="https://example.com/article",
        snippet="A concise source-provided abstract about the article's main contribution.",
        published_at=datetime.now(timezone.utc),
        content_origin="rss",
    )
    assert _can_use_candidate_metadata_fallback(rss_source, rss_candidate)


def test_safe_error_code_preserves_explicit_brief_error() -> None:
    error = _BriefGenerationError(
        "UPSTREAM_RATE_LIMITED",
        "provider rejected the request",
    )
    assert _safe_error_code(error) == "UPSTREAM_RATE_LIMITED"


async def test_producthunt_metadata_survives_failed_brief() -> None:
    pool = _Pool([_source("producthunt-1", "producthunt")])
    candidate = RadarCandidate(
        title="Useful developer tool",
        url="https://www.producthunt.com/posts/useful-tool",
        snippet="A focused developer tool that helps teams inspect and debug AI workflows.",
        published_at=datetime.now(timezone.utc),
        content_origin="api",
    )

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [candidate]

    async def failed_brief(
        adapter: Any,
        item: dict[str, Any],
        canonical: str,
        **kwargs: Any,
    ) -> Any:
        del adapter, item, canonical, kwargs
        return type(
            "Brief",
            (),
            {
                "status": AI_JOB_STATUS["FAILED"],
                "output_text": None,
                "error_code": "AI_ENGINE_UNAVAILABLE",
                "error_message": "HTTP 502 proxy_error",
                "cost": type(
                    "Cost",
                    (),
                    {
                        "token_input_total": 0,
                        "token_output_total": 0,
                        "cost_cents": 0.0,
                    },
                )(),
            },
        )()

    async def blocked(url: str, **kwargs: Any) -> FetchedDocument:
        del url, kwargs
        raise SafeFetchError(
            "URL_FETCH_BLOCKED",
            "Product Hunt returned HTTP 403",
            host="www.producthunt.com",
        )

    result = await run_radar_sync(
        pool,
        triggered_by="cron",
        adapter=FakeAdapter(),
        fetchers={"producthunt": fetcher},
        document_fetcher=blocked,
        generate_brief=failed_brief,
    )

    run = result.runs[0]
    assert run.status == "completed"
    assert run.total_failed == 0
    assert run.total_new == 1
    assert run.fallback_count >= 2
    assert any(
        'INSERT INTO "summaries"' in sql
        for sql, _ in pool.connection_value.executions
    )


async def test_short_content_is_sent_to_governance_without_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    import ai_engine.radar.sync_runner as sync_runner

    monkeypatch.setattr(sync_runner, "RADAR_CONTENT_RETRIES", 0)
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
    assert run.total_new == 0
    assert run.token_input_total == 0
    assert run.cost_usd == 0.0
    assert brief_called is False
    assert any(
        'INSERT INTO "radar_sync_diagnostics"' in sql
        and params[13] == "LOW_QUALITY"
        for sql, params in pool.connection_value.executions
    )


def test_content_fetch_failure_reason_only_matches_explicit_shells() -> None:
    assert _content_fetch_failure_reason("Reddit", "reddit") == "reddit_empty_detail"
    assert _content_fetch_failure_reason(
        "Reddit - Prove your humanity", "reddit"
    ) == "bot_challenge"
    assert _content_fetch_failure_reason(
        "Enable JavaScript and cookies to continue", "vendor_news"
    ) == "javascript_or_cloudflare_challenge"
    assert _content_fetch_failure_reason(
        "A short but real release note.", "vendor_news"
    ) is None
    assert _content_fetch_failure_reason(
        "Mark by Airtop Meet Mark. Promoted",
        "producthunt",
        "Some Other Product",
    ) == "producthunt_wrong_page_shell"


async def test_content_retry_recovers_from_empty_extraction(monkeypatch: pytest.MonkeyPatch) -> None:
    import ai_engine.radar.sync_runner as sync_runner

    monkeypatch.setattr(sync_runner, "RADAR_CONTENT_RETRY_BACKOFF_SECONDS", 0)
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    calls = 0
    good_body = "A recovered article with enough technical detail to summarize. " * 8

    async def flaky_doc(url: str, **kwargs: Any) -> FetchedDocument:
        nonlocal calls
        calls += 1
        body = "<p>Too short.</p>" if calls == 1 else f"<p>{good_body}</p>"
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
        document_fetcher=flaky_doc,
    )
    assert calls == 2
    assert result.runs[0].total_new == 1
    assert not any(
        'INSERT INTO "radar_sync_diagnostics"' in sql
        and params[13] == "LOW_QUALITY"
        for sql, params in pool.connection_value.executions
    )


async def test_cloudflare_content_is_sent_to_governance(monkeypatch: pytest.MonkeyPatch) -> None:
    import ai_engine.radar.sync_runner as sync_runner

    monkeypatch.setattr(sync_runner, "RADAR_CONTENT_RETRIES", 0)
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
    assert run.total_new == 0
    assert any(
        'INSERT INTO "radar_sync_diagnostics"' in sql
        and params[13] == "CONTENT_FETCH_FAILED"
        for sql, params in pool.connection_value.executions
    )


def test_extract_article_content_preserves_structure_with_trafilatura() -> None:
    html = """
    <html><body><nav>noise</nav><article>
      <h1>Readable title</h1>
      <p>First paragraph with enough detail to be selected by the article extractor. It explains the context, the user problem, and why the proposed approach matters for a real engineering team.</p>
      <h2>Method</h2>
      <p>Second paragraph with a <a href="https://example.com">source link</a>. It describes the method, the evidence, and the limitations that readers should verify before adopting the result.</p>
      <ul><li>One item</li><li>Two items</li></ul>
    </article><footer>noise</footer></body></html>
    """
    result = _extract_article_content(html, "https://example.com/article", "rss")
    assert "# Readable title" in result
    assert "## Method" in result
    assert "- One item" in result
    assert "[source link](https://example.com)" in result


def test_article_extraction_fallback_keeps_content_past_old_8k_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "ai_engine.radar.structured_html.structured_html_to_markdown",
        lambda _html, _url: "",
    )
    monkeypatch.setattr("trafilatura.extract", lambda *_args, **_kwargs: None)
    body = "Readable body. " + ("x" * 9_000) + " FINAL_SECTION_EVIDENCE"
    html = f'<article class="markdown-body"><p>{body}</p></article>'

    result = _extract_article_content(
        html,
        "https://github.com/acme/project",
        "github",
        max_chars=16_000,
    )

    assert "FINAL_SECTION_EVIDENCE" in result


def test_preferred_document_urls_prefers_arxiv_native_html() -> None:
    urls = _preferred_document_urls(
        "https://arxiv.org/abs/2608.26094",
        "arxiv",
    )
    assert urls[0] == "https://arxiv.org/html/2608.26094"
    assert urls[1] == "https://ar5iv.labs.arxiv.org/html/2608.26094"


def test_scoreability_allows_limited_abstract_content() -> None:
    assert _scoreability("x" * 600) == "limited"
    assert _scoreability("x" * 299) is None
    assert _scoreability("x" * 1200) == "full"


async def test_browser_mode_diagnostics_never_persist_fetched_full_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RADAR_READING_MODE", "browser")
    pool = _Pool([])
    source = RadarSource(id="source-1", name="RSS", source_type="rss", config={})
    candidate = RadarCandidate(
        title="An article",
        url="https://example.com/article",
        snippet="A bounded source snippet.",
    )
    full_text = "This is the transiently fetched full source body. " * 100

    await _record_sync_diagnostic(
        pool,
        source=source,
        run_id="run-1",
        candidate=candidate,
        canonical_url=candidate.url,
        kind="filtered",
        reason_code="TEST",
        body=full_text,
        markdown=full_text,
    )

    _sql, params = next((sql, params) for sql, params in pool.connection_value.executions
                        if sql.startswith('INSERT INTO "radar_sync_diagnostics"'))
    assert params[7] == candidate.snippet
    assert params[8] is None
    assert "external_reading" in params[12]
    assert full_text not in str(params)


def test_shell_content_label_classifies_known_shells() -> None:
    assert _shell_content_label("Reddit - Prove your humanity\nWe\u2019re committed") == "\u53cd\u722c\u9a8c\u8bc1\u9875"
    assert _shell_content_label("OpenReview\n# Verifying your browser") == "\u53cd\u722c\u9a8c\u8bc1\u9875"
    assert _shell_content_label("Enable JavaScript and cookies to continue.") == "\u53cd\u722c\u9a8c\u8bc1\u9875"
    assert _shell_content_label("Mark by AirtopMeet Mark. Vibe automation for marketers.Promoted") == "\u63a8\u5e7f/\u91cd\u5b9a\u5411\u9875"
    assert _shell_content_label("Wispr Flow: Dictation That Works EverywhereStop typing") == "\u63a8\u5e7f/\u91cd\u5b9a\u5411\u9875"
    assert _shell_content_label("<p>Article URL: <a href='https://example.com'>https://example.com</a></p> <p>Comments URL: <a href='https://news.ycombinator.com/item?id=1'>https://news.ycombinator.com/item?id=1</a></p>") == "\u4ec5\u62ff\u5230\u8bc4\u8bba\u58f3"
    assert _shell_content_label("\u672a\u627e\u5230\u9875\u9762 \u2013 \u91cf\u5b50\u4f4d 404") == "\u6e90\u7ad9 404"
    assert _shell_content_label("Lobste.rs score: 4 | comments: 2") == "\u53ea\u6709 Lobsters \u8bc4\u5206\u58f3"
    assert _shell_content_label("A substantive technical write-up about RAG agents and retrieval pipelines with examples.") is None


def test_shell_content_label_ignores_github_readme_promo_markers() -> None:
    readme = "Mark by Airtop is a sponsor. Wispr Flow appears in a support section."
    assert _shell_content_label(readme) == "\u63a8\u5e7f/\u91cd\u5b9a\u5411\u9875"
    assert _shell_content_label(
        readme,
        source_type="github",
        url="https://github.com/owner/repo",
    ) is None


def test_is_fetch_failure_shell_matches_label() -> None:
    assert _is_fetch_failure_shell("Reddit - Prove your humanity") is True
    assert _is_fetch_failure_shell("A real engineering article with enough content to summarize.") is False


def test_build_score_reason_prefixes_shell_label() -> None:
    reason = _build_score_reason(
        score=type("S", (), {"reason": "Distilled v4.7: noise"})(),
        distilled=None,
        markdown="Reddit - Prove your humanity\nWe\u2019re committed",
    )
    assert reason.startswith("\u6293\u53d6\u5931\u8d25: \u53cd\u722c\u9a8c\u8bc1\u9875 | ")
    assert "Distilled v4.7" in reason


def test_build_score_reason_combines_limited_and_shell_prefix() -> None:
    from ai_engine.radar.distilled_scorer import compute_score
    distilled = compute_score(
        {
            "信息增量": 1, "分析深度": 1, "可行动性": 1,
            "事实可信度": 1, "时效性": 1, "表达质量": 1, "综合信号": 1,
            "direct_relevance": 1, "relevance_evidence": "short note",
        },
        source_type="rss",
    )
    reason = _build_score_reason(
        score=type("S", (), {"reason": "Distilled v4.7: noise"})(),
        distilled=distilled,
        limited_score=True,
        markdown="Lobste.rs score: 2 | comments: 1",
    )
    assert "\u6293\u53d6\u5931\u8d25: \u53ea\u6709 Lobsters \u8bc4\u5206\u58f3" in reason
    assert "\u4f4e\u7f6e\u4fe1\u5ea6\u521d\u7b5b" in reason


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
    assert brief.output_text == "ok"
    assert calls == 3
    assert sleeps == [5.0, 10.0]
    assert calls == 3
    assert sleeps == [5.0, 10.0]


# PR1: radar_sources.consecutiveFailures + lastError_* wiring through _finish_run.


class _FinishRunConnection:
    def __init__(self) -> None:
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    @asynccontextmanager
    async def transaction(self):  # type: ignore[no-untyped-def]
        yield

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        return _Cursor()

    async def commit(self) -> None:
        return None


class _FinishRunPool:
    def __init__(self) -> None:
        self.connection_value = _FinishRunConnection()

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _finish_run_kwargs(*, status: str, error_code: str | None, error_message: str | None = None) -> dict[str, Any]:
    return {
        "run_id": "run-x",
        "status": status,
        "total_fetched": 1,
        "total_new": 1,
        "total_skipped": 0,
        "total_failed": 1 if error_code else 0,
        "fallback_count": 0,
        "skipped_existing": 0,
        "skipped_rule_noise": 0,
        "skipped_distilled_noise": 0,
        "skipped_conflict": 0,
        "token_input_total": 0,
        "token_output_total": 0,
        "cost_usd": 0.0,
        "elapsed_ms": 100,
        "error_code": error_code,
        "error_message": error_message,
    }


def _radar_source_updates(pool: _FinishRunPool) -> list[str]:
    """Return UPDATE statements _finish_run issued against radar_sources."""
    return [sql for sql, _ in pool.connection_value.executions if '"radar_sources"' in sql]


def test_finish_run_completed_clears_health_state() -> None:
    """A clean run must reset the failure streak and zero out last_error_*."""

    async def _scenario() -> None:
        pool = _FinishRunPool()
        await _finish_run(pool, **_finish_run_kwargs(status="completed", error_code=None))
        updates = _radar_source_updates(pool)
        # Two radar_sources UPDATEs are expected: lastSyncAt always, then the health reset.
        assert any('"consecutiveFailures" = 0' in sql for sql in updates), updates
        assert any('"lastErrorCode" = NULL' in sql for sql in updates), updates
        assert any('"lastErrorAt" = NULL' in sql for sql in updates), updates

    asyncio.run(_scenario())


def test_finish_run_failed_records_error_and_increments() -> None:
    """A failed run with error_code must bump consecutiveFailures and persist last_error_*."""

    async def _scenario() -> None:
        pool = _FinishRunPool()
        await _finish_run(
            pool,
            **_finish_run_kwargs(
                status="failed",
                error_code="UPSTREAM_RATE_LIMITED",
                error_message="HTTP 429 from arxiv api",
            ),
        )
        updates = _radar_source_updates(pool)
        # The "completed" branch must NOT fire on a failed run.
        assert not any('"consecutiveFailures" = 0' in sql for sql in updates), updates
        # The increment UPDATE must carry the error_code as a bound parameter.
        matched = [entry for entry in pool.connection_value.executions if '"consecutiveFailures" + 1' in entry[0]]
        assert len(matched) == 1, pool.connection_value.executions
        assert matched[0][1] == (
            "UPSTREAM_RATE_LIMITED",
            "HTTP 429 from arxiv api",
            "HTTP 429 from arxiv api",
            "run-x",
        ), matched[0]

    asyncio.run(_scenario())


def test_finish_run_partial_without_error_does_not_touch_health() -> None:
    """A partial run with no error_code (e.g. partial freshness) must not mutate the streak."""

    async def _scenario() -> None:
        pool = _FinishRunPool()
        await _finish_run(pool, **_finish_run_kwargs(status="partial", error_code=None))
        updates = _radar_source_updates(pool)
        # Only the lastSyncAt UPDATE is expected — health columns untouched.
        assert not any('"consecutiveFailures"' in sql for sql in updates), updates
        assert not any('"lastErrorCode"' in sql for sql in updates), updates

    asyncio.run(_scenario())


class _QuotaExhaustedError(Exception):
    """Provider billing error shaped like an exhausted account allowance."""

    status_code = 402


async def test_brief_quota_exhaustion_defers_remaining_candidates_without_retry() -> None:
    """An exhausted allowance stops model calls for the whole run, not per candidate."""
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
        raise _QuotaExhaustedError("insufficient_quota: credit balance is empty")

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=generate,
        candidate_concurrency=1,
    )

    run = result.runs[0]
    assert calls == 1  # the quota error is not retried, and the next candidate never calls the model
    assert result.quota_stopped is True
    assert run.status == "partial"
    assert run.error_code == "AI_QUOTA_EXCEEDED"
    assert run.total_failed == 0
    assert run.total_skipped == 2
    assert pool.connection_value.canonical_urls == set()


async def test_scorer_quota_exhaustion_keeps_row_and_defers_later_candidates() -> None:
    """A scorer quota fallback keeps the candidate it already paid for, then stops."""
    from dataclasses import replace

    from ai_engine.ingestion.pipeline import _generate_brief
    from ai_engine.radar.distilled_scorer import default_score

    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [
            _candidate("https://example.com/one"),
            _candidate("https://example.com/two"),
        ]

    brief_calls = 0

    async def generate(adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any) -> Any:
        nonlocal brief_calls
        brief_calls += 1
        return await _generate_brief(adapter, item, canonical, **kwargs)

    score_calls = 0

    async def scorer(title: str, content: str, **kwargs: Any) -> Any:
        nonlocal score_calls
        score_calls += 1
        return replace(default_score(kwargs["profile"]), quota_exhausted=True)

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=generate,
        distilled_scorer=scorer,
        candidate_concurrency=1,
    )

    run = result.runs[0]
    assert score_calls == 1
    assert brief_calls == 1  # the second candidate is deferred before any model call
    assert result.quota_stopped is True
    assert run.error_code == "AI_QUOTA_EXCEEDED"
    assert run.total_skipped == 1
    assert pool.connection_value.canonical_urls == {"https://example.com/one"}


async def test_pipeline_does_not_retry_sources_after_quota_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_SOURCE_RETRIES", 2)
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_SOURCE_RETRY_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr("ai_engine.radar.sync_runner.RADAR_RATE_LIMIT_RETRY_BACKOFF_SECONDS", 0.0)
    pool = _Pool([_source()])
    fetch_calls = 0

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        nonlocal fetch_calls
        fetch_calls += 1
        return [_candidate("https://example.com/one")]

    async def generate(adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any) -> Any:
        raise _QuotaExhaustedError("insufficient_quota")

    result = await run_radar_pipeline(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=generate,
        candidate_concurrency=1,
    )

    assert fetch_calls == 1  # no source retry rounds once the allowance is gone
    assert result.quota_stopped is True
    assert result.enriched_count == 0


def test_rate_limit_text_is_not_treated_as_quota_exhaustion() -> None:
    from ai_engine.radar.sync_runner import _is_quota_exhausted_brief, _is_retryable_brief_failure

    rate_limited = RuntimeError("429 too many requests, rate limit reached")
    assert _is_quota_exhausted_brief(exc=rate_limited) is False
    assert _is_retryable_brief_failure(exc=rate_limited) is True


def test_quota_brief_failure_is_never_retried_even_with_rate_limit_wording() -> None:
    from types import SimpleNamespace

    from ai_engine.radar.sync_runner import _is_retryable_brief_failure

    brief = SimpleNamespace(error_code="AI_QUOTA_EXCEEDED", error_message="429 rate limit exceeded")
    assert _is_retryable_brief_failure(brief=brief) is False


@pytest.mark.parametrize(
    ("source_type", "url", "expected_kind", "expect_tag"),
    [
        ("devto", "https://dev.to/author/post", "engineering", True),
        ("rss", "https://example.com/essay", None, False),
    ],
)
async def test_typed_brief_kind_reaches_brief_and_is_tagged_only_when_persisted(
    source_type: str, url: str, expected_kind: str | None, expect_tag: bool,
) -> None:
    pool = _Pool([_source(source_type=source_type)])
    seen: list[dict[str, Any]] = []

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate(url)]

    async def brief(adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any) -> Any:
        seen.append(item)
        return type("Brief", (), {
            "status": AI_JOB_STATUS["SUCCEEDED"],
            "output_text": "文章解释了工程约束、关键机制和取舍，并说明了适用场景与局限。" * 3,
            "cost": type("Cost", (), {
                "token_input_total": 1, "token_output_total": 1, "cost_cents": 0,
            })(),
        })()

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={source_type: fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=brief,
    )

    assert result.runs[0].total_new == 1
    assert seen[0]["brief_kind"] == expected_kind
    summary_params = [
        params for sql, params in pool.connection_value.executions
        if 'INSERT INTO "summaries"' in sql
    ]
    assert len(summary_params) == 1
    assert ("brief_typed_v1" in str(summary_params[0])) is expect_tag


async def test_auto_pause_alerts_once_when_the_threshold_is_reached(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.radar import sync_runner

    emitted: list[str] = []
    monkeypatch.setattr(
        sync_runner,
        "emit_admin_alert",
        lambda key, title, lines, **kwargs: emitted.append(key),
    )
    monkeypatch.setattr(sync_runner, "RADAR_SOURCE_MAX_CONSECUTIVE_FAILURES", 5)
    counts = iter([4, 5, 6])

    class _Conn:
        async def execute(self, sql: str, params: Any = None) -> _Cursor:
            if 'RETURNING "name"' in sql:
                return _Cursor({"name": "rss source", "consecutiveFailures": next(counts)})
            return _Cursor()

        async def commit(self) -> None:
            return None

    class _Pool:
        @asynccontextmanager
        async def connection(self):  # type: ignore[no-untyped-def]
            yield _Conn()

    run = dict(
        run_id="run-1", status="failed", total_fetched=0, total_new=0, total_skipped=0,
        total_failed=1, fallback_count=0, skipped_existing=0, skipped_rule_noise=0,
        skipped_distilled_noise=0, skipped_conflict=0, token_input_total=0,
        token_output_total=0, cost_usd=0.0, elapsed_ms=1,
        error_code="URL_FETCH_TIMEOUT", error_message="timeout",
    )
    # Below the threshold there is no alert yet.
    await sync_runner._finish_run(_Pool(), **run)
    assert emitted == []
    await sync_runner._finish_run(_Pool(), **run)
    assert emitted == ["radar.auto_paused:rss source"]
    # Later failures of the paused source alert too; admin dedup limits repeats.
    await sync_runner._finish_run(_Pool(), **run)
    assert emitted == ["radar.auto_paused:rss source", "radar.auto_paused:rss source"]


async def test_healthy_empty_source_is_not_marked_partial_by_another_sources_quota_stop() -> None:
    """A source that deferred nothing keeps its clean status when another source trips the circuit."""
    quota_source = _source("quota-source", "rss")
    quota_source["config"] = {"route": "quota"}
    empty_source = _source("empty-source", "rss")
    empty_source["config"] = {"route": "empty"}
    pool = _Pool([quota_source, empty_source])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        if config.get("route") == "quota":
            return [_candidate("https://example.com/quota")]
        return []

    async def generate(adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any) -> Any:
        raise _QuotaExhaustedError("insufficient_quota")

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=generate,
        source_concurrency=1,
        candidate_concurrency=1,
    )

    by_source = {run.source_id: run for run in result.runs}
    assert result.quota_stopped is True
    assert by_source["quota-source"].status == "partial"
    assert by_source["quota-source"].error_code == "AI_QUOTA_EXCEEDED"
    assert by_source["empty-source"].status == "completed"
    assert by_source["empty-source"].error_code is None
