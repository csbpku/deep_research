from ai_engine.markdown_pipeline import (
    inspect_markdown,
    markdown_sha256,
    normalize_markdown,
)


def test_normalize_markdown_is_stable_and_removes_transport_noise() -> None:
    source = "\ufeff# Title\r\n\r\n\r\nBody\u0000\r\n"
    assert normalize_markdown(source) == "# Title\n\nBody"
    assert normalize_markdown(normalize_markdown(source)) == "# Title\n\nBody"


def test_normalize_markdown_closes_unmatched_fence() -> None:
    assert normalize_markdown("```python\nprint('ok')").endswith("```")


def test_normalize_markdown_repairs_missing_table_separator() -> None:
    source = (
        "#### **Table 1**| **Model** | **Score** |\n"
        "| Falcon | 0.66 |\n"
        "| Chronos | 0.71 |"
    )
    assert normalize_markdown(source) == (
        "#### **Table 1**\n\n"
        "| **Model** | **Score** |\n"
        "| --- | --- |\n"
        "| Falcon | 0.66 |\n"
        "| Chronos | 0.71 |"
    )


def test_markdown_hash_uses_canonical_representation() -> None:
    assert markdown_sha256("a\r\n\r\nb\n") == markdown_sha256("a\n\nb")


def test_inspect_markdown_reports_structure_and_quality() -> None:
    result = inspect_markdown(
        "# Title\n\n"
        "A sufficiently long paragraph with a [source](https://example.com). "
        + (
            "This paragraph adds enough stable source context for the quality "
            "inspection fixture without introducing duplicate links. " * 8
        )
    )
    assert result.quality == "usable"
    assert result.heading_count == 1
    assert result.link_count == 1
    assert result.paragraph_count == 2


def test_inspect_markdown_rejects_bot_shells_and_short_content() -> None:
    result = inspect_markdown("Just a moment... Enable JavaScript and cookies to continue.")
    assert result.quality == "low"
    assert "BOT_OR_BLOCK_PAGE" in result.warnings
    assert "TOO_SHORT" in result.warnings
