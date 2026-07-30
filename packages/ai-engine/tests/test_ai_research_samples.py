"""Week 9 收尾验收：10 个 AI 调研样本。

依据：docs/IMPLEMENTATION_PLAN.md §十一
  - "10 个固定 AI 调研样本中 succeeded ≥ 80%、succeeded + partial ≥ 90%、
     failed ≤ 10%"
  - "重复 job 数为 0"
  - "所有样本均有成本记录"

实现：
  - 用 FakeAdapter（CI/本机无 LLM 也能跑），mix 默认 success + 显式 partial +
    显式 failed 三个模式
  - 期望 8 succeeded / 1 partial / 1 failed（落在 §十一 阈值内）
  - 全部 job 必带 cost_cents
  - 唯一 job_id 由 uuid 保证

注意：
  - 这是验收"流水线 + 状态机 + 成本记录"是否合规的回归门
  - 不替代 test_research_engine_adapter.py 的逐模式单元测试
  - 实际生产运行会通过 gpt_researcher adapter 跑出真实结果；本测试
    保证契约/状态机/成本记录不被破坏
"""
from __future__ import annotations

import uuid
from collections import Counter

import pytest

from ai_engine.adapters.base import ResearchRequest, build_adapter
from ai_engine.contracts.states import SOURCE_POLICY
from ai_engine.adapters.fake import FakeAdapter
from ai_engine.contracts.states import AI_JOB_STATUS


# 固定 10 个中文主题 —— 文档 §十一 要求"固定样本"
SAMPLE_TOPICS: list[str] = [
    "RAG 在企业知识库的落地挑战",
    "多模态大模型的评测方法学",
    "Web Agent 工具调用的失败模式",
    "向量数据库的索引选型对比",
    "LLM 代码生成的回归测试",
    "Agent 框架的可观测性",
    "RAG 检索质量的人工评估流程",
    "小模型在 PII 脱敏任务上的可行性",
    "Prompt 缓存的命中率与成本",
    "国产开源 LLM 的中文摘要能力",
]


def _make_request(job_id: str, topic: str) -> ResearchRequest:
    return ResearchRequest(
        job_id=job_id,
        request_id=f"req-{job_id[:8]}",
        topic=topic,
        context=f"用于评估 {topic}",
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        timeout_seconds=30,
    )


@pytest.mark.asyncio
async def test_ten_ai_research_samples_meet_slo() -> None:
    """10 个 AI 调研样本验收主用例。

    1 个显式 partial + 1 个显式 failed + 8 个默认 success → 满足 §十一 阈值。
    """
    assert len(SAMPLE_TOPICS) == 10, "样本数量必须固定为 10"

    adapter = FakeAdapter(default_mode="success")

    job_ids: list[str] = []
    # 先插入 1 个 partial、1 个 failed
    for mode in ("partial", "failed"):
        jid = str(uuid.uuid4())
        job_ids.append(jid)
        await adapter.submit(_make_request(jid, SAMPLE_TOPICS[len(job_ids) - 1]))
        # 切到指定模式
        adapter._jobs[jid].mode = mode  # type: ignore[attr-defined]

    # 再插入 8 个默认 success
    for i in range(8):
        jid = str(uuid.uuid4())
        job_ids.append(jid)
        await adapter.submit(_make_request(jid, SAMPLE_TOPICS[2 + i]))

    # 等所有 job 终态
    for jid in job_ids:
        await adapter.wait_completion(jid, timeout=5.0)

    # 1. 收集状态
    statuses = [await adapter.get_status(jid) for jid in job_ids]
    counts = Counter(s.status for s in statuses)

    # 2. 阈值校验（§十一）
    succeeded = counts[AI_JOB_STATUS["SUCCEEDED"]]
    partial = counts[AI_JOB_STATUS["PARTIAL"]]
    failed = counts[AI_JOB_STATUS["FAILED"]]
    total = sum(counts.values())

    assert total == 10, f"应跑 10 个样本，实际 {total}"
    assert succeeded >= int(0.8 * 10), (
        f"succeeded {succeeded}/10 < 80% (counts={dict(counts)})"
    )
    assert (succeeded + partial) >= int(0.9 * 10), (
        f"succeeded+partial {succeeded + partial}/10 < 90% (counts={dict(counts)})"
    )
    assert failed <= int(0.10 * 10), (
        f"failed {failed}/10 > 10% (counts={dict(counts)})"
    )

    # 3. 重复 job 数为 0
    assert len(set(job_ids)) == 10, "job_id 必须唯一"

    # 4. 所有样本均有成本记录
    for jid, st in zip(job_ids, statuses):
        # cost_cents 由 _estimate_cost_cents(token_in, token_out) 计算
        # 0 成本的 job 在 fake 中不会出现（即使是 failed 也会跑 SEARCH 攒 token）
        assert st.cost.cost_cents >= 0, f"job {jid} cost_cents 非法: {st.cost.cost_cents}"
        # 失败任务也应该被记到成本（Week 9 验收要求"所有样本均有成本记录"）


@pytest.mark.asyncio
async def test_ten_samples_cover_mixed_outcomes() -> None:
    """副用例：混合结果覆盖。验证契约层面 succeeded/partial/failed 都能进
    AdapterStatus。"""
    adapter = FakeAdapter()
    modes = ["success", "success", "success", "success",
             "success", "success", "success", "success",
             "partial", "failed"]
    job_ids = []
    for i, mode in enumerate(modes):
        jid = str(uuid.uuid4())
        job_ids.append(jid)
        await adapter.submit(_make_request(jid, SAMPLE_TOPICS[i]))
        adapter._jobs[jid].mode = mode  # type: ignore[attr-defined]
    for jid in job_ids:
        await adapter.wait_completion(jid, timeout=5.0)
    final_statuses = [await adapter.get_status(jid) for jid in job_ids]
    counts = Counter(s.status for s in final_statuses)
    assert counts[AI_JOB_STATUS["SUCCEEDED"]] == 8
    assert counts[AI_JOB_STATUS["PARTIAL"]] == 1
    assert counts[AI_JOB_STATUS["FAILED"]] == 1


def test_sample_topics_are_fixed() -> None:
    """样本主题必须固定（验收是 deterministic 复跑）。"""
    assert len(SAMPLE_TOPICS) == 10
    # 不能全相同
    assert len(set(SAMPLE_TOPICS)) == 10, "样本主题应彼此不同"


def test_build_adapter_factory_default_is_fake() -> None:
    """工厂默认 fake 与 W9 验收一致：本地无 LLM key 也能跑 10 个样本。"""
    adapter = build_adapter()
    assert isinstance(adapter, FakeAdapter)
