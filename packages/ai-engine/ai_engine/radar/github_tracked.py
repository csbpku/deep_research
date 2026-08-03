"""GitHub Tracked repos fetcher — issues/PRs/releases for a curated repo list.

Quota mirrors ``duanyytop/agents-radar/src/github.ts`` where it matters:
regular repos fetch one page of 50 issues/PRs, paginated repos walk up to 5
pages of 100, and releases use one page of 10. The lookback defaults to 24h
(same as agents-radar's daily digest).

Unlike agents-radar's per-item pipeline, this fetcher returns **one
``RadarCandidate`` per repo** carrying a ``RepoActivity`` payload. The sync
runner then generates one LLM summary per repo instead of one summary per
issue/PR/release. ``max_items_per_repo`` bounds the prompt: up to 30 issues +
20 PRs by comment count, plus up to 10 releases, totalling 60 by default.

For each repo in ``config["repos"]``:

  - GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&since=...
    (since param filters issues; PRs are dropped via the `pull_request` field)
  - GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc
    (no since param; client-side filter by `updated_at >= lookback`)
  - GET /repos/{owner}/{repo}/releases?per_page=10
    (client-side filter by `published_at >= lookback`)

Concurrency via ``asyncio.gather`` across repos. Requires ``GH_TOKEN`` env
var for production runs (rate limit).
"""
# ruff: noqa: E402
from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate, RepoActivity, RepoActivityItem

_GITHUB_API = "https://api.github.com"
_DEFAULT_LOOKBACK_DAYS = 1
_DEFAULT_MAX_ITEMS_PER_REPO = 60
_ISSUE_SAMPLE_LIMIT = 30
_PR_SAMPLE_LIMIT = 20
_ISSUE_PAGE_SIZE = 50
_PR_PAGE_SIZE = 50
_PAGINATED_PAGE_SIZE = 100
_RELEASES_PER_PAGE = 10
_MAX_PAGINATED_PAGES = 5


