"""Deterministic normalization for fetched article Markdown."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

_CONTROL_CHARS = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
_FENCE_LINE = re.compile(r"^\s{0,3}```")
_LOW_QUALITY_MARKERS = (
    "just a moment",
    "enable javascript and cookies",
    "challenge-platform",
    "verify you are human",
    "checking your browser",
    "attention required! | cloudflare",
    "performance & security by cloudflare",
    "cf-chl-",
    "access denied",
)
_PIPE_ROW = re.compile(r"^\s*\|(?:[^|\n]*\|){2,}\s*$")
_TABLE_SEPARATOR_ROW = re.compile(r"^\s*\|(?:\s*:?-{3,}:?\s*\|){2,}\s*$")
_HEADING_TABLE_ROW = re.compile(r"^(#{1,6}\s+[^|\n]+)(\|(?:[^|\n]*\|){2,})\s*$")


@dataclass(frozen=True, slots=True)
class MarkdownQuality:
    character_count: int
    paragraph_count: int
    heading_count: int
    link_count: int
    quality: str
    warnings: tuple[str, ...]


def normalize_markdown(content: str) -> str:
    """Normalize Markdown without changing its authored meaning."""
    source = content.replace("\r\n", "\n").replace("\r", "\n")
    source = source.replace("\ufeff", "").replace("\u00a0", " ")
    source = _CONTROL_CHARS.sub("", source)

    lines: list[str] = []
    for raw_line in source.split("\n"):
        line = raw_line.rstrip()
        joined_heading = _HEADING_TABLE_ROW.match(line)
        if joined_heading:
            lines.extend([joined_heading.group(1).rstrip(), "", joined_heading.group(2).strip()])
        else:
            lines.append(line)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()

    normalized: list[str] = []
    blank_count = 0
    for line in lines:
        if line.strip():
            blank_count = 0
            normalized.append(line)
        else:
            blank_count += 1
            if blank_count <= 1:
                normalized.append("")

    repaired: list[str] = []
    for index, line in enumerate(normalized):
        repaired.append(line)
        previous_line = normalized[index - 1] if index > 0 else ""
        next_line = normalized[index + 1] if index + 1 < len(normalized) else ""
        if (
            not _PIPE_ROW.match(previous_line)
            and _PIPE_ROW.match(line)
            and _PIPE_ROW.match(next_line)
            and not _TABLE_SEPARATOR_ROW.match(next_line)
        ):
            column_count = len(line.split("|")[1:-1])
            repaired.append("| " + " | ".join(["---"] * column_count) + " |")

    result = "\n".join(repaired).strip()
    if not result:
        return ""
    if sum(1 for line in result.splitlines() if _FENCE_LINE.match(line)) % 2:
        result = f"{result}\n```"
    return result


def markdown_sha256(content: str) -> str:
    return hashlib.sha256(normalize_markdown(content).encode("utf-8")).hexdigest()


def inspect_markdown(content: str, *, minimum_chars: int = 200) -> MarkdownQuality:
    normalized = normalize_markdown(content)
    lowered = normalized.casefold()
    warnings: list[str] = []
    if not normalized:
        warnings.append("EMPTY")
    if len(normalized) < minimum_chars:
        warnings.append("TOO_SHORT")
    if any(marker in lowered for marker in _LOW_QUALITY_MARKERS):
        warnings.append("BOT_OR_BLOCK_PAGE")

    paragraphs = [part for part in re.split(r"\n{2,}", normalized) if part.strip()]
    headings = re.findall(r"(?m)^\s{0,3}#{1,6}\s+\S+", normalized)
    links = re.findall(r"(?<!\!)\[[^\]]+\]\((?:[^)\\]|\\.)+\)", normalized)
    return MarkdownQuality(
        character_count=len(normalized),
        paragraph_count=len(paragraphs),
        heading_count=len(headings),
        link_count=len(links),
        quality="low" if warnings else "usable",
        warnings=tuple(warnings),
    )


__all__ = ["MarkdownQuality", "inspect_markdown", "markdown_sha256", "normalize_markdown"]
