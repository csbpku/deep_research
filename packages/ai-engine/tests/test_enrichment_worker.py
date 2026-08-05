from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.fetcher.safe_fetch import FetchedDocument
from ai_engine.radar import enrichment_worker as ew


class _Cursor:
    def __init__(
        self,
        *,
        row: dict[str, Any] | None = None,
        rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.row = row
        self.rows = rows or []

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self, row: dict[str, Any] | None = None, rows: list[dict[str, Any]] | None = None) -> None:
        self.row = row
        self.rows = rows or []
        self.updates: list[tuple[str, tuple[Any, ...]]] = []
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        if "SELECT" in sql and "canonicalUrl" in sql:
            return _Cursor(rows=self.rows)
        if "SELECT" in sql and "originalMarkdown" in sql:
            return _Cursor(row=self.row)
        if "UPDATE" in sql:
            self.updates.append((sql, params))
        return _Cursor()


class _Pool:
    def __init__(self, row: dict[str, Any] | None = None, rows: list[dict[str, Any]] | None = None) -> None:
        self.connection_value = _Connection(row=row, rows=rows)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _web_document(url: str, *, html: str = "") -> FetchedDocument:
    return FetchedDocument(
        url=url,
        final_ip="93.184.216.34",
        status=200,
        headers={"content-type": "text/html"},
        content=html.encode(),
        content_type="text/html",
        elapsed_ms=8,
        redirect_count=0,
    )


def _clean_article() -> str:
    return (
        "<article><h1>Radar post</h1><p>"
        + ("A detailed article about LLM agents and retrieval systems. " * 12)
        + "</p></article>"
    )


def test_parse_github_item_url() -> None:
    assert ew._parse_github_item_url(
        "https://github.com/acme/agent/issues/42"
    ) == ("acme", "agent", "42", "issue")
    assert ew._parse_github_item_url(
        "https://github.com/acme/agent/pull/7"
    ) == ("acme", "agent", "7", "pr")
    assert ew._parse_github_item_url(
        "https://github.com/acme/agent/releases/tag/v1.0%20beta"
    ) == ("acme", "agent", "v1.0 beta", "release")
    assert ew._parse_github_item_url("https://github.com/acme/agent") is None
    assert ew._parse_github_item_url("https://example.com/x") is None
    assert ew._parse_github_item_url("") is None


def test_github_item_meta_includes_bounded_body_and_comment_previews() -> None:
    item = {
        "body": "b" * 2_100,
        "state": "open",
        "comments": 12,
        "labels": [{"name": "bug"}, {"name": "help wanted"}],
        "user": {"login": "owner"},
        "created_at": "2026-08-01T01:00:00Z",
        "updated_at": "2026-08-02T01:00:00Z",
    }
    comments = [
        {
            "body": f"comment-{index}-" + "x" * 600,
            "user": {"login": f"user-{index}"},
            "created_at": f"2026-08-0{index + 1}T02:00:00Z",
        }
        for index in range(5)
    ]

    meta = ew._github_item_meta(
        item,
        owner="acme",
        repo="agent",
        number_or_tag="42",
        kind="issue",
        comments=comments,
    )

    assert len(meta["bodyPreview"]) == 2_000
    assert len(meta["commentPreviews"]) == 3
    assert meta["commentPreviews"][0]["author"] == "user-0"
    assert len(meta["commentPreviews"][0]["body"]) == 500
    assert meta["comments"] == 12


async def test_enrich_web_candidate_keeps_clean_markdown_and_sets_tldr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing = _clean_article().replace("<article>", "").replace("</article>", "")
    pool = _Pool(
        row={
            "id": "s1",
            "title": "Radar post",
            "interpretation": "一句话解读",
            "originalMarkdown": existing,
            "originalMeta": None,
            "tldr": None,
        }
    )

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return _web_document(url, html=_clean_article())

    monkeypatch.setattr(ew, "safe_fetch", fake_fetch)
    payload = await ew.enrich_web_candidate(
        pool, summary_id="s1", canonical_url="https://example.com/post",
    )
    assert payload is not None
    assert payload["provider"] == "web"
    assert payload["status"] == 200

    sql, params = pool.connection_value.updates[0]
    assert "originalMeta" in sql
    markdown, tldr = params[1], params[4]
    assert markdown == existing
    assert tldr == "一句话解读"


async def test_enrich_web_candidate_replaces_low_quality_markdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    low_quality = (
        "Just a moment... Enable JavaScript and cookies to continue. "
        "Checking your browser before accessing the site."
    ) * 6
    pool = _Pool(
        row={
            "id": "s2",
            "title": "Radar post",
            "interpretation": "",
            "originalMarkdown": low_quality,
            "originalMeta": None,
            "tldr": None,
        }
    )

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return _web_document(url, html=_clean_article())

    monkeypatch.setattr(ew, "safe_fetch", fake_fetch)
    payload = await ew.enrich_web_candidate(
        pool, summary_id="s2", canonical_url="https://example.com/post",
    )
    assert payload is not None
    sql, params = pool.connection_value.updates[0]
    assert "Just a moment" not in params[1]
    assert "detailed article about LLM agents" in params[1]


async def test_enrich_web_candidate_ignores_fetch_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(
        row={
            "id": "s3",
            "title": "x",
            "interpretation": "t",
            "originalMarkdown": "clean content",
            "originalMeta": None,
            "tldr": None,
        }
    )

    async def failing_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        raise TimeoutError("timeout")

    monkeypatch.setattr(ew, "safe_fetch", failing_fetch)
    assert await ew.enrich_web_candidate(
        pool, summary_id="s3", canonical_url="https://example.com/x",
    ) is None
    assert pool.connection_value.updates == []


