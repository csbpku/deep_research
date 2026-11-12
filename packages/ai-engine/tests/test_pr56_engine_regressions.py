"""Regression coverage for review lifetimes and the real memo adapter boundary."""
from __future__ import annotations

import asyncio
import importlib
import json
from types import SimpleNamespace

import httpx
import pytest

from ai_engine import reviewer
from ai_engine.adapters.base import AdapterSource, ResearchRequest
from ai_engine.adapters.gpt_researcher import GptResearcherAdapter, _Job
from ai_engine.llm import token_budget


def _source(*, captured: bool = True) -> AdapterSource:
    url = 'https://example.com/captured' if captured else 'https://example.com/discovered'
    return AdapterSource(
        source_ref={'type': 'url', 'value': url}, canonical_key=url,
        title='Captured docs' if captured else 'Discovery only',
        snippet='Captured passage proves the bounded claim.' if captured else None,
        score=1.0, step_captured='search',
        evidence_status='fetched' if captured else 'discovered',
    )


@pytest.mark.asyncio
async def test_inventory_failure_awaits_siblings_before_budget_settlement(monkeypatch: pytest.MonkeyPatch):
    events: list[str] = []
    started = asyncio.Event()
    stopped = asyncio.Event()
    provider_tasks: list[asyncio.Task] = []
    chunks = [SimpleNamespace(index=i, start=i, end=i + 1, text=f'chunk{i}') for i in (1, 2)]

    async def reserve(**_):
        return token_budget.TokenReservation('reservation', 100_000)

    async def release(_):
        events.append('release')
        assert stopped.is_set(), 'budget released while sibling provider request is still alive'

    async def generate(**kwargs):
        provider_tasks.append(asyncio.current_task())
        if 'chunk1' in kwargs['user_prompt']:
            await started.wait()
            raise RuntimeError('provider failed')
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            # Simulate asynchronous SDK cleanup, not just task.cancel().
            await asyncio.sleep(0)
            stopped.set()
            events.append('provider_stopped')

    monkeypatch.setattr(reviewer, 'split_text_by_token_budget', lambda *args: chunks)
    monkeypatch.setattr(reviewer, 'generate_text', generate)
    monkeypatch.setattr(token_budget, 'reserve_llm_tokens', reserve)
    monkeypatch.setattr(token_budget, 'release_llm_tokens', release)
    result = await reviewer.DefaultResearchReviewer().review('plain report', (_source(),), 'topic')
    # Keep the failing baseline run from leaking its intentionally blocked request.
    for task in provider_tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*provider_tasks, return_exceptions=True)
    assert result.status == 'review_unavailable'
    assert events == ['provider_stopped', 'release']


@pytest.mark.asyncio
async def test_recursive_adjudication_respects_shared_concurrency(monkeypatch: pytest.MonkeyPatch):
    active = peak = calls = 0
    monkeypatch.setenv('FACT_REVIEW_CONCURRENCY', '3')
    monkeypatch.setenv('FACT_REVIEW_BATCH_SIZE', '6')

    async def generate(**_):
        nonlocal active, peak, calls
        active += 1
        peak = max(peak, active)
        calls += 1
        try:
            await asyncio.sleep(0.001)
            raise ValueError('malformed JSON')
        finally:
            active -= 1

    async def emit(*_):
        pass

    inventory = tuple(reviewer.ClaimInventoryItem(f'C{i}', f'claim {i}', 'medium', 'external_fact')
                      for i in range(18))
    monkeypatch.setattr(reviewer, 'generate_text', generate)
    result = await reviewer._adjudicate_fact_batches(
        inventory=inventory, source_text='captured evidence', topic='topic',
        report_type='research_report', llm_spec=None, inventory_coverage='complete', emit_phase=emit,
    )
    assert calls > 6, 'the fixture must exercise recursive split recovery'
    assert result.coverage_status == 'insufficient'
    assert peak <= 3


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [401, 403, 429])
async def test_auth_and_quota_failures_do_not_split_or_retry(monkeypatch: pytest.MonkeyPatch, status: int):
    calls = 0

    async def generate(**_):
        nonlocal calls
        calls += 1
        response = httpx.Response(status, request=httpx.Request('POST', 'https://provider.example'))
        response.raise_for_status()

    monkeypatch.setattr(reviewer, 'generate_text', generate)
    result, error = await reviewer._adjudicate_batch_with_split(
        batch=tuple(reviewer.ClaimInventoryItem(f'C{i}', f'claim {i}', 'medium', 'external_fact')
                    for i in range(6)),
        batch_index=1, batch_count=1, topic='topic', report_type='research_report',
        source_text='evidence', llm_spec=None,
    )
    assert result is None and error is not None
    assert calls == 1


