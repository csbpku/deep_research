from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.radar.reader_quality import evaluate_reader_quality
from ai_engine.radar import reader_quality as rq


class _Cursor:
    def __init__(
        self,
        row: dict[str, Any] | None = None,
        *,
        rowcount: int = 1,
    ) -> None:
        self.row = row
        self.rowcount = rowcount

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row


class _Connection:
    def __init__(self, row: dict[str, Any], *, rowcount: int = 1) -> None:
        self.row = row
        self.rowcount = rowcount
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(
        self,
        sql: str,
        params: tuple[Any, ...] = (),
    ) -> _Cursor:
        self.executions.append((sql, params))
        if sql.lstrip().upper().startswith("SELECT"):
            return _Cursor(self.row)
        return _Cursor(rowcount=self.rowcount)


class _Pool:
    def __init__(self, row: dict[str, Any], *, rowcount: int = 1) -> None:
        self.connection_value = _Connection(row, rowcount=rowcount)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def test_collection_card_is_not_a_readable_web_share() -> None:
    result = evaluate_reader_quality(
        kind="web_share",
        markdown=(
            "[Rewritten templates](https://huggingface.co/collections/example/item) "
            "• 1 item • Updated Apr 30"
        ),
    )

    assert result.status == "incomplete"
    assert result.reason == "source_card_only"


def test_huggingface_paper_link_graph_is_not_paper_body() -> None:
    result = evaluate_reader_quality(
        kind="web_share",
        markdown=(
            "## Models citing this paper\n\nNo model linking this paper\n\n"
            "## Datasets citing this paper\n\nNo dataset linking this paper\n\n"
            "## Collections including this paper\n\nNo collection including this paper"
        ),
    )

    assert result.status == "incomplete"
    assert result.reason == "source_card_only"


def test_article_with_model_links_is_not_a_collection_card() -> None:
    result = evaluate_reader_quality(
        kind="rss",
        markdown=(
            "## A substantive article\n\n"
            + (
                "This article explains a real technical system, its design trade-offs, "
                "evaluation results, and operational constraints in detail. "
                "Related links include /models/ and /collections/ pages, but those "
                "links are not the article body. "
            ) * 12
        ),
    )

    assert result.status == "ready"
    assert result.reason == "reader_contract_satisfied"


def test_complete_github_zread_requires_expected_pages() -> None:
    result = evaluate_reader_quality(
        kind="github_repo",
        markdown="A readable README and generated project overview.",
        original_meta={
            "zread": {
                "status": "complete",
                "provider": "zread-cli",
                "pageCount": 4,
                "expectedPageCount": 6,
            },
        },
    )

    assert result.status == "incomplete"
    assert result.reason == "github_zread_page_gap"


@pytest.mark.parametrize("evidence", [
    {"missingPages": ["2-runtime.md"]}, {"mixedCommits": True},
])
def test_github_count_does_not_override_catalog_or_revision_gap(evidence: dict) -> None:
    result = evaluate_reader_quality(
        kind="github_repo", markdown="Substantive text. " * 30,
        original_meta={"zread": {
            "status": "complete", "provider": "zread-cli",
            "pageCount": 2, "expectedPageCount": 2, **evidence,
        }},
    )
    assert result.status == "incomplete"
    assert result.reason == "github_zread_catalog_gap"


def test_readme_fallback_is_not_full_project_documentation() -> None:
    result = evaluate_reader_quality(
        kind="github_repo",
        markdown="A readable README with enough detail.",
        original_meta={
            "zread": {
                "status": "partial",
                "provider": "github-readme-fallback",
                "pageCount": 1,
                "expectedPageCount": 1,
            },
        },
    )

    assert result.status == "incomplete"
    assert result.reason == "github_readme_fallback"


def test_normal_article_passes_deterministic_contract() -> None:
    result = evaluate_reader_quality(
        kind="rss",
        markdown=(
            "## A real article\n\n"
            "This is a substantive article paragraph about a technical system. "
            "It contains enough prose to give a reader a meaningful starting point. "
            "The article continues with concrete implementation details and trade-offs "
            "so the reader can make an informed decision."
        ),
    )

    assert result.status == "ready"
    assert result.reason == "reader_contract_satisfied"


def test_large_legacy_body_without_completeness_marker_is_not_ready() -> None:
    result = evaluate_reader_quality(
        kind="arxiv",
        markdown="x" * 500_000,
        original_meta={"enrichmentVersion": "2.0"},
    )

    assert result.status == "incomplete"
    assert result.reason == "legacy_reader_truncation"


@pytest.mark.asyncio
async def test_persist_reader_quality_is_fenced_by_snapshot_and_review_claim() -> None:
    markdown = "## Article\n\n" + ("A substantive paragraph. " * 20)
    pool = _Pool({
        "originalKind": "rss",
        "originalMarkdown": markdown,
        "originalMeta": {"enrichmentVersion": "2.0"},
        "originalSha256": "sha-current",
    })

    result = await rq.load_and_persist_reader_quality(
        pool,
        summary_id="summary-1",
        claim_id="22222222-2222-4222-8222-222222222222",
    )

    assert result.status == "ready"
    sql, params = pool.connection_value.executions[-1]
    assert '"originalSha256" IS NOT DISTINCT FROM %s' in sql
    assert '"contentReviewClaimId" = %s::uuid' in sql
    assert params[-2:] == (
        "sha-current",
        "22222222-2222-4222-8222-222222222222",
    )


@pytest.mark.asyncio
async def test_reader_quality_conflict_does_not_overwrite_new_snapshot() -> None:
    markdown = "## Article\n\n" + ("A substantive paragraph. " * 20)
    pool = _Pool({
        "originalKind": "rss",
        "originalMarkdown": markdown,
        "originalMeta": {"enrichmentVersion": "2.0"},
        "originalSha256": "sha-current",
    }, rowcount=0)

    with pytest.raises(rq.ReaderQualityConflict):
        await rq.load_and_persist_reader_quality(
            pool,
            summary_id="summary-1",
            claim_id="22222222-2222-4222-8222-222222222222",
        )
