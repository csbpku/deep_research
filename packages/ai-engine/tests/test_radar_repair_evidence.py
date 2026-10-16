"""Regression coverage for real large-source and misleading excerpt failures."""
from types import SimpleNamespace
from unittest.mock import AsyncMock
import json

import pytest

from ai_engine.fetcher.safe_fetch import SafeFetchError
from ai_engine.radar import repair as r
from ai_engine.radar.distilled_scorer import DIM_NAMES, build_user_prompt


def row():
    return {'id': 'test', 'title': 'A verified implementation', 'canonicalUrl': 'https://example.org/article',
            'sourceType': 'rss', 'body': 'Existing useful summary ' * 8, 'interpretation': 'Existing useful judgement ' * 4,
            'distilledScore': None, 'tags': ['external_reading']}


async def test_large_html_repair_keeps_a_bounded_excerpt(monkeypatch):
    source = 'A verified implementation documents concrete architecture and its limitations. ' * 500
    doc = SimpleNamespace(status=200, url=row()['canonicalUrl'], headers={}, content=source.encode())
    fetch = AsyncMock(side_effect=[SafeFetchError('URL_FETCH_TOO_LARGE', 'limit'), doc])
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    monkeypatch.setattr(r, '_extract_article_content', lambda *a, **k: source)
    complete = AsyncMock()
    monkeypatch.setattr(r, 'complete_article', complete)
    evidence = await r.acquire_evidence(row())
    assert evidence.kind == 'source_excerpt' and not evidence.complete
    assert len(evidence.text) == 18000
    assert [x.kwargs['max_bytes'] for x in fetch.await_args_list] == [2_000_000, 8_000_000]
    assert all(x.kwargs['allowed_hosts'] == ('example.org', 'www.example.org') for x in fetch.await_args_list)
    assert all(x.kwargs['max_redirects'] == 3 for x in fetch.await_args_list)
    complete.assert_not_called()


@pytest.mark.parametrize('code', ['URL_FETCH_BLOCKED', 'CONTENT_TYPE_REJECTED', 'URL_FETCH_TIMEOUT'])
async def test_non_size_failures_never_trigger_a_larger_read(monkeypatch, code):
    fetch = AsyncMock(side_effect=SafeFetchError(code, 'redacted'))
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    with pytest.raises(SafeFetchError) as failure:
        await r.acquire_evidence(row())
    assert failure.value.code == code and fetch.await_count == 1


async def test_over_eight_megabytes_stays_a_source_failure(monkeypatch):
    fetch = AsyncMock(side_effect=SafeFetchError('URL_FETCH_TOO_LARGE', 'limit'))
    monkeypatch.setattr(r, 'safe_fetch', fetch)
    with pytest.raises(SafeFetchError):
        await r.acquire_evidence(row())
    assert fetch.await_count == 2
    assert r.retry_state(r.failure(SafeFetchError('URL_FETCH_TOO_LARGE', 'limit')), 3, 1)['status'] == 'blocked'


def test_source_excerpt_prompt_never_claims_full_coverage():
    prompt = build_user_prompt('A source', 'Only a partial excerpt', content_is_source_excerpt=True)
    assert '以下仅为来源片段，未覆盖全文' in prompt
    assert '不得断言片段中未提及的内容不存在' in prompt
    assert '以下是逐块覆盖全文' not in prompt and '本次评分输入的完整正文' not in prompt
    assert '以下是逐块覆盖全文' in build_user_prompt('A source', 'Covered all chunks', content_is_chunk_evidence=True)
    assert '本次评分输入的完整正文' in build_user_prompt('A source', 'Complete text')


@pytest.mark.parametrize('kind,code', [('mismatch', 'MODEL_TITLE_MISMATCH'), ('unsafe', 'MODEL_UNSAFE_VETO'),
                                     ('zero', 'MODEL_UNASSESSABLE'), ('missing', 'MODEL_SCORE_FORMAT')])
async def test_score_rejection_has_a_specific_reason_and_never_fabricates_scores(kind, code):
    scores = dict.fromkeys(DIM_NAMES, 0)
    if kind == 'mismatch':
        scores['veto'] = 'title_content_mismatch'
    elif kind == 'unsafe':
        scores['veto'] = 'unsafe_content'
    elif kind == 'missing':
        scores = {'信息增量': 2}
    call = AsyncMock(return_value=SimpleNamespace(text=json.dumps(scores)))
    with pytest.raises(r.RepairFailure) as failure:
        await r.derive(row(), r.Evidence('A brief source excerpt', 'source_excerpt', False), call, fields='score')
    assert failure.value.code == code
    if kind != 'missing':
        assert not failure.value.retryable
    assert '以下仅为来源片段' in call.call_args.kwargs['user_prompt']
    call.assert_awaited_once()
