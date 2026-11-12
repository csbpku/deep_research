"""Turn a finished research report into a one-page decision memo.

The memo is a *derived artifact*: it never retrieves new sources and it may
only use claims that already appear in the report.  Keeping the conversion
in one place makes the output contract testable and keeps the research
pipeline responsible for evidence, not for page layout.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Sequence

from ai_engine.llm.client import generate_text

logger = logging.getLogger("ai-engine")

MEMO_MAX_SOURCE_CHARS = 20_000
MEMO_MAX_TOKENS = 1_600

MEMO_SYSTEM_PROMPT = (
    "你是技术决策备忘编辑。把研究报告压缩成一页可执行的决策备忘；"
    "只使用报告中已有的判断和引用标记，不补充新事实，不改变结论方向。"
)

MEMO_INSTRUCTIONS = """请把下面的研究报告改写成中文决策备忘，供工程师在 3 分钟内读完并决定下一步。
只输出 Markdown 正文，严格按以下结构，不要输出其他章节：

# 决策备忘

## 问题
用 1-2 句话重述要做的决策；保留原问题的范围与限制。

## 建议
给出 1-3 条明确建议，每条写清适用前提；证据不足时直接写“暂不能定案”，不要编造结论。

## 关键声明
列 3-5 条支撑建议的关键声明，每条一行，尽量保留原文的 [S#] 引用标记；
没有引用标记的声明必须写“未确认”。

## 风险与未确认
列出会改变结论的风险、冲突和仍未确认的关键事实，最多 3 条。

## 下一步验证
给出 1-3 个最小成本、可执行的验证动作，能区分当前建议是否成立。

写作规则：
- 总长度控制在 900 字以内；不要重复原报告章节，不要附参考文献列表。
- 只允许使用原报告中出现的事实、数字和引文；不得引入模型记忆。
- 明确区分事实、推断和建议。
"""


def build_decision_memo_prompt(topic: str, report: str, sources: Sequence[dict[str, Any]]) -> str:
    """Build the condensation prompt from the finished report and its sources."""
    source_lines: list[str] = []
    for index, source in enumerate(sources, start=1):
        title = str(source.get("title") or "来源").strip()
        url = str(source.get("url") or "").strip()
        source_lines.append(f"[S{index}] {title}" + (f" — {url}" if url else ""))
    source_block = "\n".join(source_lines) if source_lines else "(本轮没有可引用来源)"
    return (
        f"{MEMO_INSTRUCTIONS}\n\n"
        f"研究问题：{topic}\n\n"
        f"可用来源（引用标记必须与报告一致）：\n{source_block}\n\n"
        f"研究报告正文：\n{report[:MEMO_MAX_SOURCE_CHARS]}"
    )


def is_valid_decision_memo(text: str) -> bool:
    """Require the complete, nonempty memo contract before replacing a report."""
    normalized = text.strip()
    headings = list(re.finditer(r"(?m)^(#{1,6})\s+(.+?)\s*$", normalized))
    expected = (
        ("#", "决策备忘"),
        ("##", "问题"),
        ("##", "建议"),
        ("##", "关键声明"),
        ("##", "风险与未确认"),
        ("##", "下一步验证"),
    )
    if [(match.group(1), match.group(2)) for match in headings] != list(expected):
        return False
    if normalized[:headings[0].start()].strip():
        return False
    for index, heading in enumerate(headings[1:], start=1):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(normalized)
        content = normalized[heading.end():end]
        if not re.sub(r"[\s>*_`\-\d.\[\]]", "", content):
            return False
    return True


async def condense_to_decision_memo(
    *,
    topic: str,
    report: str,
    sources: Sequence[dict[str, Any]],
    request_id: str,
    llm_spec: str,
) -> str | None:
    """Return a memo, or ``None`` when the model cannot produce the contract."""
    prompt = build_decision_memo_prompt(topic, report, sources)
    for attempt in range(2):
        try:
            result = await generate_text(
                llm_spec=llm_spec,
                system_prompt=MEMO_SYSTEM_PROMPT,
                user_prompt=prompt,
                max_tokens=MEMO_MAX_TOKENS,
                timeout=75.0,
                disable_thinking=True,
                retry_attempts=0,
                operation="research.decision_memo",
                request_id=request_id,
            )
        except Exception as exc:  # noqa: BLE001 - provider failures are non-fatal
            logger.warning(
                "ai-engine.decision_memo.failed",
                extra={"request_id": request_id, "attempt": attempt + 1, "error": type(exc).__name__},
            )
            continue
        text = (result.text or "").strip()
        if not getattr(result, "truncated", False) and is_valid_decision_memo(text):
            return text
        logger.warning(
            "ai-engine.decision_memo.invalid",
            extra={"request_id": request_id, "attempt": attempt + 1, "chars": len(text)},
        )
    return None
