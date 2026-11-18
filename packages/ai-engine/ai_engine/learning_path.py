"""Bound a learning artifact to a path, not a compressed long report."""

from __future__ import annotations

import re

TARGET_CHARS = 2_400
MAX_CHARS = 3_200

# Caps keep every section present when the writer overshoots. A section is cut
# at a paragraph/newline boundary so the result never ends mid-sentence.
SECTION_CAPS = {
    "90 秒回答": 360,
    "概念图": 450,
    "分层解释": 850,
    "可运行示例": 550,
    "常见误区": 380,
    "自检": 300,
}

HEADINGS = tuple(SECTION_CAPS)


def normalize_learning_headings(text: str) -> str:
    """Separate a heading glued to the first line of its body.

    Writers occasionally emit ``## 概念图| 核心概念 | ...`` because the table is
    the next token in their buffer. Without the newline the heading is not a
    heading, the table is invisible to the parser, and the budget pass truncates
    the section as prose.
    """
    return re.sub(
        r"^(##\s+[^\n|]+?)\s*(\|)",
        r"\1\n\n\2",
        text,
        flags=re.MULTILINE,
    )


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


_BUDGET_NOTE = re.compile(
    r"\n*（这一节已压缩到字数上限[^）]*）\n*",
)


def strip_budget_notes(text: str) -> str:
    """Remove truncation notes left by older budget passes.

    The note was an apology for cutting a section; it made finished artifacts
    look broken. New writers no longer emit it, and re-running the budget on an
    old draft must clean it up rather than preserve it.
    """
    return _BUDGET_NOTE.sub("\n\n", text).strip() + "\n"


def _trim_section(content: str, cap: int) -> str:
    """Drop whole paragraphs instead of leaving a truncation scar.

    A learning path is read as a finished artifact. An inline note such as
    "this section was cut at the word limit" tells the reader the document is
    broken; it also consumes the space the note is apologising for. Remove
    trailing paragraphs until the section fits, and only cut inside a paragraph
    when a single paragraph is itself over budget - then stop on a sentence
    boundary.
    """
    if len(content) <= cap:
        return content
    paragraphs = re.split(r"(\n\s*\n)", content)
    # Drop from the end, preserving the separators between kept paragraphs.
    while paragraphs and len("".join(paragraphs)) > cap:
        paragraphs.pop()
        if paragraphs and paragraphs[-1].strip() == "":
            paragraphs.pop()
    kept = "".join(paragraphs).rstrip()
    if kept:
        return kept + "\n"
    cut = content[:cap]
    boundary = max(cut.rfind("。"), cut.rfind("！"), cut.rfind("？"), cut.rfind("\n"))
    if boundary > cap // 2:
        cut = cut[: boundary + 1]
    return cut.rstrip() + "\n"


def enforce_answer_shape(text: str) -> str:
    """Keep the opening answer to its three promised sentences.

    The 90-second section is the first thing a reader sees. When the writer
    turns it into four paragraphs of mechanism, the page opens with prose the
    reader did not ask for and pushes the actual answer below the fold. Trim it
    back to at most three sentences, never inventing one that is missing.
    """
    parts = re.split(r"^(##[ \t]+90 秒回答)[ \t]*$", text, flags=re.MULTILINE)
    if len(parts) < 3:
        return text
    body = parts[2]
    end = body.find("\n## ")
    section, rest = (body, "") if end == -1 else (body[:end], body[end:])
    bullets = [line.strip() for line in section.splitlines() if line.strip().startswith("-")]
    if bullets:
        kept = "\n".join(bullets[:3])
        for label in ("- 是什么：", "- 什么时候用：", "- 什么时候不要用："):
            if not any(line.startswith(label) for line in bullets):
                kept += f"\n{label}本轮未确认（证据缺口）。"
    else:
        sentences = re.findall(r"[^。！？!?]+[。！？!?]?", section)
        kept = "".join(sentences[:3]).strip()
    if not kept:
        return text
    parts[2] = f"\n\n{kept}\n{rest}" if rest else f"\n\n{kept}\n"
    return "".join(parts)


def _trim_concept_map(content: str) -> str:
    """Never cut a concept table by character count: that leaves 2 concepts."""
    lines = content.splitlines()
    table = [line for line in lines if line.strip().startswith("|")]
    if len(table) < 4:
        return _trim_section(content, SECTION_CAPS["概念图"])
    kept = table[:8]  # header + separator + up to 6 concepts
    rest = [line for line in lines if not line.strip().startswith("|")]
    prefix = "\n\n" if content.startswith("\n") else ""
    return prefix + "\n".join(kept + ([""] + rest if rest else [])) + "\n"


def enforce_learning_budget(text: str) -> str:
    """Trim overlong sections, keeping the six-section order and all headings."""
    text = strip_budget_notes(normalize_learning_headings(text))
    if not is_valid_learning_path(text):
        return text
    text = enforce_answer_shape(text)
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
