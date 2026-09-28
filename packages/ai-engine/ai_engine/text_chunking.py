"""Token-budgeted, structure-aware splitting for transient LLM inputs."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TextChunk:
    index: int
    start: int
    end: int
    text: str
    section: str


def count_text_tokens(text: str) -> int:
    """Return a conservative, offline token estimate for mixed-language text."""
    total = 0
    for match in re.finditer(r"[A-Za-z0-9]+|[ \t\r\n]+|.", text, re.DOTALL):
        value = match.group()
        if value.isascii() and value.isalnum():
            total += (len(value) + 2) // 3
        elif value.isspace():
            total += max(1, value.count("\n"))
        elif value.isascii():
            total += 1
        else:
            total += 3 if unicodedata.category(value[0]).startswith("S") else 2
    return total


def split_text_by_token_budget(text: str, max_tokens: int) -> list[TextChunk]:
    """Split losslessly, preferring Markdown section and paragraph boundaries."""
    if not text:
        return []
    if max_tokens < 3:
        raise ValueError("max_tokens must be at least 3")
    if count_text_tokens(text) <= max_tokens:
        return [TextChunk(1, 0, len(text), text, _section_at(text, 0))]

    chunks: list[TextChunk] = []
    start = 0
    while start < len(text):
        remaining = len(text) - start
        size = min(remaining, max_tokens * 4)
        while count_text_tokens(text[start:start + size]) > max_tokens:
            token_count = count_text_tokens(text[start:start + size])
            next_size = max(1, int(size * max_tokens / token_count * 0.9))
            size = min(size - 1, next_size) if size > 1 else 1

        upper = start + size
        end = _preferred_boundary(text, start, upper)
        if count_text_tokens(text[start:end]) > max_tokens:
            end = upper
        if end <= start:
            end = upper

        chunks.append(TextChunk(
            index=len(chunks) + 1,
            start=start,
            end=end,
            text=text[start:end],
            section=_section_at(text, start),
        ))
        start = end

    return chunks


def _preferred_boundary(text: str, start: int, upper: int) -> int:
    if upper >= len(text):
        return len(text)
    floor = start + max(1, (upper - start) * 3 // 5)
    paragraph_boundaries = [
        match.end()
        for match in re.compile(r"\n[ \t]*\n+").finditer(text, floor, upper)
    ]
    if paragraph_boundaries:
        return paragraph_boundaries[-1]
    line_boundaries = [
        match.end()
        for match in re.compile(r"\n").finditer(text, floor, upper)
    ]
    return line_boundaries[-1] if line_boundaries else upper


def _section_at(text: str, offset: int) -> str:
    headings: list[tuple[int, str]] = []
    heading_re = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*#*\s*$")
    for match in heading_re.finditer(text[:offset]):
        level = len(match.group(1))
        title = match.group(2).strip()
        headings = [item for item in headings if item[0] < level]
        headings.append((level, title))
    next_heading = heading_re.match(text, offset)
    if next_heading is not None:
        level = len(next_heading.group(1))
        headings = [item for item in headings if item[0] < level]
        headings.append((level, next_heading.group(2).strip()))
    return " > ".join(title for _level, title in headings)
