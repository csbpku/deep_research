from __future__ import annotations

from copy import deepcopy
from typing import Any
from unittest.mock import AsyncMock

import pytest

from ai_engine.radar.distilled_scorer import compute_score
from ai_engine.radar.noise_policy import NOISE_POLICY, confirmed_noise
from ai_engine.radar import repair as r


def noise_score() -> dict[str, Any]:
    return compute_score(dict.fromkeys(
        ('信息增量', '分析深度', '可行动性', '事实可信度', '时效性', '表达质量', '综合信号'), 1)).to_dict()


def test_source_completeness_and_quote_are_not_noise_gates() -> None:
    score = noise_score()
    score.pop('weakPointEvidence', None)
    score['weakPoint'] = None
    assert confirmed_noise(score)


@pytest.mark.parametrize('change', [
    {'isDefault': True}, {'version': '4.7'}, {'tier': 'skim'}, {'total': -1},
    {'total': float('nan')}, {'profile': 'unknown'},
    {'dimensions': dict.fromkeys('abcdefg', 1)},
    {'dimensions': dict.fromkeys(noise_score()['dimensions'], 0)},
    {'dimensions': dict.fromkeys(noise_score()['dimensions'], True)},
])
def test_ambiguous_or_invalid_noise_never_qualifies(change: dict[str, Any]) -> None:
    assert not confirmed_noise({**noise_score(), **change})
    assert not confirmed_noise(None)


async def test_policy_disposes_old_terminal_without_source_or_model(tmp_path, monkeypatch) -> None:
    row = {'id': 'noise', 'source': 'daily', 'canonicalUrl': 'https://example.org/noise',
           'updatedAt': 'now', 'distilledScore': noise_score(), 'body': '', 'interpretation': ''}
    previous = {'observedUpdatedAt': 'now', 'status': 'blocked', 'attempts': 5,
                'modelCalls': 9, 'errorCode': 'SOURCE_HTTP_404'}
    r.g.save(tmp_path / 'state.json', {'items': {'noise': previous}, 'modelCalls': 9})
    conn = AsyncMock()
    conn.__aenter__.return_value = conn
    pool = AsyncMock()
    pool.connection = lambda: conn
    monkeypatch.setattr(r.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(r.g, 'verify_admin', AsyncMock(return_value='admin'))
    monkeypatch.setattr(r.g, 'protected_ids', AsyncMock(return_value={}))
    monkeypatch.setattr(r, 'inventory', AsyncMock(return_value=[row]))
    source, model, mutate = AsyncMock(), AsyncMock(), AsyncMock(return_value='deleted')
    monkeypatch.setattr(r, 'acquire_evidence', source)
    monkeypatch.setattr(r, 'generate_text', model)
    monkeypatch.setattr(r, 'mutate', mutate)
    assert (await r.cycle(pool, 'admin', tmp_path, delete_noise=True))['processed'] == 1
    mutate.assert_awaited_once()
    assert mutate.call_args.kwargs['deletion_policy'] == NOISE_POLICY
    source.assert_not_awaited()
    model.assert_not_awaited()
    import json
    state = json.loads((tmp_path / 'state.json').read_text())
    assert state['items']['noise']['attempts'] == 5
    assert state['modelCalls'] == 9
    assert state['items']['noise']['noisePolicy'] == NOISE_POLICY
    # Even if the inventory snapshot is momentarily stale, no repeated deletion.
    await r.cycle(pool, 'admin', tmp_path, delete_noise=True)
    assert mutate.await_count == 1
    assert deepcopy(previous)['attempts'] == 5
