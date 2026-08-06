from __future__ import annotations

import httpx

from ai_engine.fact_resolvers import (
    arxiv_identifier_from_url,
    github_repo_from_url,
    npm_package_from_url,
    pypi_package_from_url,
    resolve_arxiv_paper,
    resolve_github_repository,
    resolve_npm_package,
    resolve_pypi_package,
)


async def test_github_resolver_returns_auditable_repository_fields() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "full_name": "huangruiteng/loopx",
                "stargazers_count": 2200,
                "forks_count": 120,
                "license": {"spdx_id": "Apache-2.0"},
                "updated_at": "2026-08-05T00:00:00Z",
            },
            request=request,
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        result = await resolve_github_repository("huangruiteng/loopx", client=client)
    assert result is not None
    assert result.fields["stargazers_count"] == 2200
    assert result.fields["license"] == "Apache-2.0"
    assert result.resolver == "github.repository"


async def test_npm_resolver_returns_latest_version_and_publish_time() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "dist-tags": {"latest": "3.2.1"},
                "time": {"3.2.1": "2026-08-01T00:00:00.000Z"},
            },
            request=request,
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        result = await resolve_npm_package("demo", client=client)
    assert result is not None
    assert result.fields == {"package": "demo", "version": "3.2.1", "published_at": "2026-08-01T00:00:00.000Z"}


async def test_pypi_resolver_returns_release_timestamp() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "info": {"version": "1.4.0"},
                "releases": {"1.4.0": [{"upload_time_iso_8601": "2026-08-02T00:00:00Z"}]},
            },
            request=request,
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        result = await resolve_pypi_package("demo", client=client)
    assert result is not None
    assert result.fields["version"] == "1.4.0"


async def test_arxiv_resolver_parses_original_metadata() -> None:
    xml = """
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title> A verified title </title>
        <author><name>Alice</name></author>
        <published>2026-08-01T00:00:00Z</published>
        <updated>2026-08-02T00:00:00Z</updated>
      </entry>
    </feed>
    """
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text=xml, request=request))
    async with httpx.AsyncClient(transport=transport) as client:
        result = await resolve_arxiv_paper("2608.02464", client=client)
    assert result is not None
    assert result.fields["title"] == "A verified title"
    assert result.fields["authors"] == ["Alice"]


def test_resolver_url_parsers_do_not_cross_match_domains() -> None:
    assert github_repo_from_url("https://github.com/a/b") == "a/b"
    assert github_repo_from_url("https://github.com/a/b/issues/1") is None
    assert npm_package_from_url("https://www.npmjs.com/package/react") == "react"
    assert pypi_package_from_url("https://pypi.org/project/requests") == "requests"
    assert arxiv_identifier_from_url("https://arxiv.org/abs/2608.02464v1") == "2608.02464v1"
