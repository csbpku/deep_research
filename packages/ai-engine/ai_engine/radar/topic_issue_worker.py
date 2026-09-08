"""P1-D V2: TopicIssue 自动聚类 worker（ADR 0010）。

规则：
- 窗口：14 天内的 candidate summary。
- 对每个 Topic：
  - 若过去 14 天内新增的 candidate 数 >= 3 且独立来源 >= 2，调用 LLM 产出 1-3 个 Issue。
  - 若 LLM 返回的某个 Issue 引用 >= 3 个 candidateId 且其中至少 1 个 originalKind 在
    authoritative set（github_repo/github_release/arxiv/vendor_changelog），
    视为通过质量门槛，写入 TopicIssue + TopicIssueCandidate。
- 单一权威例外：当一个 candidate 落在 authoritative set 且 distilledTier 至少是 deep_read
  时，允许 1 个 candidate 就形成一个 Issue（event 类型）。
- 去重：已有 active Issue.title + proposition 与新提议相似时跳过。
- 提供 keep / archive API 供 Admin V2 治理使用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_engine.llm.client import generate_text
from psycopg.rows import dict_row

logger = logging.getLogger("ai_engine.radar.topic_issue_worker")

WORKER_ID = f"topic-issue-worker-{os.getpid()}"
WINDOW_DAYS = 14
MAX_TOPICS_PER_RUN = 8
LLM_TIMEOUT_SECONDS = 50.0

# 单一权威例外允许的原稿类型
AUTHORITATIVE_KINDS = frozenset(
    {
        "github_repo",
        "github_release",
        "arxiv",
        "vendor_changelog",
    }
)

_ISSUE_TEXT_STOPWORDS = frozenset(
    {
        "ai",
        "agent",
        "agents",
        "artificial",
        "intelligence",
        "llm",
        "llms",
        "model",
        "models",
        "system",
        "systems",
        "technology",
        "technologies",
        "tool",
        "tools",
        "new",
        "open",
        "source",
        "the",
        "and",
        "for",
        "with",
        "from",
        "into",
        "that",
        "this",
    }
)

_ISSUE_CJK_STOP_CONCEPTS = frozenset(
    {
        "智能体",
        "基础模型",
        "框架",
        "系统",
        "问题",
        "能力",
        "发布",
        "提出",
        "面向",
        "当前",
        "集中",
        "密集",
        "普遍",
        "受到",
        "引发",
        "关注",
    }
)


def _authoritative_count(rows: list[dict[str, Any]]) -> int:
    return sum(1 for r in rows if (r.get("originalKind") in AUTHORITATIVE_KINDS))


def _distinct_sources(rows: list[dict[str, Any]]) -> set[str]:
    out: set[str] = set()
    for r in rows:
        host = r.get("sourceHost") or ""
        kind = r.get("originalKind") or ""
        if host:
            out.add(host)
        elif kind:
            out.add(kind)
    return {v for v in out if v}


def _issue_candidate_ids(issue: dict[str, Any]) -> list[str]:
    values = issue.get("summaryIds") or issue.get("candidateIds") or []
    return list(dict.fromkeys(str(value) for value in values if str(value)))


def _issue_concepts(issue: dict[str, Any]) -> set[str]:
    text = f"{issue.get('title') or ''} {issue.get('proposition') or ''}".lower()
    concepts: set[str] = set()
    for match in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        for size in (2, 3):
            for index in range(len(match) - size + 1):
                concept = match[index : index + size]
                if concept not in _ISSUE_CJK_STOP_CONCEPTS:
                    concepts.add(concept)
    for token in re.findall(r"[a-z][a-z0-9-]{2,}", text):
        if token not in _ISSUE_TEXT_STOPWORDS:
            concepts.add(token)
    return concepts


def _candidate_overlap(left: list[str], right: list[str]) -> float:
    left_set = set(left)
    right_set = set(right)
    if not left_set or not right_set:
        return 0.0
    return len(left_set & right_set) / min(len(left_set), len(right_set))


def _concept_overlap(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_concepts = _issue_concepts(left)
    right_concepts = _issue_concepts(right)
    if not left_concepts or not right_concepts:
        return 0.0
    return len(left_concepts & right_concepts) / min(len(left_concepts), len(right_concepts))


def _same_candidate_set(left: list[str], right: list[str]) -> bool:
    left_set = set(left)
    right_set = set(right)
    return bool(left_set) and left_set == right_set


def _issues_are_near_duplicates(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_ids = _issue_candidate_ids(left)
    right_ids = _issue_candidate_ids(right)
    overlap = _candidate_overlap(left_ids, right_ids)
    if overlap == 0:
        return False
    if _same_candidate_set(left_ids, right_ids):
        return True
    if overlap >= 0.8:
        return True

    # Shared evidence alone is insufficient because one article can support
    # distinct claims. Require a strong shared evidence core and related text.
    return overlap >= 2 / 3 and _concept_overlap(left, right) >= 0.08


async def _fetch_topic_inputs(
    pool: Any, topic_id: str, window_start: datetime
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        topic = await (
            await conn.execute(
                'SELECT "id", "name", "tier" FROM "topics" WHERE "id" = %s',
                (topic_id,),
            )
        ).fetchone()
        if topic is None:
            return None, []
        rows = await (
            await conn.execute(
                """
                SELECT s."id", s."title", s."interpretation", s."tags",
                       s."originalKind", s."url",
                       s."publishedAt", s."createdAt",
                       s."distilledTier",
                       split_part(regexp_replace(COALESCE(s."url", ''), '^https?://', ''), '/', 1) AS "sourceHost",
                       tc."addedAt"
                FROM "topic_candidates" tc
                JOIN "summaries" s ON s."id" = tc."summaryId"
                WHERE tc."topicId" = %s AND tc."addedAt" >= %s
                ORDER BY tc."addedAt" DESC
                LIMIT 24
                """,
                (topic_id, window_start),
            )
        ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": str(r["id"]),
                "title": str(r["title"] or ""),
                "interpretation": str(r["interpretation"] or ""),
                "tags": list(r["tags"] or []),
                "originalKind": r["originalKind"],
                "url": str(r["url"] or ""),
                "sourceHost": str(r["sourceHost"] or ""),
                "distilledTier": r["distilledTier"],
                "addedAt": r["addedAt"],
            }
        )
    topic_dict = {
        "id": str(topic["id"]),
        "name": str(topic["name"]),
        "tier": str(topic["tier"] or "emerging"),
    }
    return topic_dict, out


def _meets_normal_threshold(group_rows: list[dict[str, Any]]) -> bool:
    if len(group_rows) < 3:
        return False
    if len(_distinct_sources(group_rows)) < 2:
        return False
    if not any(r["distilledTier"] == "deep_read" for r in group_rows):
        return False
    return True


def _meets_authoritative_threshold(group_rows: list[dict[str, Any]]) -> bool:
    if not group_rows:
        return False
    if _authoritative_count(group_rows) < 1:
        return False
    if not any(r["distilledTier"] == "deep_read" for r in group_rows):
        return False
    return True


def _build_issue_prompt(name: str, candidates: list[dict[str, Any]]) -> str:
    parts = [
        f"主题：{name}",
        "",
        "下列候选摘要属于同一技术主题。请识别 1-3 个'短期事件或问题'（issue），输出 JSON：",
        '{',
        '  "issues": [',
        '    {',
        '      "kind": "event" | "problem",',
        '      "title": "<≤30 字>",',
        '      "proposition": "<≤120 字，描述发生了什么、影响谁>",',
        '      "summaryIds": ["<summaryId>", "..."]',
        '    }',
        '  ]',
        '}',
        "",
        "要求：",
        "- 每个 issue 必须真实可追溯；不要捏造。",
        "- summaryIds 必须出现在下方候选列表中。",
        "- 不同 issue 之间必须能区分；不允许完全重复。",
        "- 优先用简体中文。",
        "",
        "候选：",
    ]
    for c in candidates:
        title = (c["title"] or "").strip()[:200]
        snippet = (c["interpretation"] or "").strip()[:300]
        parts.append(
            f"- id={c['id']} kind={c['originalKind']} tier={c['distilledTier']} title={title}\n  {snippet}"
        )
    return "\n".join(parts)


def _parse_payload(raw: str) -> dict[str, Any]:
    """Parse JSON despite common model wrappers, while rejecting truncation."""
    s = raw.strip()
    if not s:
        raise ValueError("payload is empty")
    candidates = [s]
    fence = re.search(r"```(?:json)?\s*(.*?)```", s, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        candidates.insert(0, fence.group(1).strip())
    start = s.find("{")
    end = s.rfind("}")
    if start >= 0 and end > start:
        candidates.append(s[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    raise ValueError("invalid or truncated JSON payload")


def _normalize_issues(raw: dict[str, Any], valid_ids: set[str]) -> list[dict[str, Any]]:
    issues_raw = raw.get("issues") if isinstance(raw, dict) else None
    if not isinstance(issues_raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in issues_raw:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        if kind not in ("event", "problem"):
            continue
        title = str(item.get("title") or "").strip()[:200]
        proposition = str(item.get("proposition") or "").strip()[:1000]
        summary_ids = [
            str(x).strip()
            for x in (item.get("summaryIds") or [])
            if str(x).strip() in valid_ids
        ]
        if not title or not proposition or not summary_ids:
            continue
        out.append(
            {
                "kind": kind,
                "title": title,
                "proposition": proposition,
                "summaryIds": summary_ids,
            }
        )
    return out


async def _existing_active_issues(pool: Any, topic_id: str) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        rows = await (
            await conn.execute(
                """
                SELECT ti."id", ti."kind", ti."title", ti."proposition",
                       ti."importanceScore", ti."lastSeenAt", tic."summaryId"
                FROM "topic_issues" ti
                LEFT JOIN "topic_issue_candidates" tic ON tic."issueId" = ti."id"
                WHERE ti."topicId" = %s AND ti."status" = %s
                ORDER BY ti."importanceScore" DESC, ti."lastSeenAt" DESC, ti."id" ASC
                """,
                (topic_id, "active"),
            )
        ).fetchall()
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        issue_id = str(row["id"])
        issue = grouped.get(issue_id)
        if issue is None:
            issue = {
                "id": issue_id,
                "kind": str(row["kind"]),
                "title": str(row["title"] or ""),
                "proposition": str(row["proposition"] or ""),
                "importanceScore": float(row["importanceScore"] or 0),
                "lastSeenAt": row["lastSeenAt"],
                "summaryIds": [],
            }
            grouped[issue_id] = issue
        if row["summaryId"] is not None:
            issue["summaryIds"].append(str(row["summaryId"]))
    return list(grouped.values())


async def _persist_issue(
    pool: Any,
    topic_id: str,
    issue: dict[str, Any],
    rows_by_id: dict[str, dict[str, Any]],
    *,
    existing_issue_id: str | None = None,
) -> str | None:
    summary_ids = issue["summaryIds"]
    group_rows = [rows_by_id[sid] for sid in summary_ids if sid in rows_by_id]
    if not group_rows:
        return None
    authoritative = _meets_authoritative_threshold(group_rows)
    if not (authoritative or _meets_normal_threshold(group_rows)):
        return None
    importance = min(1.0, 0.3 + 0.1 * len(group_rows))
    first_seen = min((r["addedAt"] for r in group_rows), default=datetime.now(UTC))
    last_seen = max((r["addedAt"] for r in group_rows), default=datetime.now(UTC))

    async with pool.connection() as conn, conn.transaction():
        conn.row_factory = dict_row
        existing = {"id": existing_issue_id} if existing_issue_id else await (
            await conn.execute(
                'SELECT "id" FROM "topic_issues" WHERE "topicId" = %s AND "title" = %s AND "status" = %s',
                (topic_id, issue["title"], "active"),
            )
        ).fetchone()
        if existing:
            issue_id = str(existing["id"])
            await conn.execute(
                """
                UPDATE "topic_issues"
                SET "firstSeenAt" = LEAST("firstSeenAt", %s),
                    "lastSeenAt" = GREATEST("lastSeenAt", %s),
                    "importanceScore" = GREATEST("importanceScore", %s),
                    "updatedAt" = now()
                WHERE "id" = %s
                """,
                (first_seen, last_seen, importance, issue_id),
            )
        else:
            row = await (
                await conn.execute(
                    """
                        INSERT INTO "topic_issues"
                          ("id","topicId","kind","status","title","proposition","summary","importanceScore",
                           "firstSeenAt","lastSeenAt","createdAt","updatedAt")
                        VALUES (gen_random_uuid(), %s, %s::"TopicIssueKind", 'active'::"TopicIssueStatus",
                                %s, %s, %s, %s, %s, %s, now(), now())
                        RETURNING "id"
                        """,
                    (
                        topic_id,
                        issue["kind"],
                        issue["title"],
                        issue["proposition"],
                        " ".join((r["interpretation"] or "")[:300] for r in group_rows[:3])[:2000],
                        importance,
                        first_seen,
                        last_seen,
                    ),
                )
            ).fetchone()
            issue_id = str(row["id"])
        for sid in summary_ids:
            await conn.execute(
                """
                    INSERT INTO "topic_issue_candidates" ("issueId","summaryId","addedAt")
                    VALUES (%s, %s, now())
                    ON CONFLICT ("issueId","summaryId") DO NOTHING
                    """,
                (issue_id, sid),
            )
    return issue_id


async def _process_topic(pool: Any, topic_id: str) -> dict[str, int]:
    window_start = datetime.now(UTC) - timedelta(days=WINDOW_DAYS)
    topic, rows = await _fetch_topic_inputs(pool, topic_id, window_start)
    if not topic or not rows:
        return {"considered": 0, "created": 0, "skipped": 0}

    new_rows = [r for r in rows if r["addedAt"] and r["addedAt"] >= window_start]
    if not new_rows:
        return {"considered": 0, "created": 0, "skipped": 0}

    rows_by_id = {r["id"]: r for r in new_rows}
    valid_ids = set(rows_by_id.keys())

    authoritative_existing = any(
        r for r in new_rows if r["distilledTier"] in {"collection", "deep_read"} and r["originalKind"] in AUTHORITATIVE_KINDS
    )
    if len(new_rows) < 3 and not authoritative_existing:
        return {"considered": len(new_rows), "created": 0, "skipped": 0}

    active_issues = await _existing_active_issues(pool, topic_id)

    try:
        result = await asyncio.wait_for(
            generate_text(
                user_prompt=_build_issue_prompt(topic["name"], new_rows),
                tier="light",
                max_tokens=2000,
                timeout=LLM_TIMEOUT_SECONDS,
                disable_thinking=True,
                operation="radar.topic_issue_cluster",
            ),
            timeout=LLM_TIMEOUT_SECONDS + 5,
        )
        raw = _parse_payload(result.text)
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.topic_issue.failed",
            extra={"topic_id": topic_id, "error": type(exc).__name__},
        )
        return {"considered": len(new_rows), "created": 0, "skipped": 0}

    # Keep one clustering run bounded even when the model ignores the 1-3 issue instruction.
    issues = _normalize_issues(raw, valid_ids)[:3]
    created = 0
    skipped = 0
    for issue in issues:
        duplicate = next(
            (existing for existing in active_issues if _issues_are_near_duplicates(issue, existing)),
            None,
        )
        if duplicate is not None:
            issue_id = await _persist_issue(
                pool,
                topic_id,
                issue,
                rows_by_id,
                existing_issue_id=str(duplicate["id"]),
            )
            if issue_id:
                duplicate["summaryIds"] = list(
                    dict.fromkeys(
                        [*duplicate.get("summaryIds", []), *_issue_candidate_ids(issue)],
                    )
                )
            skipped += 1
            continue
        if any(issue["title"] == existing["title"] for existing in active_issues):
            skipped += 1
            continue
        issue_id = await _persist_issue(pool, topic_id, issue, rows_by_id)
        if issue_id:
            created += 1
            active_issues.append(
                {
                    "id": issue_id,
                    "kind": issue["kind"],
                    "title": issue["title"],
                    "proposition": issue["proposition"],
                    "importanceScore": min(1.0, 0.3 + 0.1 * len(issue["summaryIds"])),
                    "lastSeenAt": max(
                        (rows_by_id[sid]["addedAt"] for sid in issue["summaryIds"] if sid in rows_by_id),
                        default=datetime.now(UTC),
                    ),
                    "summaryIds": _issue_candidate_ids(issue),
                }
            )
        else:
            skipped += 1
    return {"considered": len(new_rows), "created": created, "skipped": skipped}


async def _claim_topics(pool: Any, limit: int) -> list[str]:
    """挑候选 topic：过去 14 天新增 candidate >= 3 或有 authoritative must-read。"""
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        rows = await (
            await conn.execute(
                """
                SELECT t."id"
                FROM "topics" t
                WHERE t."enabled" = true
                  AND t."candidateCount" >= 1
                  AND (
                    EXISTS (
                      SELECT 1 FROM "topic_candidates" tc
                      WHERE tc."topicId" = t."id" AND tc."addedAt" >= now() - (%s || ' days')::interval
                    )
                  )
                ORDER BY t."updatedAt" DESC
                LIMIT %s
                """,
                (str(WINDOW_DAYS), limit),
            )
        ).fetchall()
    return [str(r["id"]) for r in rows]


async def run_topic_issue_worker(
    pool: Any,
    *,
    max_topics: int | None = None,
) -> dict[str, int]:
    """单轮运行：扫描候选 topic 并生成 / 更新 TopicIssue。"""
    limit = max_topics or MAX_TOPICS_PER_RUN
    topic_ids = await _claim_topics(pool, limit)
    created_total = 0
    skipped_total = 0
    considered_total = 0
    for topic_id in topic_ids:
        try:
            stats = await _process_topic(pool, topic_id)
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.topic_issue.exception",
                extra={"topic_id": topic_id, "error": type(exc).__name__},
            )
            continue
        created_total += stats["created"]
        skipped_total += stats["skipped"]
        considered_total += stats["considered"]
    logger.info(
        "ai-engine.radar.topic_issue.done",
        extra={"processed": len(topic_ids), "created": created_total, "skipped": skipped_total},
    )
    return {
        "processed": len(topic_ids),
        "considered": considered_total,
        "created": created_total,
        "skipped": skipped_total,
    }


__all__ = ["WINDOW_DAYS", "run_topic_issue_worker"]
