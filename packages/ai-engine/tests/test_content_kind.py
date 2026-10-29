"""The URL fallback that keeps a source shape knowable without stored state."""

from __future__ import annotations

from ai_engine.radar.content_kind import effective_kind, kind_from_url


def test_kind_from_url_recognises_repository_roots() -> None:
    assert kind_from_url("https://github.com/General-Instinct/InstinctFlash") == "github_repo"
    assert kind_from_url("https://github.com/volotat/mini-AGI/") == "github_repo"
    assert kind_from_url("https://github.com/volotat/mini-AGI.git") == "github_repo"
    assert kind_from_url("https://www.github.com/owner/repo") == "github_repo"


def test_kind_from_url_separates_issues_pulls_and_releases() -> None:
    assert kind_from_url("https://github.com/owner/repo/issues/12") == "github_issue"
    assert kind_from_url("https://github.com/owner/repo/pull/7") == "github_pr"
    assert kind_from_url("https://github.com/owner/repo/releases/tag/v1.0") == "github_release"
    assert kind_from_url("https://github.com/owner/repo/tree/main") == "github_other"


def test_kind_from_url_recognises_papers() -> None:
    assert kind_from_url("https://arxiv.org/abs/2609.12345") == "arxiv"
    assert kind_from_url("https://arxiv.org/html/2609.12345") == "arxiv"
    assert kind_from_url("https://huggingface.co/papers/2609.12345") == "arxiv"


def test_kind_from_url_ignores_shapes_it_cannot_identify() -> None:
    assert kind_from_url("https://example.com/post") is None
    assert kind_from_url("https://example.com/owner/repo") is None
    assert kind_from_url("") is None
    assert kind_from_url(None) is None


def test_effective_kind_prefers_the_stored_label() -> None:
    # A stored label is authoritative even when the URL would say otherwise.
    assert effective_kind("rss", "https://github.com/owner/repo") == "rss"
    assert effective_kind(None, "https://github.com/owner/repo") == "github_repo"
    assert effective_kind("", "https://github.com/owner/repo") == "github_repo"
    assert effective_kind(None, "https://example.com/post") is None
