from __future__ import annotations

from ai_engine.radar.ai_keyword_filter import is_ai_related


def test_mixed_language_keywords_are_detected_without_unicode_word_boundaries() -> None:
    assert is_ai_related("量子位人工智能2026")
    assert is_ai_related("OpenAI是某平台")
    assert is_ai_related("全面AI化了")


def test_short_ascii_keywords_still_have_ascii_boundaries() -> None:
    assert not is_ai_related("detail available retail")
    assert is_ai_related("an AI system")
    assert is_ai_related("a RAG pipeline")


def test_punctuation_and_cjk_spacing_are_supported() -> None:
    assert is_ai_related("A.I. tools for research")
    assert is_ai_related("大模型应用")
    assert is_ai_related("向量数据库检索")
