"""Explicit Admin migration to one reading mode and the current scoring rubric.

This is a bounded, owner-authorized replacement of legacy scores, separate from
continuous repair (which still preserves valid scores). No schema changes.
"""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import urljoin, urlsplit
from uuid import NAMESPACE_URL, uuid4, uuid5

from bs4 import BeautifulSoup
from psycopg import sql
from psycopg.types.json import Jsonb

from ai_engine.fetcher.safe_fetch import safe_fetch
from ai_engine.llm.client import generate_text
from ai_engine.radar import governance as g, repair as r
from ai_engine.radar.distilled_scorer import DISTILLED_VERSION
from ai_engine.radar.noise_policy import NOISE_POLICY, confirmed_noise
from ai_engine.radar.scoring_input import _usable_content
from ai_engine.radar.sync_runner import _extract_article_content

POLICY = 'external_three_tiers_5_1'
MAX_CALLS_PER_ITEM = 2
JSON_FIELDS = {'distilledScore', 'originalMeta'}
FIELDS = set(g.SUMMARY_FIELDS) | {'scoreVersion', 'scoreReason', 'originalMeta',
    'originalMarkdown', 'originalBytes', 'originalSha256', 'contentSha256',
    'originalFetchedAt', 'enrichmentStatus', 'enrichmentNextRetryAt'}


def cache_anomaly(row: dict[str, Any]) -> bool:
    text = row.get('originalMarkdown')
    if not isinstance(text, str) or not text:
        return False
    raw = text.encode()
    return bool(row.get('originalSha256') and hashlib.sha256(raw).hexdigest() != row['originalSha256']
                or row.get('originalBytes') is not None and len(raw) != row['originalBytes'])


def request_id(batch: str, sid: str, phase: str = 'apply') -> str:
    return str(uuid5(NAMESPACE_URL, batch + ':' + sid + ':radar_unification_' + phase))


def version_changes(row: dict[str, Any]) -> dict[str, Any]:
    """5.0 -> 5.1 changes taxonomy only; never relabel an older rubric."""
    score = row.get('distilledScore') or {}
    if not r.has_score(row) or score.get('version') != '5.0':
        return {}
    tier = 'deep_read' if score['tier'] == 'collection' else score['tier']
    return {'distilledScore': {**score, 'version': DISTILLED_VERSION, 'tier': tier},
            'distilledTargetTier': tier, 'distilledTier': tier,
            'scoreVersion': DISTILLED_VERSION}


def reading_changes(row: dict[str, Any]) -> dict[str, Any]:
    score = row.get('distilledScore') or {}
    if not r.has_score(row) or score.get('tier') == 'noise':
        return {}
    tier = 'deep_read' if score['tier'] == 'collection' else score['tier']
    tags = [t for t in row.get('tags') or [] if not t.startswith('tier_')]
    if 'external_reading' not in tags:
        tags.append('external_reading')
    changes: dict[str, Any] = {'tags': tags + ['tier_' + tier], 'distilledTier': tier,
                              'distilledTargetTier': tier}
    if row.get('enrichmentStatus') in {'pending', 'retryable', 'manual'}:
        changes.update(enrichmentStatus=None, enrichmentNextRetryAt=None)
    return changes


async def snapshot(pool: Any, actor: str, directory: Path) -> dict[str, Any]:
    path = directory / 'state.json'
    if path.exists():
        return json.loads(path.read_text())  # type: ignore[no-any-return]
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            actor = await g.verify_admin(conn, actor)
            rows = [dict(x) for x in await (await conn.execute('''SELECT s.id,s.title,s."canonicalUrl",s."updatedAt",s."createdAt",
                s.tags,s.status,s."distilledScore",s."distilledTier",s."distilledTargetTier",
                s."userNote"<>'' AS "directNote",s."sharedByUserId" IS NOT NULL AS "directShare",
                md5(to_jsonb(s)::text) fingerprint
                FROM summaries s WHERE ''' + r.SCOPE_SQL + ' ORDER BY s."createdAt" DESC,s.id')).fetchall()]
            protections = await g.protected_ids(conn, rows)
    rows.sort(key=lambda x: not bool(protections.get(str(x['id'])) or x['directNote'] or x['directShare']))
    state = {'policy': POLICY, 'version': DISTILLED_VERSION, 'batch': str(uuid4()),
             'actor': actor, 'createdAt': time.time(), 'modelCalls': 0, 'quotaStopped': False,
             'maxModelCalls': sum((x.get('distilledScore') or {}).get('version') not in ('5.0', DISTILLED_VERSION)
                                  for x in rows) * MAX_CALLS_PER_ITEM,
             'beforeCounts': dict(Counter((x.get('distilledScore') or {}).get('version') for x in rows)),
             'targets': [{**g.serial(x), 'protectedBy': protections.get(str(x['id']), [])} for x in rows],
             'items': {}}
    g.save(path, state)
    return state


