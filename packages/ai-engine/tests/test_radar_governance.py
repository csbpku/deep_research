from __future__ import annotations

import copy
from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import pytest

from ai_engine.radar import governance as g
from ai_engine.radar.distilled_scorer import DISTILLED_VERSION


def score_row() -> dict:
    return {'distilledTier': 'noise', 'distilledScore': {
        'isDefault': False, 'version': DISTILLED_VERSION, 'tier': 'noise',
        'dimensions': dict.fromkeys(('a', 'b', 'c', 'd', 'e', 'f', 'g'), 1),
        'weakPoint': 'No technical detail', 'weakPointEvidence': 'Only a tagline',
    }}


@pytest.mark.parametrize('change', ['default', 'zero', 'missing', 'boolean', 'tier'])
def test_invalid_scores_are_not_noise_evidence(change: str) -> None:
    row = score_row()
    if change == 'default':
        row['distilledScore']['isDefault'] = True
    elif change == 'zero':
        row['distilledScore']['dimensions'] = dict.fromkeys('abcdefg', 0)
    elif change == 'missing':
        row['distilledScore'] = None
    elif change == 'boolean':
        row['distilledScore']['dimensions']['a'] = True
    else:
        row['distilledTier'] = 'skim'
    assert not g.valid_score(row)


def test_valid_legacy_score_preserved_but_not_current_noise() -> None:
    row = score_row()
    row['distilledScore']['version'] = '4.7'
    assert g.valid_score(row)
    assert not g.valid_score(row, current=True)


def test_reference_tokens_json_urls_and_ids() -> None:
    sid = str(uuid4())
    assert g.reference_tokens({'nested': [sid, 'https://github.com/a/b/']}) == {sid, 'https://github.com/a/b'}


def test_reference_anchors_and_tracking_protect_the_same_publication() -> None:
    assert 'https://example.org/article' in g.reference_tokens({'source': 'https://example.org/article?utm_source=test#section'})
    assert 'https://github.com/owner/repo' in g.reference_tokens({'source': 'https://github.com/OWNER/Repo#readme'})
    assert 'https://example.org/article' not in g.reference_tokens({'source': 'https://example.org/another'})


