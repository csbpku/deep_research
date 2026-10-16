from copy import deepcopy
from contextlib import asynccontextmanager
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from ai_engine.radar import unification as u
from ai_engine.radar.distilled_scorer import DIM_NAMES, DISTILLED_VERSION, compute_score


def row(version='5.0', tier='collection'):
    score = compute_score(dict.fromkeys(DIM_NAMES, 3)).to_dict()
    score.update(version=version, tier=tier)
    return {'id': str(uuid4()), 'title': 'Verified source title', 'canonicalUrl': 'https://example.org/article',
            'distilledScore': score, 'distilledTier': tier, 'tags': [], 'sourceType': 'rss'}


def test_taxonomy_upgrade_preserves_all_numerical_evidence():
    original = row()
    before = deepcopy(original)
    changes = u.version_changes(original)
    assert changes['distilledTier'] == 'deep_read'
    assert changes['distilledScore'] == {**original['distilledScore'], 'tier': 'deep_read', 'version': DISTILLED_VERSION}
    assert original == before
    assert not u.version_changes(row('4.7'))  # cannot relabel legacy evidence
    assert not u.version_changes({**original, 'distilledScore': None})


def test_external_migration_preserves_old_review_and_cache():
    original = {**row(), 'originalMarkdown': 'old cache', 'contentReviewStatus': 'failed'}
    changes = u.reading_changes(original)
    assert changes['distilledTier'] == 'deep_read'
    assert 'external_reading' in changes['tags'] and 'tier_collection' not in changes['tags']
    assert 'contentReviewStatus' not in changes and 'originalMarkdown' not in changes
    assert not u.reading_changes(row(tier='noise'))


def test_cache_mismatch_is_not_blessed_by_old_ready_status():
    assert u.cache_anomaly({'originalMarkdown': 'changed', 'originalSha256': 'old', 'readerQualityStatus': 'ready'})
    assert not u.cache_anomaly({'originalMarkdown': None, 'tags': ['external_reading']})
    assert not u.cache_anomaly({'originalMarkdown': 'old unverified cache'})


async def test_live_migration_rejects_different_canonical(monkeypatch):
    doc = SimpleNamespace(status=200, url=row()['canonicalUrl'], content=b'<link rel="canonical" href="https://example.org/other">')
    monkeypatch.setattr(u, 'safe_fetch', AsyncMock(return_value=doc))
    with pytest.raises(u.r.RepairFailure, match='SOURCE_IDENTITY_MISMATCH'):
        await u.live_evidence(row())


async def test_live_migration_rejects_generic_landing_page(monkeypatch):
    doc = SimpleNamespace(status=200, url=row()['canonicalUrl'], content=b'<title>Welcome</title><h1>Home</h1>')
    monkeypatch.setattr(u, 'safe_fetch', AsyncMock(return_value=doc))
    monkeypatch.setattr(u, '_extract_article_content', lambda *a, **k: 'Some different lengthy source text ' * 100)
    with pytest.raises(u.r.RepairFailure, match='SOURCE_IDENTITY_UNVERIFIED'):
        await u.live_evidence(row())


def test_scorer_never_emits_separate_collection():
    parsed = dict.fromkeys(DIM_NAMES, 3)
    parsed.update(direct_relevance=3, scope_breadth=2, validation_breadth=2, implementation_stage=2,
                  relevance_evidence='Concrete implementation with independent evaluation')
    assert compute_score(parsed).tier == 'deep_read'


class Pool:
    @asynccontextmanager
    async def connection(self):
        yield self

    @asynccontextmanager
    async def transaction(self):
        yield self