async def fetch_row(pool: Any, sid: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        row = await (await conn.execute('''SELECT s.*,md5(to_jsonb(s)::text) fingerprint,rr."sourceId",rs."sourceType"
            FROM summaries s LEFT JOIN radar_sync_runs rr ON rr.id=s."syncRunId"
            LEFT JOIN radar_sources rs ON rs.id=rr."sourceId" WHERE s.id=%s''', (sid,))).fetchone()
    return dict(row) if row else None


def normalized_url(value: str) -> str:
    parts = urlsplit(value)
    return parts._replace(scheme='https', netloc=parts.netloc.lower().removeprefix('www.'),
                          path=parts.path.rstrip('/'), fragment='').geturl()


async def live_evidence(row: dict[str, Any]) -> r.Evidence:
    """Verify exact publication identity before retiring a legacy reader gate."""
    url = str(row['canonicalUrl'])
    parts = urlsplit(url)
    host = parts.hostname or ''
    # These providers validate a document envelope / exact repo or paper ID.
    if host in {'github.com', 'dev.to', 'arxiv.org'} or parts.path.lower().endswith('.pdf'):
        evidence = await r.acquire_evidence({**row, 'originalMarkdown': None})
        if evidence.kind == 'cached_original':
            raise r.RepairFailure('SOURCE_IDENTITY_UNVERIFIED', '站外迁移不能只凭旧缓存', retryable=False)
        return evidence
    allowed = (host, host[4:] if host.startswith('www.') else 'www.' + host)
    doc = await safe_fetch(url, allowed_hosts=allowed, max_bytes=r.REPAIR_MAX_HTML_BYTES,
                           timeout=20, max_redirects=3)
    if doc.status != 200:
        raise r.RepairFailure('SOURCE_RATE_LIMITED' if doc.status == 429 else f'SOURCE_HTTP_{doc.status}',
                              f'迁移核验来源HTTP {doc.status}')
    if normalized_url(doc.url) != normalized_url(url):
        raise r.RepairFailure('SOURCE_IDENTITY_MISMATCH', '最终URL与出版身份不同', retryable=False)
    html = doc.content.decode('utf-8', errors='replace')
    soup = BeautifulSoup(html, 'html.parser')
    canonical = soup.select_one('link[rel="canonical"]')
    if canonical and normalized_url(urljoin(doc.url, str(canonical.get('href') or ''))) != normalized_url(url):
        raise r.RepairFailure('SOURCE_IDENTITY_MISMATCH', 'canonical与出版身份不同', retryable=False)
    text = _extract_article_content(html, doc.url, str(row.get('sourceType') or 'rss'), max_chars=200_001)
    if not _usable_content(text, source_type=str(row.get('sourceType') or 'rss'), url=url):
        raise r.RepairFailure('SOURCE_INSUFFICIENT', '未取得可用于判断的正文')
    if not canonical:
        # Exact URL alone could serve a homepage or login wall. Require title
        # overlap when the publisher supplies no canonical document identity.
        import re
        title = str(row.get('title') or '').casefold()
        headings = ' '.join(x.get_text(' ', strip=True) for x in soup.select('title,h1')).casefold()
        words = set(re.findall(r'[\w]{3,}', title))
        if not words or sum(w in headings for w in words) / len(words) < .5:
            raise r.RepairFailure('SOURCE_IDENTITY_UNVERIFIED', '缺canonical且标题身份无法匹配', retryable=False)
    complete = len(text) <= 18000 and r.complete_article(html, text, url)
    return r.Evidence(text[:18000], 'verified_live_article', complete)


async def apply(pool: Any, actor: str, batch: str, row: dict[str, Any], changes: dict[str, Any],
                evidence: r.Evidence | None, reason: str) -> str:
    if not changes:
        return 'unchanged'
    if not set(changes) <= FIELDS:
        raise ValueError('unsupported unification fields')
    async with pool.connection() as conn:
        async with conn.transaction():
            actor = await g.verify_admin(conn, actor)
            rid = request_id(batch, str(row['id']))
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (rid,))
            if await (await conn.execute('SELECT id FROM admin_actions WHERE "requestId"=%s', (rid,))).fetchone():
                return 'already_applied'
            current = await (await conn.execute('SELECT *,md5(to_jsonb(s)::text) fingerprint FROM summaries s WHERE id=%s FOR UPDATE', (row['id'],))).fetchone()
            if not current or current['fingerprint'] != row['fingerprint'] or str(current['updatedAt']) != str(row['updatedAt']):
                return 'conflict'
            current = dict(current)
            if 'distilledScore' in changes:
                new = changes['distilledScore']
                if new.get('version') != DISTILLED_VERSION or new.get('tier') == 'collection' or not r.has_score({'distilledScore': new}):
                    raise ValueError('invalid current score')
                old_version = (current.get('distilledScore') or {}).get('version')
                if old_version not in ('5.0', DISTILLED_VERSION) and evidence is None:
                    raise ValueError('legacy rescore requires source evidence')
            assignments = [sql.SQL('{}=%s').format(sql.Identifier(k)) for k in changes]
            values = [Jsonb(v) if k in JSON_FIELDS else v for k, v in changes.items()]
            saved = dict(await (await conn.execute(sql.SQL('UPDATE summaries SET {},"updatedAt"=clock_timestamp() WHERE id=%s RETURNING *').format(
                sql.SQL(',').join(assignments)), (*values, row['id']))).fetchone())
            fields = {k for k in saved if k != 'updatedAt' and g.serial(saved[k]) != g.serial(current[k])}
            await r.audit(conn, actor, batch, row, 'radar_unification_apply', {
                'policy': POLICY, 'batchId': batch, 'reason': reason,
                'before': {k: g.serial(current[k]) for k in fields},
                'after': {k: g.serial(saved[k]) for k in fields},
                'beforeUpdatedAt': str(current['updatedAt']), 'afterUpdatedAt': str(saved['updatedAt']),
                'evidenceSha256': evidence.sha256 if evidence else None,
                'evidenceKind': evidence.kind if evidence else '5.0_taxonomy_only',
                'sourceComplete': evidence.complete if evidence else None})
            return 'applied'


