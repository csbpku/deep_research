"""P1-D: 热点主题聚合 worker。

设计 (ADR 0009)：
- 周期：每日一次（建议 02:00 Asia/Shanghai）；可以手动触发。
- 窗口：最近 14 天 published / candidate summary。
- 归并算法 V1：按 summary 的 tags 数组做分桶 —— 每个非 metadata tag 满足
  ≥ 3 summary + ≥ 2 distinct originalKind 时，对应该 tag 的所有 summary 归为
  一个 topic 候选。V2 可以升级为 title 相似度 / 嵌入。
- tier 判定：candidateCount >= MIN_CANDIDATES*2 = hot；>= MIN_CANDIDATES = warming；else emerging。
- 写回 topics / topic_candidates；已存在 topic 的 candidate 用 (topicId, summaryId) 唯一。

设计要点：
- 不调用 LLM；纯 SQL 聚合。
- 失败隔离：单 cluster 失败不阻断其它 cluster。
- 幂等：每次运行前清理 14 天前窗口的 stale topic_candidates。
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from ai_engine.radar.topic_clustering import is_metadata_tag as _is_metadata_tag

logger = logging.getLogger("ai_engine.radar.topic_worker")

WORKER_ID = f"topic-aggregator-{os.getpid()}"

WINDOW_DAYS = 14
MIN_CANDIDATES = 3
MIN_SOURCES = 2
# 质量守门：以 distilled tier 为主，hard score 阈值作兜底。
# V1 选择：tier ∈ {'skim', 'deep_read'} 即视为"够格"主题候选；
# 'noise' 直接排除。这样 skim(avg~59) 与 deep_read(avg~80) 都进，
# 而 noise(avg~28) 不会污染主题。
# Hard score SCORE_THRESHOLD 用作 admin 后台可调的兜底（未来同步给
# AdminConsole 设置页）；目前 V1 不强约束，避免和现有 Admin 队列不一致。
SCORE_THRESHOLD = 0.0  # 兜底用；V1 主要靠 tier 守门
ALLOWED_TIERS = frozenset({"skim", "deep_read"})

def _topic_slug(name: str) -> str:
    """Return the stable canonical slug used for reconciliation and upsert."""
    return re.sub(r"[^a-z0-9一-鿿]+", "-", name.lower()).strip("-")[:120]


async def _fetch_candidate_clusters(pool: Any, since: datetime) -> list[dict[str, Any]]:
    """在 SQL 端挑出"主题候选 tag"：每个 tag 满足 ≥ 3 summary + ≥ 2 distinct originalKind。

    返回 [{tag, name, summary_ids, kinds}, ...]
    """
    async with pool.connection() as conn:
        # Step 1: 收集通过质量守门的 summary + 它们的非 metadata tag。
        # 质量守门：distilledTier ∈ {skim, deep_read}（噪声 noise 排除）。
        # NULL tier 表示尚未评分（sync_runner 还没跑 LLM distilled）；
        # 它们**不**进主题候选 —— 让用户先看到 Admin 队列候选里的人工筛选结果。
        # Hard score 阈值 SCORE_THRESHOLD 当前为 0（兜底用），方便 V2 把控。
        exploded = await (
            await conn.execute(
                """
                WITH windowed AS (
                  SELECT s."id" AS "summaryId", s."originalKind", s."title",
                         s."tags", s."summaryDate", s."publishedAt", s."createdAt"
                  FROM "summaries" s
                  WHERE s."status" IN ('candidate', 'published')
                    AND (s."publishedAt" >= %s OR s."createdAt" >= %s)
                    AND s."distilledTier" = ANY(%s)
                    AND (s."distilledTotal" IS NULL OR s."distilledTotal" >= %s)
                )
                SELECT "summaryId", "originalKind", "title", "tag"
                FROM windowed, unnest("tags") AS "tag"
                """,
                (since, since, list(ALLOWED_TIERS), SCORE_THRESHOLD),
            )
        ).fetchall()

    # Step 2: Python 侧过滤 metadata + 按 tag 聚合
    by_tag: dict[str, dict[str, Any]] = {}
    for r in exploded:
        tag = str(r["tag"]).strip().lower()
        if _is_metadata_tag(tag):
            continue
        c = by_tag.setdefault(
            tag,
            {"tag": tag, "summary_ids": [], "kinds": set(), "titles": []},
        )
        c["summary_ids"].append(str(r["summaryId"]))
        if r["originalKind"]:
            c["kinds"].add(str(r["originalKind"]))
        if r["title"]:
            c["titles"].append(str(r["title"]))

    # Step 3: 应用门槛
    clusters: list[dict[str, Any]] = []
    for tag, c in by_tag.items():
        if len(c["summary_ids"]) < MIN_CANDIDATES:
            continue
        if len(c["kinds"]) < MIN_SOURCES:
            continue
        # name 用 tag 自身（保留大小写 + 连字符）；slug 会归一化
        name = tag
        clusters.append(
            {
                "tag": tag,
                "name": name,
                "summary_ids": c["summary_ids"],
                "kinds": sorted(c["kinds"]),
                "sample_title": c["titles"][0][:200] if c["titles"] else tag,
            }
        )
    return clusters


async def _upsert_topic(
    pool: Any,
    *,
    name: str,
    summary_count: int,
    source_count: int,
    window_start: datetime,
    window_end: datetime,
) -> str:
    """根据 cluster name 生成 slug；upsert topic，返回 id。"""
    slug = _topic_slug(name)
    if not slug:
        slug = f"topic-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"

    tier: str
    if summary_count < MIN_CANDIDATES:
        tier = "emerging"
    elif summary_count >= MIN_CANDIDATES * 2:
        tier = "hot"
    else:
        tier = "warming"

    new_id: str | None = None
    async with pool.connection() as conn:
        async with conn.transaction():
            existing = await (
                await conn.execute(
                    'SELECT "id" FROM "topics" WHERE "slug" = %s LIMIT 1',
                    (slug,),
                )
            ).fetchone()
            if existing:
                new_id = str(existing["id"])
                await conn.execute(
                    """
                    UPDATE "topics"
                    SET "candidateCount" = %s, "sourceCount" = %s,
                        "tier" = %s, "lastSyncedAt" = now(),
                        "aggregationWindowStart" = %s,
                        "aggregationWindowEnd" = %s,
                        "updatedAt" = now()
                    WHERE "id" = %s
                    """,
                    (summary_count, source_count, tier, window_start, window_end, new_id),
                )
            else:
                new_id = str(__import__("uuid").uuid4())
                await conn.execute(
                    """
                    INSERT INTO "topics"
                      ("id", "slug", "name", "tier", "candidateCount", "sourceCount",
                       "aggregationWindowStart", "aggregationWindowEnd", "lastSyncedAt",
                       "createdAt", "updatedAt")
                    VALUES
                      (%s, %s, %s, %s, %s, %s, %s, %s, now(), now(), now())
                    """,
                    (new_id, slug, name[:200], tier, summary_count, source_count,
                     window_start, window_end),
                )
    assert new_id is not None
    return new_id


async def _link_candidates(
    pool: Any, topic_id: str, summary_ids: list[str], reason: str = "auto"
) -> None:
    """把 summary_ids 关联到 topic_id；INSERT ON CONFLICT DO NOTHING（幂等）。"""
    if not summary_ids:
        return
    async with pool.connection() as conn:
        for sid in summary_ids:
            await conn.execute(
                """
                INSERT INTO "topic_candidates"
                  ("id", "topicId", "summaryId", "addedReason", "addedAt")
                VALUES (%s, %s, %s, %s::"TopicCandidateReason", now())
                ON CONFLICT ("topicId", "summaryId") DO NOTHING
                """,
                (str(__import__("uuid").uuid4()), topic_id, sid, reason),
            )


async def _cleanup_stale_topic_candidates(pool: Any, cutoff: datetime) -> int:
    """删除 window 之外的 topic_candidates（summary 早已过期）。
    用 DELETE ... RETURNING 拿到实际删除行数（psycopg cursor 不暴露 rowcount
    在 execute() 返回值上 —— 必须 fetchall）。
    """
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            DELETE FROM "topic_candidates" tc
            USING "summaries" s
            WHERE tc."summaryId" = s."id"
              AND s."createdAt" < %s
              AND s."publishedAt" < %s
            RETURNING tc."id"
            """,
            (cutoff, cutoff),
        )
        rows = await cursor.fetchall()
    return len(rows)


