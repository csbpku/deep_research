from ai_engine.radar.zread_remote import _flight_markdown, _page_refs


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
    html = r'{"pages":[{"slug":"1-overview"},{"slug":"2-quick-start"}]}'
    assert _page_refs(html, "owner", "repo") == ["1-overview", "2-quick-start"]