async def rollback(pool: Any, actor: str, audit_id: str) -> str:
    """Restore audited values only while their exact post-write version holds."""
    g.verify_backup()
    async with pool.connection() as conn:
        async with conn.transaction():
            actor = await g.verify_admin(conn, actor)
            proof = await (await conn.execute("SELECT * FROM admin_actions WHERE id=%s AND action='radar_unification_apply'",
                                              (audit_id,))).fetchone()
            if not proof:
                raise ValueError('unification audit not found')
            meta = proof['metadata']
            row = await (await conn.execute('SELECT * FROM summaries WHERE id=%s FOR UPDATE', (proof['targetId'],))).fetchone()
            if (not row or str(row['updatedAt']) != meta['afterUpdatedAt']
                    or any(g.serial(row[k]) != v for k, v in meta['after'].items())):
                raise r.RepairFailure('ROLLBACK_CONFLICT', '条目有后续修改，拒绝覆盖', retryable=False)
            if not set(meta['before']) <= FIELDS:
                raise ValueError('unsupported rollback fields')
            fields = list(meta['before'])
            values = [Jsonb(meta['before'][k]) if k in JSON_FIELDS and meta['before'][k] is not None
                      else meta['before'][k] for k in fields]
            saved = dict(await (await conn.execute(sql.SQL('UPDATE summaries SET {},"updatedAt"=clock_timestamp() WHERE id=%s RETURNING *').format(
                sql.SQL(',').join(sql.SQL('{}=%s').format(sql.Identifier(k)) for k in fields)), (*values, row['id']))).fetchone())
            await r.audit(conn, actor, audit_id, dict(row), 'radar_unification_rollback',
                {'policy': POLICY, 'originalAuditId': audit_id, 'before': meta['after'],
                 'after': {k: g.serial(saved[k]) for k in fields}, 'afterUpdatedAt': str(saved['updatedAt'])})
            return str(row['id'])