SHORT_MEMO = '''# 决策备忘

## 问题
应选择哪个工具？

## 建议
当前证据不足，暂不能定案。

## 关键声明
没有充分证据支持长期成本差异，未确认。 [S1]

## 风险与未确认
缺少真实负载数据。

## 下一步验证
测量团队现有 CI 运行时间。
'''
FULL_REPORT = '## 结论\n\n' + '完整报告保留研究结论、证据与适用限制。' * 30 + ' [S1]。'


async def _run_memo_job(monkeypatch: pytest.MonkeyPatch, model_text: str, *, truncated: bool = False):
    module = importlib.import_module('ai_engine.adapters.gpt_researcher')
    memo_module = importlib.import_module('ai_engine.decision_memo')
    prompts: list[str] = []
    sources = [_source(captured=False), _source()]

    async def load(self, job):
        job.sources = sources
        return sources

    async def write(**_):
        return FULL_REPORT

    async def hydrate(items, **_):
        return items

    async def usage(*_):
        pass

    async def generate(**kwargs):
        prompts.append(kwargs['user_prompt'])
        return SimpleNamespace(text=model_text, truncated=truncated)

    monkeypatch.setattr(GptResearcherAdapter, '_load_locked_user_sources', load)
    monkeypatch.setattr(module, '_write_report_with_bounded_client', write)
    monkeypatch.setattr(module, '_hydrate_source_snippets', hydrate)
    monkeypatch.setattr(module, 'record_llm_usage', usage)
    monkeypatch.setattr(memo_module, 'generate_text', generate)
    adapter = GptResearcherAdapter(llm_spec='openai:test', brief_llm='openai:test')
    job = _Job(ResearchRequest(
        job_id='memo-regression', request_id='memo-regression', topic='tool decision', context=None,
        report_type='decision_memo', source_policy='only_user_sources', source_refs=(),
    ))
    await adapter._run(job)
    return job, prompts


@pytest.mark.asyncio
async def test_real_adapter_keeps_short_complete_memo_readable(monkeypatch: pytest.MonkeyPatch):
    job, _ = await _run_memo_job(monkeypatch, SHORT_MEMO)
    assert job.status == 'succeeded', job.error_message
    assert '暂不能定案' in job.body
    assert job.review_phase == 'queued'


@pytest.mark.asyncio
async def test_real_adapter_uses_captured_namespace_and_materializes_memo_citations(monkeypatch: pytest.MonkeyPatch):
    memo = SHORT_MEMO.replace('没有充分证据支持长期成本差异，未确认。', '证据中的结论。' * 40)
    job, prompts = await _run_memo_job(monkeypatch, memo)
    assert job.status == 'succeeded', job.error_message
    assert '[S1] Captured docs' in prompts[0]
    assert 'Discovery only' not in prompts[0]
    assert '[S1]' not in job.body
    assert '[Captured docs](https://example.com/captured)' in job.body.split('## 参考文献')[0]
    assert len(reviewer._citation_ledger(job.body, tuple(job.sources))) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('model_text,truncated', [
    ('# 决策备忘\n## 建议\n## 关键声明\n', False),
    (SHORT_MEMO, True),
])
async def test_real_adapter_preserves_report_when_memo_contract_fails(
    monkeypatch: pytest.MonkeyPatch, model_text: str, truncated: bool,
):
    job, prompts = await _run_memo_job(monkeypatch, model_text, truncated=truncated)
    assert job.status == 'succeeded', job.error_message
    assert '完整报告保留研究结论' in job.body
    assert len(prompts) == 2
