"""Read-only, evidence-scoped quality checks for every retained radar row.

Passing structural checks never proves factual accuracy or authorizes deletion.
Legacy scores and external reading are first-class, supported states.
"""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from ai_engine.radar import repair
from ai_engine.radar.distilled_scorer import SERIAL_KEYS
from ai_engine.radar.enrichment_contract import is_enrichment_ready

TIERS = {'collection', 'deep_read', 'skim', 'noise'}
CHECKS = {
    'identity': '身份与原文地址', 'lineage': '入库来源与批次',
    'summary': '可用摘要', 'judgement': '适用场景与限制判断',
    'score': '有效七维评分', 'score_fields': '评分与展示字段一致',
    'score_evidence': '评分理由与证据可追溯', 'cached_original': '已有正文完整性',
    'reading_path': '配置的阅读路径', 'lifecycle': '状态与公开展示门槛',
    'timestamps': '时间字段', 'references': '引用与保留保护',
    'diagnostics': '当前诊断真实且不重复', 'retry': '失败原因与有界重试',
    'duplicates': '疑似重复候选', 'live_source': '当前原文可达性与身份',
    'semantic_quality': '摘要、判断与评分的语义忠实度',
}


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 100


def _stamp(value: Any) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc)
    except ValueError:
        return None


def _url(value: Any) -> bool:
    try:
        parts = urlsplit(str(value or ''))
        return bool(parts.scheme in {'http', 'https'} and parts.hostname and not parts.username
                    and not parts.password)
    except ValueError:
        return False


def valid_score(row: dict[str, Any]) -> bool:
    score = row.get('distilledScore')
    return bool(repair.has_score(row) and isinstance(score, dict)
                and set(score['dimensions']) == set(SERIAL_KEYS.values())
                and score.get('tier') in TIERS and _number(score.get('total'))
                and (score.get('tierScore') is None or _number(score['tierScore']))
                and bool(score.get('version')) and bool(score.get('profile')))


