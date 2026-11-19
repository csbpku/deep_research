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
    "可运行示例": 900,
    "常见误区": 380,
    "自检": 700,
}

HEADINGS = tuple(SECTION_CAPS)
_EMPTY_LAYER_GAP = "本轮未确认（这一层还没有足够证据展开）。"


_EXPECTATION = re.compile(r"预期(?:输出|结果)|expected output|should print", re.IGNORECASE)


def repair_truncated_example(text: str) -> str:
    """End an example on a complete statement, even when the writer cut it.

    The writer sometimes stops mid-query (``SELECT pid, datname,``) and closes
    the fence. The section fits the budget, so no trim runs, and the reader gets
    a script that fails at the prompt. Drop the incomplete tail and say so.
    """
    parts = re.split(r"^(##[ \t]+可运行示例)[ \t]*$", text, flags=re.MULTILINE)
    if len(parts) < 3:
        return text
    body = parts[2]
    end = body.find("\n## ")
    section, rest = (body, "") if end == -1 else (body[:end], body[end:])
    match = re.search(r"```([^\n]*)\n([\s\S]*?)```", section)
    if match is None or "sql" not in match.group(1).lower():
        return text
    code = match.group(2).rstrip()
    lines = [line for line in code.splitlines()]
    if not lines or lines[-1].strip().endswith(";") or lines[-1].strip().startswith("--"):
        return text
    boundary = None
    for index, line in enumerate(lines):
        if line.strip().endswith(";"):
            boundary = index
    if boundary is None:
        return text
    kept = "\n".join(lines[: boundary + 1]) + "\n-- 其余语句已省略（原示例在语句中间被截断）"
    section = section[: match.start(2)] + kept + "\n" + section[match.end(2):]
    parts[2] = section + rest
    return "".join(parts)


def ensure_example_expectation(text: str) -> str:
    """A runnable example must say what running it produces.

    The writer often supplies a long diagnostic script and stops at the closing
    fence. A reader can run it but cannot tell whether the result is healthy, so
    the "example" teaches nothing. If the section has no expectation, state the
    gap rather than inventing an output.
    """
    parts = re.split(r"^(##[ \t]+可运行示例)[ \t]*$", text, flags=re.MULTILINE)
    if len(parts) < 3:
        return text
    body = parts[2]
    end = body.find("\n## ")
    section, rest = (body, "") if end == -1 else (body[:end], body[end:])
    if "```" not in section or _EXPECTATION.search(section):
        return text
    fence_end = section.rfind("```")
    if fence_end == -1:
        return text
    insert_at = fence_end + 3
    expectation = "\n\n**预期输出：** 本轮未确认（尚未记录实际运行结果）。\n"
    parts[2] = section[:insert_at] + expectation + section[insert_at:] + rest
    return "".join(parts)


