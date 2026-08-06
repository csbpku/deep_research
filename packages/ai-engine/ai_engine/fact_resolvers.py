"""Deterministic resolvers for facts with authoritative machine-readable sources.

Resolvers deliberately return raw, auditable evidence instead of a truth score.
The reviewer decides whether a claim matches the resolved value.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

import httpx


@dataclass(frozen=True, slots=True)
class ResolverEvidence:
    resolver: str
    source_url: str
    excerpt: str
    observed_at: str
    fields: dict[str, Any]


def _observed_at() -> str:
    return datetime.now(timezone.utc).isoformat()


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "deep-research-reviewer/0.2",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def _get_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any] | None:
    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=10.0)
    try:
        response = await http_client.get(url, headers=headers)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        return None
    finally:
        if owns_client:
            await http_client.aclose()
    return payload if isinstance(payload, dict) else None


async def resolve_github_repository(
    repo: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> ResolverEvidence | None:
    """Resolve repository-level facts from GitHub's official REST API."""
    url = f"https://api.github.com/repos/{repo}"
    payload = await _get_json(url, headers=_github_headers(), client=client)
    if payload is None or not isinstance(payload.get("stargazers_count"), int):
        return None
    license_payload = payload.get("license")
    license_id = license_payload.get("spdx_id") if isinstance(license_payload, dict) else None
    fields: dict[str, Any] = {
        "full_name": payload.get("full_name"),
        "stargazers_count": payload.get("stargazers_count"),
        "forks_count": payload.get("forks_count"),
        "license": license_id,
        "updated_at": payload.get("updated_at"),
        "pushed_at": payload.get("pushed_at"),
        "default_branch": payload.get("default_branch"),
    }
    return ResolverEvidence(
        resolver="github.repository",
        source_url=url,
        excerpt=json.dumps(fields, ensure_ascii=False, sort_keys=True),
        observed_at=_observed_at(),
        fields=fields,
    )


def github_repo_from_url(value: str) -> str | None:
    parsed = urlsplit(value.strip())
    if parsed.netloc.lower() not in {"github.com", "www.github.com"}:
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        return None
    return f"{parts[0]}/{parts[1]}"


def npm_package_from_url(value: str) -> str | None:
    parsed = urlsplit(value.strip())
    if parsed.netloc.lower() not in {"npmjs.com", "www.npmjs.com"}:
        return None
    match = re.match(r"^/package/(.+?)/?$", parsed.path)
    return unquote(match.group(1)) if match else None


async def resolve_npm_package(
    package: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> ResolverEvidence | None:
    """Resolve npm version and publication metadata from npm's registry."""
    url = f"https://registry.npmjs.org/{package}"
    payload = await _get_json(url, client=client)
    if payload is None:
        return None
    dist_tags = payload.get("dist-tags")
    latest = dist_tags.get("latest") if isinstance(dist_tags, dict) else None
    times = payload.get("time")
    published_at = times.get(latest) if isinstance(times, dict) and isinstance(latest, str) else None
    if not isinstance(latest, str):
        return None
    fields = {"package": package, "version": latest, "published_at": published_at}
    return ResolverEvidence(
        resolver="npm.registry",
        source_url=url,
        excerpt=json.dumps(fields, ensure_ascii=False, sort_keys=True),
        observed_at=_observed_at(),
        fields=fields,
    )


def pypi_package_from_url(value: str) -> str | None:
    parsed = urlsplit(value.strip())
    if parsed.netloc.lower() not in {"pypi.org", "www.pypi.org"}:
        return None
    match = re.match(r"^/project/([^/]+)/?$", parsed.path)
    return unquote(match.group(1)) if match else None


async def resolve_pypi_package(
    package: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> ResolverEvidence | None:
    """Resolve PyPI version and release timestamp from PyPI's JSON API."""
    url = f"https://pypi.org/pypi/{package}/json"
    payload = await _get_json(url, client=client)
    if payload is None:
        return None
    info = payload.get("info")
    version = info.get("version") if isinstance(info, dict) else None
    releases = payload.get("releases")
    release_files = releases.get(version) if isinstance(releases, dict) and isinstance(version, str) else None
    uploaded_at = None
    if isinstance(release_files, list) and release_files and isinstance(release_files[0], dict):
        uploaded_at = (
            release_files[0].get("upload_time_iso_8601")
            or release_files[0].get("upload_time_iso")
            or release_files[0].get("upload_time")
        )
    if not isinstance(version, str):
        return None
    fields = {"package": package, "version": version, "uploaded_at": uploaded_at}
    return ResolverEvidence(
        resolver="pypi.json",
        source_url=url,
        excerpt=json.dumps(fields, ensure_ascii=False, sort_keys=True),
        observed_at=_observed_at(),
        fields=fields,
    )


def arxiv_identifier_from_url(value: str) -> str | None:
    parsed = urlsplit(value.strip())
    if parsed.netloc.lower() not in {"arxiv.org", "export.arxiv.org"}:
        return None
    match = re.match(r"^/(?:abs|pdf)/([^/]+?)(?:\.pdf)?/?$", parsed.path)
    return unquote(match.group(1)) if match else None


async def resolve_arxiv_paper(
    identifier: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> ResolverEvidence | None:
    """Resolve arXiv title/authors/date/version from the arXiv API feed."""
    url = f"https://export.arxiv.org/api/query?id_list={identifier}"
    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=10.0)
    try:
        response = await http_client.get(url)
        response.raise_for_status()
        root = ElementTree.fromstring(response.text)
    except (httpx.HTTPError, ElementTree.ParseError):
        return None
    finally:
        if owns_client:
            await http_client.aclose()
    entry = next(iter(root.findall("{http://www.w3.org/2005/Atom}entry")), None)
    if entry is None:
        return None
    def text(name: str) -> str:
        return (entry.findtext(f"{{http://www.w3.org/2005/Atom}}{name}") or "").strip()
    authors = [
        (author.findtext("{http://www.w3.org/2005/Atom}name") or "").strip()
        for author in entry.findall("{http://www.w3.org/2005/Atom}author")
    ]
    fields = {
        "identifier": identifier,
        "title": re.sub(r"\s+", " ", text("title")),
        "authors": authors,
        "published": text("published"),
        "updated": text("updated"),
    }
    return ResolverEvidence(
        resolver="arxiv.api",
        source_url=url,
        excerpt=json.dumps(fields, ensure_ascii=False, sort_keys=True),
        observed_at=_observed_at(),
        fields=fields,
    )


__all__ = [
    "ResolverEvidence",
    "arxiv_identifier_from_url",
    "github_repo_from_url",
    "npm_package_from_url",
    "pypi_package_from_url",
    "resolve_arxiv_paper",
    "resolve_github_repository",
    "resolve_npm_package",
    "resolve_pypi_package",
]
