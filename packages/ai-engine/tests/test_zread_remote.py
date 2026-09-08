import pytest

from ai_engine.radar import zread_remote
from ai_engine.radar.zread_remote import _flight_markdown, _html_page_title, _page_catalog, _page_refs


def test_flight_markdown_extracts_server_rendered_markdown() -> None:
    html = (
        '<script>self.__next_f.push([1,"---\\nslug:4-latest-updates\\n---\\n\\n'
        '# Latest Updates\\n\\nExisting content."])<\/script>'
    )
    assert _flight_markdown(html) == "# Latest Updates\n\nExisting content."


def test_page_refs_reads_zread_catalog_links() -> None:
    html = (
        '<a href="/owner/repo/1-overview">Overview</a>'
        '<a href="/owner/repo/2-quick-start">Quick Start</a>'
        '<a href="/other/repo/ignored">Ignored</a>'
    )
    assert _page_refs(html, "owner", "repo") == ["1-overview", "2-quick-start"]


def test_page_refs_reads_escaped_next_flight_catalog() -> None:
    html = r'{"pages":[{"page_id":"a","topic":"Overview","group":"","section":"入门","slug":"1-overview"},{"page_id":"b","topic":"Quick Start","group":"","section":"入门","slug":"2-quick-start"}]}'
    assert _page_refs(html, "owner", "repo") == ["1-overview", "2-quick-start"]


def test_page_catalog_preserves_zread_hierarchy() -> None:
    # Zread's actual catalog uses section for the top-level directory and
    # group for a nested bucket under that directory.
    html = r'{"pages":[{"page_id":"a","topic":"Overview","group":"","section":"Get Started","slug":"1-overview"},{"page_id":"b","topic":"Architecture","group":"Hooks","section":"Deep Dive","slug":"8-architecture"}]}'
    assert _page_catalog(html) == [
        {"topic": "Overview", "group": "", "section": "Get Started", "slug": "1-overview"},
        {"topic": "Architecture", "group": "Hooks", "section": "Deep Dive", "slug": "8-architecture"},
    ]


def test_page_catalog_decodes_unicode_escapes_in_directory_names() -> None:
    html = r'{"pages":[{"page_id":"a","topic":"UI \u0026 Design","group":"Core \u0026 Runtime","section":"Deep Dive","slug":"1-ui"}]}'

    assert _page_catalog(html) == [
        {
            "topic": "UI & Design",
            "group": "Core & Runtime",
            "section": "Deep Dive",
            "slug": "1-ui",
        },
    ]


def test_page_catalog_decodes_double_unicode_escapes_in_directory_names() -> None:
    html = r'{"pages":[{"page_id":"a","topic":"UI \\u0026 Design","group":"Core \\u0026 Runtime","section":"Deep Dive","slug":"1-ui"}]}'

    assert _page_catalog(html)[0]["group"] == "Core & Runtime"


def test_html_page_title_prefers_zread_heading() -> None:
    assert _html_page_title('<h1>多智能体配置指南 <a>报告问题</a></h1>', "3-guide") == "多智能体配置指南 报告问题"


@pytest.mark.asyncio
async def test_remote_rate_limit_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zread_remote, "ZREAD_REMOTE_MIN_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(zread_remote, "_zread_remote_last_request_ts", 0.0)
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(zread_remote.asyncio, "sleep", fake_sleep)

    await zread_remote._zread_remote_rate_limit()

    assert sleeps == []


@pytest.mark.asyncio
async def test_remote_does_not_refetch_root_when_catalog_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeClient:
        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

    calls: list[str] = []

    async def fake_get(client: object, url: str) -> str:
        del client
        calls.append(url)
        return "<html><div>application shell only</div></html>"

    monkeypatch.setattr(zread_remote, "_HAS_CURL_CFFI", False)
    monkeypatch.setattr(zread_remote.httpx, "AsyncClient", lambda **_: FakeClient())
    monkeypatch.setattr(zread_remote, "_get", fake_get)

    payload = await zread_remote.fetch_zread_wiki(owner="example", repo="repo")

    assert payload is None
    assert calls == ["https://zread.ai/example/repo"]
