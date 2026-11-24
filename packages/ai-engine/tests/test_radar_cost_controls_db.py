"""Real PostgreSQL + actual pipeline/client; the provider wire is an in-memory fake."""

from __future__ import annotations

import json
import os
from uuid import uuid4

import pytest
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ai_engine.adapters.gpt_researcher import GptResearcherAdapter
from ai_engine.llm import client
from ai_engine.llm.client import TextGenerationResult
from ai_engine.radar.distilled_scorer import score_with_llm
from ai_engine.radar.models import RadarCandidate
from ai_engine.radar.sync_runner import run_radar_pipeline

pytestmark = pytest.mark.requires_db


async def test_budget_deferral_is_durable_and_paid_usage_reconciles(monkeypatch):  # type: ignore[no-untyped-def]
    dsn = os.environ.get("RADAR_COST_TEST_DSN", "")
    if not dsn:
        pytest.skip("set RADAR_COST_TEST_DSN to an isolated loopback *_test DB")
    cfg = conninfo_to_dict(dsn)
    assert cfg.get("host") in {"localhost", "127.0.0.1", "::1"} and cfg["dbname"].endswith("_test")
    for key, value in {
        "DATABASE_URL": dsn,
        "RADAR_READING_MODE": "browser",
        "UTILITY_LLM": "openai:test-model",
        "RESEARCH_LLM": "openai:test-model",
        "FALLBACK_LLM": "openai:test-model",
        "OPENAI_API_KEY": "fake-provider-key",
        "LLM_USAGE_AUDIT_ENABLED": "true",
        "LLM_TOKEN_BUDGET_USER_LIMIT": "0",
        "LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT": "0",
        "RADAR_SOURCE_MAX_CALLS": "3",
        "RADAR_SOURCE_MAX_TOKENS": "50000",
    }.items():
        monkeypatch.setenv(key, value)
    pool = AsyncConnectionPool(dsn, min_size=1, max_size=3, open=False, kwargs={"row_factory": dict_row})
    await pool.open(wait=True)
    sid, old_run, old_summary = (str(uuid4()) for _ in range(3))
    base = uuid4().int % 90000 + 10000
    urls = [f"https://arxiv.org/abs/2611.{base + i}" for i in range(3)]
    payload = {"immutableExistingScore": str(uuid4())}
    async with pool.connection() as c:
        await c.execute(
            "INSERT INTO radar_sources (id,name,\"sourceType\",config,\"updatedAt\") VALUES (%s,'cost control test','arxiv','{}',now())",
            (sid,),
        )
        await c.execute(
            "INSERT INTO radar_sync_runs (id,\"sourceId\",\"triggeredBy\",status) VALUES (%s,%s,'admin','completed')",
            (old_run, sid),
        )
        await c.execute(
            'INSERT INTO summaries (id,title,body,url,"canonicalUrl",source,"summaryDate","syncRunId","updatedAt","distilledScore",tags) VALUES (%s,\'Existing agent\',\'preserve body\',%s,%s,\'daily\',current_date,%s,now(),%s,%s)',
            (old_summary, urls[0], urls[0], old_run, Jsonb(payload), ["external_reading"]),
        )
        await c.commit()
    wire_calls = []
    abstract = (
        "This agent benchmark compares working implementations, measured task results, reproducible deployment methods and explicit limitations. "
        * 5
    )

    async def fetcher(config):  # type: ignore[no-untyped-def]
        return [
            RadarCandidate("Agent engineering benchmark", u, snippet=abstract, content_origin="api")
            for u in urls
        ]

    async def no_fetch(*args, **kwargs):  # type: ignore[no-untyped-def]
        pytest.fail("arXiv discovery must not fetch full papers")

    async def wire(**kwargs):  # type: ignore[no-untyped-def]
        wire_calls.append(kwargs)
        if kwargs["max_tokens"] == 4096:
            text = json.dumps(
                {
                    k: 3
                    for k in [
                        "信息增量",
                        "分析深度",
                        "可行动性",
                        "事实可信度",
                        "时效性",
                        "表达质量",
                        "综合信号",
                    ]
                }
                | {
                    "direct_relevance": 3,
                    "relevance_evidence": "agent benchmark compares working implementations",
                }
            )
        else:
            text = "本文比较智能体工程实现和基准测试结果，提供可复现的方法，并说明部署条件和局限。" * 5
        return TextGenerationResult(text, 20, 10, "test-model", "test-model", "openai")

    monkeypatch.setattr(client, "_generate_text_once", wire)
    try:
        async with pool.connection() as c:
            before_usage = await (
                await c.execute(
                    'SELECT COALESCE(sum("inputTokens"),0) AS inp, COALESCE(sum("outputTokens"),0) AS out FROM llm_usage_events'
                )
            ).fetchone()
        result = await run_radar_pipeline(
            pool,
            source_ids={sid},
            adapter=GptResearcherAdapter(),
            fetchers={"arxiv": fetcher},
            document_fetcher=no_fetch,
            distilled_scorer=score_with_llm,
            candidate_concurrency=1,
            triggered_by="admin",
        )
        assert len(result.sync.runs) == 1  # No whole-source retry after local budget.
        run = result.sync.runs[0]
        assert run.status == "partial" and run.error_code == "MODEL_WORK_BUDGET_EXCEEDED"
        assert len(wire_calls) == 3  # One brief+score; next brief paid, score denied.
        assert (run.token_input_total, run.token_output_total) == (60, 30)
        async with pool.connection() as c:
            old = await (
                await c.execute('SELECT body,"distilledScore" FROM summaries WHERE id=%s', (old_summary,))
            ).fetchone()
            assert old["body"] == "preserve body" and old["distilledScore"] == payload
            diagnostic = await (
                await c.execute(
                    'SELECT status,"reasonCode" FROM radar_sync_diagnostics WHERE "runId"=%s', (run.run_id,)
                )
            ).fetchall()
            assert any(
                d["status"] == "pending" and d["reasonCode"] == "MODEL_WORK_BUDGET_EXCEEDED"
                for d in diagnostic
            )
            recorded = await (
                await c.execute(
                    'SELECT "tokenInputTotal","tokenOutputTotal" FROM radar_sync_runs WHERE id=%s',
                    (run.run_id,),
                )
            ).fetchone()
            assert (recorded["tokenInputTotal"], recorded["tokenOutputTotal"]) == (60, 30)
            audit = await (
                await c.execute(
                    'SELECT COALESCE(sum("inputTokens"),0) AS inp, COALESCE(sum("outputTokens"),0) AS out FROM llm_usage_events'
                )
            ).fetchone()
            assert (audit["inp"] - before_usage["inp"], audit["out"] - before_usage["out"]) == (60, 30)
    finally:
        await pool.close()


