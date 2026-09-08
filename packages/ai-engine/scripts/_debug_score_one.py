"""Debug a single noise row to see why scoring returns default_score."""
from __future__ import annotations

import asyncio
import os
import sys
import time

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PACKAGE_ROOT)
load_dotenv(os.path.join(PACKAGE_ROOT, ".env"))

from ai_engine.job_runner.db_store import DbJobStore  # noqa: E402
from ai_engine.radar.distilled_scorer import score_with_llm  # noqa: E402


async def main() -> int:
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT id, title, length(\"originalMarkdown\") AS l, "
                    "\"originalMarkdown\" AS md, \"url\" AS url "
                    "FROM summaries "
                    "WHERE \"distilledTier\"='noise' "
                    "AND length(coalesce(\"originalMarkdown\",body,''))>=24000 "
                    "AND \"originalMarkdown\" IS NOT NULL "
                    "ORDER BY \"updatedAt\" DESC LIMIT 1"
                )
            ).fetchone()
        if row is None:
            print("no row found")
            return 1
        sid = str(row["id"])
        title = row["title"]
        md = row["md"]
        url = row["url"]
        print(f"target={sid} len={row['l']} url={url}", flush=True)
        t0 = time.time()
        try:
            r = await score_with_llm(
                title,
                md,
                source_type="arxiv",
                url=url,
            )
            if r.is_default:
                # Re-run once with debug printing to surface the failure path.
                from ai_engine.llm.client import generate_text
                from ai_engine.llm.config import resolve_spec
                spec = resolve_spec("utility")
                from ai_engine.radar.distilled_scorer import (
                    build_user_prompt, _prepare_scoring_content,
                )
                prepared = _prepare_scoring_content(title, md, source_type="arxiv", url=url)
                user_prompt = build_user_prompt(
                    title, prepared, source_type="arxiv", url=url,
                )
                try:
                    res = await generate_text(
                        llm_spec=spec, system_prompt="", user_prompt=user_prompt,
                        max_tokens=200, timeout=60, disable_thinking=True,
                        operation="debug",
                    )
                    print(
                        f"raw_elapsed={time.time()-t0:.1f}s raw_text len={len(res.text)}",
                        flush=True,
                    )
                    print("raw_head=", res.text[:200], flush=True)
                except Exception as exc:
                    print(
                        f"raw_elapsed={time.time()-t0:.1f}s raw_EXC {type(exc).__name__}: {str(exc)[:300]}",
                        flush=True,
                    )
            print(
                f"elapsed={time.time()-t0:.1f}s default={r.is_default} "
                f"tier={r.tier} total={r.total}"
            )
        except Exception as exc:
            print(
                f"elapsed={time.time()-t0:.1f}s EXC "
                f"{type(exc).__name__}: {str(exc)[:400]}"
            )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
