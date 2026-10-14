"""Deterministic normalization for fetched article Markdown."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

_CONTROL_CHARS = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
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


_FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def _fence_closes(line: str, char: str, length: int) -> bool:
    match = re.match(r"^ {0,3}(`{3,}|~{3,})[ \t]*$", line)
    if match is None:
        return False
    return match.group(1)[0] == char and len(match.group(1)) >= length


def _mark_fenced(lines: list[str]) -> tuple[list[bool], tuple[str, int] | None]:
    """Flag lines that belong to a fenced code block (fences included).

    A closing fence must use the same character as the opener and be at least as
    long, so a ``` line inside a ~~~ block is plain code content. Returns the
    flags plus the still-open (char, length) when the document ends in a fence.
    """
    flags: list[bool] = []
    open_fence: tuple[str, int] | None = None
    for line in lines:
        if open_fence is None:
            match = _FENCE_OPEN.match(line)
            if match and not (match.group(1)[0] == "`" and "`" in match.group(2)):
                open_fence = (match.group(1)[0], len(match.group(1)))
                flags.append(True)
            else:
                flags.append(False)
        else:
            flags.append(True)
            if _fence_closes(line, *open_fence):
                open_fence = None
    return flags, open_fence


def normalize_markdown(content: str) -> str:
    """Normalize Markdown without changing its authored meaning.

    Fenced code blocks (``` and ~~~) are preserved byte-for-byte.
    """
    source = content.replace("\r\n", "\n").replace("\r", "\n")

    raw_lines = source.split("\n")
    fenced, open_fence = _mark_fenced(raw_lines)

    lines: list[tuple[str, bool]] = []
    for raw_line, is_code in zip(raw_lines, fenced, strict=True):
        if is_code:
            lines.append((raw_line, True))
            continue
        line = raw_line.replace("\ufeff", "").replace("\u00a0", " ")
        line = _CONTROL_CHARS.sub("", line).rstrip()
        joined_heading = _HEADING_TABLE_ROW.match(line)
        if joined_heading:
            lines.extend([
                (joined_heading.group(1).rstrip(), False),
                ("", False),
                (joined_heading.group(2).strip(), False),
            ])
        else:
            lines.append((line, False))
    while lines and not lines[0][1] and not lines[0][0].strip():
        lines.pop(0)
    while lines and not lines[-1][1] and not lines[-1][0].strip():
        lines.pop()

    normalized: list[tuple[str, bool]] = []
    blank_count = 0
    for line, is_code in lines:
        if is_code or line.strip():
            blank_count = 0
            normalized.append((line, is_code))
        else:
            blank_count += 1
            if blank_count <= 1:
                normalized.append(("", False))

    def _plain(index: int) -> str:
        if 0 <= index < len(normalized) and not normalized[index][1]:
            return normalized[index][0]
        return ""

    repaired: list[str] = []
    for index, (line, is_code) in enumerate(normalized):
        repaired.append(line)
        if is_code:
            continue
        previous_line = _plain(index - 1)
        next_line = _plain(index + 1)
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
    if open_fence is not None:
        char, length = open_fence
        result = f"{result}\n{char * length}"
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
