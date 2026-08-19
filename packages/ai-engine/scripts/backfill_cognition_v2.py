"""One-shot backfill for cognition-loop V2 (ADR 0010).

调用：
  cd packages/ai-engine && uv run python -m scripts.backfill_cognition_v2

执行：
  1) 把现有 Topic.synthesisVersion 设为 v2（migration 已设，但兜底）
  2) 把现有 Topic.synthesisInputHash 设为旧 hash 强制下次再生成
  3) 跑一轮 TopicIssue 聚类
  4) 跑一轮 Synthesis V2（hash 变化触发生成）
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import psycopg
from dotenv import load_dotenv

logger = logging.getLogger("ai_engine.backfill_cognition_v2")
load_dotenv()


async def _run() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL missing", file=sys.stderr)
        return 2

    from ai_engine.radar.topic_issue_worker import run_topic_issue_worker
    from ai_engine.radar.topic_synthesis_v2 import run_topic_synthesis_v2

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        # 强制刷新：清空现有 hash，让 worker 重跑
        await conn.execute(
            "UPDATE topics SET \"synthesisInputHash\" = NULL WHERE \"synthesisVersion\" = 'v2'"
        )
        await conn.execute("UPDATE topics SET \"synthesisVersion\" = 'v2'")
        await conn.commit()
        print("cleared synthesis hash + bumped version to v2")

    pool = await psycopg.AsyncConnectionPool.connect(dsn, min_size=1, max_size=2)
    try:
        issue_stats = await run_topic_issue_worker(pool)
        synth_stats = await run_topic_synthesis_v2(pool)
    finally:
        await pool.close()

    print(f"issue_worker: {issue_stats}")
    print(f"synthesis_v2: {synth_stats}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