def _headers(token: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "deep-research-radar/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _parse_ts(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _truncate(text: str | None, max_len: int = 300) -> str:
    if not text:
        return ""
    text = " ".join(str(text).split())
    return text[:max_len] + ("..." if len(text) > max_len else "")


def _raise_if_rate_limited(resp: httpx.Response, repo: str) -> None:
    if resp.status_code == 403 and "rate limit" in resp.text.lower():
        raise RuntimeError(f"github_rate_limited: {repo}")
    resp.raise_for_status()


async def _fetch_issues(
    http: httpx.AsyncClient,
    repo: str,
    lookback: datetime,
    *,
    paginate: bool,
) -> list[dict[str, Any]]:
    """Fetch issues updated since ``lookback``. Skips PRs (which appear in
    /issues with a non-null ``pull_request`` field).

    Paginated repos walk up to 5 pages of 100, like agents-radar; regular
    repos fetch exactly one page of 50.
    """
    url = f"{_GITHUB_API}/repos/{repo}/issues"
    all_items: list[dict[str, Any]] = []
    max_pages = _MAX_PAGINATED_PAGES if paginate else 1
    page_size = _PAGINATED_PAGE_SIZE if paginate else _ISSUE_PAGE_SIZE
    for page in range(1, max_pages + 1):
        params: dict[str, str] = {
            "state": "all",
            "sort": "updated",
            "direction": "desc",
            "per_page": str(page_size),
            "since": lookback.isoformat(),
            "page": str(page),
        }
        resp = await http.get(url, params=params)
        _raise_if_rate_limited(resp, repo)
        items = resp.json() if isinstance(resp.json(), list) else []
        if not items:
            break
        all_items.extend(items)
        if len(items) < page_size or not paginate:
            break
    return [
        it for it in all_items
        if isinstance(it, dict) and "pull_request" not in it
    ]


async def _fetch_prs(
    http: httpx.AsyncClient,
    repo: str,
    lookback: datetime,
    *,
    paginate: bool,
) -> list[dict[str, Any]]:
    """Fetch PRs updated since ``lookback``. /pulls does not accept ``since``,
    so we filter client-side.

    Mirrors agents-radar's quota semantics: ordinary repos fetch exactly one
    page of 50; only ``paginate=True`` repos walk up to 5 pages of 100 and
    stop once a page's oldest item predates ``lookback``.
    """
    url = f"{_GITHUB_API}/repos/{repo}/pulls"
    all_items: list[dict[str, Any]] = []
    max_pages = _MAX_PAGINATED_PAGES if paginate else 1
    page_size = _PAGINATED_PAGE_SIZE if paginate else _PR_PAGE_SIZE
    for page in range(1, max_pages + 1):
        params: dict[str, str] = {
            "state": "all",
            "sort": "updated",
            "direction": "desc",
            "per_page": str(page_size),
            "page": str(page),
        }
        resp = await http.get(url, params=params)
        _raise_if_rate_limited(resp, repo)
        items = resp.json() if isinstance(resp.json(), list) else []
        if not items:
            break

        page_in_window: list[dict[str, Any]] = []
        for it in items:
            updated = _parse_ts(it.get("updated_at"))
            if updated and updated >= lookback:
                page_in_window.append(it)
            else:
                # Items are sorted desc by updated_at — once we hit one older
                # than lookback, the rest of the page is older too.
                break

        all_items.extend(page_in_window)
        if len(page_in_window) < len(items):
            break
        if len(items) < page_size:
            break
        if not paginate:
            break

    return all_items


async def _fetch_releases(
    http: httpx.AsyncClient,
    repo: str,
    lookback: datetime,
) -> list[dict[str, Any]]:
    url = f"{_GITHUB_API}/repos/{repo}/releases"
    resp = await http.get(url, params={"per_page": str(_RELEASES_PER_PAGE)})
    _raise_if_rate_limited(resp, repo)
    items = resp.json() if isinstance(resp.json(), list) else []
    in_window: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        published = _parse_ts(it.get("published_at") or it.get("created_at"))
        if published is not None and published >= lookback:
            in_window.append(it)
    return in_window


def _activity_item(
    repo: str,
    kind: str,
    item: dict[str, Any],
) -> RepoActivityItem:
    """Convert one GitHub API item to a compact digest DTO."""
    user = item.get("user")
    author = str(user.get("login") or "") if isinstance(user, dict) else ""
    labels: list[str] = []
    for label in item.get("labels") or []:
        if isinstance(label, dict) and label.get("name"):
            labels.append(str(label["name"]))
    reactions = item.get("reactions") or {}
    reactions_n = (
        int(reactions.get("+1") or 0)
        if isinstance(reactions, dict)
        else 0
    )
    number = str(
        item.get("number")
        or item.get("tag_name")
        or item.get("name")
        or ""
    )
    title = str(
        item.get("title")
        or item.get("name")
        or item.get("tag_name")
        or "(no title)"
    )[:300]
    url = str(
        item.get("html_url")
        or f"https://github.com/{repo}/issues/{number}"
    )
    return RepoActivityItem(
        kind=kind,  # type: ignore[arg-type]
        number=number,
        title=title,
        url=url,
        state=str(item.get("state") or ""),
        author=author,
        comments=int(item.get("comments") or 0),
        labels=tuple(labels[:6]),
        reactions=reactions_n,
        created_at=str(item.get("created_at") or ""),
        updated_at=str(item.get("updated_at") or ""),
        published_at=str(
            item.get("published_at")
            or item.get("updated_at")
            or item.get("created_at")
            or ""
        ),
        body=_truncate(item.get("body") or ""),
    )


def _sort_by_comments(items: list[RepoActivityItem]) -> list[RepoActivityItem]:
    return sorted(items, key=lambda it: it.comments, reverse=True)


def format_repo_activity(
    activity: RepoActivity,
    max_chars: int = 8000,
) -> str:
    """Render a tracked repo's activity as compact markdown for LLM prompts."""

    def item_block(item: RepoActivityItem) -> str:
        label_str = f" [{', '.join(item.labels)}]" if item.labels else ""
        kind = "PR" if item.kind == "pr" else "Issue"
        updated = item.updated_at or item.published_at or item.created_at
        return (
            f"#{item.number} [{item.state.upper()}] {item.title}{label_str}\n"
            f"  {kind} | 作者: {item.author} | 评论: {item.comments} | "
            f"更新: {updated}\n"
            f"  链接: {item.url}\n"
            f"  摘要: {item.body}"
        )

    parts: list[str] = [f"# {activity.repo}"]
    if activity.releases:
        release_lines = [
            f"- {it.number}: {it.title}\n  摘要: {it.body}\n  链接: {it.url}"
            for it in activity.releases
        ]
        parts.append("## Releases (past 24h)\n" + "\n".join(release_lines))
    if activity.issues:
        parts.append(
            "## Issues (updated in past 24h)\n"
            + "\n\n".join(item_block(it) for it in activity.issues)
        )
    if activity.prs:
        parts.append(
            "## Pull Requests (updated in past 24h)\n"
            + "\n\n".join(item_block(it) for it in activity.prs)
        )
    text = "\n\n".join(parts)
    return text[:max_chars]


def _latest_published(activity: RepoActivity) -> datetime | None:
    candidates: list[datetime] = []
    for it in (*activity.issues, *activity.prs, *activity.releases):
        ts = _parse_ts(it.updated_at or it.published_at or it.created_at)
        if ts is not None:
            candidates.append(ts)
    return max(candidates) if candidates else None


def _cap_activity(activity: RepoActivity, limit: int) -> RepoActivity:
    """Sample per type (issues first, then PRs, then releases) up to ``limit``.

    Issues and PRs are ranked by comment count like agents-radar; releases
    are newest-first. The total never exceeds ``limit`` so the per-repo LLM
    prompt stays bounded.
    """
    remaining = max(0, limit)
    issues = tuple(_sort_by_comments(list(activity.issues))[:min(remaining, _ISSUE_SAMPLE_LIMIT)])
    remaining = max(0, limit - len(issues))
    prs = tuple(_sort_by_comments(list(activity.prs))[:min(remaining, _PR_SAMPLE_LIMIT)])
    remaining = max(0, limit - len(issues) - len(prs))
    releases = sorted(
        activity.releases,
        key=lambda it: _parse_ts(it.published_at or it.updated_at) or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[:min(remaining, _RELEASES_PER_PAGE)]
    return RepoActivity(
        repo=activity.repo,
        issues=issues,
        prs=prs,
        releases=tuple(releases),
    )


async def _fetch_one_repo(
    http: httpx.AsyncClient,
    repo: str,
    lookback: datetime,
    max_items_per_repo: int,
    include_issues: bool,
    include_prs: bool,
    include_releases: bool,
    paginate: bool,
) -> list[RadarCandidate]:
    """Fetch issues + PRs + releases for a single repo and return either an
    empty list (no recent activity) or one repo-digest candidate.

    Failures on one API call are isolated: data already fetched for the same
    repo is still summarized rather than dropping the whole repo.
    """
    raw_issues: list[dict[str, Any]] = []
    raw_prs: list[dict[str, Any]] = []
    raw_releases: list[dict[str, Any]] = []
    try:
        if include_issues:
            raw_issues = await _fetch_issues(http, repo, lookback, paginate=paginate)
        if include_prs:
            raw_prs = await _fetch_prs(http, repo, lookback, paginate=paginate)
        if include_releases:
            raw_releases = await _fetch_releases(http, repo, lookback)
    except Exception:
        # Fall through with whatever was fetched before the failure.
        pass

    issues = tuple(_activity_item(repo, "issue", it) for it in raw_issues)
    prs = tuple(_activity_item(repo, "pr", it) for it in raw_prs)
    releases = tuple(_activity_item(repo, "release", it) for it in raw_releases)
    activity = _cap_activity(
        RepoActivity(repo=repo, issues=issues, prs=prs, releases=releases),
        max_items_per_repo,
    )
    if activity.item_count == 0:
        return []

    digest_date = datetime.now(timezone.utc).date().isoformat()
    candidate = RadarCandidate(
        title=f"{repo} 24h GitHub 动态",
        url=f"https://github.com/{repo}?digest={digest_date}",
        snippet=format_repo_activity(activity, max_chars=2000),
        published_at=_latest_published(activity),
        content_origin="api",
        tags=("github", "tracked", repo, "repo_digest"),
        source_quality_hint=0.90,
        repo_activity=activity,
    )
    return [candidate]


async def fetch_github_tracked(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    """Track a curated list of AI/agent/infra repos via GitHub REST API.

    config keys:
      - repos: list[str]                    # ["anthropics/claude-code", ...]
      - lookback_days: int = 1              # agents-radar uses a 24h window
      - max_items_per_repo: int = 60        # TOTAL per repo, across all types
      - include_issues: bool = True
      - include_prs: bool = True
      - include_releases: bool = True
      - paginated_repos: list[str] — repos that should paginate beyond the
        first 50 issues/PRs (high-volume repos only, mirrors agents-radar's
        ``paginated: true``).

    Returns one ``RadarCandidate`` per repo with recent activity. Repos with
    no activity return nothing (agents-radar also skips the per-repo LLM
    summary when there is nothing to summarize).
    """
    repos = list(config.get("repos") or [])
    lookback_days = max(1, int(config.get("lookback_days", _DEFAULT_LOOKBACK_DAYS)))
    max_items_per_repo = max(
        1,
        min(100, int(config.get("max_items_per_repo", _DEFAULT_MAX_ITEMS_PER_REPO))),
    )
    include_issues = bool(config.get("include_issues", True))
    include_prs = bool(config.get("include_prs", True))
    include_releases = bool(config.get("include_releases", True))
    paginated_repos = {
        str(repo).strip().lower().rstrip("/")
        for repo in (config.get("paginated_repos") or [])
    }

    if not repos:
        return []

    lookback = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    normalized_repos = [str(repo).strip().rstrip("/") for repo in repos]

    token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")
    total_requests = len(repos) * (
        int(include_issues) + int(include_prs) + int(include_releases)
    )
    if not token and total_requests > 60:
        # Unauthenticated rate limit is 60 req/h — fail loudly so the
        # operator knows to set GH_TOKEN rather than silently missing data.
        raise RuntimeError(
            f"github_tracked: {total_requests} requests needed but no GH_TOKEN set. "
            "Set GH_TOKEN env var (or reduce repos / max_items_per_repo)."
        )

    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=timeout,
        headers=_headers(token),
        # GitHub returns 301 for renamed/case-changed repos; follow it like
        # agents-radar's native fetch does.
        follow_redirects=True,
    )

    try:
        results = await asyncio.gather(
            *(
                _fetch_one_repo(
                    http,
                    repo,
                    lookback,
                    max_items_per_repo,
                    include_issues,
                    include_prs,
                    include_releases,
                    repo.lower().rstrip("/") in paginated_repos,
                )
                for repo in normalized_repos
            ),
            return_exceptions=False,
        )
    finally:
        if owns_client:
            await http.aclose()

    out: list[RadarCandidate] = []
    for batch in results:
        out.extend(batch)
    return out


__all__ = ["fetch_github_tracked", "format_repo_activity"]
