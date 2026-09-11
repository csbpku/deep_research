"""Recall-safe AI keyword matching for mixed-language radar sources.

Python's ``\b`` is an ASCII/Unicode word-boundary concept. It does not form
boundaries between CJK text and ASCII terms, so a title such as
``OpenAI是某平台`` or ``量子位人工智能2026`` can be incorrectly rejected.
Short ASCII terms still need boundaries to avoid matching ``ai`` inside
``detail``; the boundary used here only treats ASCII letters and digits as
word characters, which is the useful rule for mixed Chinese/English text.
"""

from __future__ import annotations

import re

_AI_KEYWORD_EXPRESSIONS: tuple[str, ...] = (
    r"ai",
    r"a\.i\.",
    r"llm(?:s)?",
    r"ml",
    r"machine\s+learning",
    r"deep\s+learning",
    r"neural",
    r"transformer(?:s)?",
    r"language\s+model(?:s)?",
    r"foundation\s+model(?:s)?",
    r"rag",
    r"agent(?:s|ic)?",
    r"openai",
    r"anthropic",
    r"claude",
    r"chatgpt",
    r"gemini",
    r"xai",
    r"minimax",
    r"grok",
    r"deepseek",
    r"kimi",
    r"qwen",
    r"copilot",
    r"hugging\s*face",
    r"langchain",
    r"langgraph",
    r"llamaindex",
    r"vector\s+(?:db|database|store)",
    r"embedding(?:s)?",
    r"fine[-\s]+tune(?:d|ing)?",
    r"inference",
    r"prompt",
    r"rlhf",
    r"alignment",
    r"agentic",
    r"mcp",
    r"model\s+context\s+protocol",
    r"vibe\s+coding",
    r"人工智能",
    r"大模型",
    r"智能体",
    r"微调",
    r"向量(?:数据库|检索)",
)

def _compile_keyword(expression: str) -> re.Pattern[str]:
    # CJK terms are meaningful substrings in mixed text, including before a
    # year or model number (for example ``人工智能2026``). ASCII terms need
    # explicit ASCII-only boundaries to avoid matching ``ai`` in ``detail``.
    if re.search(r"[^\x00-\x7f]", expression):
        return re.compile(rf"(?:{expression})", re.IGNORECASE)
    return re.compile(
        rf"(?<![A-Za-z0-9])(?:{expression})(?![A-Za-z0-9])",
        re.IGNORECASE,
    )


_AI_KEYWORD_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    _compile_keyword(expression) for expression in _AI_KEYWORD_EXPRESSIONS
)


def is_ai_related(corpus: str) -> bool:
    """Return whether ``corpus`` contains an AI-related signal.

    The function deliberately remains a coarse source-side prefilter. It is
    not a quality gate; the downstream scorer remains responsible for ranking
    and noise decisions.
    """
    if not corpus:
        return False
    return any(pattern.search(corpus) for pattern in _AI_KEYWORD_PATTERNS)


__all__ = ["is_ai_related"]
