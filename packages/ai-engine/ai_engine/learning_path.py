"""Bound a learning artifact to a path, not a compressed long report."""

from __future__ import annotations

import re

TARGET_CHARS = 2_400
MAX_CHARS = 3_200

# Caps keep every section present when the writer overshoots. A section is cut
# at a paragraph/newline boundary so the result never ends mid-sentence.
SECTION_CAPS = {
    "90 秒回答": 300,
    "概念图": 450,
    "分层解释": 850,
    "可运行示例": 550,
    "常见误区": 380,
    "自检": 300,
}

HEADINGS = tuple(SECTION_CAPS)


def learning_headings(text: str) -> list[str]:
    return re.findall(r"^##\s+(.+?)\s*$", text, re.MULTILINE)


def is_valid_learning_path(text: str) -> bool:
    headings = [heading.strip() for heading in learning_headings(text)]
    positions = []
    for expected in HEADINGS:
        if expected not in headings:
            return False
        positions.append(headings.index(expected))
    return positions == sorted(positions)


def _trim_section(content: str, cap: int) -> str:
    if len(content) <= cap:
        return content
    cut = content[:cap]
    boundary = max(cut.rfind("\n\n"), cut.rfind("\n"))
    if boundary > cap // 2:
        cut = cut[:boundary]
    return cut.rstrip() + "\n\n（这一节已压缩到字数上限；完整依据见参考来源。）\n\n"


def _trim_concept_map(content: str) -> str:
    """Never cut a concept table by character count: that leaves 2 concepts."""
    lines = content.splitlines()
    table = [line for line in lines if line.strip().startswith("|")]
    if len(table) < 4:
        return _trim_section(content, SECTION_CAPS["概念图"])
    kept = table[:8]  # header + separator + up to 6 concepts
    rest = [line for line in lines if not line.strip().startswith("|")]
    return "\n".join(kept + ([""] + rest if rest else [])) + "\n"


def enforce_learning_budget(text: str) -> str:
    """Trim overlong sections, keeping the six-section order and all headings."""
    if not is_valid_learning_path(text):
        return text
    parts = re.split(r"^(##\s+.+)$", text, flags=re.MULTILINE)
    # parts: [intro, heading, body, heading, body, ...]
    out = [parts[0]]
    for index in range(1, len(parts), 2):
        heading = parts[index].strip().lstrip("#").strip()
        body = parts[index + 1] if index + 1 < len(parts) else ""
        cap = SECTION_CAPS.get(heading)
        out.append(parts[index])
        if heading == "概念图":
            out.append(_trim_concept_map(body))
        else:
            out.append(_trim_section(body, cap) if cap else body)
    bounded = "".join(out)
    # Per-section caps can still add up past the page budget. Trim the longest
    # explanatory section until the whole path fits, never dropping a heading.
    while len(bounded) > MAX_CHARS:
        chunks = re.split(r"^(##\s+.+)$", bounded, flags=re.MULTILINE)
        candidates = [
            (len(chunks[index + 1]), index)
            for index in range(1, len(chunks), 2)
            if chunks[index].strip().lstrip("#").strip() in {"分层解释", "可运行示例", "概念图", "常见误区"}
        ]
        if not candidates:
            break
        _, index = max(candidates)
        body = chunks[index + 1]
        keep = max(120, int(len(body) * 0.75))
        chunks[index + 1] = _trim_section(body, keep)
        bounded = "".join(chunks)
    return bounded
