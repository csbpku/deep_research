"""P1-D: 主题 AI 综述 worker。

设计 (ADR 0009)：
- 触发：topic 创建 + candidate 数量变化时（异步任务）。
- 输入：topic_candidates 列表（标题 + 摘要 + tags）。
- 输出：JSON ``{ tldr, sections, references }`` 写入 topic.synthesisPayload。
- 失败：不阻断主题创建，标 synthesisErrorCode；Admin 可重试。
- 模型：复用现有 LLM 客户端（gpt-researcher 抽象），由 ``LLM_MODEL`` 决定。
- 频率限制：每次循环最多处理 N 个 topic（默认 5），避免 LLM 配额尖峰。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from ai_engine.llm.client import generate_text

logger = logging.getLogger("ai_engine.radar.topic_synthesis")

WORKER_ID = f"topic-synthesis-{os.getpid()}"
MAX_TOPICS_PER_RUN = 5
LLM_TIMEOUT_SECONDS = 60.0


def _build_prompt(name: str, candidates: list[dict[str, Any]]) -> str:
    parts = [
        f"主题名称：{name}",
        "",
        "下列候选与该主题相关。请输出一段中文 AI 综述，格式为 JSON：",
        '{ "tldr": "<一句话总结 ≤80 字>",',
        '  "sections": [{ "title": "...", "content": "..." }],',
        '  "references": [{ "summaryId": "<id>", "kind": "<title>" }] }',
        "",
        "要求：",
        "- 客观、可追溯；不要捏造未在候选中出现的事实。",
        "- 段落 2-4 个；每段 80-200 字。",
        "- 候选编号请按列表顺序。",
        "",
        "候选：",
    ]
    for i, c in enumerate(candidates, 1):
        title = (c.get("title") or "").strip()[:200]
        snippet = (c.get("snippet") or c.get("interpretation") or "").strip()[:500]
        tags = c.get("tags") or []
        parts.append(
            f"[{i}] (id={c.get('id')}) {title}\n    标签: {', '.join(tags[:5])}\n    摘要: {snippet}"
        )
    return "\n".join(parts)


def _parse_payload(raw: str) -> dict[str, Any]:
    """宽松解析 LLM 输出：可能夹带 markdown 围栏。"""
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1] if "```" in s else s
        if s.startswith("json"):
            s = s[4:]
        s = s.strip()
    if s.endswith("```"):
        s = s[:-3].strip()
    return json.loads(s)  # type: ignore[no-any-return]


async def _generate_for_topic(pool: Any, topic_id: str) -> bool:
    """为一条 topic 生成综述；成功 → True，失败 → False（写 errorCode）。"""
    async with pool.connection() as conn:
        topic = await (
            await conn.execute(
                'SELECT "id", "name", "synthesisErrorCode" FROM "topics" WHERE "id" = %s',
                (topic_id,),
            )
        ).fetchone()
        if topic is None:
            return False
        rows = await (
            await conn.execute(
                """
                SELECT s."id", s."title", s."interpretation", s."tags"
                FROM "topic_candidates" tc
                JOIN "summaries" s ON s."id" = tc."summaryId"
                WHERE tc."topicId" = %s
                ORDER BY tc."addedAt" DESC
                LIMIT 20
                """,
                (topic_id,),
            )
        ).fetchall()

    if not rows:
        await _mark_failed(pool, topic_id, "NO_CANDIDATES", "主题无候选，跳过综述")
        return False

    candidates = [
        {
            "id": str(r["id"]),
            "title": r["title"],
            "interpretation": r["interpretation"],
            "tags": list(r["tags"] or []),
            "snippet": r["interpretation"] or "",
        }
        for r in rows
    ]
    prompt = _build_prompt(str(topic["name"]), candidates)

    try:
        result = await asyncio.wait_for(
            generate_text(
                user_prompt=prompt,
                tier="light",
                max_tokens=2048,
                timeout=LLM_TIMEOUT_SECONDS,
            ),
            timeout=LLM_TIMEOUT_SECONDS + 5,
        )
        payload = _parse_payload(result.text)
    except Exception as exc:
        await _mark_failed(pool, topic_id, type(exc).__name__, str(exc)[:500])
        logger.warning(
            "ai-engine.radar.topic_synthesis.failed",
            extra={"topic_id": topic_id, "error": type(exc).__name__},
        )
        return False

    # payload 形状最小校验
    if not isinstance(payload, dict) or "tldr" not in payload:
        await _mark_failed(pool, topic_id, "BAD_PAYLOAD", "LLM 输出缺少 tldr")
        return False

    references = payload.get("references") or []
    sections = payload.get("sections") or []
    if not isinstance(sections, list):
        sections = []

    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE "topics"
            SET "synthesisPayload" = %s::jsonb,
                "synthesisGeneratedAt" = now(),
                "synthesisModel" = %s,
                "synthesisVersion" = %s,
                "synthesisErrorCode" = NULL,
                "synthesisErrorMessage" = NULL,
                "updatedAt" = now()
            WHERE "id" = %s
            """,
            (
                json.dumps(
                    {
                        "tldr": str(payload.get("tldr", ""))[:500],
                        "sections": sections[:6],
                        "references": references[:20],
                    },
                    ensure_ascii=False,
                ),
                os.environ.get("LLM_MODEL", "unknown"),
                "v1",
                topic_id,
            ),
        )
    logger.info(
        "ai-engine.radar.topic_synthesis.done",
        extra={"topic_id": topic_id, "candidate_count": len(candidates)},
    )
    return True


async def _mark_failed(pool: Any, topic_id: str, code: str, message: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE "topics"
            SET "synthesisErrorCode" = %s,
                "synthesisErrorMessage" = %s,
                "synthesisGeneratedAt" = NULL,
                "updatedAt" = now()
            WHERE "id" = %s
            """,
            (code[:64], message[:500], topic_id),
        )


async def _claim_topics(pool: Any, limit: int) -> list[str]:
    """挑选需要生成 / 重新生成综述的 topic：
    - 有候选 & 没有 synthesisPayload & 没有未处理的 errorCode
    - 或 synthesisErrorCode 非空（Admin 重试后）
    """
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                """
                SELECT t."id"
                FROM "topics" t
                WHERE t."candidateCount" >= 1
                  AND (
                    (t."synthesisPayload" IS NULL AND t."synthesisErrorCode" IS NULL)
                    OR t."synthesisErrorCode" IS NOT NULL
                  )
                ORDER BY t."updatedAt" ASC
                LIMIT %s
                """,
                (limit,),
            )
        ).fetchall()
    return [str(r["id"]) for r in rows]


async def run_topic_synthesis(
    pool: Any,
    *,
    max_topics: int | None = None,
) -> dict[str, int]:
    """执行一次综述生成；返回 { processed, succeeded, failed }。"""
    limit = max_topics or MAX_TOPICS_PER_RUN
    topic_ids = await _claim_topics(pool, limit)
    succeeded = 0
    failed = 0
    for tid in topic_ids:
        ok = await _generate_for_topic(pool, tid)
        if ok:
            succeeded += 1
        else:
            failed += 1
    return {"processed": len(topic_ids), "succeeded": succeeded, "failed": failed}


__all__ = ["run_topic_synthesis"]
