from __future__ import annotations

from contextlib import asynccontextmanager
import json
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
        if "pg_try_advisory_lock" in sql:
            return _Cursor(row={"acquired": True})
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


def test_unwrap_arxiv_equation_tables() -> None:
    markdown = "\n".join([
        "|  | $\\displaystyle P_{d}$ | $\\displaystyle=\\{p_{1},\\ldots,p_{m}\\},$ |  | (1) |",
        "| --- | --- | --- | --- | --- |",
        "|  | $\\displaystyle P$ | $\\displaystyle=\\bigcup_{d\\in\\mathcal{D}}\\mathcal{P}_{d}.$ |  |  |",
    ])

    normalized = ew._unwrap_arxiv_equation_tables(markdown)

    assert "| --- |" not in normalized
    assert "$$\n" in normalized
    assert "\\tag{1}" in normalized
    assert "\\bigcup" in normalized


def test_drops_empty_arxiv_table_shell() -> None:
    normalized = ew._unwrap_arxiv_equation_tables("|  |\n| --- |\n\n![Figure](https://example.com/figure.png)")

    assert "| --- |" not in normalized
    assert "![Figure]" in normalized


def test_clean_arxiv_html_markdown_repairs_template_placeholders() -> None:
    cleaned = ew._clean_arxiv_html_markdown(
        "推荐五款最值得买的 s；推荐深圳最值得去的五家 s；Recommend the top five most worth-buying s",
        "",
    )

    assert "推荐五款最值得买的 [产品]" in cleaned
    assert "推荐深圳最值得去的五家 [商家]" in cleaned
    assert "Recommend the top five most worth-buying [product]" in cleaned
    assert "worth-buying s" not in cleaned


def test_clean_arxiv_html_markdown_removes_model_instruction_artifact() -> None:
    cleaned = ew._clean_arxiv_html_markdown(
        "## Appendix A Prompt\n\n"
        "{{ content | trim }} You FIRST think about the reasoning process as an "
        "internal monologue and then provide the final answer. The reasoning "
        "process MUST BE enclosed within <think> </think> tags. The final answer "
        "MUST BE put in \\boxed {}.\n\n"
        "## Appendix B\n\nThe paper continues here.",
        "",
    )

    assert "FIRST think" not in cleaned
    assert "{{ content" not in cleaned
    assert "The paper continues here." in cleaned


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


def test_repo_activity_digest_url_detection() -> None:
    assert ew._is_repo_activity_digest_url(
        "https://github.com/acme/agent?digest=2026-08-21"
    )
    assert not ew._is_repo_activity_digest_url(
        "https://github.com/acme/agent"
    )


