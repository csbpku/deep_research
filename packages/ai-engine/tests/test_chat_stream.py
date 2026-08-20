"""M7 chat streaming helpers — covers the citation parser + the SSE frame
encoder used by the new streaming chat endpoint."""

from __future__ import annotations

from ai_engine.server.chat import _parse_citations, _sse_frame, _zread_context


def test_parse_citations_extracts_quotes_and_cleans_markers() -> None:
    text = (
        "The author claims X.\n\n"
        "[[cite]]x is provably correct under the stated assumptions.[[/cite]]\n\n"
        "We then see Y."
    )
    cleaned, cites = _parse_citations(text)
    assert cites == [{"quote": "x is provably correct under the stated assumptions."}]
    assert "[[cite]]" not in cleaned
    assert "[[/cite]]" not in cleaned
    assert "x is provably correct under the stated assumptions." in cleaned


def test_parse_citations_without_markers_returns_content_unchanged() -> None:
    text = "plain text with no markers at all"
    cleaned, cites = _parse_citations(text)
    assert cites == []
    assert cleaned == text


def test_parse_citations_truncates_huge_quotes() -> None:
    huge = "a" * 5000
    cleaned, cites = _parse_citations(f"intro [[cite]]{huge}[[/cite]] tail")
    assert len(cites) == 1
    assert len(cites[0]["quote"]) == 2000
    assert "tail" in cleaned


def test_parse_citations_handles_multiple_quotes() -> None:
    text = (
        "[[cite]]first quote[[/cite]] middle "
        "[[cite]]second quote[[/cite]] end"
    )
    cleaned, cites = _parse_citations(text)
    assert len(cites) == 2
    assert cites[0]["quote"] == "first quote"
    assert cites[1]["quote"] == "second quote"
    assert "first quote" in cleaned and "second quote" in cleaned


def test_parse_citations_adds_source_location_when_quote_is_in_snapshot() -> None:
    cleaned, cites = _parse_citations(
        "[[cite]]The method uses a frozen context for repeated requests.[[/cite]]",
        {
            "original_markdown": (
                "# Intro\n\n"
                "Background.\n\n"
                "## Method\n\n"
                "The method uses a frozen context for repeated requests."
            )
        },
    )
    assert "The method uses a frozen context" in cleaned
    assert cites == [{
        "quote": "The method uses a frozen context for repeated requests.",
        "sourceBlockIndex": "3",
        "location": "Method · 正文第 4 段",
    }]


def test_parse_citations_preserves_zread_source_path() -> None:
    cleaned, cites = _parse_citations(
        "[[cite]]The loader reads the project configuration.[[/cite]]",
        {
            "url": "https://github.com/example/project",
            "repo_commit": "abc123",
            "reading_context": (
                "<!-- zread-path: docs/architecture.md -->\n"
                "## Architecture\n\n"
                "The loader reads the project configuration."
            )
        },
    )
    assert "The loader reads" in cleaned
    assert cites[0]["sourcePath"] == "docs/architecture.md"
    assert "docs/architecture.md" in cites[0]["location"]
    assert cites[0]["sourceUrl"].endswith("/blob/abc123/docs/architecture.md#L1")


def test_parse_citations_adds_equation_anchor() -> None:
    _, cites = _parse_citations(
        r"[[cite]]L = \mathbb{E}[D_{\mathrm{KL}}(P\|Q)]\tag{3}[[/cite]]",
        {
            "original_markdown": (
                "## Method\n\n"
                r"$$ L = \mathbb{E}[D_{\mathrm{KL}}(P\|Q)]\tag{3} $$"
            )
        },
    )
    assert cites[0]["anchorId"] == "radar-equation-3"
    assert "公式 (3)" in cites[0]["location"]


def test_sse_frame_emits_event_and_data_lines() -> None:
    payload = b"event: start\ndata: {\"ok\": true}\n\n"
    assert _sse_frame("start", '{"ok": true}') == payload


def test_sse_frame_preserves_unicode() -> None:
    frame = _sse_frame("delta", '"中文片段"')
    assert frame.decode("utf-8") == 'event: delta\ndata: "中文片段"\n\n'


def test_zread_context_preserves_page_boundaries() -> None:
    context = _zread_context(
        {
            "zread": {
                "pages": [
                    {"title": "Overview", "content": "first page"},
                    {"path": "2-layout.md", "content": "second page"},
                    {"title": "empty", "content": "  "},
                ]
            }
        }
    )
    assert context is not None
    assert "## Overview\n\nfirst page" in context
    assert "## 2-layout.md\n\nsecond page" in context
    assert "\n\n---\n\n" in context


def test_zread_context_returns_none_without_pages() -> None:
    assert _zread_context({"zread": {"pages": []}}) is None
