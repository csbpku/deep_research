"""GitHub radar source fetcher.

GitHub is a fixed HTTPS API host, so source discovery calls the GitHub API
itself. Candidate page content is fetched later by the shared ``safe_fetch``
pipeline.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

_GITHUB_API = "https://api.github.com"


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _headers(token: str | None) -> dict[str, str]:
    result = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "deep-research-radar/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        result["Authorization"] = f"Bearer {token}"
    return result


def _repo_candidate(repo: Mapping[str, Any]) -> RadarCandidate | None:
    url = repo.get("html_url")
    name = repo.get("full_name") or repo.get("name")
    if not isinstance(url, str) or not url or not isinstance(name, str) or not name:
        return None
    description = repo.get("description")
    stars = repo.get("stargazers_count")
    snippet = str(description or "").strip()
    if isinstance(stars, int):
        snippet = f"{snippet}\nGitHub stars: {stars}".strip()
    return RadarCandidate(
        title=name[:300],
        url=url,
        snippet=snippet[:2000],
        published_at=_parse_timestamp(repo.get("pushed_at") or repo.get("updated_at")),
        content_origin="api",
        tags=("github", "repository"),
        source_quality_hint=0.85,
    )


def _release_candidate(repo_name: str, release: Mapping[str, Any]) -> RadarCandidate | None:
    url = release.get("html_url")
    name = release.get("name") or release.get("tag_name")
    if not isinstance(url, str) or not url or not isinstance(name, str) or not name:
        return None
    body = release.get("body")
    return RadarCandidate(
        title=f"{repo_name} · {name}"[:300],
        url=url,
        snippet=str(body or "").strip()[:2000],
        published_at=_parse_timestamp(release.get("published_at") or release.get("created_at")),
        content_origin="api",
        tags=("github", "release"),
        source_quality_hint=0.9,
    )


async def fetch_github(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    token: str | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    """Fetch configured organizations, repositories, or release feeds.

    Supported config shape: ``orgs``, ``repos`` and
    ``type=trending|stars|releases``. ``trending`` and ``stars`` both use the
    documented repository listing/search surfaces; they are discovery modes,
    not scraping of github.com/trending.
    """

    mode = str(config.get("type") or "trending").lower()
    if mode not in {"trending", "stars", "releases"}:
        raise ValueError("GitHub source type must be trending, stars, or releases")

    orgs = [str(item).strip() for item in config.get("orgs", []) if str(item).strip()]
    repos = [str(item).strip() for item in config.get("repos", []) if str(item).strip()]
    if not orgs and not repos:
        raise ValueError("GitHub source requires at least one org or repo")

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=timeout, headers=_headers(token or os.getenv("GH_TOKEN")))
    candidates: list[RadarCandidate] = []
    try:
        for org in orgs:
            response = await http_client.get(
                f"{_GITHUB_API}/orgs/{org}/repos",
                params={"sort": "updated", "direction": "desc", "per_page": "30"},
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("GitHub organization response is not a list")
            for raw in payload:
                if not isinstance(raw, dict):
                    continue
                candidate = _repo_candidate(raw)
                if candidate is not None:
                    candidates.append(candidate)

        for repo in repos:
            if repo.count("/") != 1:
                raise ValueError("GitHub repo must use owner/name format")
            if mode == "releases":
                response = await http_client.get(
                    f"{_GITHUB_API}/repos/{repo}/releases", params={"per_page": "20"}
                )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list):
                    raise ValueError("GitHub releases response is not a list")
                for raw in payload:
                    if not isinstance(raw, dict):
                        continue
                    candidate = _release_candidate(repo, raw)
                    if candidate is not None:
                        candidates.append(candidate)
            else:
                response = await http_client.get(f"{_GITHUB_API}/repos/{repo}")
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("GitHub repository response is not an object")
                candidate = _repo_candidate(payload)
                if candidate is not None:
                    candidates.append(candidate)
    finally:
        if owns_client:
            await http_client.aclose()

    if mode == "stars":
        candidates.sort(
            key=lambda candidate: next(
                (
                    int(line.rsplit(":", 1)[-1].strip())
                    for line in candidate.snippet.splitlines()
                    if line.startswith("GitHub stars:")
                ),
                0,
            ),
            reverse=True,
        )
    return candidates


__all__ = ["fetch_github"]
