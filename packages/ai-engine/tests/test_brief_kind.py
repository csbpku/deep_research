from __future__ import annotations

import pytest

from ai_engine.radar.brief_kind import TYPED_BRIEF_QUESTIONS, TYPED_BRIEF_TAG, radar_brief_kind


@pytest.mark.parametrize(
    ("source_type", "url", "github_repo_candidate", "expected"),
    [
        ("arxiv", "https://arxiv.org/abs/2401.00001", False, "paper"),
        ("huggingface_papers", "https://huggingface.co/papers/2401.00001", False, "paper"),
        ("openreview", "https://openreview.net/forum?id=abc", False, "paper"),
        ("github", "https://github.com/openai/codex", True, "project"),
        ("huggingface_models", "https://huggingface.co/org/model", False, "project"),
        ("vendor_changelog", "https://example.com/changelog", False, "change"),
        ("github", "https://github.com/org/tool/releases/tag/v1.2.0", True, "change"),
        ("vendor_news", "https://openai.com/index/agents", False, "change"),
        ("vendor_news", "https://docs.anthropic.com/en/docs/agents", False, "engineering"),
        ("rss", "https://platform.openai.com/docs/guides/agents", False, "engineering"),
        ("devto", "https://dev.to/author/post", False, "engineering"),
        ("hn_algolia", "https://example.com/story", False, "engineering"),
        # Mixed feeds keep the generic brief: one feed can hold essays, news and papers.
        ("rss", "https://example.com/essay", False, None),
        ("hackernews", "https://example.com/story", False, None),
        ("reddit", "https://reddit.com/r/x/comments/1", False, None),
        ("lobsters", "https://lobste.rs/s/abc", False, None),
        ("sitemap_watch", "https://example.com/post", False, None),
        ("", "", False, None),
    ],
)
def test_radar_brief_kind_routes_clear_shapes_and_leaves_mixed_feeds_generic(
    source_type: str, url: str, github_repo_candidate: bool, expected: str | None,
) -> None:
    assert radar_brief_kind(
        source_type, url, github_repo_candidate=github_repo_candidate,
    ) == expected


def test_every_routed_kind_has_questions_and_a_stable_tag() -> None:
    assert set(TYPED_BRIEF_QUESTIONS) == {"paper", "engineering", "project", "change"}
    assert all(questions for questions in TYPED_BRIEF_QUESTIONS.values())
    assert TYPED_BRIEF_TAG == "brief_typed_v1"


def test_pipeline_kind_whitelist_matches_brief_kind_module() -> None:
    from ai_engine.ingestion.pipeline import _TYPED_BRIEF_KINDS

    assert _TYPED_BRIEF_KINDS == frozenset(TYPED_BRIEF_QUESTIONS)