async def test_enrich_web_candidate_uses_clean_cached_content_on_fetch_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cached = "A detailed cached article about agent evaluation. " * 30
    pool = _Pool(row={
        "id": "s4",
        "title": "Cached article",
        "interpretation": "缓存文章摘要",
        "originalMarkdown": cached,
        "originalMeta": None,
        "tldr": None,
    })

    async def failing_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        raise TimeoutError("timeout")

    async def fake_highlights(markdown: str, title: str) -> dict[str, Any]:
        return {"summary": "摘要", "highlights": ["亮点一", "亮点二", "亮点三"]}

    monkeypatch.setattr(ew, "safe_fetch", failing_fetch)
    monkeypatch.setattr(ew, "_generate_web_highlights", fake_highlights)

    payload = await ew.enrich_web_candidate(
        pool, summary_id="s4", canonical_url="https://example.com/cached",
    )

    assert payload is not None
    assert payload["degraded"] is True
    assert payload["reason"] == "cached_source"
    assert len(pool.connection_value.updates) == 1


async def test_enrich_arxiv_uses_cached_abstract_when_pdf_is_too_large(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(row={
        "id": "paper-1",
        "title": "Large PDF paper",
        "interpretation": "论文摘要",
        "originalMarkdown": "A sufficiently detailed cached arXiv abstract. " * 20,
        "originalMeta": None,
        "tldr": None,
    })

    async def oversized_pdf(url: str) -> bytes:
        return b"x" * (8 * 1024 * 1024 + 1)

    async def fake_analysis(markdown: str, title: str) -> dict[str, str]:
        return {
            "tldr": "一句话总结",
            "motivation": "研究动机",
            "method": "研究方法",
            "result": "实验结果",
            "conclusion": "研究结论",
        }

    monkeypatch.setattr(ew, "_fetch_arxiv_pdf", oversized_pdf)
    monkeypatch.setattr(ew, "_generate_arxiv_analysis", fake_analysis)

    result = await ew.enrich_arxiv_candidate(
        pool,
        summary_id="paper-1",
        canonical_url="https://arxiv.org/abs/2608.02412",
    )

    assert result is not None
    assert result["meta"]["degraded"] is True
    assert result["meta"]["reason"] == "pdf_too_large"
    assert result["analysis"]["method"] == "研究方法"


async def test_run_enrichment_for_pending_dispatches_all_default_kinds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kinds = ("github_repo", "arxiv", "github_other", "github_release", "rss", "web_share")
    pool = _Pool(rows=[
        {"id": f"id-{kind}", "canonicalUrl": f"https://example.com/{kind}", "originalKind": kind}
        for kind in kinds
    ])
    calls: list[str] = []

    async def fake_enrich(pool: Any, *, summary_id: str, canonical_url: str) -> dict[str, Any]:
        calls.append(summary_id.removeprefix("id-"))
        return {"ok": True}

    monkeypatch.setattr(ew, "enrich_github_candidate", fake_enrich)
    monkeypatch.setattr(ew, "enrich_arxiv_candidate", fake_enrich)
    monkeypatch.setattr(ew, "enrich_github_item_candidate", fake_enrich)
    monkeypatch.setattr(ew, "enrich_web_candidate", fake_enrich)

    succeeded = await ew.run_enrichment_for_pending(pool, limit=50)
    assert succeeded == 6
    assert set(calls) == set(kinds)


async def test_run_enrichment_for_pending_filters_current_sync_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(rows=[
        {
            "id": "id-rss",
            "canonicalUrl": "https://example.com/rss",
            "originalKind": "rss",
        },
    ])

    async def fake_enrich(
        pool: Any,
        *,
        summary_id: str,
        canonical_url: str,
    ) -> dict[str, Any]:
        return {"ok": True}

    monkeypatch.setattr(ew, "enrich_web_candidate", fake_enrich)

    succeeded = await ew.run_enrichment_for_pending(
        pool,
        limit=10,
        source_kinds=("rss",),
        sync_run_ids=("run-a", "run-b"),
        concurrency=1,
    )

    assert succeeded == 1
    sql, params = pool.connection_value.executions[0]
    assert '"syncRunId" IN (%s,%s)' in sql
    assert '"share_submissions"' in sql
    assert params == ("rss", "run-a", "run-b", 10)


async def test_run_enrichment_for_pending_isolates_exceptions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(rows=[
        {"id": "id-a", "canonicalUrl": "https://example.com/a", "originalKind": "rss"},
        {"id": "id-b", "canonicalUrl": "https://example.com/b", "originalKind": "web_share"},
    ])

    async def failing(pool: Any, *, summary_id: str, canonical_url: str) -> dict[str, Any]:
        raise RuntimeError("boom")

    async def ok(pool: Any, *, summary_id: str, canonical_url: str) -> dict[str, Any]:
        return {"ok": True}

    monkeypatch.setattr(ew, "enrich_web_candidate", failing)
    monkeypatch.setattr(ew, "enrich_github_candidate", ok)
    monkeypatch.setattr(ew, "enrich_arxiv_candidate", ok)
    monkeypatch.setattr(ew, "enrich_github_item_candidate", ok)

    succeeded = await ew.run_enrichment_for_pending(
        pool, limit=50, source_kinds=("rss", "web_share"),
    )
    assert succeeded == 0
