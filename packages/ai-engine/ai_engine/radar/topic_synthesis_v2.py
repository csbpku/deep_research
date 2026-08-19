"""P1-D V2: 主题 AI 综述（ADR 0010）。

变更要点（相对 topic_synthesis_worker V1）：
- 只在输入变化（candidate 数量、tier 或窗口内 firstSeenAt 变化）时重新生成。
  通过 sha256(snapshot_key + candidate_ids + titles + tier + window_first_seen) 判定。
- 输出 V2 结构：tldr / keyChanges / subtopics / openQuestions / sections / references。
- 引用直接给出 summaryId + title + canonicalUrl，前端可点击到来源详情。
- 不在 prompt 里要求"候选编号"，避免与 candidate 行号耦合。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import datetime
from typing import Any

from ai_engine.llm.client import generate_text
from psycopg.rows import dict_row

logger = logging.getLogger("ai_engine.radar.topic_synthesis_v2")

WORKER_ID = f"topic-synthesis-v2-{os.getpid()}"
MAX_TOPICS_PER_RUN = 8
LLM_TIMEOUT_SECONDS = 60.0
SYNTHESIS_VERSION = "v2"

MAX_REFERENCES = 12
MAX_SECTIONS = 6


def _hash_input(
    candidate_ids: list[str],
    candidate_titles: list[str],
    tier: str,
    window_first_seen: datetime | None,
) -> str:
    """稳定 hash：candidate 顺序、title、tier、first_seen 都会影响正文。"""
    seed_parts = [
        tier or "emerging",
        (window_first_seen.isoformat() if window_first_seen else "0"),
    ]
    body_parts = []
    for cid, title in zip(candidate_ids, candidate_titles):
        body_parts.append(f"{cid}|{title.strip()[:200]}")
    payload = "\n".join(seed_parts + body_parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _build_prompt(name: str, candidates: list[dict[str, Any]]) -> str:
    """构造 V2 prompt：要求结构化、引用 summaryId 而不是编号。"""
    parts = [
        f"主题名称：{name}",
        "",
        "下列摘要与该主题相关。请输出 JSON，结构如下：",
        '{',
        '  "tldr": "<一句话总结 ≤80 字>",',
        '  "keyChanges": [',
        '    { "title": "...", "whyItMatters": "...", "summaryIds": ["<summaryId>", "..."] }',
        '  ],',
        '  "subtopics": [ { "title": "...", "summary": "..." } ],',
        '  "openQuestions": [ "..." ],',
        '  "sections": [ { "title": "...", "content": "...", "summaryIds": ["..."] } ],',
        '  "references": [ { "summaryId": "...", "title": "..." } ]',
        '}',
        "",
        "要求：",
        "- 客观、可追溯；不要捏造未在候选中出现的事实。",
        "- summaryIds 必须存在于候选列表中（UUID）。",
        "- openQuestions 仅列未在已有摘要中获得明确回答的争议点。",
        "- sections 至少 1 段、最多 6 段；每段 80-200 字。",
        "- references 保留 6-12 条最重要的来源摘要。",
        "",
        "候选：",
    ]
    for c in candidates:
        title = (c.get("title") or "").strip()[:200]
        snippet = (c.get("snippet") or c.get("interpretation") or "").strip()[:500]
        cid = c.get("id") or ""
        parts.append(f"- id={cid} title={title}\n  摘要: {snippet}")
    return "\n".join(parts)


def _parse_payload(raw: str) -> dict[str, Any]:
    s = raw.strip()
    if s.startswith("```"):
        first = s.find("\n")
        if first >= 0:
            s = s[first + 1 :]
        s = s.removesuffix("```")
        s = s.strip()
    data = json.loads(s)
    if not isinstance(data, dict):
        raise ValueError("payload not object")
    return data


def _normalize(
    raw: dict[str, Any],
    candidate_ids: set[str],
) -> dict[str, Any]:
    """标准化 LLM 输出：过滤无效 summaryId、补默认字段。"""

    def _ids(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        out: list[str] = []
        for item in value:
            if isinstance(item, str) and item in candidate_ids:
                out.append(item)
        return out

    tldr = str(raw.get("tldr") or "").strip()[:500]

    key_changes: list[dict[str, Any]] = []
    for item in raw.get("keyChanges") or []:
        if not isinstance(item, dict):
            continue
        summary_ids = _ids(item.get("summaryIds"))
        if not summary_ids:
            continue
        key_changes.append(
            {
                "title": str(item.get("title") or "").strip()[:160],
                "whyItMatters": str(item.get("whyItMatters") or "").strip()[:400],
                "summaryIds": summary_ids,
            }
        )

    subtopics: list[dict[str, Any]] = []
    for item in raw.get("subtopics") or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:160]
        summary = str(item.get("summary") or "").strip()[:500]
        if not title or not summary:
            continue
        subtopics.append({"title": title, "summary": summary})

    open_questions: list[str] = []
    for item in raw.get("openQuestions") or []:
        if isinstance(item, str) and item.strip():
            open_questions.append(item.strip()[:240])
        if len(open_questions) >= 6:
            break

    sections: list[dict[str, Any]] = []
    for item in raw.get("sections") or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:160]
        content = str(item.get("content") or "").strip()
        if not title or not content:
            continue
        sections.append(
            {
                "title": title,
                "content": content[:1000],
                "summaryIds": _ids(item.get("summaryIds")),
            }
        )
        if len(sections) >= MAX_SECTIONS:
            break

    references: list[dict[str, Any]] = []
    for item in raw.get("references") or []:
        if not isinstance(item, dict):
            continue
        sid = str(item.get("summaryId") or "").strip()
        if sid not in candidate_ids:
            continue
        title = str(item.get("title") or "").strip()[:200]
        references.append({"summaryId": sid, "title": title})
        if len(references) >= MAX_REFERENCES:
            break

    return {
        "tldr": tldr,
        "keyChanges": key_changes[:6],
        "subtopics": subtopics[:6],
        "openQuestions": open_questions,
        "sections": sections,
        "references": references,
    }


async def _fetch_payload(pool: Any, topic_id: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        topic = await (
            await conn.execute(
                'SELECT "id", "name", "tier" FROM "topics" WHERE "id" = %s',
                (topic_id,),
            )
        ).fetchone()
        if topic is None:
            return None
        rows = await (
            await conn.execute(
                """
                SELECT s."id", s."title", s."interpretation",
                       COALESCE(s."summaryDate", s."publishedAt", s."createdAt") AS "appearAt"
                FROM "topic_candidates" tc
                JOIN "summaries" s ON s."id" = tc."summaryId"
                WHERE tc."topicId" = %s
                ORDER BY tc."addedAt" DESC
                LIMIT 24
                """,
                (topic_id,),
            )
        ).fetchall()
    if not rows:
        return None

    candidate_ids = [str(r["id"]) for r in rows]
    candidate_titles = [str(r["title"]) for r in rows]
    candidate_id_set = set(candidate_ids)
    tier = str(topic["tier"] or "emerging")
    window_first_seen = min((r["appearAt"] for r in rows), default=None)

    new_hash = _hash_input(candidate_ids, candidate_titles, tier, window_first_seen)
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        prev = await (
            await conn.execute(
                'SELECT "synthesisInputHash" FROM "topics" WHERE "id" = %s',
                (topic_id,),
            )
        ).fetchone()
    prev_hash = prev["synthesisInputHash"] if prev else None
    if prev_hash == new_hash:
        return {"__skip__": True}

    candidates = [
        {
            "id": str(r["id"]),
            "title": str(r["title"]),
            "snippet": str(r["interpretation"] or ""),
        }
        for r in rows
    ]
    prompt = _build_prompt(str(topic["name"]), candidates)
    try:
        result = await asyncio.wait_for(
            generate_text(
                user_prompt=prompt,
                tier="light",
                max_tokens=2400,
                timeout=LLM_TIMEOUT_SECONDS,
                operation="radar.topic_synthesis_v2",
            ),
            timeout=LLM_TIMEOUT_SECONDS + 5,
        )
        raw = _parse_payload(result.text)
    except Exception as exc:
        await _mark_failed(pool, topic_id, type(exc).__name__, str(exc)[:500])
        logger.warning(
            "ai-engine.radar.topic_synthesis_v2.failed",
            extra={"topic_id": topic_id, "error": type(exc).__name__},
        )
        return {"__error__": True}

    payload = _normalize(raw, candidate_id_set)
    payload["_synthesisInputHash"] = new_hash
    return payload


async def _mark_failed(pool: Any, topic_id: str, code: str, message: str) -> None:
    async with pool.connection() as conn:
        conn.row_factory = dict_row
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


async def _persist_payload(pool: Any, topic_id: str, payload: dict[str, Any]) -> None:
    synthesis_hash = str(payload.pop("_synthesisInputHash", ""))[:64] or None
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        await conn.execute(
            """
            UPDATE "topics"
            SET "synthesisPayload" = %s::jsonb,
                "synthesisGeneratedAt" = now(),
                "lastSynthesisSuccessAt" = now(),
                "synthesisModel" = %s,
                "synthesisVersion" = %s,
                "synthesisInputHash" = %s,
                "synthesisErrorCode" = NULL,
                "synthesisErrorMessage" = NULL,
                "previousCandidateCount" = "candidateCount",
                "updatedAt" = now()
            WHERE "id" = %s
            """,
            (
                json.dumps(payload, ensure_ascii=False),
                os.environ.get("LLM_MODEL", "unknown"),
                SYNTHESIS_VERSION,
                synthesis_hash,
                topic_id,
            ),
        )


async def _claim_topics(pool: Any, limit: int) -> list[str]:
    """挑选需要重新生成综述的 topic：input hash 已变 或 上次失败。"""
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        rows = await (
            await conn.execute(
                """
                SELECT t."id"
                FROM "topics" t
                WHERE t."candidateCount" >= 1
                  AND t."enabled" = true
                  AND (
                    t."synthesisErrorCode" IS NOT NULL
                    OR t."synthesisPayload" IS NULL
                    OR t."synthesisVersion" <> %s
                    OR t."previousCandidateCount" <> t."candidateCount"
                  )
                ORDER BY t."updatedAt" ASC
                LIMIT %s
                """,
                (SYNTHESIS_VERSION, limit),
            )
        ).fetchall()
    return [str(r["id"]) for r in rows]


async def run_topic_synthesis_v2(
    pool: Any,
    *,
    max_topics: int | None = None,
) -> dict[str, int]:
    """执行一次 V2 综述生成。"""
    limit = max_topics or MAX_TOPICS_PER_RUN
    topic_ids = await _claim_topics(pool, limit)
    succeeded = 0
    failed = 0
    skipped = 0

    for topic_id in topic_ids:
        try:
            payload = await _fetch_payload(pool, topic_id)
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.topic_synthesis_v2.exception",
                extra={"topic_id": topic_id, "error": type(exc).__name__},
            )
            failed += 1
            continue
        if payload is None:
            skipped += 1
            continue
        if payload.get("__skip__"):
            skipped += 1
            continue
        if payload.get("__error__"):
            failed += 1
            continue
        await _persist_payload(pool, topic_id, payload)
        succeeded += 1

    logger.info(
        "ai-engine.radar.topic_synthesis_v2.done",
        extra={"processed": len(topic_ids), "succeeded": succeeded, "failed": failed, "skipped": skipped},
    )
    return {
        "processed": len(topic_ids),
        "succeeded": succeeded,
        "failed": failed,
        "skipped": skipped,
    }


def synthesize_hash_from_input(
    candidate_ids: list[str],
    candidate_titles: list[str],
    tier: str,
    window_first_seen: datetime | None = None,
) -> str:
    """公开哈希：客户端可在生成候选视图前预估 hash 不变则跳过。"""
    return _hash_input(candidate_ids, candidate_titles, tier, window_first_seen)


__all__ = ["SYNTHESIS_VERSION", "run_topic_synthesis_v2", "synthesize_hash_from_input"]
