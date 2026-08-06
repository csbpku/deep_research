"""Generate reviewable topic proposals from titles and enrichment evidence.

This is intentionally a proposal generator, not a publisher. The model may
suggest a cluster, but only an admin review can materialize a public Topic.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, TypedDict
from urllib.parse import urlsplit

from ai_engine.llm.client import generate_text
from ai_engine.radar.topic_clustering import build_candidate_clusters

logger = logging.getLogger("ai_engine.radar.topic_proposals")

WINDOW_DAYS = 14
ALGORITHM_VERSION = "precluster-llm-v2"
MAX_CANDIDATES = 120
MAX_PROPOSALS_PER_CLUSTER = 2


class TopicProposalGenerationResult(TypedDict):
    proposals_created: int
    candidates_linked: int
    failed: int
    eligible_candidates: int
    failure_reason: str


def _source_key(url: str, original_kind: str | None) -> str:
    """Use publisher identity, not content type, for source diversity."""
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        host = ""
    if host.endswith("github.com"):
        parts = [p for p in urlsplit(url).path.split("/") if p]
        return f"github:{parts[0].lower()}" if parts else "github"
    return host or (original_kind or "unknown")


def _clean_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text else text
        if text.lstrip().startswith("json"):
            text = text.lstrip()[4:]
    if text.endswith("```"):
        text = text[:-3]
    value = json.loads(text.strip())
    if not isinstance(value, dict):
        raise ValueError("topic proposal payload must be an object")
    return value


def _prompt(rows: list[dict[str, Any]], *, cluster_hint: str | None = None) -> str:
    lines = [
        "你是技术研究编辑。请从候选资料中找出最可信的共同议题，生成供管理员审核的主题提议。",
        "主题粒度应是最近 14 天可持续跟踪的研究脉络或趋势，而不是单篇文章、单个仓库或某个过窄的实现场景。",
        "共同领域不算主题：AI、LLM、Agent、Python、TypeScript、开源、编程等必须排除；",
        "但同一具体工程问题、研究趋势、发布事件或安全风险可以算。",
        "每个预聚簇通常只生成 1 个主题提议；只有组内确实存在两个互不重叠的可跟踪脉络时才最多生成 2 个。",
        "主题名应概括可继续跟进的脉络，不要用某个项目名或特定场景作为标题主体；项目名只作为候选证据。",
        "每个提议至少包含 3 条资料和 2 个独立发布方。",
        "不要因为标题措辞不同就漏掉明显同题；也不要为了凑数把不相关资料塞进同一个提议。",
    ]
    if cluster_hint:
        lines.append(
            f"这些资料按词面线索 ‘{cluster_hint}’ 预聚，请先判断是否存在可信共同点；"
            "确实没有共同点时才返回空 proposals。"
        )
    lines.extend([
        "只输出 JSON，不要 markdown：",
        '{"proposals":[{"name":"可跟踪主题名","kind":"event|problem",'
        '"proposition":"一句可证伪的共同命题","confidence":0.0,'
        '"candidateIds":["..."],"candidateEvidence":{"id":"证据"}}]}',
        "候选资料：",
    ])
    for row in rows:
        evidence = []
        for key in ("interpretation", "tldr", "repoSummary"):
            value = str(row.get(key) or "").strip()
            if value:
                evidence.append(value[:500])
        analysis = row.get("arxivAnalysis")
        if isinstance(analysis, dict):
            evidence.extend(str(analysis.get(k) or "")[:350] for k in ("tldr", "motivation", "result"))
        highlights = row.get("highlights")
        if isinstance(highlights, list):
            evidence.extend(str(item)[:250] for item in highlights[:3])
        text = " | ".join(part for part in evidence if part)[:600]
        tags = row.get("tags")
        tag_text = ""
        if isinstance(tags, list) and tags:
            tag_text = "，标签：" + ",".join(str(tag) for tag in tags[:8])
        lines.append(
            f"[{row['id']}] 标题：{str(row.get('title') or '')[:300]}\n"
            f"发布方：{row['sourceKey']}{tag_text}\n证据：{text or '无 enrichment，仅有标题'}"
        )
    return "\n".join(lines)


async def _fetch_rows(pool: Any, since: datetime, limit: int) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                """
                SELECT "id", "title", "url", "originalKind", "interpretation", "tldr",
                       "repoSummary", "arxivAnalysis", "highlights", "tags"
                FROM "summaries"
                WHERE "status" IN ('candidate', 'published')
                  AND ("publishedAt" >= %s OR "createdAt" >= %s)
                  AND "distilledTier" IN ('skim', 'deep_read')
                ORDER BY COALESCE("publishedAt", "createdAt") DESC
                LIMIT %s
                """,
                (since, since, limit),
            )
        ).fetchall()
    output: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["id"] = str(item["id"])
        item["sourceKey"] = _source_key(str(item.get("url") or ""), item.get("originalKind"))
        output.append(item)
    return output


async def _generate_and_persist(
    pool: Any,
    rows: list[dict[str, Any]],
    *,
    since: datetime,
    now: datetime,
    cluster_hint: str | None = None,
) -> tuple[int, int, str]:
    """Call the LLM on one focused prompt and persist valid proposals."""
    try:
        result = await generate_text(
            user_prompt=_prompt(rows, cluster_hint=cluster_hint),
            tier="light",
            max_tokens=4096,
            timeout=90.0,
            disable_thinking=True,
        )
        payload = _clean_json(result.text)
    except Exception as exc:
        logger.warning(
            "topic proposal generation failed",
            extra={"error": type(exc).__name__, "cluster_hint": cluster_hint},
        )
        return 0, 0, "LLM_UNAVAILABLE"

    by_id = {row["id"]: row for row in rows}
    proposals = payload.get("proposals")
    if not isinstance(proposals, list):
        return 0, 0, "BAD_MODEL_PAYLOAD"
    proposals = proposals[:MAX_PROPOSALS_PER_CLUSTER]

    created = linked = 0
    for raw in proposals:
        if not isinstance(raw, dict):
            continue
        ids = [str(value) for value in (raw.get("candidateIds") or []) if str(value) in by_id]
        ids = list(dict.fromkeys(ids))
        sources = {by_id[sid]["sourceKey"] for sid in ids}
        name = str(raw.get("name") or "").strip()[:200]
        proposition = str(raw.get("proposition") or "").strip()[:1000]
        kind = str(raw.get("kind") or "").strip().lower()
        if len(ids) < 3 or len(sources) < 2 or not name or not proposition or kind not in {"event", "problem"}:
            continue
        key_material = f"{ALGORITHM_VERSION}|{name.lower()}|{proposition.lower()}|{','.join(sorted(ids))}"
        proposal_key = hashlib.sha256(key_material.encode()).hexdigest()[:64]
        evidence = raw.get("candidateEvidence")
        if not isinstance(evidence, dict):
            evidence = {}
        confidence = raw.get("confidence")
        try:
            confidence_value = max(0.0, min(1.0, float(str(confidence))))
        except (TypeError, ValueError):
            confidence_value = None
        async with pool.connection() as conn:
            async with conn.transaction():
                proposal_row = await (
                    await conn.execute(
                        """
                        INSERT INTO "topic_proposals"
                          ("proposalKey", "name", "proposition", "kind", "confidence",
                           "candidateCount", "sourceCount", "windowStart", "windowEnd",
                           "algorithmVersion", "evidence")
                        VALUES (%s, %s, %s, %s::"TopicProposalKind", %s, %s, %s, %s, %s, %s, %s::jsonb)
                        ON CONFLICT ("proposalKey") DO UPDATE SET "updatedAt" = now()
                        RETURNING "id"
                        """,
                        (proposal_key, name, proposition, kind, confidence_value, len(ids), len(sources), since, now, ALGORITHM_VERSION, json.dumps(evidence, ensure_ascii=False)),
                    )
                ).fetchone()
                if proposal_row is None:
                    continue
                proposal_id = str(proposal_row["id"])
                for sid in ids:
                    await conn.execute(
                        """
                        INSERT INTO "topic_proposal_candidates"
                          ("proposalId", "summaryId", "fitScore", "evidence")
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT ("proposalId", "summaryId") DO NOTHING
                        """,
                        (proposal_id, sid, confidence_value, str(evidence.get(sid) or "")[:500]),
                    )
        created += 1
        linked += len(ids)
    if created == 0:
        return 0, 0, "NO_QUALIFYING_CLUSTER"
    return created, linked, ""


async def run_topic_proposal_generation(
    pool: Any,
    *,
    now: datetime | None = None,
    max_candidates: int = MAX_CANDIDATES,
) -> TopicProposalGenerationResult:
    """Generate and persist proposals from focused pre-clusters."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=WINDOW_DAYS)
    rows = await _fetch_rows(pool, since, max_candidates)
    if len(rows) < 3:
        return {
            "proposals_created": 0,
            "candidates_linked": 0,
            "failed": 0,
            "eligible_candidates": len(rows),
            "failure_reason": "NOT_ENOUGH_CANDIDATES",
        }

    clusters = build_candidate_clusters(rows)
    jobs: list[tuple[list[dict[str, Any]], str | None]] = [
        (cluster["rows"], cluster["concept"]) for cluster in clusters
    ]
    if not jobs:
        jobs = [(rows, None)]
    logger.info(
        "topic proposal generation preclustered",
        extra={"eligible_candidates": len(rows), "clusters": len(clusters), "jobs": len(jobs)},
    )

    created = linked = failed = 0
    reasons: list[str] = []
    for job_rows, cluster_hint in jobs:
        created_in_batch, linked_in_batch, reason = await _generate_and_persist(
            pool,
            job_rows,
            since=since,
            now=now,
            cluster_hint=cluster_hint,
        )
        created += created_in_batch
        linked += linked_in_batch
        if reason in {"LLM_UNAVAILABLE", "BAD_MODEL_PAYLOAD"}:
            failed += 1
        if reason:
            reasons.append(reason)

    if created:
        failure_reason = ""
    elif "LLM_UNAVAILABLE" in reasons:
        failure_reason = "LLM_UNAVAILABLE"
    elif "BAD_MODEL_PAYLOAD" in reasons:
        failure_reason = "BAD_MODEL_PAYLOAD"
    else:
        failure_reason = "NO_QUALIFYING_CLUSTER"
    return {
        "proposals_created": created,
        "candidates_linked": linked,
        "failed": failed,
        "eligible_candidates": len(rows),
        "failure_reason": failure_reason,
    }


__all__ = ["run_topic_proposal_generation"]
