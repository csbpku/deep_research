"""Derive the three publish-gate summary fields from a finished report.

The editor requires background / conclusion / risks before an AI research
draft can be published.  Asking the author to re-summarise a 30k-character
report by hand is the main reason drafts never leave the library, so the
draft is pre-filled from sections the report already contains.  The author
still edits and confirms before publishing; nothing here is presented as a
verified fact.

Design rules:
- only use text that exists in the report;
- prefer an explicitly named section (背景/结论/风险…), otherwise fall back
  to the lead paragraph for background and the summary section for
  conclusions;
- never invent a risks section: an empty value stays empty.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

MAX_FIELD_CHARS = 1_200

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_CITE_BLOCK = re.compile(r"\[\[/?cite\]\]", re.IGNORECASE)
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|`)")
_HTML_TAG = re.compile(r"<[^>]+>")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_RULE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")

_BACKGROUND_KEYS = ("背景", "研究范围", "问题背景", "研究问题")
_CONCLUSION_KEYS = ("结论", "决策摘要", "取舍", "总结", "建议")
_RISK_KEYS = ("风险", "待验证", "未确认", "局限", "证据缺口", "限制")


def _clean_inline(text: str) -> str:
    text = _IMAGE.sub("", text)
    text = _LINK.sub(r"\1", text)
    text = _CITE_BLOCK.sub("", text)
    text = _HTML_TAG.sub("", text)
    text = _EMPHASIS.sub("", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def _split_sections(body: str) -> tuple[str, list[tuple[str, str]]]:
    """Return (lead, [(heading, text), ...]) for level-2/3 headings."""
    lead_lines: list[str] = []
    sections: list[tuple[str, str]] = []
    current_title: str | None = None
    current_lines: list[str] = []

    for raw in body.splitlines():
        line = raw.rstrip()
        match = _HEADING.match(line)
        if match and len(match.group(1)) >= 2:
            if current_title is not None:
                sections.append((current_title, "\n".join(current_lines)))
            current_title = match.group(2)
            current_lines = []
            continue
        if current_title is None:
            lead_lines.append(line)
        else:
            current_lines.append(line)

    if current_title is not None:
        sections.append((current_title, "\n".join(current_lines)))
    return "\n".join(lead_lines), sections


def _paragraphs(text: str) -> list[str]:
    kept: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or _RULE.match(line) or _TABLE_ROW.match(line):
            continue
        if line.startswith(("- ", "* ", "> ")):
            line = line[2:].strip()
        cleaned = _clean_inline(line)
        if cleaned:
            kept.append(cleaned)
    return kept


def _truncate(text: str, limit: int = MAX_FIELD_CHARS) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for separator in ("。", "；", "！", "？", ". ", "; "):
        index = cut.rfind(separator)
        if index >= int(limit * 0.6):
            return cut[: index + len(separator)].strip()
    return cut.rstrip() + "…"


def _find_section(
    sections: list[tuple[str, str]],
    keys: tuple[str, ...],
    prefer: tuple[str, ...] = (),
) -> str | None:
    matches = [(title, text) for title, text in sections if any(key in title for key in keys)]
    if prefer:
        matches.sort(key=lambda item: 0 if any(word in item[0] for word in prefer) else 1)
    for title, text in matches:
        joined = " ".join(_paragraphs(text))
        if joined:
            return joined
    return None


def derive_research_summary(body: str) -> dict[str, str]:
    """Return background/conclusion/risks suggestions, possibly empty."""
    body = body.strip()
    if not body:
        return {"background": "", "conclusion": "", "risks": ""}

    lead, sections = _split_sections(body)
    lead_paragraphs = _paragraphs(lead)

    background = _find_section(sections, _BACKGROUND_KEYS, prefer=("背景",))
    if not background and lead_paragraphs:
        background = " ".join(lead_paragraphs[:2])

    conclusion = _find_section(
        sections,
        _CONCLUSION_KEYS,
        prefer=("结论", "取舍"),
    )
    if not conclusion:
        # A report may open with a "decision summary" before any heading.
        conclusion = " ".join(lead_paragraphs[:2]) if lead_paragraphs else ""

    risks = _find_section(sections, _RISK_KEYS, prefer=("风险", "待验证", "未确认")) or ""

    return {
        "background": _truncate(background or ""),
        "conclusion": _truncate(conclusion or ""),
        "risks": _truncate(risks),
    }


def missing_summary_updates(
    current: Mapping[str, str | None],
    body: str,
) -> dict[str, str]:
    """Return only the derived fields that are still empty on the draft.

    Existing author text always wins; a backfill must never overwrite it.
    """
    derived = derive_research_summary(body)
    return {
        field: value
        for field, value in derived.items()
        if value and not (current.get(field) or "").strip()
    }
