"""Small deterministic verifier for volatile, high-risk report facts.

The first MVP rule covers GitHub repository star counts.  These values are
authoritative in GitHub's REST API and should not be trusted from search
snippets or model memory.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from ai_engine.adapters.base import AdapterSource

_GITHUB_API = "https://api.github.com"
_GITHUB_REPO_RE = re.compile(r"^/([^/]+)/([^/]+)/?$")
_STAR_CLAIM_RE = re.compile(
    r"(?P<before>"
    r"(?:GitHub\s*)?(?:stars?|stargazers?|star\s*数|星标数)"
    r"\s*[:：]?\s*)(?P<number>\d[\d,.]*\s*[kKm万]?)"
    r"|(?P<number_before>\d[\d,.]*\s*[kKm万]?)"
    r"(?P<after>\s*(?:个?\s*)?(?:GitHub\s*)?"
    r"(?:stars?|stargazers?|star\s*数|星标数))",
    re.IGNORECASE,
)


@dataclass(slots=True, frozen=True)
class FactVerificationResult:
    report: str
    checked: int = 0
    corrected: int = 0
    unavailable: int = 0


def _repo_from_url(value: str) -> str | None:
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if parsed.netloc.lower() not in {"github.com", "www.github.com"}:
        return None
    match = _GITHUB_REPO_RE.match(parsed.path)
    if not match:
        return None
    return f"{match.group(1)}/{match.group(2)}"


def _parse_count(value: str) -> float | None:
    compact = value.replace(",", "").replace(" ", "").lower()
    multiplier = 1
    if compact.endswith("k"):
        multiplier, compact = 1_000, compact[:-1]
    elif compact.endswith("万"):
        multiplier, compact = 10_000, compact[:-1]
    try:
        return float(compact) * multiplier
    except ValueError:
        return None


def _headers(token: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "deep-research-fact-verifier/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def verify_github_star_claims(
    report: str,
    sources: list[AdapterSource],
    *,
    client: httpx.AsyncClient | None = None,
    token: str | None = None,
) -> FactVerificationResult:
    """Correct GitHub star claims when the report has a resolvable repo URL.

    The verifier is deliberately conservative: it only rewrites a report
    when exactly one GitHub repository is represented by the captured sources.
    If the API is unavailable, it leaves the prose untouched and records the
    unavailable check for the caller/UI.
    """
    repos = {
        repo
        for source in sources
        for value in (
            source.canonical_key,
            source.source_ref.get("value")
            if isinstance(source.source_ref, dict)
            else None,
        )
        if isinstance(value, str)
        for repo in (_repo_from_url(value),)
        if repo is not None
    }
    if len(repos) != 1:
        return FactVerificationResult(report=report)

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=10.0)
    try:
        repo = next(iter(repos))
        try:
            response = await http_client.get(
                f"{_GITHUB_API}/repos/{repo}",
                headers=_headers(token),
            )
            response.raise_for_status()
            payload: Any = response.json()
        except (httpx.HTTPError, ValueError):
            return FactVerificationResult(report=report, unavailable=1)
    finally:
        if owns_client:
            await http_client.aclose()

    stars = payload.get("stargazers_count") if isinstance(payload, dict) else None
    if not isinstance(stars, int):
        return FactVerificationResult(report=report, unavailable=1)

    checked = 0
    corrected = 0

    def replace_claim(match: re.Match[str]) -> str:
        nonlocal checked, corrected
        raw_number = match.group("number") or match.group("number_before")
        if not raw_number:
            return match.group(0)
        parsed = _parse_count(raw_number)
        if parsed is None:
            return match.group(0)
        checked += 1
        if round(parsed) == stars:
            return match.group(0)
        corrected += 1
        if match.group("number"):
            return f"{match.group('before')}{stars:,}"
        trailing_space = raw_number[len(raw_number.rstrip()):]
        return f"{stars:,}{trailing_space}{match.group('after')}"

    corrected_report = _STAR_CLAIM_RE.sub(replace_claim, report)
    return FactVerificationResult(
        report=corrected_report,
        checked=checked,
        corrected=corrected,
    )


__all__ = ["FactVerificationResult", "verify_github_star_claims"]