async def test_abstract_noise_is_pending_and_next_sync_does_not_pay_again(monkeypatch):  # type: ignore[no-untyped-def]
    dsn = os.environ.get("RADAR_COST_TEST_DSN", "")
    if not dsn:
        pytest.skip("isolated test DB required")
    cfg = conninfo_to_dict(dsn)
    assert cfg.get("host") in {"localhost", "127.0.0.1", "::1"} and cfg["dbname"].endswith("_test")
    for key, value in {
        "DATABASE_URL": dsn,
        "RADAR_READING_MODE": "browser",
        "UTILITY_LLM": "openai:test-model",
        "RESEARCH_LLM": "openai:test-model",
        "FALLBACK_LLM": "openai:test-model",
        "OPENAI_API_KEY": "fake-key",
        "LLM_USAGE_AUDIT_ENABLED": "false",
        "LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT": "0",
        "LLM_TOKEN_BUDGET_USER_LIMIT": "0",
    }.items():
        monkeypatch.setenv(key, value)
    pool = AsyncConnectionPool(dsn, min_size=1, max_size=3, open=False, kwargs={"row_factory": dict_row})
    await pool.open(wait=True)
    sid = str(uuid4())
    url = f"https://arxiv.org/abs/2611.{uuid4().int % 90000 + 10000}"
    async with pool.connection() as c:
        await c.execute(
            "INSERT INTO radar_sources (id,name,\"sourceType\",config,\"updatedAt\") VALUES (%s,'abstract pending test','arxiv','{}',now())",
            (sid,),
        )
        await c.commit()
    calls = []

    async def wire(**kwargs):  # type: ignore[no-untyped-def]
        calls.append(kwargs)
        text = (
            json.dumps(
                {
                    k: 1
                    for k in [
                        "信息增量",
                        "分析深度",
                        "可行动性",
                        "事实可信度",
                        "时效性",
                        "表达质量",
                        "综合信号",
                    ]
                }
            )
            if kwargs["max_tokens"] == 4096
            else "本文仅提供初步研究设想，缺少可复用的实现细节和验证结果，需要读者打开原文确认适用范围。" * 4
        )
        return TextGenerationResult(text, 20, 10, "test-model", "test-model", "openai")

    monkeypatch.setattr(client, "_generate_text_once", wire)

    async def fetcher(config):  # type: ignore[no-untyped-def]
        return [
            RadarCandidate(
                "Agent benchmark study",
                url,
                snippet="This study describes an agent benchmark, preliminary findings and relevant limitations for implementation. "
                * 6,
                content_origin="api",
            )
        ]

    async def no_fetch(*args, **kwargs):  # type: ignore[no-untyped-def]
        pytest.fail("abstract discovery fetched a full paper")

    try:
        for _ in range(2):
            result = await run_radar_pipeline(
                pool,
                source_ids={sid},
                adapter=GptResearcherAdapter(),
                fetchers={"arxiv": fetcher},
                document_fetcher=no_fetch,
                distilled_scorer=score_with_llm,
                triggered_by="admin",
            )
            assert result.sync.runs[0].total_new == 0
        assert len(calls) == 2
        async with pool.connection() as c:
            rows = await (
                await c.execute(
                    'SELECT "reasonCode",status FROM radar_sync_diagnostics WHERE "sourceId"=%s', (sid,)
                )
            ).fetchall()
            assert (
                len(rows) == 1
                and rows[0]["reasonCode"] == "SOURCE_EXCERPT_NOISE_PENDING"
                and rows[0]["status"] == "pending"
            )
            assert (
                await (
                    await c.execute('SELECT count(*) AS n FROM summaries WHERE "canonicalUrl"=%s', (url,))
                ).fetchone()
            )["n"] == 0
    finally:
        await pool.close()