async def run(pool: Any, actor: str, directory: Path, *, limit: int = 100) -> dict[str, Any]:
    if not 1 <= limit <= 100:
        raise ValueError('limit must be 1..100')
    g.verify_backup()
    path = directory / 'state.json'
    with (directory / 'worker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(path.read_text())
        if state['policy'] != POLICY or state['version'] != DISTILLED_VERSION or state['actor'] != actor:
            raise ValueError('checkpoint identity or rubric mismatch')
        processed = 0
        for target in state['targets']:
            sid = target['id']
            if sid in state['items'] and state['items'][sid].get('status') != 'running':
                continue
            if processed >= limit:
                break
            processed += 1
            row = await fetch_row(pool, sid)
            item = state['items'].setdefault(sid, {'calls': 0, 'status': 'running'})
            # A reserved call with no recorded result must never be charged a
            # second time by a restart. An operator can inspect its usage ID.
            if item.get('inflight'):
                item.update(status='unresolved', error='MODEL_RESULT_UNKNOWN')
                g.save(path, state)
                continue
            if not row:
                item['status'] = 'missing'
                g.save(path, state)
                continue
            if row['fingerprint'] != target['fingerprint']:
                # Detect a committed apply after a crash without rebasing any
                # unrelated change onto this immutable source snapshot.
                async with pool.connection() as conn:
                    prior = await (await conn.execute('SELECT id,metadata FROM admin_actions WHERE "requestId"=%s',
                        (str(uuid5(NAMESPACE_URL, state['batch'] + ':' + sid + ':radar_unification_apply')),))).fetchone()
                unchanged_apply = prior and str(row['updatedAt']) == prior['metadata']['afterUpdatedAt']
                item['status'] = 'already_applied' if unchanged_apply else 'conflict'
                if unchanged_apply and confirmed_noise(row.get('distilledScore')):
                    item['disposition'] = await r.mutate(pool, actor, state['batch'], row, {}, None,
                        delete=True, directory=directory, deletion_policy=NOISE_POLICY)
                g.save(path, state)
                continue
            evidence = None
            changes = version_changes(row)
            legacy = (row.get('distilledScore') or {}).get('version') not in ('5.0', DISTILLED_VERSION)
            cache_invalid = cache_anomaly(row)
            needs_live = 'external_reading' not in (row.get('tags') or []) or cache_invalid
            if legacy and state['quotaStopped']:
                # Still finish deterministic migration of other rows.
                item.update(status='unresolved', error='MODEL_QUOTA_STOPPED')
                g.save(path, state)
                continue
            try:
                if legacy or needs_live:
                    evidence = await asyncio.wait_for(live_evidence(row), timeout=65)
                if legacy:
                    assert evidence is not None
                    proof = {'sha256': evidence.sha256, 'kind': evidence.kind, 'complete': evidence.complete}
                    if item.get('responses') and item.get('sourceEvidence') != proof:
                        raise r.RepairFailure('SOURCE_CHANGED_AFTER_MODEL',
                            '已付费响应的来源证据不匹配，禁止套用到新来源或重置预算', retryable=False)
                    item['sourceEvidence'] = proof
                    g.save(path, state)
                    response_index = 0
                    async def call(**kwargs: Any) -> Any:
                        nonlocal response_index
                        responses = item.setdefault('responses', [])
                        if response_index < len(responses):
                            response_index += 1
                            return SimpleNamespace(text=responses[response_index - 1])
                        if item['calls'] >= MAX_CALLS_PER_ITEM or state['modelCalls'] >= state['maxModelCalls']:
                            raise r.RepairFailure('MODEL_CALL_LIMIT', '本轮评分调用预算已用完', retryable=False)
                        item['calls'] += 1
                        state['modelCalls'] += 1
                        rid = f"radar-unification:{state['batch']}:{sid}:{item['calls']}"
                        item.update(inflight=True, requestId=rid)
                        g.save(path, state)
                        try:
                            result = await generate_text(**kwargs, single_attempt=True, disable_thinking=True,
                                                         timeout=90, request_id=rid)
                        except Exception:
                            item['inflight'] = False
                            g.save(path, state)
                            raise
                        item['inflight'] = False
                        responses.append(result.text)
                        response_index += 1
                        g.save(path, state)
                        return result
                    assert evidence is not None
                    for attempt in range(MAX_CALLS_PER_ITEM):
                        try:
                            changes = await r.derive({**row, 'distilledScore': None, 'tags': [*(row.get('tags') or []), 'external_reading']},
                                                     evidence, call, fields='score')
                            changes['scoreVersion'] = DISTILLED_VERSION
                            break
                        except r.RepairFailure as exc:
                            if exc.code != 'MODEL_SCORE_FORMAT' or attempt + 1 == MAX_CALLS_PER_ITEM:
                                raise
                    if r.needs_summary({**row, **changes}):
                        changes.update(await r.derive({**row, **changes}, evidence, call, fields='summary'))
                effective = {**row, **changes}
                if 'distilledScore' in changes:
                    s = changes['distilledScore']
                    changes['scoreReason'] = (f"Distilled {DISTILLED_VERSION}；等级={s['tier']}；"
                        f"等级分={s.get('tierScore', s['total'])}/100；{s.get('weakPoint', '')}")
                if needs_live:
                    assert evidence is not None
                    changes.update(reading_changes(effective))
                    changes['originalMeta'] = {**(changes.get('originalMeta') or row.get('originalMeta') or {}),
                        'externalReadingVerification': {'policy': POLICY, 'checkedAt': time.time(),
                            'evidenceSha256': evidence.sha256, 'kind': evidence.kind}}
                if cache_invalid:
                    assert evidence is not None
                    # Preserve the entire old cache in the transactional audit
                    # and backup. Replace it with identified source text; never
                    # assert the old mismatched hash was correct.
                    changes.update(originalMarkdown=evidence.text, originalBytes=len(evidence.text.encode()),
                        originalSha256=evidence.sha256, contentSha256=evidence.sha256,
                        originalFetchedAt=datetime.now(timezone.utc))
                    changes['originalMeta'] = {**(changes.get('originalMeta') or row.get('originalMeta') or {}),
                        'cacheReplacement': {'evidenceKind': evidence.kind, 'complete': evidence.complete,
                            'sha256': evidence.sha256, 'historicalReviewSourceSha256': row.get('originalSha256'),
                            'historicalContentReviewStatus': row.get('contentReviewStatus')}}
                if confirmed_noise(effective.get('distilledScore')):
                    changes.update(distilledTier='noise', distilledTargetTier='noise')
                    if target['protectedBy'] or row.get('userNote') or row.get('sharedByUserId'):
                        changes.update(status='archived', tags=list(dict.fromkeys([*(changes.get('tags') or row.get('tags') or []),
                                                                                  'reference_only_noise'])))
                outcome = await apply(pool, actor, state['batch'], row, changes, evidence,
                                      'source_backed_legacy_rescore' if legacy else 'unified_external_reading_and_tiers')
                item['status'] = outcome
                if outcome in {'applied', 'unchanged', 'already_applied'}:
                    current = await fetch_row(pool, sid)
                    if current and confirmed_noise(current.get('distilledScore')):
                        # Deletion rechecks references under table locks and
                        # archives the complete row before the transaction.
                        if current.get('source') != 'daily':
                            item['disposition'] = 'protected_share'
                        else:
                            item['disposition'] = await r.mutate(pool, actor, state['batch'], current, {}, evidence,
                                delete=True, directory=directory, deletion_policy=NOISE_POLICY)
            except Exception as exc:
                problem = r.failure(exc)
                item.update(status='unresolved', error=problem.code, reason=problem.detail)
                if problem.code == 'MODEL_QUOTA':
                    state['quotaStopped'] = True
                # No new sync diagnostics for this one-off operator pass.
                async with pool.connection() as conn:
                    async with conn.transaction():
                        await g.verify_admin(conn, actor)
                        await r.audit(conn, actor, state['batch'], row, 'radar_unification_unresolved',
                                      {'policy': POLICY, 'batchId': state['batch'], **item})
            g.save(path, state)
            print(json.dumps({'processed': len(state['items']), 'targets': len(state['targets']),
                'modelCalls': state['modelCalls'], 'id': sid, 'status': item['status'],
                'error': item.get('error'), 'disposition': item.get('disposition')}), flush=True)
        return {'processed': processed, 'total': len(state['items']), 'targets': len(state['targets']),
                'modelCalls': state['modelCalls'], 'quotaStopped': state['quotaStopped'],
                'outcomes': dict(Counter(x['status'] for x in state['items'].values()))}