def normalize_learning_headings(text: str) -> str:
    """Separate a heading glued to the first line of its body.

    Writers occasionally emit ``## 概念图| 核心概念 | ...`` because the table is
    the next token in their buffer. Without the newline the heading is not a
    heading, the table is invisible to the parser, and the budget pass truncates
    the section as prose.
    """
    text = re.sub(
        r"^(##\s+[^\n|`]+?)\s*(\|)",
        r"\1\n\n\2",
        text,
        flags=re.MULTILINE,
    )
    # A fence glued to the heading ("## 可运行示例```bash") is not a heading
    # either; separate it so the section boundary survives.
    return re.sub(
        r"^(##\s+[^\n]+?)\s*(```)",
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


def balance_code_fences(text: str) -> str:
    """Close a fence the writer left open before the next heading.

    An unterminated ``` turns every following section into code, so the reader
    sees "## 常见误区" rendered as a literal line inside the example. Close the
    block at the next heading (and at EOF) rather than leaving the page broken.
    """
    lines = text.splitlines()
    out: list[str] = []
    in_fence = False
    for line in lines:
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence and line.startswith("## "):
            out.append("```")
            in_fence = False
        out.append(line)
    if in_fence:
        out.append("```")
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


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


def _cut_text(text: str, limit: int) -> str:
    """Cut prose on a sentence boundary without leaving a dangling half-line."""
    if len(text) <= limit:
        return text.rstrip()
    cut = text[:limit]
    boundary = max(cut.rfind("。"), cut.rfind("！"), cut.rfind("？"), cut.rfind("\n"))
    if boundary > limit // 2:
        cut = cut[: boundary + 1]
    return cut.rstrip()


def _trim_section(content: str, cap: int) -> str:
    """Fit a section into its cap without destroying its example.

    Dropping trailing paragraphs is right for prose, but a runnable example is
    a single fenced block: popping it leaves an empty section, and cutting
    inside it loses the closing fence and swallows the following headings.
    Keep the fence, trim the prose around it, and only shorten the code itself
    when the fence alone exceeds the cap.
    """
    if len(content) <= cap:
        return content
    lead = content[: len(content) - len(content.lstrip("\n"))]
    match = re.search(r"```[^\n]*\n[\s\S]*?```", content)
    if match is None:
        kept = _drop_trailing_paragraphs(content, cap)
        return lead + (kept if kept else _cut_text(content, cap) + "\n")
    fence = match.group(0)
    before = content[: match.start()].rstrip()
    if len(fence) + 8 >= cap:
        return lead + _cut_fence_at_statement(fence, cap)
    room = cap - len(fence) - 4
    kept_before = _cut_text(before, room) if before else ""
    return lead + (kept_before + "\n\n" if kept_before else "") + fence + "\n"


_SELF_CHECK_ITEM = re.compile(r"(?m)^(\d+)\.\s+")


_ANSWER_LINE = re.compile(r"(?m)^\s*(?:\*\*)?答案(?:要点)?[：:]")


def _trim_self_check(content: str, cap: int) -> str:
    """Keep three whole self-check items, each with an answer.

    Character trimming used to stop inside item 2, so the page shipped one
    usable question and one fragment. A question without an answer is just as
    misleading as a half question: replace it with a stated gap instead of
    presenting a quiz that cannot be answered.
    """
    starts = [match.start() for match in _SELF_CHECK_ITEM.finditer(content)]
    if not starts:
        return _trim_section(content, cap)
    lead = content[: starts[0]].rstrip()
    raw = [
        content[start:end].strip()
        for start, end in zip(starts, starts[1:] + [len(content)])
    ]
    items: list[str] = []
    for index in range(3):
        if index >= len(raw):
            items.append(f"{index + 1}. 本轮未确认（自检题未生成）。")
            continue
        item = raw[index]
        if not _ANSWER_LINE.search(item):
            items.append(f"{index + 1}. 本轮未确认（该题缺少答案要点，已省略）。")
        else:
            items.append(item)
    budget = max(80, (cap - len(lead)) // 3 - 8)
    trimmed = []
    for item in items:
        if len(item) > budget:
            cut = _cut_text(item, budget).rstrip()
            if not cut.endswith(("。", "？", "！")):
                cut += "。"
            item = cut
        trimmed.append(item)
    text = lead + "\n\n" + "\n\n".join(trimmed) + "\n"
    return text if len(text) <= cap else text[:cap].rstrip() + "\n"


def _trim_layered_section(content: str, cap: int) -> str:
    """Keep all three layers, shrinking each instead of deleting the tail.

    Dropping trailing paragraphs can leave ``### 第二层`` with no body at all:
    the heading survives the cut while its explanation does not, so the page
    claims a layered explanation but delivers one layer. Budget per layer and
    always keep at least one paragraph under each.
    """
    parts = re.split(r"(?m)^(###\s+.+)$", content)
    if len(parts) < 5:
        kept = _drop_trailing_paragraphs(content, cap)
        return kept if kept.strip() else _cut_text(content, cap) + "\n"
    layers = [(parts[i], parts[i + 1]) for i in range(1, len(parts), 2)]
    if len(content) <= cap and all(body.strip() for _, body in layers):
        return content
    budget = max(60, (cap - 24) // len(layers) - 8)
    rendered = []
    for heading, body in layers:
        text = body.strip()
        if not text:
            # A heading with no body is worse than a stated gap: the page
            # promises a layer and delivers nothing. Say so instead of
            # pretending the structure is complete.
            text = _EMPTY_LAYER_GAP
        elif len(text) > budget:
            text = _cut_text(text, budget).rstrip()
        rendered.append(f"{heading.strip()}\n\n{text}\n")
    text = "\n\n" + "\n".join(rendered)
    return text if len(text) <= cap else text[:cap].rstrip() + "\n"


def _cut_fence_at_statement(fence: str, cap: int) -> str:
    """Shorten a code block without leaving a half-written statement.

    A SQL example cut mid-query looks runnable but fails at the prompt. Keep the
    largest prefix that ends on a statement boundary and say what was elided.
    """
    lines = fence.splitlines()
    header, body = lines[0], lines[1:-1]
    room = max(1, cap - len(header) - 40)
    kept: list[str] = []
    used = 0
    for line in body:
        if used + len(line) + 1 > room:
            break
        kept.append(line)
        used += len(line) + 1
    # Back up to the last completed statement, unless nothing is complete yet.
    boundary = None
    for index, line in enumerate(kept):
        if line.strip().endswith(";"):
            boundary = index
    if boundary is not None:
        kept = kept[: boundary + 1] + ["-- 其余语句已省略"]
    elif kept:
        kept = kept + ["-- 示例因篇幅截断"]
    return f"{header}\n" + "\n".join(kept) + "\n```\n"


def _drop_trailing_paragraphs(content: str, cap: int) -> str:
    paragraphs = re.split(r"(\n\s*\n)", content)
    while paragraphs and len("".join(paragraphs)) > cap:
        paragraphs.pop()
        if paragraphs and paragraphs[-1].strip() == "":
            paragraphs.pop()
    kept = "".join(paragraphs).rstrip()
    return kept + "\n" if kept else ""


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
# A boundary answers "when should I not use it", so it needs a condition
# ("when X") or a direct prohibition ("do not do Y"). A bare limitation
# ("VACUUM does not return space to the OS") is a trade-off, not a boundary.
_BOUNDARY_CONDITION = re.compile(
    r"当|如果|若|一旦|在[^，。]{0,30}(?:时|情况下)|只在|"
    r"(?:阻止|阻塞|导致|造成)[^。；]{0,60}(?:无效|无法|不能|失败|回卷)"
)
_DIRECT_PROHIBITION = re.compile(r"不要|不应|不宜|避免|不建议|仅适合|只适合")
# A condition ("when X") is only a boundary when it leads to a negative
# outcome. "在表内容变化时更新统计" is normal operation, not an abstention.
_NEGATIVE_OUTCOME = re.compile(r"无效|无法|不能|失败|回卷|不要|不应|不宜|避免|不建议|仅适合|只适合")


def is_boundary_statement(claim: str) -> bool:
    text = re.sub(r"^\s*答案要点[:：]\s*", "", claim).strip()
    if not text or any(marker in text for marker in _GAP_MARKERS):
        return False
    if _DIRECT_PROHIBITION.search(text):
        return True
    return bool(_BOUNDARY_CONDITION.search(text) and _NEGATIVE_OUTCOME.search(text))


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
            and not is_boundary_statement(line.split("：", 1)[-1])
        ),
        None,
    )
    if gap_index is None or not rest:
        return text
    source = ""
    # Prefer a cited condition + negative outcome from anywhere in the body.
    source = _cited_boundary(rest) or ""
    prohibited = re.compile(r"不要|不应|不适合|不宜|避免|不建议")
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
        if stripped.startswith("- 什么时候不要用"):
            continue
        if "[S" in stripped and prohibited.search(stripped):
            source = stripped.lstrip("-*· ").strip()
            break
    if not source:
        # The evidence for a boundary is not always written as a misconception.
        # Release notes and troubleshooting docs often state it as "X blocks Y,
        # so tuning Z does not help" — a condition plus a negative outcome, with
        # no 不要 in sight. Scan cited body cells for that shape before giving up.
        source = _cited_boundary(rest) or ""
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
    citations = "".join(dict.fromkeys(re.findall(r"\[S\d+\]", source)))
    if len(claim) > 140:
        boundary = max(claim.rfind("，", 0, 120), claim.rfind("；", 0, 120))
        claim = claim[: boundary + 1] if boundary > 60 else claim[:140]
        claim = claim.rstrip("，；") + "。"
    if citations and citations not in claim:
        claim = f"{claim.rstrip('。')}。{citations}"
    lines[gap_index] = f"- 什么时候不要用：{claim}"
    parts[2] = "\n".join(lines) + ("\n\n" + rest.lstrip("\n") if rest else "\n")
    return "".join(parts)


def _cited_boundary(rest: str) -> str | None:
    """Find a cited sentence that bounds use, not just a cited trade-off."""
    for line in rest.splitlines():
        stripped = line.strip()
        if "[S" not in stripped or stripped.startswith("## 自检"):
            continue
        if stripped.startswith("- 什么时候不要用"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        citations = "".join(
            dict.fromkeys(re.findall(r"\[S\d+\]", stripped))
        )
        for cell in reversed(cells):
            cell = re.sub(r"\[S(\d+)\]\([^)]*\)", r"[S\1]", cell)
            for sentence in re.split(r"(?<=[。；])", cell):
                if is_boundary_statement(sentence):
                    sentence = sentence.strip()
                    if citations and citations not in sentence:
                        sentence = f"{sentence.rstrip('。')}。{citations}"
                    return sentence
    return None


_SOURCE_CLEAN = re.compile(r"\[([^\]]+)\]\([^)]*\)|[*_`>#]")


def fill_answer_boundary_from_sources(
    text: str, sources: list[tuple[int, str]]
) -> str:
    """Fill an unconfirmed boundary with a cited condition from the evidence.

    The writer often leaves "本轮未确认" even when a retrieved troubleshooting
    page states the exact abstention condition ("anything that blocks the xmin
    horizon makes cleanup impossible, no matter how hard you tune autovacuum").
    The condition is in the source snippet, not in the body, so body-only
    reconciliation cannot see it. Lift the cited sentence instead of inventing.
    """
    parts = re.split(r"^(##[ \t]+90 秒回答)[ \t]*$", text, flags=re.MULTILINE)
    if len(parts) < 3:
        return text
    body = parts[2]
    end = body.find("\n## ")
    section, rest = (body, "") if end == -1 else (body[:end], body[end:])
    lines = section.splitlines()
    gap_index = next(
        (
            index
            for index, line in enumerate(lines)
            if line.startswith("- 什么时候不要用：")
            and not is_boundary_statement(line.split("：", 1)[-1])
        ),
        None,
    )
    if gap_index is None:
        return text
    for number, snippet in sources:
        for sentence in re.split(r"(?<=[。；])", _SOURCE_CLEAN.sub("", snippet or "")):
            sentence = " ".join(sentence.split())
            if not is_boundary_statement(sentence):
                continue
            claim = re.sub(r"^\s*答案要点[:：]\s*", "", sentence)
            claim = claim.strip("，；。 ")
            if len(claim) > 140:
                cut = max(claim.rfind("，", 0, 120), claim.rfind("；", 0, 120))
                claim = claim[: cut + 1] if cut > 40 else claim[:140]
            claim = claim.rstrip("，；。 ")
            lines[gap_index] = f"- 什么时候不要用：{claim}。[S{number}]"
            parts[2] = "\n".join(lines) + ("\n\n" + rest.lstrip("\n") if rest else "\n")
            return "".join(parts)
    return text


def normalize_answer_boundary_text(text: str) -> str:
    """Strip writer scaffolding that leaked into the boundary bullet.

    A sentence lifted from the writer's own draft can still carry "答案要点："
    and a doubled "；。". Those are artifacts of the upstream format, not
    content, so remove them even when the bullet otherwise reads as a boundary.
    """
    parts = re.split(r"^(##[ \t]+90 秒回答)[ \t]*$", text, flags=re.MULTILINE)
    if len(parts) < 3:
        return text
    body = parts[2]
    end = body.find("\n## ")
    section, rest = (body, "") if end == -1 else (body[:end], body[end:])
    lines = section.splitlines()
    changed = False
    for index, line in enumerate(lines):
        if not line.startswith("- 什么时候不要用："):
            continue
        prefix, value = line.split("：", 1)
        cleaned = re.sub(r"^\s*答案要点[:：]\s*", "", value)
        cleaned = re.sub(r"[，；]+。", "。", cleaned)
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
        if cleaned != value:
            lines[index] = f"{prefix}：{cleaned}"
            changed = True
    if not changed:
        return text
    parts[2] = "\n".join(lines) + ("\n\n" + rest.lstrip("\n") if rest else "\n")
    return "".join(parts)


def enforce_answer_boundary(text: str) -> str:
    """Make the third opening bullet an actual abstention, or a stated gap.

    The writer tends to reuse the nearest trade-off ("VACUUM does not return
    space to the OS") as the "when not to use it" answer. That is a limitation,
    not a condition for abstaining, so it reads like an answer while giving the
    reader nothing actionable. Keep a real boundary, otherwise say so.
    """
    parts = re.split(r"^(##[ \t]+90 秒回答)[ \t]*$", text, flags=re.MULTILINE)
    if len(parts) < 3:
        return text
    body = parts[2]
    end = body.find("\n## ")
    section, rest = (body, "") if end == -1 else (body[:end], body[end:])
    lines = section.splitlines()
    changed = False
    for index, line in enumerate(lines):
        if not line.startswith("- 什么时候不要用："):
            continue
        claim = line.split("：", 1)[-1]
        if is_boundary_statement(claim):
            continue
        lines[index] = "- 什么时候不要用：本轮未确认（证据缺口）。"
        changed = True
    if not changed:
        return text
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
    text = strip_bibliography(
        strip_budget_notes(balance_code_fences(normalize_learning_headings(text)))
    )
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
        elif heading == "自检":
            out.append(_trim_self_check(body, cap or 550))
        elif heading == "可运行示例":
            out.append(_trim_section(body, cap or 900) if cap else body)
        elif heading == "分层解释":
            out.append(_trim_layered_section(body, cap or 850))
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
            if chunks[index].strip().lstrip("#").strip() in {"分层解释", "概念图", "常见误区"}
        ]
        if not candidates:
            break
        _, index = max(candidates)
        body = chunks[index + 1]
        keep = max(120, int(len(body) * 0.75))
        trimmed = _trim_section(body, keep)
        if len(trimmed) >= len(body) - 20:
            break
        chunks[index + 1] = trimmed
        bounded = "".join(chunks)
    bounded = reconcile_answer_shape(enforce_answer_shape(bounded))
    bounded = ensure_example_expectation(repair_truncated_example(bounded))
    bounded = normalize_answer_boundary_text(bounded)
    bounded = re.sub(r"\n{3,}", "\n\n", bounded)
    return enforce_answer_boundary(bounded)
