"""Derive the content shape of a radar item from its URL.

``originalKind`` is the authoritative label for a source shape (repository,
paper, issue, article).  Rows ingested before the platform moved to external
reading carry a null kind even when the URL identifies the shape
unambiguously, so every consumer that reasons about shape must be able to
fall back to the URL instead of treating those rows as an unknown web page.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

GITHUB_ISSUE_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/[^/]+/[^/]+/issues/\d+(?:/|$)",
    re.IGNORECASE,
)
GITHUB_PULL_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/[^/]+/[^/]+/pull/\d+(?:/|$)",
    re.IGNORECASE,
)
GITHUB_RELEASE_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/[^/]+/[^/]+/releases/tag/",
    re.IGNORECASE,
)
GITHUB_REPO_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/[^/]+/[^/?#]+(?:\.git)?/?$",
    re.IGNORECASE,
)
ARXIV_RE = re.compile(
    r"^https?://(?:www\.)?arxiv\.org/(?:abs|html)/",
    re.IGNORECASE,
)
HUGGINGFACE_PAPERS_RE = re.compile(
    r"^https?://(?:www\.)?huggingface\.co/papers/",
    re.IGNORECASE,
)


def kind_from_url(url: str | None) -> str | None:
    """Return the content kind implied by a source URL, if any."""
    if not url:
        return None
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if host in {"github.com", "www.github.com"}:
        if GITHUB_ISSUE_RE.match(url):
            return "github_issue"
        if GITHUB_PULL_RE.match(url):
            return "github_pr"
        if GITHUB_RELEASE_RE.match(url):
            return "github_release"
        if GITHUB_REPO_RE.match(url):
            return "github_repo"
        return "github_other"
    if host in {"arxiv.org", "www.arxiv.org"} or ARXIV_RE.match(url):
        return "arxiv"
    if (
        host in {"huggingface.co", "www.huggingface.co"}
        and HUGGINGFACE_PAPERS_RE.match(url)
    ):
        return "arxiv"
    return None


def effective_kind(original_kind: str | None, url: str | None) -> str | None:
    """Return the stored content kind, falling back to the URL when absent."""
    if original_kind:
        return str(original_kind)
    return kind_from_url(url)


__all__ = ["effective_kind", "kind_from_url"]
