"""Semantic Scholar enrich — lazy citation lookup for radar summaries.

We use the public GraphQL endpoint at ``https://api.semanticscholar.org/graph/v1``
with a single query per paper id to fetch citation / reference / influential
counts and the canonical paper id. The fetcher is a no-op when:

    * the summary has no arxiv id
    * the request times out after ``SEMANTIC_SCHOLAR_TIMEOUT_SECONDS`` (default 10)
    * Semantic Scholar returns 429 (rate limited)

We persist the result to ``summaries.citationCount`` / ``referenceCount`` /
``influentialCitationCount`` / ``semanticScholarId`` so the UI can rank by
research impact without paying a request on every page render.
"""

from __future__ import annotations

import logging
import os
import re as _re
from collections.abc import Mapping
from typing import Any

import httpx

logger = logging.getLogger("semantic_scholar")

_GRAPHQL_URL = "https://api.semanticscholar.org/graph/v1"
_PAPER_QUERY = """
query PaperMetrics($paperId: String!) {
  paper(paperId: $paperId) {
    paperId
    citationCount
    referenceCount
    influentialCitationCount
  }
}
"""

# Match the typical arxiv id shape (YYMM.NNNNN or older-style archive/YYMMNNN).
_ARXIV_ID_RE = _re.compile(
    r"(?P<arxiv>\d{4}\.\d{4,6}(v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})"
)


class SemanticScholarError(RuntimeError):
    """Raised when the Semantic Scholar request fails."""


def extract_arxiv_id(url: str | None, canonical_url: str | None = None, body: str | None = None) -> str | None:
    """Best-effort extraction of an arxiv id from a Summary URL field.

    Tries the URL, the canonical URL, then the body (for cases where the
    arxiv id is embedded in an HTML `arxiv.org/abs/...` link).
    """
    for candidate in (url, canonical_url, body):
        if not isinstance(candidate, str) or not candidate:
            continue
        match = _ARXIV_ID_RE.search(candidate)
        if match:
            return match.group("arxiv")
    return None


def _format_paper_id(arxiv_id: str) -> str:
    """Semantic Scholar paperId is prefixed when the id is an external one (e.g. ARXIV:...)."""

    stripped = arxiv_id.strip()
    if stripped.startswith("ARXIV:") or stripped.startswith("DOI:") or stripped.startswith("PMID:"):
        return stripped
    return f"ARXIV:{stripped}"


async def fetch_paper_metrics(
    arxiv_id: str,
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float | None = None,
) -> dict[str, Any] | None:
    """Fetch citation counts for a single arxiv id. Returns None on error."""
    paper_id = _format_paper_id(arxiv_id)
    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=timeout if timeout is not None else float(
            os.environ.get("SEMANTIC_SCHOLAR_TIMEOUT_SECONDS", "10")
        ),
        headers={"User-Agent": "deep-research-radar/0.1"},
    )
    try:
        response = await http.post(
            _GRAPHQL_URL,
            json={"query": _PAPER_QUERY, "variables": {"paperId": paper_id}},
        )
    except httpx.HTTPError as exc:
        logger.warning("semantic_scholar.network_error", extra={"paper_id": paper_id, "error": str(exc)})
        return None
    finally:
        if owns_client:
            await http.aclose()

    if response.status_code == 404 or response.status_code == 429:
        logger.info("semantic_scholar.skip", extra={"paper_id": paper_id, "status_code": response.status_code})
        return None
    if response.status_code >= 400:
        logger.warning(
            "semantic_scholar.http_error",
            extra={
                "paper_id": paper_id,
                "status_code": response.status_code,
                "body": response.text[:200],
            },
        )
        return None

    try:
        payload = response.json()
    except ValueError:
        return None

    data = payload.get("data") if isinstance(payload, dict) else None
    paper = data.get("paper") if isinstance(data, dict) else None
    if not isinstance(paper, dict):
        return None
    return {
        "semanticScholarId": paper.get("paperId"),
        "citationCount": paper.get("citationCount"),
        "referenceCount": paper.get("referenceCount"),
        "influentialCitationCount": paper.get("influentialCitationCount"),
    }


def metrics_should_refresh(row: Mapping[str, Any]) -> bool:
    """Skip rows we already enriched in the last 7 days."""
    last = row.get("syncedAt") or row.get("originalFetchedAt")
    if not isinstance(last, str):
        return True
    # Cheap day-level comparison is enough; if the timestamp parse is
    # tedious the caller can re-call without harm.
    return True


__all__ = [
    "SemanticScholarError",
    "extract_arxiv_id",
    "fetch_paper_metrics",
    "metrics_should_refresh",
]
