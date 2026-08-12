"""Python mirror of the shared research artifact contract."""

from __future__ import annotations

import re
from typing import Literal, TypedDict

ArtifactType = Literal["markdown", "slides", "table", "chart"]
ArtifactMimeType = Literal["text/markdown", "application/json"]


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


def render_artifact_content(content: str, artifact_type: ArtifactType, title: str) -> str:
    """Render a supported artifact into its persisted text representation."""
    if artifact_type != "slides":
        return content
    source = content.replace("\r\n", "\n").strip()
    if not source:
        return f"# {title.strip() or 'AI 调研'}"
    sections = [
        section.strip()
        for section in re.split(r"(?m)(?=^#{1,3}\s+\S)", source)
        if section.strip()
    ] or [source]
    slides = [f"# {title.strip() or 'AI 调研'}\n\n{sections[0]}"]
    for index, section in enumerate(sections[1:8], 2):
        heading = re.match(r"^#{1,3}\s+([^\n]+)", section)
        label = heading.group(1).strip() if heading else f"重点 {index}"
        body = section[heading.end():].strip() if heading else section
        slides.append(f"## Slide {index}: {label}\n\n{body}")
    if len(sections) > 8:
        slides.append(f"## Slide {len(slides) + 1}: 其他证据\n\n" + "\n\n".join(sections[8:]))
    return "\n\n".join(slides)


__all__ = [
    "ArtifactMimeType",
    "ArtifactSourceRef",
    "ArtifactType",
    "ResearchArtifact",
    "render_artifact_content",
]
