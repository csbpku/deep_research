"""Keep the web-brief artifact actually brief.

The report writer reliably follows the section contract but treats the length
budget as advisory.  A *web brief* that runs to several thousand characters is
no longer scannable, so the adapter applies a bounded, second-pass compression
after the report has been cleaned.  The compression may only delete and
rephrase; it must not introduce new facts or citations.
"""

from __future__ import annotations

import logging
import re

from ai_engine.decision_memo import memo_readable_chars
from ai_engine.llm.client import generate_text

logger = logging.getLogger("ai-engine")

WEB_BRIEF_SYSTEM_PROMPT = (
    "你是中文技术简报编辑。把网页简报压缩到一页可扫读的长度；"
    "只使用原文已有的事实和引用标记，不新增结论、数字或来源。"
)

WEB_BRIEF_TARGET_CHARS = 900
WEB_BRIEF_MAX_CHARS = 1_000

WEB_BRIEF_SHORTEN_PROMPT = """下面是一份网页简报，篇幅超出预算。请在不改变结论、不新增事实的前提下压缩。

要求：
- 控制在 900 个中文字符以内（Markdown 链接目标与 URL 不计入）。
- 必须保留这些二级标题，顺序不变：## 决策摘要、## 关键发现、## 风险与限制、## 下一步行动、## 结构化推荐。
- 保留原有的 [S#] 引用标记和结构化推荐里的字段。
- 优先删除重复解释、背景铺垫和长引用；不要删除风险、下一步和结论。
- 只输出压缩后的 Markdown 正文，不要解释。

待压缩的简报：
"""

_REQUIRED_HEADINGS = (
    "## 决策摘要",
    "## 关键发现",
    "## 风险与限制",
    "## 下一步行动",
    "## 结构化推荐",
)


def _render_sections(sections: list[tuple[str, list[str]]]) -> str:
    chunks: list[str] = []
    for heading, body in sections:
        text = heading
        if body:
            text = f"{text}\n" + "\n".join(body)
        chunks.append(text)
    return "\n".join(chunks).strip()


def enforce_web_brief_budget(text: str, limit: int = WEB_BRIEF_MAX_CHARS) -> str:
    """Trim the longest sections until the prose fits, keeping the contract."""
    if memo_readable_chars(text) <= limit:
        return text
    parts = re.split(r"(?m)^(?=## )", text)
    sections: list[tuple[str, list[str]]] = []
    for part in parts:
        lines = part.splitlines()
        if not lines:
            continue
        if lines[0].startswith("## "):
            sections.append((lines[0], lines[1:]))
        else:
            sections.append(("", lines))
    protected = {"## 结构化推荐"}
    while memo_readable_chars(_render_sections(sections)) > limit:
        candidates = [
            (len("\n".join(body)), index)
            for index, (heading, body) in enumerate(sections)
            if heading not in protected and len(body) > 1
        ]
        if not candidates:
            break
        _, index = max(candidates)
        sections[index][1].pop()
    rendered = _render_sections(sections)
    for _ in range(6):
        overflow = memo_readable_chars(rendered) - limit
        if overflow <= 0:
            break
        candidates = [
            (memo_readable_chars("\n".join(body)), index)
            for index, (heading, body) in enumerate(sections)
            if heading not in protected and body
        ]
        if not candidates:
            break
        _, index = max(candidates)
        body = "\n".join(sections[index][1])
        keep = max(0, len(body) - overflow - 2)
        sections[index] = (sections[index][0], [body[:keep].rstrip() + "…"])
        rendered = _render_sections(sections)
    return rendered


def is_valid_web_brief(text: str) -> bool:
    if not text.strip():
        return False
    positions = [text.find(heading) for heading in _REQUIRED_HEADINGS]
    if any(position < 0 for position in positions):
        return False
    return positions == sorted(positions)


async def condense_web_brief(
    *,
    report: str,
    request_id: str,
    llm_spec: str,
) -> str | None:
    """Return a shorter brief, or ``None`` when compression is not usable."""
    if memo_readable_chars(report) <= WEB_BRIEF_MAX_CHARS:
        return report
    prompt = f"{WEB_BRIEF_SHORTEN_PROMPT}\n{report}"
    shortest = report
    for attempt in range(2):
        try:
            result = await generate_text(
                llm_spec=llm_spec,
                system_prompt=WEB_BRIEF_SYSTEM_PROMPT,
                user_prompt=prompt,
                max_tokens=1_400,
                timeout=60.0,
                disable_thinking=True,
                retry_attempts=0,
                operation="research.web_brief_condense",
                request_id=request_id,
            )
        except Exception as exc:  # noqa: BLE001 - compression is best-effort
            logger.warning(
                "ai-engine.web_brief.condense_failed",
                extra={"request_id": request_id, "attempt": attempt + 1, "error": type(exc).__name__},
            )
            continue
        text = (result.text or "").strip()
        if getattr(result, "truncated", False) or not is_valid_web_brief(text):
            logger.warning(
                "ai-engine.web_brief.condense_invalid",
                extra={"request_id": request_id, "attempt": attempt + 1, "chars": len(text)},
            )
            continue
        if memo_readable_chars(text) < memo_readable_chars(shortest):
            shortest = text
        if memo_readable_chars(shortest) <= WEB_BRIEF_MAX_CHARS:
            return shortest
        prompt = f"{WEB_BRIEF_SHORTEN_PROMPT}\n{shortest}"
    if memo_readable_chars(shortest) > WEB_BRIEF_MAX_CHARS:
        trimmed = enforce_web_brief_budget(shortest)
        logger.warning(
            "ai-engine.web_brief.trimmed_to_budget",
            extra={
                "request_id": request_id,
                "chars": memo_readable_chars(trimmed),
                "before": memo_readable_chars(shortest),
            },
        )
        return trimmed
    if memo_readable_chars(shortest) < memo_readable_chars(report):
        return shortest
    logger.warning(
        "ai-engine.web_brief.too_long",
        extra={"request_id": request_id, "chars": memo_readable_chars(report)},
    )
    return None
