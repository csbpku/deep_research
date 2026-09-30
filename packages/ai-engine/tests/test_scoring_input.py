from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from ai_engine.fetcher.safe_fetch import FetchedDocument
from ai_engine.radar.scoring_input import transient_scoring_input


class _Pool:
    def __init__(self, excerpt: str | None = None) -> None:
        self.excerpt = excerpt
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self

    async def execute(self, sql: str, params: tuple[Any, ...]):  # type: ignore[no-untyped-def]
        self.queries.append((sql, params))
        return self

    async def fetchone(self):  # type: ignore[no-untyped-def]
        return {"body": self.excerpt} if self.excerpt is not None else None


def _row(**overrides: Any) -> dict[str, Any]:
    return {
        "source": "daily",
        "tags": ["external_reading"],
        "sourceType": "arxiv",
        "url": "https://arxiv.org/abs/2609.00001",
        "canonicalUrl": "https://arxiv.org/abs/2609.00001",
        "syncRunId": "run-1",
        **overrides,
    }


async def test_uses_existing_source_excerpt_without_network_or_new_writes() -> None:
    excerpt = "A technical paper describes its method, experiments and limitations. " * 15
    pool = _Pool(excerpt)

    async def no_fetch(*args: Any, **kwargs: Any) -> FetchedDocument:
        raise AssertionError("an adequate excerpt must not be fetched again")

    assert await transient_scoring_input(pool, _row(), fetcher=no_fetch) == (
        excerpt.strip()[:2_000], "source_excerpt",
    )
    assert len(pool.queries) == 1
    sql, params = pool.queries[0]
    assert "PENDING_SCORE" in sql
    assert params == ("run-1", "https://arxiv.org/abs/2609.00001")
    assert sql.startswith("SELECT")


async def test_short_excerpt_uses_bounded_in_memory_source_read() -> None:
    pool = _Pool("short snippet")
    seen: list[dict[str, Any]] = []
    html = (
        '<blockquote class="abstract">'
        + "A peer-reviewed research result discusses benchmarks and implementation. " * 15
        + "</blockquote>"
    )

    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        seen.append({"url": url, **kwargs})
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=200,
            headers={}, content=html.encode(), content_type="text/html",
            elapsed_ms=12,
        )

    result = await transient_scoring_input(pool, _row(), fetcher=fetch)
    assert result is not None
    assert result[1] == "transient_source"
    assert "benchmarks and implementation" in result[0]
    assert seen == [{
        "url": "https://arxiv.org/abs/2609.00001",
        "max_bytes": 256_000, "timeout": 10.0, "max_redirects": 2,
        "allowed_hosts": ("arxiv.org", "github.com"),
    }]
    assert len(pool.queries) == 1


async def test_rejects_untrusted_rows_and_non_https_links_without_fetch() -> None:
    pool = _Pool()

    async def no_fetch(*args: Any, **kwargs: Any) -> FetchedDocument:
        raise AssertionError("not an approved source link")

    for row in (
        _row(source="user"),
        _row(tags=["content_pending"]),
        _row(url="https://arxiv.org.attacker.example/abs/1"),
        _row(url="http://arxiv.org/abs/1"),
        _row(sourceType="hackernews"),
    ):
        assert await transient_scoring_input(pool, row, fetcher=no_fetch) is None
    assert all(sql.startswith("SELECT") for sql, _ in pool.queries)


async def test_rejects_shell_failure_status_and_cross_domain_result() -> None:
    pool = _Pool("short")

    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url=kwargs.get("final_url", url), final_ip="8.8.8.8",
            status=kwargs.get("status", 200), headers={},
            content=("Just a moment, verifying your browser " * 30).encode(),
            content_type="text/html", elapsed_ms=12,
        )

    assert await transient_scoring_input(pool, _row(), fetcher=fetch) is None

    async def wrong_host(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url="https://untrusted.example/article", final_ip="8.8.8.8",
            status=200, headers={}, content=b"irrelevant",
            content_type="text/html", elapsed_ms=12,
        )

    assert await transient_scoring_input(pool, _row(), fetcher=wrong_host) is None

    async def failed_status(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=404, headers={},
            content=b"Not found " * 100, content_type="text/html", elapsed_ms=12,
        )

    assert await transient_scoring_input(pool, _row(), fetcher=failed_status) is None
    assert all(sql.startswith("SELECT") for sql, _ in pool.queries)
