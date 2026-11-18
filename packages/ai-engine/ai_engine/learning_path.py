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


_BIBLIOGRAPHY = re.compile(r"^##\s*(参考文献|参考资料|References)\s*$", re.MULTILINE | re.IGNORECASE)


def strip_bibliography(text: str) -> str:
    """Remove a trailing bibliography; every claim already carries [S#]."""
    match = _BIBLIOGRAPHY.search(text)
    if match is None:
        return text
    return text[: match.start()].rstrip()


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


_ANSWER_LABELS = ("- 是什么：", "- 什么时候用：", "- 什么时候不要用：")


def normalize_answer_lines(section: str) -> str:
    """Remove writer artefacts from the three opening bullets.

    A rewritten bullet occasionally starts with "实际情况：**" because the
    model copied the misconception template into the opening. That reads as a
    broken sentence, so peel the template prefixes until the claim starts.
    """
    out = []
    for line in section.splitlines():
        if not line.startswith(_ANSWER_LABELS):
            out.append(line)
            continue
        label, _, claim = line.partition("：")
        previous = None
        while claim != previous:
            previous = claim
            claim = re.sub(r"^[\s*_`]+", "", claim)
            claim = re.sub(r"^实际情况[:：]\s*", "", claim)
            claim = re.sub(r"^误区[:：]\s*", "", claim)
            claim = re.sub(r"^[\s*_`]+", "", claim)
        out.append(f"{label}：{claim.strip()}")
    return "\n".join(out)


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
    kept = normalize_answer_lines(kept)
    parts[2] = f"\n\n{kept}\n{rest}" if rest else f"\n\n{kept}\n"
    return "".join(parts)


_GAP_MARKERS = ("未确认", "证据缺口", "暂无", "无直接证据")
_COUNTEREXAMPLE = re.compile(r"不要|不应|不适合|不宜|避免|反例|失败|禁用|不建议|无原因|根治|全库|全量|并不|不会|不能|仅|只需|不必")

# A misconception line that only contrasts behaviour is weaker than one that
# names a prohibited action. Score the second group higher so the opening
# bullet gets the actionable prohibition, not a general trade-off.
_STRONG_COUNTEREXAMPLE = re.compile(r"不要|不应|不适合|不宜|避免|禁用|不建议|并不|不会|不能")

# A usable "when not to use" either forbids an action or marks a case as
# unsuitable. "学习 X 前应先理解 Y" is a prerequisite, not a boundary.
_PROHIBITION = re.compile(r"不要|不应|不适合|不宜|避免|禁用|不建议|不能|无法|仅适合|只适合")


def reconcile_answer_shape(text: str) -> str:
    """Use a cited counterexample from the body to fill a gap in the opening.

    Writers often explain when *not* to use something in 常见误区 and still
    leave the opening bullet at "本轮未确认". The evidence is already in the
    document, only in a later section. When that happens, move the cited
    sentence up instead of asking the reader to reconcile two contradictory
    statements.
    """
    parts = re.split(r"^(##[ \t]+90 秒回答)[ \t]*$", text, flags=re.MULTILINE)
    if len(parts) < 3:
        return text
    body = parts[2]
    end = body.find("\n## ")
    section, rest = (body, "") if end == -1 else (body[:end], body[end:])
    lines = section.splitlines()
    # The third bullet is only correct when it bounds use. Writers sometimes
    # fill it with a prerequisite ("learn MVCC first"), which reads as an
    # answer but actually says nothing about abstaining. Treat both a gap and
    # a non-prohibition as "needs evidence".
    gap_index = next(
        (
            index
            for index, line in enumerate(lines)
            if line.startswith("- 什么时候不要用：")
            and (
                any(marker in line for marker in _GAP_MARKERS)
                or not _PROHIBITION.search(line.split("：", 1)[-1])
            )
        ),
        None,
    )
    if gap_index is None or not rest:
        return text
    source = ""
    prohibited = re.compile(r"不要|不应|不适合|不宜|避免|禁用|不建议")
    # Only the misconception section answers "when not to use it"; scanning
    # the whole body picks up prerequisites ("learn X before VACUUM"), which
    # is about ordering, not about abstaining.
    sections = rest.split("## 常见误区", 1)
    if len(sections) != 2:
        return text
    for line in sections[1].splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("|") or stripped.startswith("```"):
            continue
        if "[S" in stripped and prohibited.search(stripped):
            source = stripped.lstrip("-*· ").strip()
            break
    if not source:
        # Fall back to an uncited misconception only when it names a concrete
        # prohibition; otherwise the opening would lift a neutral comparison.
        best = 0
        for line in sections[1].splitlines():
            if "→" not in line or "|" in line:
                continue
            score = len(_STRONG_COUNTEREXAMPLE.findall(line)) * 2 + len(
                _COUNTEREXAMPLE.findall(line)
            )
            if score > best:
                source = line.strip().lstrip("-*· ").strip()
                best = score
    if not source:
        lines[gap_index] = "- 什么时候不要用：本轮未确认（证据缺口）。"
        parts[2] = "\n".join(lines) + ("\n\n" + rest.lstrip("\n") if rest else "\n")
        return "".join(parts)
    claim = re.sub(r"^(误区|反例|注意)[:：]\s*", "", source)
    if "→" in claim:
        claim = claim.split("→", 1)[1]
    claim = re.sub(r"^[\s*_`]+", "", claim)
    claim = re.sub(r"^\s*实际情况[:：]\s*", "", claim)
    claim = re.sub(r"^[\s*_`]+", "", claim)
    if "→" in claim:
        # "误区 → 实际情况：错误说法 → 正确说法" leaves the misconception in
        # front. The sentence after the last arrow is the actual claim.
        claim = claim.rsplit("→", 1)[1]
    claim = re.sub(r"^[\s\-*·]+", "", claim)
    if len(claim) > 140:
        boundary = max(claim.rfind("，", 0, 120), claim.rfind("；", 0, 120))
        claim = claim[: boundary + 1] if boundary > 60 else claim[:140]
        claim = claim.rstrip("，；") + "。"
    lines[gap_index] = f"- 什么时候不要用：{claim}"
    parts[2] = "\n".join(lines) + ("\n\n" + rest.lstrip("\n") if rest else "\n")
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
    text = strip_bibliography(strip_budget_notes(normalize_learning_headings(text)))
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
    return reconcile_answer_shape(enforce_answer_shape(bounded))