def test_backup_requires_actual_checksum(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(g, 'root_dir', lambda: tmp_path)
    dump = tmp_path / 'backup.dump'
    dump.write_bytes(b'verified-backup')
    receipt = {'restoreVerified': True, 'restoredDatabase': 'governance_verify_test',
               'path': str(dump), 'sha256': g.hashlib.sha256(dump.read_bytes()).hexdigest()}
    g.save(tmp_path / 'backup-verified.json', receipt)
    g.verify_backup()
    dump.write_bytes(b'corrupted')
    with pytest.raises(RuntimeError, match='checksum'):
        g.verify_backup()


def test_serial_does_not_mutate_score() -> None:
    row = score_row()
    before = copy.deepcopy(row)
    assert g.serial(row) == before
    assert row == before


@pytest.mark.parametrize('quota', [True, False])
async def test_recovery_call_budget_and_repeat_resume(tmp_path, monkeypatch, quota: bool) -> None:
    from ai_engine.llm import client
    from ai_engine.radar import distilled_scorer, scoring_input

    actor, sid, batch = str(uuid4()), str(uuid4()), str(uuid4())
    row = {**score_row(), 'id': sid, 'title': 'owner/repo', 'canonicalUrl': 'https://github.com/owner/repo',
           'updatedAt': '2026-10-12T00:00:00+00:00', 'interpretation': None, 'tags': [],
           'sourceType': 'github', 'protectedBy': [], 'distilledScore': None, 'distilledTier': None}
    monkeypatch.setattr(g, 'root_dir', lambda: tmp_path)
    monkeypatch.setattr(g, 'verify_backup', lambda: None)
    g.save(g.plan_path(batch), {'actorId': actor, 'batchId': batch, 'beforeStats': {}, 'protectedCount': 0,
                              'recoveryDeferred': 0, 'recovery': [row], 'operations': [], 'review': [],
                              'recoveryResults': {}, 'modelCalls': 0, 'quotaStopped': False})

    class Cursor:
        def __init__(self, value):
            self.value = value

        async def fetchone(self):
            return self.value

    class Connection:
        async def execute(self, query, params):
            return Cursor({'id': actor} if 'FROM users' in query else row if 'FROM summaries' in query else None)

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Connection()

    async def source(*args, **kwargs):
        return ('Agent runtime implementation, benchmarks, configuration and limitations. ' * 30, 'transient_source')

    calls = 0

    async def generate(**kwargs):
        nonlocal calls
        calls += 1
        if quota:
            raise RuntimeError('test quota exhausted')
        return SimpleNamespace(text='invalid format')

    async def scorer(*args, **kwargs):
        # Model format retries also consume the two-call item cap.
        for _ in range(3):
            await kwargs['scorer']('title', 'source')

    monkeypatch.setattr(scoring_input, '_github_readme_input', source)
    monkeypatch.setattr(client, 'generate_text', generate)
    monkeypatch.setattr(client, 'is_quota_error', lambda exc: quota)
    monkeypatch.setattr(distilled_scorer, 'score_with_llm', scorer)
    await g.recover(Pool(), actor, batch)
    assert calls == (1 if quota else 2)
    assert g.load(batch)['modelCalls'] == calls
    await g.recover(Pool(), actor, batch)
    assert g.load(batch)['modelCalls'] == calls


class TriggerConnection:
    def __init__(self, row, saved, original=None):
        self.row, self.saved, self.original = row, saved, original
        self.audits = []

    async def execute(self, query, params):
        text = query if isinstance(query, str) else query.as_string()
        value = None
        if text.startswith('SELECT * FROM'):
            value = self.row
        elif text.startswith('SELECT metadata') and '"requestId"' in text:
            value = {'metadata': self.original} if self.original else None
        elif text.startswith('UPDATE'):
            value = self.saved
        elif text.startswith('INSERT INTO admin_actions'):
            self.audits.append(params[-1].obj)

        class Cursor:
            async def fetchone(self):
                return value

        return Cursor()


@pytest.mark.parametrize('retire_enrichment', [False, True])
async def test_governance_audits_actual_trigger_values_and_rollback_fields(retire_enrichment) -> None:
    before = {'id':str(uuid4()), 'updatedAt':'2026-10-15T00:00:00+00:00', 'tags':['tier_skim'],
              'distilledTier':'skim', 'enrichmentStatus':'pending',
              'enrichmentNextRetryAt':'2026-10-15T01:00:00+00:00'}
    requested = {'tags':['tier_skim','external_reading'],'distilledTier':'deep_read'}
    after = {**before,**requested,'tags':['external_reading','tier_deep_read'],
             'updatedAt':'2026-10-15T02:00:00+00:00'}
    if retire_enrichment:
        after.update(enrichmentStatus=None,enrichmentNextRetryAt=None)
    op = {'table':'summaries','id':before['id'],'reason':'verified_legacy_external_reading',
          'expectedUpdatedAt':before['updatedAt'],'before':before,'after':requested}
    conn = TriggerConnection(before,after)
    assert await g.apply_one(conn,'actor','batch',op)=='applied'
    audit = conn.audits[0]
    assert audit['after']['tags']==after['tags']
    assert audit['requestedAfter']==requested
    if retire_enrichment:
        assert audit['before']['enrichmentStatus']=='pending'
        assert audit['after']['enrichmentStatus'] is None
        assert audit['after']['enrichmentNextRetryAt'] is None
    restored = {**before,'updatedAt':'2026-10-15T03:00:00+00:00'}
    rollback = TriggerConnection(after,restored,audit)
    assert await g.apply_one(rollback,'actor','batch',op,rollback=True)=='rolled_back'
    assert rollback.audits[0]['after']['tags']==before['tags']
    if retire_enrichment:
        assert rollback.audits[0]['after']['enrichmentStatus']=='pending'


@pytest.mark.parametrize('later_change', [None,'tags','version'])
async def test_legacy_migration_rollback_accepts_only_exact_trigger_normalization(later_change) -> None:
    requested = {'tags':['tier_skim','external_reading'],'distilledTier':'deep_read'}
    original = {'reason':'verified_legacy_external_reading','after':requested,
                'before':{'tags':['tier_skim'],'distilledTier':'skim'},
                'afterUpdatedAt':'2026-10-15T02:00:00+00:00'}
    current = {'id':str(uuid4()),'tags':['external_reading','tier_deep_read'],
               'distilledTier':'deep_read','updatedAt':original['afterUpdatedAt']}
    if later_change == 'tags':
        current['tags'].append('user-edited')
    if later_change == 'version':
        current['updatedAt'] = '2026-10-15T03:00:00+00:00'
    conn = TriggerConnection(current,{**current,**original['before']},original)
    result = await g.apply_one(conn,'actor','batch',{'table':'summaries','id':current['id'],
        'reason':original['reason']},rollback=True)
    assert result==('rolled_back' if later_change is None else 'conflict')
    assert len(conn.audits)==(1 if later_change is None else 0)