async def test_format_retries_are_bounded_and_rerun_does_not_pay(tmp_path, monkeypatch):
    source_row = {**row('4.7', 'deep_read'), 'fingerprint': 'same', 'updatedAt': '2026-10-16T00:00:00Z',
                  'body': 'Useful existing summary. ' * 8, 'interpretation': 'Useful existing judgement. ' * 5}
    state = {'policy': u.POLICY, 'version': DISTILLED_VERSION, 'batch': str(uuid4()), 'actor': 'admin',
             'modelCalls': 0, 'maxModelCalls': 2, 'quotaStopped': False, 'items': {},
             'targets': [{'id': source_row['id'], 'fingerprint': 'same', 'protectedBy': []}]}
    u.g.save(tmp_path / 'state.json', state)
    monkeypatch.setattr(u.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(u, 'fetch_row', AsyncMock(return_value=source_row))
    monkeypatch.setattr(u, 'live_evidence', AsyncMock(return_value=u.r.Evidence('A concrete source. ' * 100, 'fixture', True)))
    model = AsyncMock(return_value=SimpleNamespace(text='invalid JSON'))
    monkeypatch.setattr(u, 'generate_text', model)
    monkeypatch.setattr(u.g, 'verify_admin', AsyncMock(return_value='admin'))
    monkeypatch.setattr(u.r, 'audit', AsyncMock())
    await u.run(Pool(), 'admin', tmp_path, limit=1)
    await u.run(Pool(), 'admin', tmp_path, limit=1)
    saved = json.loads((tmp_path / 'state.json').read_text())
    assert model.await_count == saved['modelCalls'] == 2
    assert saved['items'][source_row['id']]['error'] == 'MODEL_SCORE_FORMAT'


async def test_unknown_reserved_call_is_not_repeated(tmp_path, monkeypatch):
    source_row = {**row('4.7'), 'fingerprint': 'same'}
    state = {'policy': u.POLICY, 'version': DISTILLED_VERSION, 'batch': str(uuid4()), 'actor': 'admin',
             'modelCalls': 1, 'maxModelCalls': 2, 'quotaStopped': False,
             'targets': [{'id': source_row['id'], 'fingerprint': 'same', 'protectedBy': []}],
             'items': {source_row['id']: {'status': 'running', 'calls': 1, 'inflight': True}}}
    u.g.save(tmp_path / 'state.json', state)
    monkeypatch.setattr(u.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(u, 'fetch_row', AsyncMock(return_value=source_row))
    model = AsyncMock()
    monkeypatch.setattr(u, 'generate_text', model)
    await u.run(Pool(), 'admin', tmp_path, limit=1)
    saved = json.loads((tmp_path / 'state.json').read_text())
    assert saved['modelCalls'] == 1
    assert saved['items'][source_row['id']]['error'] == 'MODEL_RESULT_UNKNOWN'
    model.assert_not_awaited()


async def test_paid_response_cannot_be_reused_for_changed_source(tmp_path, monkeypatch):
    source_row = {**row('4.7'), 'fingerprint': 'same'}
    state = {'policy': u.POLICY, 'version': DISTILLED_VERSION, 'batch': str(uuid4()), 'actor': 'admin',
             'modelCalls': 1, 'maxModelCalls': 2, 'quotaStopped': False,
             'targets': [{'id': source_row['id'], 'fingerprint': 'same', 'protectedBy': []}],
             'items': {source_row['id']: {'status': 'running', 'calls': 1, 'responses': ['old response'],
                                         'sourceEvidence': {'sha256': 'old', 'kind': 'fixture', 'complete': True}}}}
    u.g.save(tmp_path / 'state.json', state)
    monkeypatch.setattr(u.g, 'verify_backup', lambda: None)
    monkeypatch.setattr(u, 'fetch_row', AsyncMock(return_value=source_row))
    monkeypatch.setattr(u, 'live_evidence', AsyncMock(return_value=u.r.Evidence('Changed source', 'fixture', True)))
    monkeypatch.setattr(u.g, 'verify_admin', AsyncMock(return_value='admin'))
    monkeypatch.setattr(u.r, 'audit', AsyncMock())
    model = AsyncMock()
    monkeypatch.setattr(u, 'generate_text', model)
    await u.run(Pool(), 'admin', tmp_path, limit=1)
    saved = json.loads((tmp_path / 'state.json').read_text())
    assert saved['modelCalls'] == 1
    assert saved['items'][source_row['id']]['error'] == 'SOURCE_CHANGED_AFTER_MODEL'
    model.assert_not_awaited()
