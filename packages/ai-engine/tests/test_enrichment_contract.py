from __future__ import annotations

import pytest

from ai_engine.radar.enrichment_contract import (
    effective_tier,
    github_zread_is_complete,
    is_enrichment_ready,
)


def _github_meta(**zread_overrides: object) -> dict[str, object]:
    zread: dict[str, object] = {
        "provider": "zread-cli",
        "status": "complete",
        "pageCount": 2,
        "expectedPageCount": 2,
        "pages": [
            {"path": "1-overview.md", "content": "Overview"},
            {"path": "2-runtime.md", "content": "Runtime"},
        ],
    }
    zread.update(zread_overrides)
    return {"enrichmentVersion": "2.0", "zread": zread}


def test_complete_github_zread_is_the_only_full_repo_contract() -> None:
    assert github_zread_is_complete(_github_meta()) is True
    assert github_zread_is_complete(
        _github_meta(provider="github-readme-fallback", status="partial"),
    ) is False
    assert github_zread_is_complete(
        _github_meta(status="partial", pageCount=2, expectedPageCount=2),
    ) is False
    assert github_zread_is_complete(
        _github_meta(missingPages=["3-deploy.md"]),
    ) is False
    assert github_zread_is_complete(
        _github_meta(mixedCommits="true"),
    ) is False
    assert github_zread_is_complete(
        _github_meta(pageCount=1, expectedPageCount=2),
    ) is False
    assert github_zread_is_complete(
        _github_meta(pageCount="bad"),
    ) is False
    assert github_zread_is_complete(
        _github_meta(pageCount=2, expectedPageCount=2, pages=[]),
    ) is False


@pytest.mark.parametrize(
    ("status", "quality", "meta", "expected"),
    [
        ("ready", "ready", {"enrichmentVersion": "2.0"}, True),
        ("pending", "ready", {"enrichmentVersion": "2.0"}, False),
        ("ready", "incomplete", {"enrichmentVersion": "2.0"}, False),
        ("ready", "ready", {"enrichmentVersion": "1.0"}, False),
    ],
)
def test_non_github_enrichment_requires_both_durable_gates(
    status: str,
    quality: str,
    meta: dict[str, object],
    expected: bool,
) -> None:
    assert is_enrichment_ready(
        enrichment_status=status,
        reader_quality_status=quality,
        original_kind="rss",
        original_meta=meta,
    ) is expected


def test_high_scored_candidate_is_exposed_as_skim_until_ready() -> None:
    assert effective_tier("deep_read", enrichment_ready=False) == "skim"
    assert effective_tier("collection", enrichment_ready=False) == "skim"
    assert effective_tier("deep_read", enrichment_ready=True) == "deep_read"
    assert effective_tier("skim", enrichment_ready=False) == "skim"
