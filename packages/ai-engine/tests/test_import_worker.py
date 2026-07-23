from __future__ import annotations

import os
from pathlib import Path

import pytest

from ai_engine.import_worker import (
    _safe_temp_path,
    cleanup_stale_import_files,
    convert_to_markdown,
)


def test_markdown_and_text_are_deterministic() -> None:
    markdown, warnings = convert_to_markdown("# Title\n\nBody", ".md")
    assert markdown == "# Title\n\nBody"
    assert warnings == []

    text, warnings = convert_to_markdown("Plain text\n", ".txt")
    assert text == "Plain text"
    assert warnings == []


def test_html_conversion_preserves_structure_and_removes_active_content() -> None:
    markdown, warnings = convert_to_markdown(
        """
        <h1>Title</h1>
        <p onclick=\"steal()\">Hello <strong>world</strong>.</p>
        <script>prompt('secret')</script>
        <ul><li>One</li><li>Two</li></ul>
        <a href=\"javascript:alert(1)\">unsafe link</a>
        <pre><code>print('ok')</code></pre>
        """,
        ".html",
    )

    assert "# Title" in markdown
    assert "**world**" in markdown
    assert "- One" in markdown
    assert "prompt('secret')" not in markdown
    assert "javascript:" not in markdown
    assert "```" in markdown
    assert any("unsafe <script>" in warning for warning in warnings)
    assert any("event handler" in warning for warning in warnings)
    assert any("unsafe link" in warning for warning in warnings)


def test_html_with_only_unsafe_content_is_rejected() -> None:
    with pytest.raises(ValueError, match="no importable text"):
        convert_to_markdown("<script>alert(1)</script>", ".html")


def test_temp_object_key_cannot_escape_root(tmp_path: Path) -> None:
    safe = _safe_temp_path("abc.md", tmp_path)
    assert safe == tmp_path / "abc.md"
    with pytest.raises(ValueError, match="invalid temp object key"):
        _safe_temp_path("../secret.md", tmp_path)


async def test_cleanup_stale_import_files(tmp_path: Path) -> None:
    stale = tmp_path / "stale.md"
    protected = tmp_path / "protected.md"
    fresh = tmp_path / "fresh.md"
    stale.write_text("old")
    protected.write_text("active")
    fresh.write_text("new")
    os.utime(stale, (1, 1))
    os.utime(protected, (1, 1))

    assert await cleanup_stale_import_files(
        tmp_path, max_age_seconds=60, protected_keys={protected.name}
    ) == 1
    assert not stale.exists()
    assert protected.exists()
    assert fresh.exists()
