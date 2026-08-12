"""AI sourceRefs[type='url'] helper — Week 4 (W4-3) / Week 5 worker entry point.

This is the *safe URL fetch* integration point for AI research
`sourceRefs` of type `url`. The W5 worker will own the full Plan →
Search → Compress → Analyze → Write flow; for W4 we expose a thin
helper that:

1. Validates the URL (delegates to `safe_fetch`, which rejects
   loopback / private / metadata / link-local / metadata IPs).
2. Returns a Markdown-only body, mirroring the W3 import worker.
3. Records structured logs (host, status, bytes, elapsed_ms) without
   the URL query string or the body.

Week 5 worker callers (W5 / W6) will iterate over a job's
`source_refs` and call this helper for each `{type:'url'}` entry.

Why this lives in `fetcher/`:
- The safe fetch implementation is the SSRF guard; this module just
  packages its output into an `AdapterSource` that the AI pipeline
  can consume (and that the AI `sourceRefs` schema already validates
  via `packages/shared/src/schemas.ts SourceRefUrl`).

Why this is a *placeholder* in W4:
- The full W5 worker writes `ai_research_sources` rows; this W4
  helper just verifies the safe_fetch integration works end-to-end
  and prepares the seam.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import structlog

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import AI_JOB_STEP
from ai_engine.fetcher.safe_fetch import (
    FetchedDocument,
    SafeFetchError,
    safe_fetch,
)

logger = logging.getLogger("ai_engine.fetcher.ai_source_urls")
structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
)


@dataclass(slots=True, frozen=True)
class FetchedUrlSource:
    """Result of `_fetch_user_url` — AdapterSource + safety metadata.

    `canonical_key` is the dedupe key (URL with tracking stripped —
    mirrors the share worker's `_canonical_url`).
    `is_accessible` is True iff safe_fetch succeeded and the response
    was 2xx; False otherwise (caller decides partial vs failed).
    """

    adapter_source: AdapterSource
    canonical_key: str
    is_accessible: bool
    fetched_doc: FetchedDocument | None = None
    error_code: str | None = None


# Tracking query keys — keep in sync with `share._TRACKING_QUERY_KEYS`.
_TRACKING_QUERY_KEYS = (
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "msclkid",
    "mc_eid",
    "mc_cid",
    "ref",
    "source",
)


def _strip_query_for_log(url: str) -> str:
    """Return scheme://host/path only — no query, no fragment."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def _canonical_key(url: str) -> str:
    """Dedupe key — host + path, query stripped of tracking."""
    parts = urlsplit(url)
    keep: list[tuple[str, str]] = []
    if parts.query:
        for pair in parts.query.split("&"):
            if "=" not in pair:
                continue
            key, value = pair.split("=", 1)
            if key.lower() in _TRACKING_QUERY_KEYS:
                continue
            keep.append((key, value))
    keep.sort()
    return f"{parts.scheme}://{parts.netloc.lower()}{parts.path}?" + "&".join(
        f"{k}={v}" for k, v in keep
    ) if keep else f"{parts.scheme}://{parts.netloc.lower()}{parts.path}"


async def _fetch_user_url(
    source_ref: dict[str, Any],
    *,
    request_id: str | None = None,
) -> FetchedUrlSource:
    """Fetch a single `{type:'url', value:'...'}` source ref safely.

    Returns a `FetchedUrlSource` whose `adapter_source` can be passed
    to the AI pipeline (Step search). On safe_fetch failure, returns
    a `FetchedUrlSource` with `is_accessible=False` + `error_code`
    set; the caller decides whether to fail the job or fall back to
    auto-search (per `SourcePolicy`).
    """
    url = source_ref.get("value")
    if not isinstance(url, str) or not url:
        raise AdapterError(
            code="VALIDATION_FAILED",
            message="sourceRefs[type='url'] requires non-empty value",
        )
    if not (url.startswith("http://") or url.startswith("https://")):
        raise AdapterError(
            code="VALIDATION_FAILED",
            message=f"sourceRefs[type='url'] value must be http(s); got {url[:32]!r}",
        )

    canonical = _canonical_key(url)
    log = structlog.get_logger("ai_engine.fetcher.ai_source_urls")

    # P1.7: arxiv URLs go through the radar arxiv fetcher so research jobs
    # share the same arxiv-mcp + pymupdf + institution filter pipeline that
    # /radar uses. Other URLs keep the previous safe_fetch + HTML-strip path.
    if _looks_like_arxiv(url):
        return await _fetch_via_arxiv_radar(url, canonical, log, request_id)

    try:
        doc = await safe_fetch(url)
    except SafeFetchError as exc:
        log.warning(
            "ai-engine.ai_source.fetch_rejected",
            request_id=request_id,
            code=exc.code,
            host=exc.host or "",
        )
        # Return an inaccessible source so the caller can decide.
        return FetchedUrlSource(
            adapter_source=AdapterSource(
                source_ref={"type": "url", "value": url},
                canonical_key=canonical,
                title=None,
                snippet=None,
                score=None,
                step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
                is_accessible=False,
            ),
            canonical_key=canonical,
            is_accessible=False,
            fetched_doc=None,
            error_code=exc.code,
        )

    # Markdown body — never store raw HTML in adapter source snippets.
    body_md = _html_to_text(doc.content.decode("utf-8", errors="replace"))
    snippet = body_md[:1000]

    title = _infer_title(doc, body_md)
    # Content SHA-256 is recorded by the W5 worker when inserting the
    # `ai_research_sources` row; this helper just hands back the body
    # + canonical key so the worker can dedupe + hash in one place.

    log.info(
        "ai-engine.ai_source.fetched",
        request_id=request_id,
        host=_strip_query_for_log(url),
        bytes=len(doc.content),
        status=doc.status,
    )

    return FetchedUrlSource(
        adapter_source=AdapterSource(
            source_ref={"type": "url", "value": url},
            canonical_key=canonical,
            title=title,
            snippet=snippet,
            score=0.9,
            step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
            is_accessible=200 <= doc.status < 300,
        ),
        canonical_key=canonical,
        is_accessible=200 <= doc.status < 300,
        fetched_doc=doc,
        error_code=None,
    )


def _html_to_text(html: str) -> str:
    """Cheap HTML→text — same approach as share.html_to_markdown.

    We re-implement (instead of importing share._strip_dangerous_html)
    to keep this module self-contained for the W5 worker; the worker
    should not need to import the share subsystem.
    """
    import re

    # Drop script/style/iframe/object/embed blocks + unclosed open tags.
    for tag in ("script", "style", "iframe", "object", "embed"):
        html = re.sub(
            rf"<\s*{tag}\b[^>]*>.*?<\s*/\s*{tag}\s*>",
            "",
            html,
            flags=re.DOTALL | re.IGNORECASE,
        )
        html = re.sub(
            rf"<\s*{tag}\b[^>]*>",
            "",
            html,
            flags=re.IGNORECASE,
        )
    # Drop event attrs.
    html = re.sub(
        r"\s+on[a-z]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
        "",
        html,
        flags=re.IGNORECASE,
    )
    # Drop dangerous URLs.
    html = re.sub(
        r'(?:href|src|xlink:href)\s*=\s*"(?:javascript|data):[^"]*"',
        "",
        html,
        flags=re.IGNORECASE,
    )
    # W9 code review 修订：此前实体解码放在标签剥离之后，
    # 导致 &lt;script&gt;…&lt;/script&gt; 被 decode 成活体标签残片。
    # 已对调顺序：先解码再用 catch-all 正则抹掉所有尖括号标签。
    text = (
        html.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _infer_title(doc: FetchedDocument, body_md: str) -> str | None:
    import re

    raw = doc.content.decode("utf-8", errors="replace")
    m = re.search(r"<title[^>]*>(.*?)</title>", raw, flags=re.DOTALL | re.IGNORECASE)
    if m:
        return re.sub(r"\s+", " ", m.group(1)).strip()[:300]
    return None


def _looks_like_arxiv(url: str) -> bool:
    """Return True for arxiv.org/abs or arxiv.org/pdf URLs only."""
    from urllib.parse import urlparse

    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    # Allow arxiv.org and its pre-Lite mirrors (e.g. export.arxiv.org).
    return host == "arxiv.org" or host.endswith(".arxiv.org") or host == "export.arxiv.org"


async def _fetch_via_arxiv_radar(
    url: str,
    canonical: str,
    log: Any,
    request_id: str | None,
) -> FetchedUrlSource:
    """Route an arxiv URL through the radar arxiv fetcher and translate.

    Returns a `FetchedUrlSource` mirroring the safe_fetch path so the rest
    of the AI engine pipeline does not need to know which fetcher served
    the document. When the radar fetcher returns nothing (off-topic,
    rate-limited, blocked), we surface ``is_accessible=False`` so the
    source policy in ``adapters/gpt_researcher.py`` can fall back to
    auto-search.
    """
    try:
        from ai_engine.radar.arxiv_fetcher import fetch_arxiv_candidates
        _arxiv_fetcher_fn = fetch_arxiv_candidates  # rebind for monkeypatch in tests
    except ImportError:
        _arxiv_fetcher_fn = None

    if _arxiv_fetcher_fn is None:
        log.warning("ai-engine.ai_source.arxiv_fetcher_unavailable", url=url)
        return await _fetch_via_safe_fetch(url, canonical, log, request_id)

    candidates = await _arxiv_fetcher_fn({"maxResults": 5, "categories": [], "lookback_days": 365})
    matched = next(
        (c for c in candidates if c.url == url or canonical in (_canonical_key(c.url),)),
        None,
    )
    if matched is None:
        # The arxiv fetcher may have surfaced the same canonical via a
        # different URL shape (e.g. https://arxiv.org/abs/2608.X vs
        # https://arxiv.org/pdf/2608.X). Try matching by arxiv id.
        for c in candidates:
            if url.rsplit("/", 1)[-1].replace(".pdf", "") in c.url:
                matched = c
                break
    if matched is None:
        log.info("ai-engine.ai_source.arxiv_no_match", url=url, candidates=len(candidates))
        return FetchedUrlSource(
            adapter_source=AdapterSource(
                source_ref={"type": "url", "value": url},
                canonical_key=canonical,
                title=None,
                snippet=None,
                score=None,
                step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
                is_accessible=False,
            ),
            canonical_key=canonical,
            is_accessible=False,
            fetched_doc=None,
            error_code="ARXIV_NO_MATCH",
        )

    snippet = matched.snippet or matched.title or ""
    log.info(
        "ai-engine.ai_source.arxiv_fetched",
        request_id=request_id,
        url=matched.url,
        title=matched.title,
    )
    return FetchedUrlSource(
        adapter_source=AdapterSource(
            source_ref={"type": "url", "value": url, "resolvedUrl": matched.url},
            canonical_key=canonical,
            title=(matched.title or "")[:300] or None,
            snippet=snippet[:1000] or None,
            score=0.9,
            step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
            is_accessible=True,
        ),
        canonical_key=canonical,
        is_accessible=True,
        fetched_doc=None,
        error_code=None,
    )


async def _fetch_via_safe_fetch(
    url: str,
    canonical: str,
    log: Any,
    request_id: str | None,
) -> FetchedUrlSource:
    """Plain-HTML fetcher path used when an arxiv URL falls back."""
    try:
        doc = await safe_fetch(url)
    except SafeFetchError as exc:
        log.warning(
            "ai-engine.ai_source.fetch_rejected",
            request_id=request_id,
            code=exc.code,
            host=exc.host or "",
        )
        return FetchedUrlSource(
            adapter_source=AdapterSource(
                source_ref={"type": "url", "value": url},
                canonical_key=canonical,
                title=None,
                snippet=None,
                score=None,
                step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
                is_accessible=False,
            ),
            canonical_key=canonical,
            is_accessible=False,
            fetched_doc=None,
            error_code=exc.code,
        )
    body_md = _html_to_text(doc.content.decode("utf-8", errors="replace"))
    return FetchedUrlSource(
        adapter_source=AdapterSource(
            source_ref={"type": "url", "value": url},
            canonical_key=canonical,
            title=_infer_title(doc, body_md),
            snippet=body_md[:1000],
            score=0.9,
            step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
            is_accessible=200 <= doc.status < 300,
        ),
        canonical_key=canonical,
        is_accessible=200 <= doc.status < 300,
        fetched_doc=doc,
        error_code=None,
    )


__all__ = [
    "FetchedUrlSource",
    "_canonical_key",
    "_fetch_user_url",
    "_strip_query_for_log",
]