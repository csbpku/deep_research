from __future__ import annotations

import base64
from urllib.parse import quote

import pytest

from ai_engine.llm.input_text import model_readable_text
from ai_engine.text_chunking import split_text_by_token_budget


def svg_data(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


def test_image_bytes_are_removed_before_chunking_and_svg_evidence_is_preserved() -> None:
    svg = '<svg><style>hidden css</style><script>untrusted script</script><text>Accuracy 95%</text>'
    svg += '<foreignObject><div>n = 42</div></foreignObject><path d="' + "M0 0 " * 20000 + '"/></svg>'
    original = f"# Results\n\nBefore evidence.\n\n![Comparison]({svg_data(svg)}#A1.F12)\n\nCaption.\n\nEnd evidence."

    cleaned = model_readable_text(original)

    assert "data:image" not in cleaned
    assert all(part in cleaned for part in ("Before evidence.", "End evidence.", "Caption.", "Comparison"))
    assert "Accuracy 95%" in cleaned and "n = 42" in cleaned
    assert "hidden css" not in cleaned and "untrusted script" not in cleaned
    assert len(split_text_by_token_budget(original, 6000)) > 5
    assert len(split_text_by_token_budget(cleaned, 6000)) == 1
    # Model input preparation must not mutate the Markdown used by the reader.
    assert "data:image" in original


@pytest.mark.parametrize("uri", [
    "data:image/png;base64,AQID",
    "data:image/svg+xml;base64,broken===",
    "data:image/svg+xml;base64," + "a" * 3_000_000,
])
def test_unreadable_image_data_is_not_sent_as_text(uri: str) -> None:
    cleaned = model_readable_text(f"start ![useful caption]({uri}) end")
    assert cleaned.startswith("start ") and cleaned.endswith(" end")
    assert "useful caption" in cleaned
    assert "data:image" not in cleaned


def test_percent_encoded_svg_and_bare_data_uri() -> None:
    uri = "data:image/svg+xml," + quote("<svg><text>Median 12 ms</text></svg>", safe="")
    assert "Median 12 ms" in model_readable_text(uri)


def test_long_readable_svg_text_is_chunked_without_silent_truncation() -> None:
    uri = svg_data("<svg><text>" + "Measured evidence " * 500 + "TAIL_RESULT</text></svg>")
    clean = model_readable_text(uri)
    assert "TAIL_RESULT" in clean
    assert "data:image" not in clean


def test_prose_tables_and_external_image_links_are_unchanged() -> None:
    text = "# Source\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![chart](https://example.com/a.svg)"
    assert model_readable_text(text) == text
