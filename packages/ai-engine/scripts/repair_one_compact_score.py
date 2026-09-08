"""One-off compact-prompt repair for a verified complete article."""

from __future__ import annotations

import asyncio
import json
import os

from dotenv import load_dotenv

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.llm.client import generate_text
from ai_engine.llm.config import resolve_spec
from ai_engine.radar.distilled_scorer import (
    _parse_llm_response,
    build_distilled_score_reason,
    compute_score,
)
from ai_engine.scoring.scoring_profiles import profile_for_source_url

SUMMARY_ID = "ac7d0a28-621b-45cc-ac2b-c4c7b615c654"


async def main() -> int:
    load_dotenv()
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            row = dict(
                await (
                    await conn.execute(
                        'SELECT "title", "url", "publishedAt", '
                        'COALESCE("originalMarkdown", body, title) AS content '
                        'FROM summaries WHERE "id" = %s',
                        (SUMMARY_ID,),
                    )
                ).fetchone()
            )
        profile, _ = profile_for_source_url("arxiv", str(row["url"] or ""))
        content = str(row["content"] or "")[:6_000]
        prompt = f"""只输出一个完整 JSON 对象，不要解释、不要 markdown、不要 <think>。
给这篇 arXiv 论文按 0-3 分评分：信息增量、分析深度、可行动性、事实可信度、时效性、表达质量、综合信号。
另填 direct_relevance、scope_breadth、validation_breadth、implementation_stage、weak_point、veto、risk_flag、suspected_repost。
标题：{row["title"]}
正文代表性片段：
{content}
JSON 键必须为：信息增量,分析深度,可行动性,事实可信度,时效性,表达质量,综合信号,direct_relevance,relevance_evidence,scope_breadth,scope_evidence,validation_breadth,implementation_stage,weak_point,veto,risk_flag,suspected_repost。"""
        result = await generate_text(
            llm_spec=resolve_spec("utility"),
            system_prompt="你是严格的技术论文评分器，只返回可解析 JSON。",
            user_prompt=prompt,
            max_tokens=4096,
            timeout=60.0,
            disable_thinking=True,
            operation="radar.distilled_score",
        )
        parsed = _parse_llm_response(result.text)
        score = compute_score(
            parsed,
            profile=profile,
            source_type="arxiv",
            evidence_text=f'{row["title"]}\n{content}',
            url=str(row["url"] or ""),
        )
        if score.is_default:
            raise RuntimeError("compact scorer returned default score")
        total = score.tier_score if score.tier_score is not None else score.total
        async with store.pool.connection() as conn:
            await conn.execute(
                'UPDATE "summaries" SET "distilledScore" = %s::jsonb, '
                '"distilledTotal" = %s, "distilledTier" = %s, '
                '"distilledProfile" = %s, '
                '"scoreReason" = %s, "tags" = array_remove('
                'COALESCE("tags", ARRAY[]::text[]), \'content_pending\'), '
                '"updatedAt" = now() WHERE "id" = %s',
                (
                    json.dumps(score.to_dict(), ensure_ascii=False),
                    total,
                    score.tier,
                    score.profile_id,
                    build_distilled_score_reason(score),
                    SUMMARY_ID,
                ),
            )
        print(
            f"scored=1 total={total} tier={score.tier} "
            f"model={result.actual_model or result.requested_model}",
            flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