def duplicate_candidates(rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Suggestions only; a shared title/repository is never proof of duplication."""
    groups: dict[tuple[str, str], list[str]] = defaultdict(list)
    for row in rows:
        title = re.sub(r'\s+', ' ', str(row.get('title') or '')).strip().casefold()
        if title:
            groups[('title', title)].append(str(row['id']))
        if _url(row.get('canonicalUrl')):
            u = urlsplit(row['canonicalUrl'])
            key = u._replace(scheme=u.scheme.lower(), netloc=u.netloc.lower(),
                             path=u.path.rstrip('/'), fragment='').geturl()
            groups[('url', key)].append(str(row['id']))
    result: dict[str, set[str]] = defaultdict(set)
    for ids in groups.values():
        if len(ids) > 1:
            for sid in ids:
                result[sid].update(other for other in ids if other != sid)
    return {sid: sorted(others) for sid, others in result.items()}


def audit_row(row: dict[str, Any], *, now: datetime, protections: list[str],
              diagnostics: list[dict[str, Any]], item: dict[str, Any] | None,
              checkpoint_stable: bool, duplicate_ids: list[str]) -> dict[str, Any]:
    checks: dict[str, dict[str, Any]] = {}

    def check(key: str, state: str, evidence: Any, action: str = '') -> None:
        checks[key] = {'state': state, 'evidence': evidence, 'action': action}

    sid = str(row['id'])
    try:
        UUID(sid)
        uuid_ok = True
    except ValueError:
        uuid_ok = False
    identity = {'uuid': uuid_ok, 'titlePresent': bool(str(row.get('title') or '').strip()),
                'urlShape': _url(row.get('url')), 'canonicalUrlShape': _url(row.get('canonicalUrl'))}
    check('identity', 'passed' if all(identity.values()) else 'invalid', identity,
          '' if all(identity.values()) else '核实标题、UUID和原文地址；禁止据此公开或删除')
    lineage_ok = ((row.get('source') == 'daily' and bool(row.get('sourceId')))
                  or (row.get('source') == 'user' and row.get('approvedShare') is True))
    check('lineage', 'passed' if lineage_ok else 'missing',
          {k: row.get(k) for k in ('source', 'syncRunId', 'sourceId', 'sourceType', 'approvedShare')},
          '' if lineage_ok else '核对真实入库来源，补足可核验来源关系')
    for key, missing, evidence in (
        ('summary', repair.needs_body_summary(row), {'bodyChars': len(str(row.get('body') or '').strip())}),
        ('judgement', len(str(row.get('interpretation') or '').strip()) < 30,
         {'judgementChars': len(str(row.get('interpretation') or '').strip())}),
    ):
        check(key, 'missing' if missing else 'passed', evidence,
              '按真实原文补齐；无法读取则保留失败原因' if missing else '')
    score = row.get('distilledScore')
    score = score if isinstance(score, dict) else {}
    scored = valid_score(row)
    check('score', 'passed' if scored else 'missing' if not score else 'invalid',
          {'present': bool(score), 'version': score.get('version'), 'isDefault': score.get('isDefault'),
           'dimensions': score.get('dimensions'), 'total': score.get('total'), 'tier': score.get('tier')},
          '' if scored else '以原文补分；保留无效旧结果，禁止占位评分')
    external = 'external_reading' in (row.get('tags') or [])
    issues = []
    if not scored:
        if any(row.get(k) is not None for k in ('distilledTotal', 'distilledTier', 'distilledTargetTier')):
            issues.append('无有效评分却有展示分数或等级')
    else:
        target, delivered = score.get('tier'), row.get('distilledTier')
        if row.get('distilledTargetTier') not in (None, target):
            issues.append('目标等级与评分矛盾')
        if delivered != target and not (target in {'collection', 'deep_read'} and delivered == 'skim'
                                         and not external):
            issues.append('交付等级与评分矛盾')
        expected = score.get('tierScore') if score.get('tierScore') is not None else score.get('total')
        if not _number(row.get('distilledTotal')) or abs(row['distilledTotal'] - expected) > 0.02:
            issues.append('展示分数与分层分矛盾或缺失')
        def profile(value: Any) -> Any:
            return 'engineering' if value == 'tech_blog' else value
        if profile(row.get('distilledProfile')) != profile(score.get('profile')):
            issues.append('评分配置不一致或缺失')
    check('score_fields', 'invalid' if issues else 'passed' if scored else 'not_applicable',
          {'issues': issues, **{k: row.get(k) for k in
                             ('distilledTotal', 'distilledTier', 'distilledTargetTier', 'distilledProfile')}},
          '复核后条件写入展示字段，保留有效评分' if issues else '')
    meta = row.get('originalMeta')
    meta = meta if isinstance(meta, dict) else {}
    proof = meta.get('radarRepair')
    proof = proof if isinstance(proof, dict) else {}
    reason_field = 'weakPoint' if str(score.get('weakPoint') or '').strip() else (
        'scoreReason' if str(row.get('scoreReason') or '').strip() else None)
    check('score_evidence', 'not_applicable' if not scored else 'missing' if not reason_field
          else 'unverified',
          {'reasonPresent': bool(reason_field), 'reasonField': reason_field,
           'quotePresent': bool(score.get('weakPointEvidence')),
           'repairEvidenceKind': proof.get('evidenceKind'), 'repairEvidenceSha256': proof.get('evidenceSha256'),
           'repairCheckedAt': proof.get('checkedAt')},
          '核验评分原始证据；旧评分缺引文不自动重评' if scored else '')
    original = str(row.get('originalMarkdown') or '')
    if not original:
        check('cached_original', 'not_applicable', {'externalReading': external, 'cachedChars': 0})
    else:
        integrity = {'bytesMatch': row.get('originalBytes') == len(original.encode()),
                     'hashMatch': row.get('originalSha256') == hashlib.sha256(original.encode()).hexdigest()}
        check('cached_original', 'passed' if all(integrity.values()) else 'invalid', integrity,
              '' if all(integrity.values()) else '核对缓存与元数据；不可将该缓存作为完整性证明')
    target = score.get('tier') or row.get('distilledTargetTier') or row.get('distilledTier')
    if external:
        check('reading_path', 'passed' if _url(row.get('canonicalUrl')) else 'invalid',
              {'mode': 'external', 'cacheAndOldReviewsRequired': False})
    elif target not in {'collection', 'deep_read'}:
        check('reading_path', 'not_applicable', {'mode': 'skim_or_pending'})
    else:
        ready = is_enrichment_ready(enrichment_status=row.get('enrichmentStatus'),
                                    reader_quality_status=row.get('readerQualityStatus'),
                                    original_kind=row.get('originalKind'), original_meta=meta)
        usable = ready and bool(original) and row.get('contentReviewStatus') == 'approved'
        check('reading_path', 'passed' if usable else 'missing',
              {'mode': 'server', 'sourceContractReady': ready, 'cachedBodyPresent': bool(original),
               **{k: row.get(k) for k in ('enrichmentStatus', 'readerQualityStatus', 'contentReviewStatus',
                                         'renderReviewStatus')}},
              '' if usable else '验证原文后迁移外部阅读，或补齐站内阅读门槛；不改写旧审核结果')
    active = row.get('status') in {'candidate', 'published'}
    # Mirrors default list gate, not a claim that an HTTP/browser request passed.
    reader_item = (row.get('originalKind') not in {'github_issue', 'github_pr', 'github_release'}
                   and not any(s in str(row.get('canonicalUrl')) for s in ('/issues/', '/pull/', '/releases/tag/')))
    visible = bool(active and reader_item and lineage_ok and row.get('distilledTier') in TIERS - {'noise'}
                   and (row.get('source') == 'user' or (row.get('distilledScore') is not None
                        and (row.get('distilledTier') == 'skim' or external or (
                            row.get('enrichmentStatus') == row.get('readerQualityStatus') == 'ready'
                            and row.get('contentReviewStatus') == 'approved')))))
    blocked = []
    if not active:
        blocked.append('非活跃状态')
    if not scored:
        blocked.append('缺有效评分')
    if row.get('distilledTier') == 'noise':
        blocked.append('噪声不公开')
    if checks['reading_path']['state'] == 'missing':
        blocked.append('站内阅读门槛未完成')
    check('lifecycle', 'invalid' if visible and not scored else 'passed',
          {'status': row.get('status'), 'defaultListGateEligible': visible,
           'blockers': blocked, 'httpOrBrowserChecked': False},
          '公开门槛允许无效评分通过，需单独修复门槛并处理条目' if visible and not scored else '')
    created, updated = _stamp(row.get('createdAt')), _stamp(row.get('updatedAt'))
    chronology = bool(created and updated and created <= updated <= now + timedelta(minutes=5))
    check('timestamps', 'passed' if chronology else 'invalid',
          {k: str(row.get(k)) for k in ('createdAt', 'updatedAt', 'publishedAt', 'summaryDate')},
          '' if chronology else '核对时间来源；不因内容年代久而处置')
    reasons = sorted(set(protections + (['user_note'] if row.get('userNote') else [])
                         + (['shared_by_user'] if row.get('sharedByUserId') else [])))
    check('references', 'passed', {'protected': bool(reasons), 'protectionReasons': reasons,
                                  'scope': 'governance.REFERENCE_TABLES + direct note/share'})
    stale = [str(d['id']) for d in diagnostics if (d['reasonCode'] == 'PENDING_SCORE' and scored)
             or (d['reasonCode'].startswith('REPAIR_') and scored and not repair.needs_summary(row))]
    repeated = [str(d['id']) for d in diagnostics if d.get('duplicateCount', 1) > 1]
    check('diagnostics', 'invalid' if stale or repeated else 'passed',
          {'matchedSameRunUrlPendingIds': [str(d['id']) for d in diagnostics],
           'provablyResolvedIds': stale, 'duplicateIds': repeated},
          '仅关闭同run/URL已解决诊断，重复项保留历史' if stale or repeated else '')
    need = not scored or repair.needs_summary(row)
    if not item:
        check('retry', 'missing' if need else 'not_applicable', {'state': 'unattempted'},
              '持续补救队列尚未尝试；按优先级推进' if need else '')
    elif not checkpoint_stable or str(row.get('updatedAt')) != item.get('observedUpdatedAt'):
        check('retry', 'unverified', {'state': item.get('status'), 'reason': '断点与快照并发变化或版本不匹配'},
              '下一次只读快照复核，禁止据旧断点判定当前成功或失败')
    else:
        problems = []
        status = item.get('status')
        if status == 'complete' and need:
            problems.append('完成状态仍有缺口')
        if status in {'retry_wait', 'blocked'}:
            if not item.get('errorCode') or not item.get('reason'):
                problems.append('失败缺原因')
            if status == 'retry_wait' and not item.get('nextAttemptAt'):
                problems.append('退避缺下次时间')
            if status == 'blocked' and item.get('nextAttemptAt'):
                problems.append('阻塞状态仍自动重试')
            maximum = 3 if item.get('errorCode') in {'SOURCE_HTTP_404', 'SOURCE_HTTP_410',
                                                     'URL_FETCH_TOO_LARGE'} else 5
            if status == 'retry_wait' and int(item.get('attempts', 0)) >= maximum:
                problems.append('重试次数达到上限仍在排队')
        check('retry', 'invalid' if problems else 'passed',
              {**{k: item.get(k) for k in ('status', 'attempts', 'errorCode', 'reason', 'nextAttemptAt')},
               'issues': problems}, '复核断点和失败审计，不无条件重试' if problems else '')
    check('duplicates', 'unverified' if duplicate_ids else 'passed', {'candidateIds': duplicate_ids},
          '人工比对出版身份和证据；不自动合并' if duplicate_ids else '')
    check('live_source', 'unverified', {'fetchedDuringAudit': False}, '需安全读取原文才能验证当前身份与可达性')
    check('semantic_quality', 'unverified', {'modelOrHumanReviewDuringAudit': False},
          '结构通过不代表质量通过；结合真实原文核验摘要、判断和评分')
    assert set(checks) == set(CHECKS)
    defects = [key for key, value in checks.items() if value['state'] in {'missing', 'invalid'}]
    return {'id': sid, 'title': row.get('title'), 'canonicalUrl': row.get('canonicalUrl'),
            'sourceType': row.get('sourceType'), 'status': row.get('status'), 'updatedAt': str(row.get('updatedAt')),
            'protected': bool(reasons), 'basicComplete': all(checks[k]['state'] == 'passed' for k in
                   ('identity', 'lineage', 'summary', 'judgement', 'score', 'score_fields')),
            'defects': defects, 'checks': checks}


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {'total': len(rows), 'uniqueIds': len({row['id'] for row in rows}),
            'basicComplete': sum(row['basicComplete'] for row in rows),
            'withDefects': sum(bool(row['defects']) for row in rows),
            'protected': sum(row['protected'] for row in rows),
            'checks': {key: dict(Counter(row['checks'][key]['state'] for row in rows)) for key in CHECKS},
            'bySource': {str(source): {'total': len(group), 'basicComplete': sum(r['basicComplete'] for r in group)}
                         for source in {r['sourceType'] for r in rows}
                         if (group := [r for r in rows if r['sourceType'] == source])}}
