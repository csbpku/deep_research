"""Radar daily digest: cross-source summary article backed by summaries rows.

The digest replaces the old "4 hand-picked summaries per day" flow:

- Relevant candidates participate, capped at five per source category so a
  large arXiv batch cannot crowd out GitHub and engineering signals.
- The composed article is stored as a published ``summaries`` row whose
  ``canonicalUrl`` is ``digest://YYYY-MM-DD``. Comments therefore work through
  the existing summary comment API without a schema-level target change.
- ``digestMeta`` keeps the structured article so the web client renders
  narrative sections, the ranked list, and radar links without parsing Markdown
  at runtime.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

from psycopg.rows import dict_row

logger = logging.getLogger("ai_engine.radar.daily_digest")

# Noise is excluded; category quotas provide the second-stage quality gate.
ELIGIBLE_TIERS = ("collection", "deep_read", "skim")

DIGEST_CANONICAL_PREFIX = "digest://"

REQUIRED_KEYS = {"tldr", "sections", "highlights", "ranked", "sourcesUsed"}


@dataclass(frozen=True)
class DailyDigestResult:
    """Outcome of a digest generation run."""

    date: str
    summary_id: str | None
    markdown: str
    candidate_count: int
    narrative_degraded: bool


async def query_digest_candidates(
    pool: Any,
    *,
    target_date: date,
    limit: int = 40,
) -> list[dict[str, Any]]:
    """Fetch high-scoring radar candidates for a date, ordered by score."""
    async with pool.connection() as conn:
        conn.row_factory = dict_row
        rows = await (
            await conn.execute(
                """
                WITH ranked AS (
                    SELECT
                        s.id,
                        s.title,
                        s.url,
                        s."canonicalUrl",
                        s."distilledScore",
                        s."distilledTotal",
                        s."distilledTier",
                        s."distilledMustRead",
                        s.interpretation,
                        s.body,
                        s.tags,
                        COALESCE(rs."sourceType", 'unknown') AS "sourceType",
                        CASE
                            WHEN rs."sourceType" LIKE 'github%%' THEN 'github'
                            WHEN rs."sourceType" = 'arxiv' THEN 'arxiv'
                            WHEN rs."sourceType" IN ('hackernews', 'producthunt', 'reddit', 'lobsters') THEN 'community'
                            WHEN rs."sourceType" IN ('rss', 'devto', 'vendor_news', 'wechat', 'sitemap_watch') THEN 'articles'
                            ELSE 'other'
                        END AS "sourceCategory",
                        ROW_NUMBER() OVER (
                            PARTITION BY CASE
                                WHEN rs."sourceType" LIKE 'github%%' THEN 'github'
                                WHEN rs."sourceType" = 'arxiv' THEN 'arxiv'
                                WHEN rs."sourceType" IN ('hackernews', 'producthunt', 'reddit', 'lobsters') THEN 'community'
                                WHEN rs."sourceType" IN ('rss', 'devto', 'vendor_news', 'wechat', 'sitemap_watch') THEN 'articles'
                                ELSE 'other'
                            END
                            ORDER BY
                                COALESCE(s."distilledMustRead", FALSE) DESC,
                                COALESCE(s."distilledTotal", 0) DESC,
                                s."createdAt" DESC
                        ) AS "categoryRank"
                    FROM summaries s
                    LEFT JOIN "radar_sync_runs" rsr ON s."syncRunId" = rsr.id
                    LEFT JOIN "radar_sources" rs ON rsr."sourceId" = rs.id
                    WHERE s."summaryDate" = %s::date
                      AND s."syncRunId" IS NOT NULL
                      AND s."status" IN ('candidate', 'published')
                      AND s."distilledScore" IS NOT NULL
                      AND s."distilledTier" = ANY(%s)
                )
                SELECT * FROM ranked
                WHERE "categoryRank" <= 5
                ORDER BY
                    CASE "sourceCategory"
                        WHEN 'github' THEN 0
                        WHEN 'articles' THEN 1
                        WHEN 'community' THEN 2
                        WHEN 'arxiv' THEN 3
                        ELSE 4
                    END,
                    COALESCE("distilledMustRead", FALSE) DESC,
                    COALESCE("distilledTotal", 0) DESC
                LIMIT %s
                """,
                (target_date, list(ELIGIBLE_TIERS), limit),
            )
        ).fetchall()

    candidates: list[dict[str, Any]] = []
    for row in rows:
        row = dict(row)
        ds = row.get("distilledScore")
        if isinstance(ds, str):
            try:
                ds = json.loads(ds)
            except json.JSONDecodeError:
                ds = None
        row["_ds"] = ds
        row["id"] = str(row["id"])
        candidates.append(row)
    return candidates


def _format_distilled(ds: dict[str, Any] | None) -> str:
    """Format distilled score for prompt (compact)."""
    if not ds or not isinstance(ds, dict):
        return "暂无评分"
    tier = ds.get("tier", "?")
    total = ds.get("total", "?")
    must_read = "⭐必读" if ds.get("must_read") else ""
    dims = ds.get("dimension_scores") or {}
    dim_str = ", ".join(f"{k}={v}" for k, v in dims.items()) if dims else ""
    weak = ds.get("weak_point", "")
    parts = [f"总分={total}/100", f"tier={tier}"]
    if must_read:
        parts.append(must_read)
    if dim_str:
        parts.append(f"维度: {dim_str}")
    if weak:
        parts.append(f"弱项: {weak}")
    return " | ".join(parts)


def _body_excerpt(text: str, max_chars: int = 300) -> str:
    """Truncate body text for prompt inclusion."""
    if not text:
        return ""
    text = text.strip()
    return text[:max_chars] + ("…" if len(text) > max_chars else "")


DIGEST_SYSTEM_PROMPT = """\
你是 AI 生态日报编辑，负责基于当日信号生成中文日报。风格要求：
- 简洁专业，每条信号最多 2 句话
- 不编造数字、链接或未在信号中出现过的信息
- 使用简体中文，术语保留英文原名（如 LLM, RAG, RLHF）
- 分类合理，避免 "其他" 分类，至少 3 个自然分类
"""

DIGEST_USER_PROMPT_TEMPLATE = """\
基于以下 {N} 条今日 AI 社区信号，生成一份中文日报。

