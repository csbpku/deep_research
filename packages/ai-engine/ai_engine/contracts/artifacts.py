"""Python mirror of the shared research artifact contract."""

from __future__ import annotations

import re
from typing import Literal, TypedDict

ArtifactType = Literal["markdown", "slides", "table", "chart"]
ArtifactMimeType = Literal["text/markdown", "application/json"]

DEFAULT_SLIDE_LIMIT = 8
MIN_SLIDE_LIMIT = 3
MAX_SLIDE_LIMIT = 12


class ArtifactSourceRef(TypedDict, total=False):
    type: Literal["url", "summary", "research", "favorite"]
    value: str
    title: str | None


class ResearchArtifact(TypedDict):
    type: ArtifactType
    title: str
    version: int
    mimeType: ArtifactMimeType
    content: str | None
    payload: object | None
    sourceRefs: list[ArtifactSourceRef]
    sourceHash: str | None
    draftResearchId: str | None


def extract_slide_limit(text: str, fallback: int = DEFAULT_SLIDE_LIMIT) -> int:
    """Read a user-declared slide/page limit and clamp it to a usable range."""
    patterns = (
        r"(?:不超过|以内|最多|至多)\s*(\d+)\s*(?:页|张)?",
        r"(\d+)\s*(?:页|张)\s*(?:以内|上限)",
        r"(?:max(?:imum)?|up\s+to)\s*(\d+)\s*(?:slides?|pages?)",
    )
    value: int | None = None
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            value = int(match.group(1))
            break
    if value is None:
        return fallback
    return min(MAX_SLIDE_LIMIT, max(MIN_SLIDE_LIMIT, value))


def _split_markdown_sections(source: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"(?m)^#{1,3}\s+([^\n]+?)\s*#*\s*$", source))
    if not matches:
        return [("研究问题", source.strip())]
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        sections.append((match.group(1).strip(), source[match.end():end].strip()))
    return sections


def _clean_slide_heading(value: str) -> str:
    return re.sub(r"^(?:Slide|幻灯片)\s*\d*\s*[:：-]?\s*", "", value, flags=re.IGNORECASE).strip()


def _group_sections(sections: list[tuple[str, str]], limit: int) -> list[list[tuple[str, str]]]:
    group_count = min(limit, len(sections))
    base_size, remainder = divmod(len(sections), group_count)
    groups: list[list[tuple[str, str]]] = []
    cursor = 0
    for index in range(group_count):
        size = base_size + (1 if index < remainder else 0)
        groups.append(sections[cursor:cursor + size])
        cursor += size
    return groups


def render_artifact_content(content: str, artifact_type: ArtifactType, title: str) -> str:
    """Render a supported artifact into its persisted text representation."""
    if artifact_type != "slides":
        return content
    source = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    safe_title = title.strip() or "AI 调研"
    if not source:
        return f"## Slide 1: {safe_title}"

    slide_limit = extract_slide_limit(f"{safe_title}\n{source}")
    marker_count = len(re.findall(r"(?m)^#{1,2}\s+Slide\s+\d+\s*:", source))
    if re.match(r"(?im)^#{1,2}\s+Slide\s+1\s*:", source) and marker_count <= slide_limit:
        return source

    slides: list[str] = []
    for index, group in enumerate(_group_sections(_split_markdown_sections(source), slide_limit), start=1):
        label = _clean_slide_heading(group[0][0]) or ("研究问题" if index == 1 else f"重点 {index}")
        body_parts: list[str] = []
        for section_index, (heading, body) in enumerate(group):
            if body:
                body_parts.append(body if len(group) == 1 or section_index == 0 else f"### {_clean_slide_heading(heading)}\n\n{body}")
        if index == 1 and safe_title != label and not any(safe_title in part for part in body_parts):
            body_parts.insert(0, f"主题：{safe_title}")
        body = "\n\n".join(body_parts) or "本页暂无正文。"
        slides.append(f"## Slide {index}: {label}\n\n{body}")
    return "\n\n".join(slides)


__all__ = [
    "ArtifactMimeType",
    "ArtifactSourceRef",
    "ArtifactType",
    "ResearchArtifact",
    "render_artifact_content",
]