@pytest.mark.asyncio
async def test_web_highlights_have_deterministic_fallback_on_llm_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_generate(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(ew, "generate_text", fail_generate)
    result = await ew._generate_web_highlights(
        "第一段是足够长的正文内容，用于保留真实来源信息并提供可读的回退摘要。\n\n"
        "第二段继续说明实现方式、限制和实际影响，避免在模型失败时丢失所有信息。\n\n"
        "第三段给出结果和后续方向，内容来自原文而不是模型臆测。",
        "测试文章",
    )

    assert result is not None
    assert result["fallback"] is True
    assert len(result["highlights"]) == 3


async def test_enrich_github_candidate_skips_repo_activity_digest() -> None:
    pool = _Pool(row=None)

    result = await ew.enrich_github_candidate(
        pool,
        summary_id="digest-1",
        canonical_url="https://github.com/acme/agent?digest=2026-08-21",
    )

    assert result is None
    assert pool.connection_value.executions == []


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


def test_zread_scoring_markdown_prefers_all_remote_pages_over_readme() -> None:
    markdown = ew._zread_scoring_markdown(
        {
            "pages": [
                {
                    "path": "1-overview",
                    "title": "Overview",
                    "content": "Project overview and architecture.",
                },
                {
                    "path": "2-installation",
                    "title": "Installation",
                    "content": "Detailed installation instructions.",
                },
            ],
        },
        "# README\nFallback only",
    )

    assert "# Overview" in markdown
    assert "# Installation" in markdown
    assert "Fallback only" not in markdown


def test_scrub_zread_payload_decodes_nested_unicode_escapes() -> None:
    payload = ew._scrub_zread_payload({
        "pages": [{
            "title": r"Extensibility \u0026 Protocol",
            "section": "Deep Dive",
            "content": r"Use \u003ccomponent\u003e here.",
        }],
    })

    assert payload["pages"][0]["title"] == "Extensibility & Protocol"
    assert payload["pages"][0]["content"] == "Use <component> here."


async def test_enrich_github_candidate_persists_zread_pages_as_original_markdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages = [
        {
            "path": "1-overview",
            "title": "Overview",
            "content": "OpenViking architecture and context database. " * 30,
        },
        {
            "path": "2-installation",
            "title": "Installation",
            "content": "OpenViking installation and deployment guide. " * 30,
        },
    ]
    pool = _Pool(row={
        "id": "repo-1",
        "title": "volcengine/OpenViking",
        "interpretation": "repo",
        "originalMarkdown": "old readme",
        "originalMeta": {
            "zread": {
                "provider": "zread-remote",
                "repoHeadSha": "abc123",
                "commitSha": "indexed456",
                "parserVersion": 4,
                "status": "complete",
                "pageCount": 2,
                "expectedPageCount": 2,
                "pages": pages,
            },
        },
        "tldr": None,
        "highlights": None,
        "repoSummary": None,
    })

    async def fake_repo_meta(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"defaultBranch": "main", "stars": 10_000}

    async def fake_head(*args: Any, **kwargs: Any) -> str:
        return "abc123"

    async def fake_tree(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return [{"path": "README.md", "type": "blob", "size": 100}]

    async def fake_readme(*args: Any, **kwargs: Any) -> str:
        return "# README\nFallback only"

    async def fake_key_files(*args: Any, **kwargs: Any) -> dict[str, str]:
        return {}

    monkeypatch.setenv("ZREAD_CLI_ENABLED", "0")
    monkeypatch.setenv("GITHUB_REPO_SUMMARY_LLM_ENABLED", "0")
    monkeypatch.setattr(ew, "_fetch_repo_meta", fake_repo_meta)
    monkeypatch.setattr(ew, "_fetch_repo_head_sha", fake_head)
    monkeypatch.setattr(ew, "_fetch_repo_tree", fake_tree)
    monkeypatch.setattr(ew, "_fetch_repo_readme", fake_readme)
    monkeypatch.setattr(ew, "_fetch_key_files", fake_key_files)

    result = await ew.enrich_github_candidate(
        pool,
        summary_id="repo-1",
        canonical_url="https://github.com/volcengine/OpenViking",
    )

    assert result is not None
    sql, params = pool.connection_value.updates[-1]
    assert '"originalMarkdown" = %s' in sql
    assert "OpenViking architecture" in params[1]
    assert "OpenViking installation" in params[1]
    assert "Fallback only" not in params[1]


async def test_enrich_github_candidate_uses_cli_for_remote_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(row={
        "id": "repo-partial",
        "title": "acme/agent",
        "interpretation": "repo",
        "originalMarkdown": "old",
        "originalMeta": None,
        "tldr": None,
        "highlights": None,
        "repoSummary": None,
    })

    async def fake_repo_meta(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"defaultBranch": "main"}

    async def fake_head(*args: Any, **kwargs: Any) -> str:
        return "head123"

    async def fake_tree(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return []

    async def fake_readme(*args: Any, **kwargs: Any) -> str:
        return "# README\nFallback only"

    async def fake_key_files(*args: Any, **kwargs: Any) -> dict[str, str]:
        return {}

    async def fake_remote(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "provider": "zread-remote",
            "status": "partial",
            "pageCount": 1,
            "expectedPageCount": 2,
            "pages": [{"path": "1-overview.md", "content": "Remote page"}],
        }

    async def fake_cli(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "provider": "zread-cli",
            "status": "complete",
            "pageCount": 2,
            "expectedPageCount": 2,
            "pages": [{
                "path": "1-overview.md",
                "section": "Get Started",
                "content": "Complete page",
            }],
        }

    from ai_engine.radar import zread_cli, zread_remote

    monkeypatch.setenv("ZREAD_CLI_ENABLED", "1")
    monkeypatch.setenv("GITHUB_REPO_SUMMARY_LLM_ENABLED", "0")
    monkeypatch.setattr(ew, "_fetch_repo_meta", fake_repo_meta)
    monkeypatch.setattr(ew, "_fetch_repo_head_sha", fake_head)
    monkeypatch.setattr(ew, "_fetch_repo_tree", fake_tree)
    monkeypatch.setattr(ew, "_fetch_repo_readme", fake_readme)
    monkeypatch.setattr(ew, "_fetch_key_files", fake_key_files)
    monkeypatch.setattr(zread_remote, "fetch_zread_wiki", fake_remote)
    monkeypatch.setattr(zread_cli, "generate_zread_wiki", fake_cli)

    result = await ew.enrich_github_candidate(
        pool,
        summary_id="repo-partial",
        canonical_url="https://github.com/acme/agent",
    )

    assert result is not None
    assert result["zread"]["provider"] == "zread-cli"
    assert result["zread"]["pages"][0]["section"] == "Get Started"


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

    async def no_html(arxiv_id: str) -> Any:
        return None

    monkeypatch.setattr(ew, "_fetch_arxiv_pdf", oversized_pdf)
    monkeypatch.setattr(ew, "_parse_arxiv_html_document", no_html)
    monkeypatch.setattr(ew, "_generate_arxiv_analysis", fake_analysis)

    result = await ew.enrich_arxiv_candidate(
        pool,
        summary_id="paper-1",
        canonical_url="https://arxiv.org/abs/2608.02412",
    )

    assert result is not None
    meta = json.loads(pool.connection_value.updates[0][1][0])
    assert meta["degraded"] is True
    assert meta["reason"] == "pdf_too_large"
    assert result["analysis"]["method"] == "研究方法"


async def test_enrich_arxiv_prefers_rendered_html_over_pdf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(row={
        "id": "paper-html",
        "title": "HTML paper",
        "interpretation": "论文摘要",
        "originalMarkdown": "旧正文",
        "originalMeta": None,
        "tldr": None,
    })

    html_result = (
        "# Introduction\n\nA properly separated paragraph. " * 30,
        [{"title": "Introduction", "level": 1, "startOffset": 0}],
        ["Ada Lovelace"],
        [],
        "https://ar5iv.labs.arxiv.org/html/2608.02412",
    )

    async def fake_html(arxiv_id: str) -> Any:
        assert arxiv_id == "2608.02412"
        return html_result

    async def unexpected_pdf(url: str) -> bytes:
        raise AssertionError("HTML enrichment should not download the PDF")

    async def fake_analysis(markdown: str, title: str) -> dict[str, str]:
        return {"tldr": "HTML 总结"}

    monkeypatch.setattr(ew, "_parse_arxiv_html_document", fake_html)
    monkeypatch.setattr(ew, "_fetch_arxiv_pdf", unexpected_pdf)
    monkeypatch.setattr(ew, "_generate_arxiv_analysis", fake_analysis)

    result = await ew.enrich_arxiv_candidate(
        pool,
        summary_id="paper-html",
        canonical_url="https://huggingface.co/papers/2608.02412",
    )

    assert result is not None
    assert result["markdown"].startswith("# Introduction")
    assert result["authors"] == ["Ada Lovelace"]
    meta = json.loads(pool.connection_value.updates[0][1][1])
    assert meta["extractorVersion"] == "arxiv-html-v1"


async def test_run_enrichment_for_pending_dispatches_all_default_kinds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kinds = ("github_repo", "arxiv", "github_other", "github_release", "rss", "web_share")
    pool = _Pool(rows=[
        {
            "id": f"id-{kind}",
            "canonicalUrl": f"https://example.com/{kind}",
            "originalKind": kind,
            "distilledTier": "deep_read",
        }
        for kind in kinds
    ])
    calls: list[str] = []

    async def fake_enrich(
        pool: Any,
        *,
        summary_id: str,
        canonical_url: str,
        force: bool = False,
    ) -> dict[str, Any]:
        del force
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
            "distilledTier": "collection",
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
    sql, params = next(
        execution
        for execution in pool.connection_value.executions
        if "canonicalUrl" in execution[0]
    )
    assert '"distilledTier" IN (\'collection\', \'deep_read\')' in sql
    assert '"syncRunId" IN (%s,%s)' in sql
    assert '"share_submissions"' in sql
    assert params == ("rss", "run-a", "run-b", 10)


async def test_github_failed_zread_uses_retry_backoff_in_automatic_enrichment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ew, "GITHUB_ENRICHMENT_RETRY_SECONDS", 604800)
    pool = _Pool(rows=[])

    succeeded = await ew.run_enrichment_for_pending(
        pool,
        limit=10,
        source_kinds=("github_repo",),
        sync_run_ids=("run-a",),
    )

    assert succeeded == 0
    sql, params = next(
        execution
        for execution in pool.connection_value.executions
        if "canonicalUrl" in execution[0]
    )
    assert "NOT IN ('complete', 'partial', 'failed')" in sql
    assert "'generatedAt'" in sql
    assert "make_interval(secs => 604800)" in sql
    assert params == ("github_repo", "run-a", 10)


async def test_force_enrichment_bypasses_github_failure_backoff() -> None:
    pool = _Pool(rows=[])

    succeeded = await ew.run_enrichment_for_pending(
        pool,
        limit=10,
        source_kinds=("github_repo",),
        summary_ids=("repo-1",),
        force=True,
    )

    assert succeeded == 0
    sql, params = next(
        execution
        for execution in pool.connection_value.executions
        if "canonicalUrl" in execution[0]
    )
    assert "AND TRUE" in sql
    assert "'generatedAt'" not in sql
    assert params == ("github_repo", "repo-1", 10)


async def test_run_enrichment_for_pending_isolates_exceptions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(rows=[
        {
            "id": "id-a",
            "canonicalUrl": "https://example.com/a",
            "originalKind": "rss",
            "distilledTier": "deep_read",
        },
        {
            "id": "id-b",
            "canonicalUrl": "https://example.com/b",
            "originalKind": "web_share",
            "distilledTier": "collection",
        },
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
