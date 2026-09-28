from __future__ import annotations

from ai_engine.text_chunking import count_text_tokens, split_text_by_token_budget


def test_split_text_is_lossless_and_prefers_markdown_boundaries() -> None:
    text = (
        "# Overview\n\n"
        + ("Introductory evidence about the problem and its context.\n" * 180)
        + "\n## Results\n\n"
        + ("Measured result and limitation are described here.\n" * 180)
    )

    chunks = split_text_by_token_budget(text, 240)

    assert len(chunks) > 2
    assert "".join(chunk.text for chunk in chunks) == text
    assert all(count_text_tokens(chunk.text) <= 240 for chunk in chunks)
    assert any("Overview" in chunk.section for chunk in chunks)
    assert any("Results" in chunk.section for chunk in chunks)
    assert all(left.end == right.start for left, right in zip(chunks, chunks[1:]))