## 今日信号

{signal_list}

## 输出要求

返回严格 JSON（不要 markdown 代码块、不要解释、不要 trailing comma）：

{{
  "tldr": "今日 AI 领域的一句话总结，不超过 200 字",
  "sections": [
    {{
      "title": "分类标题（如 LLM 框架、开源模型、学术前沿、工具生态、行业动态）",
      "body": "该分类下 2-4 句话综述"
    }}
  ],
  "highlights": ["最值得关注的信号，每条 ≤150 字"],
  "ranked": [
    {{
      "title": "原文标题",
      "url": "原文链接",
      "oneLineReason": "一句话推荐理由（≤100 字）"
    }}
  ],
  "sourcesUsed": ["github", "arxiv", "huggingface"]
}}

约束：
- sections: 3-5 个分类
- highlights: 4-8 条
- ranked: 5-15 条，按重要度从高到低排序
- GitHub 仓库更新、Release 和可直接采用的工程工具优先于泛研究论文
- 不得让单一来源占 ranked 的一半以上；同等价值时优先 GitHub 与工程实践
- 如果信号数量 < 5，sections 返回空数组 []，highlights ≤ 2
- 信息来源使用每个信号给出的 "来源类型" 字段值
- 不要修改或编造链接；链接必须来自信号列表
- 如果 JSON 无法解析，请严格自查并确保输出有效的 JSON
"""


def build_prompt(candidates: list[dict[str, Any]]) -> str:
    """Build a cross-source digest prompt from candidate list."""
    signal_parts = []
    for i, c in enumerate(candidates, 1):
        ds = c.get("_ds") or {}
        tier_emoji = {
            "collection": "📌",
            "deep_read": "📖",
            "skim": "👀",
            "noise": "🔇",
        }.get(ds.get("tier", ""), "📄")

        source_type = c.get("sourceType", "unknown")
        interpretation = c.get("interpretation") or ""
        body = _body_excerpt(c.get("body") or "", max_chars=300)

        signal_parts.append(
            f"### 信号 {i}\n"
            f"- 内部编号: {c['id']}\n"
            f"- 标题: {c['title']}\n"
            f"- 链接: {c['url']}\n"
            f"- 来源类型: {source_type}\n"
            f"- 评分: {_format_distilled(ds)} {tier_emoji}\n"
            f"- AI 一句话解读: {interpretation[:300] if interpretation else '无'}\n"
            f"- 原文摘要: {body if body else '无'}\n"
        )

    return DIGEST_USER_PROMPT_TEMPLATE.format(
        N=len(candidates),
        signal_list="\n".join(signal_parts),
    )


async def _call_digest_llm(system_prompt: str, user_prompt: str) -> str | None:
    """Call BRIEF_LLM for cross-source digest generation."""
    from ai_engine.llm.client import generate_text

    llm_spec = (
        os.environ.get("BRIEF_LLM")
        or os.environ.get("SMART_LLM")
        or "anthropic:claude-haiku-4-5"
    )
    try:
        result = await generate_text(
            llm_spec=llm_spec,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=4096,
            timeout=90.0,
            disable_thinking=True,
        )
    except Exception as exc:
        logger.error("LLM call failed: %s: %s", type(exc).__name__, exc)
        return None

    text = result.text
    if not text:
        logger.error("LLM returned empty response")
        return None
    return text


def _extract_json(text: str) -> dict[str, Any] | None:
    """Extract and parse JSON from LLM output, handling wrapping prose."""
    candidates = [text]

    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start != -1 and brace_end > brace_start:
        candidates.insert(0, text[brace_start : brace_end + 1])

    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        candidates.insert(0, m.group(1).strip())

    for i, candidate in enumerate(candidates):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict) and REQUIRED_KEYS <= parsed.keys():
                return parsed
            if isinstance(parsed, dict):
                missing = REQUIRED_KEYS - parsed.keys()
                if missing:
                    logger.warning(
                        "JSON parse #%s missing keys %s", i, sorted(missing)
                    )
        except json.JSONDecodeError as exc:
            logger.warning(
                "JSON parse #%s failed: %s (preview: %s)",
                i,
                exc,
                candidate[:120].replace("\n", " "),
            )
            continue

    return None


def _degraded_digest(
    candidates: list[dict[str, Any]],
    target_date: str,
) -> dict[str, Any]:
    """Build a ranked-list-only digest when LLM JSON generation fails."""
    ranked: list[dict[str, Any]] = []
    for c in candidates[:15]:
        ds = c.get("_ds") or {}
        total = ds.get("total", 0) if isinstance(ds, dict) else 0
        ranked.append(
            {
                "summaryId": c["id"],
                "title": c["title"][:300],
                "url": c["url"],
                "oneLineReason": (
                    f"AI 评分 {total:.0f}/100"
                    if isinstance(total, (int, float))
                    else "暂无评分"
                ),
            }
        )

    return {
        "date": target_date,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "model": os.environ.get("BRIEF_LLM", "unknown"),
        "narrativeDegraded": True,
        "tldr": (
            f"今日共收录 {len(candidates)} 条 AI 社区信号"
            "（LLM 摘要生成失败，以下为自动排序的候选列表）。"
        ),
        "sections": [],
        "highlights": [],
        "ranked": ranked,
        "sourcesUsed": list({c.get("sourceType", "unknown") for c in candidates}),
        "_candidateCount": len(candidates),
    }


def _normalize_title(title: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", title.lower())


def _normalize_highlights(digest: dict[str, Any]) -> dict[str, Any]:
    """Keep the persisted/UI contract stable when an LLM emits objects.

    The prompt asks for ``string[]``, but some compatible models return
    ``{title, summary}`` objects.  React cannot render those objects and the
    Markdown renderer previously exposed their Python repr.  Convert common
    object variants to concise strings and discard unusable values.
    """
    normalized: list[str] = []
    for item in digest.get("highlights") or []:
        text = ""
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict):
            title = str(item.get("title") or "").strip()
            detail = str(
                item.get("summary")
                or item.get("body")
                or item.get("text")
                or ""
            ).strip()
            text = f"{title}：{detail}" if title and detail else title or detail
        if text:
            normalized.append(text[:300])
    digest["highlights"] = normalized[:8]
    return digest


def _resolve_ranked_links(
    digest: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    """Attach summary ids to ranked entries, rewrite URLs to radar links, and
    dedupe by ``(summaryId, url)`` so the LLM emitting the same candidate
    twice with different titles does not bloat the ranked list.

    Background: the LLM occasionally emits two ranked entries pointing at the
    same radar source — e.g. one entry with the candidate's real title and
    another with a hallucinated title but the same URL. After link resolution
    both rows collapse to identical ``(summaryId, url)``. Without this dedup,
    the web client renders the same article twice (and React throws a
    "duplicate key" warning once we keyed by URL).
    """
    by_url: dict[str, dict[str, Any]] = {}
    by_canonical: dict[str, dict[str, Any]] = {}
    by_title: dict[str, dict[str, Any]] = {}
    by_id: dict[str, dict[str, Any]] = {}
    for c in candidates:
        by_url[c["url"]] = c
        by_title[_normalize_title(c["title"])] = c
        by_id[str(c["id"])] = c
        canonical = c.get("canonicalUrl")
        if canonical:
            by_canonical[str(canonical)] = c

    ranked = digest.get("ranked") or []
    resolved: list[dict[str, Any]] = []
    seen: set[tuple[str | None, str]] = set()
    for item in ranked:
        item = dict(item)
        candidate = (
            by_id.get(str(item.get("summaryId") or ""))
            or by_url.get(item.get("url") or "")
            or by_canonical.get(item.get("url") or "")
            or by_title.get(_normalize_title(item.get("title") or ""))
        )
        if candidate is not None:
            item["summaryId"] = str(candidate["id"])
            item["url"] = candidate["url"]
            item["radarUrl"] = f"/radar/{candidate['id']}"
        else:
            item["summaryId"] = None
        # Dedup: keep first occurrence per (summaryId, url). When the entry
        # could not be resolved (summaryId is None), still dedupe by URL so
        # the LLM's "two titles, one URL" failure mode is collapsed too.
        key = (item.get("summaryId"), item.get("url") or "")
        if key in seen:
            continue
        seen.add(key)
        resolved.append(item)
    digest["ranked"] = resolved
    return digest


def _render_markdown(digest: dict[str, Any]) -> str:
    """Render a digest dict to Markdown."""
    date_str = digest.get("date", "?")
    model = digest.get("model", "unknown")
    generated = digest.get("generatedAt", "?")

    lines = [
        f"# AI 雷达日报 — {date_str}",
        "",
        f"> **TL;DR:** {digest.get('tldr', '暂无摘要')}",
        "",
    ]

    if digest.get("narrativeDegraded"):
        lines.append("> ⚠️ LLM 摘要生成失败，以下为自动降级的候选列表。")
        lines.append("")

    highlights = digest.get("highlights") or []
    if highlights:
        lines.append("## 今日看点")
        lines.append("")
        for h in highlights:
            lines.append(f"- {h}")
        lines.append("")

    sections = digest.get("sections") or []
    if sections:
        lines.append("## 分类综述")
        lines.append("")
        for sec in sections:
            lines.append(f"### {sec.get('title', '?')}")
            lines.append("")
            lines.append(sec.get("body", ""))
            lines.append("")

    ranked = digest.get("ranked") or []
    if ranked:
        lines.append("## 今日榜单")
        lines.append("")
        lines.append("| # | 条目 | 理由 |")
        lines.append("|---|------|------|")
        for i, item in enumerate(ranked, 1):
            title = (item.get("title") or "?")[:120]
            url = item.get("radarUrl") or item.get("url") or "#"
            reason = (item.get("oneLineReason") or "-")[:200]
            lines.append(f"| {i} | [{title}]({url}) | {reason} |")
        lines.append("")

    sources = digest.get("sourcesUsed") or []
    count = digest.get("_candidateCount", len(ranked))
    lines.append("---")
    lines.append(
        f"生成时间: {generated} · 模型: {model} · "
        f"信号数: {count} · 来源: {', '.join(sources) if sources else '—'}"
    )

    return "\n".join(lines)


def _digest_meta(
    digest: dict[str, Any],
    *,
    target_date: date,
    candidate_count: int,
) -> dict[str, Any]:
    """Return the stable JSON shape persisted in summaries.digestMeta."""
    return {
        "version": 1,
        "date": target_date.isoformat(),
        "generatedAt": digest.get("generatedAt"),
        "model": digest.get("model"),
        "narrativeDegraded": bool(digest.get("narrativeDegraded")),
        "tldr": digest.get("tldr") or "",
        "sections": digest.get("sections") or [],
        "highlights": digest.get("highlights") or [],
        "ranked": digest.get("ranked") or [],
        "sourcesUsed": digest.get("sourcesUsed") or [],
        "candidateCount": candidate_count,
    }


async def _upsert_digest(
    pool: Any,
    *,
    target_date: date,
    markdown: str,
    meta: dict[str, Any],
) -> str:
    """Upsert a published digest article row and return its summary id."""
    canonical_url = f"{DIGEST_CANONICAL_PREFIX}{target_date.isoformat()}"
    now = datetime.now(timezone.utc)
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                """
                INSERT INTO "summaries" (
                    "id", "title", "body", "url", "canonicalUrl", "source",
                    "contentOrigin", "summaryDate", "publishedAt", "tags",
                    "status", "digestMeta", "createdAt", "updatedAt"
                )
                VALUES (
                    %s, %s, %s, %s, %s, 'daily', 'manual', %s::date, %s,
                    %s::text[], 'published', %s::jsonb, now(), now()
                )
                ON CONFLICT ("canonicalUrl") DO UPDATE SET
                    "title" = EXCLUDED."title",
                    "body" = EXCLUDED."body",
                    "publishedAt" = EXCLUDED."publishedAt",
                    "digestMeta" = EXCLUDED."digestMeta",
                    "updatedAt" = now()
                RETURNING "id"
                """,
                (
                    str(uuid.uuid4()),
                    f"AI 雷达日报 · {target_date.isoformat()}",
                    markdown,
                    canonical_url,
                    canonical_url,
                    target_date,
                    now,
                    ["radar", "daily-digest"],
                    json.dumps(meta, ensure_ascii=False),
                ),
            )
        ).fetchone()
    if row is None:
        raise RuntimeError("digest upsert returned no row")
    # The shared pool uses psycopg's dict_row factory.  The INSERT already
    # succeeded before this value is read, so using tuple-style row[0] here
    # made successful digests look like failed pipeline stages (KeyError: 0).
    # The shared server pool uses dict_row; standalone CLI pools use the
    # default tuple row factory. Support both so a successful upsert is never
    # misreported as a post-write pipeline failure.
    return str(row["id"] if isinstance(row, dict) else row[0])


async def generate_daily_digest(
    pool: Any,
    *,
    target_date: date,
    dry_run: bool = False,
    candidate_limit: int = 40,
) -> DailyDigestResult:
    """Run the digest pipeline; persist the article when not dry-running."""
    target_date_str = target_date.isoformat()
    candidates = await query_digest_candidates(
        pool,
        target_date=target_date,
        limit=candidate_limit,
    )
    logger.info(
        "digest.found_candidates",
        extra={"date": target_date_str, "count": len(candidates)},
    )

    if not candidates:
        markdown = f"# AI 雷达日报 — {target_date_str}\n\n> 今日暂无收录信号。\n"
        return DailyDigestResult(
            date=target_date_str,
            summary_id=None,
            markdown=markdown,
            candidate_count=0,
            narrative_degraded=False,
        )

    prompt = build_prompt(candidates)
    if dry_run:
        print(f"[DRY-RUN] Prompt length: {len(prompt)} chars\n", file=sys.stderr)
        print("=" * 60)
        print(prompt)
        print("=" * 60)
        print(
            f"\n[DRY-RUN] Would call LLM, max_tokens=4096, "
            f"model={os.environ.get('BRIEF_LLM', 'anthropic:claude-haiku-4-5')}",
            file=sys.stderr,
        )
        return DailyDigestResult(
            date=target_date_str,
            summary_id=None,
            markdown="",
            candidate_count=len(candidates),
            narrative_degraded=False,
        )

    digest: dict[str, Any] | None = None
    for attempt in (1, 2):
        logger.info("digest.llm_attempt", extra={"attempt": attempt})
        llm_output = await _call_digest_llm(DIGEST_SYSTEM_PROMPT, prompt)
        if llm_output is None:
            if attempt < 2:
                logger.warning("digest.llm_empty_retry")
            continue

        parsed = _extract_json(llm_output)
        if parsed is not None:
            digest = parsed
            digest["date"] = target_date_str
            digest["generatedAt"] = datetime.now(timezone.utc).isoformat()
            digest["model"] = (
                os.environ.get("BRIEF_LLM")
                or os.environ.get("SMART_LLM")
                or "anthropic:claude-haiku-4-5"
            )
            digest["narrativeDegraded"] = False
            digest["_candidateCount"] = len(candidates)
            break

        logger.warning(
            "digest.llm_json_failed",
            extra={"attempt": attempt, "preview": llm_output[:200].replace("\n", " ")},
        )
        if attempt < 2:
            prompt = (
                prompt
                + "\n\n【重要】上一次你的输出 JSON 解析失败。请严格只输出 JSON，"
                "不要 wrapping markdown 代码块、不要解释、不要在花括号外加任何文字。"
            )

    if digest is None:
        logger.warning("digest.degraded_fallback")
        digest = _degraded_digest(candidates, target_date_str)

    digest = _normalize_highlights(digest)
    digest = _resolve_ranked_links(digest, candidates)
    markdown = _render_markdown(digest)
    meta = _digest_meta(
        digest,
        target_date=target_date,
        candidate_count=len(candidates),
    )
    summary_id = await _upsert_digest(
        pool,
        target_date=target_date,
        markdown=markdown,
        meta=meta,
    )
    return DailyDigestResult(
        date=target_date_str,
        summary_id=summary_id,
        markdown=markdown,
        candidate_count=len(candidates),
        narrative_degraded=bool(digest.get("narrativeDegraded")),
    )


async def _main_async(args: argparse.Namespace) -> int:
    # The server loads the project environment during boot, while the CLI is
    # invoked directly. Load the same local .env so BRIEF/SMART_LLM and proxy
    # base URLs are consistent in both paths.
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))
    from psycopg_pool import AsyncConnectionPool

    dsn = os.environ.get("DATABASE_URL", "postgresql://localhost:5432/deep_research")
    print(f"[INFO] Connecting to DB: {dsn[:60]}...", file=sys.stderr)
    pool = AsyncConnectionPool(dsn, min_size=1, max_size=2, open=False)
    await pool.open()
    try:
        result = await generate_daily_digest(
            pool,
            target_date=date.fromisoformat(args.date),
            dry_run=args.dry_run,
            candidate_limit=args.limit,
        )
    finally:
        await pool.close()

    if not result.markdown:
        return 0
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result.markdown)
        print(f"[INFO] Wrote digest to {args.output}", file=sys.stderr)
    else:
        print(result.markdown)
    return 0


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Generate a daily AI radar digest (cross-source article)."
    )
    p.add_argument(
        "--date",
        default=date.today().isoformat(),
        help="Target date in YYYY-MM-DD (default: today UTC).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print prompt only, no LLM call and no DB write.",
    )
    p.add_argument(
        "--output",
        "-o",
        help="Write Markdown to file instead of stdout.",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=40,
        help="Max high-scoring candidates to include (default: 40).",
    )
    return p.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = _parse_args()
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "DailyDigestResult",
    "ELIGIBLE_TIERS",
    "generate_daily_digest",
    "query_digest_candidates",
]