async def _retire_obsolete_auto_topics(pool: Any, active_slugs: set[str]) -> int:
    """Delete derived topics no longer supported by the current aggregation.

    Topics with admin-curated candidates are product data and stay. All other
    topics are reproducible projections of the current window; retaining them
    after their tag is rejected or expires would keep misleading topics visible.
    """
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            DELETE FROM "topics" t
            WHERE NOT (t."slug" = ANY(%s))
              AND NOT EXISTS (
                SELECT 1 FROM "topic_candidates" tc
                WHERE tc."topicId" = t."id"
                  AND tc."addedReason" = 'admin_manual'
              )
              AND NOT EXISTS (
                SELECT 1 FROM "topic_proposals" tp
                WHERE tp."publishedTopicId" = t."id"
                  AND tp."status" = 'approved'
              )
            RETURNING t."id"
            """,
            (list(active_slugs),),
        )
        rows = await cursor.fetchall()
    return len(rows)


async def run_topic_aggregation(
    pool: Any,
    *,
    now: datetime | None = None,
) -> dict[str, int]:
    """Generate review proposals and reconcile old auto-published topics.

    Public topics are no longer written by this scheduled path. Approval is an
    explicit Admin action handled by the web BFF.
    """
    now = now or datetime.now(timezone.utc)
    window_start = now - timedelta(days=WINDOW_DAYS)
    from ai_engine.radar.topic_proposal_worker import run_topic_proposal_generation

    proposal_result = await run_topic_proposal_generation(pool, now=now)
    active_slugs: set[str] = set()

    stale = await _cleanup_stale_topic_candidates(pool, window_start)
    retired = await _retire_obsolete_auto_topics(pool, active_slugs)
    logger.info(
        "ai-engine.radar.topic.aggregation_done",
        extra={
            "topics_created": 0,
            "candidates_linked": 0,
            "proposals_created": proposal_result["proposals_created"],
            "proposal_candidates_linked": proposal_result["candidates_linked"],
            "stale_removed": stale,
            "topics_retired": retired,
        },
    )
    return {
        "topics_created": 0,
        "candidates_linked": 0,
        "proposals_created": proposal_result["proposals_created"],
        "proposal_candidates_linked": proposal_result["candidates_linked"],
        "proposal_failed": proposal_result["failed"],
        "stale_removed": stale,
        "topics_retired": retired,
    }


__all__ = ["run_topic_aggregation"]
