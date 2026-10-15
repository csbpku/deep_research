from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import pytest

from ai_engine.radar import quality_audit as q

NOW = datetime(2026, 10, 15, 5, tzinfo=timezone.utc)


def row() -> dict[str, Any]:
    return {'id': str(uuid4()), 'title': 'A technical article', 'body': 'Concrete source summary. ' * 10,
            'interpretation': 'Useful for tool evaluation with explicit implementation limitations.',
            'url': 'https://example.org/a', 'canonicalUrl': 'https://example.org/a',
            'source': 'daily', 'sourceId': str(uuid4()), 'sourceType': 'rss', 'syncRunId': str(uuid4()),
            'status': 'candidate', 'createdAt': NOW, 'updatedAt': NOW, 'tags': ['external_reading'],
            'distilledTotal': 60, 'distilledTier': 'deep_read', 'distilledProfile': 'engineering',
            'distilledScore': {'version': '4.7', 'isDefault': False, 'tier': 'deep_read',
                               'profile': 'engineering', 'total': 60,
                               'dimensions': dict.fromkeys(q.SERIAL_KEYS.values(), 2),
                               'weakPoint': 'Limited implementation evidence'}}


def audit(r: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return q.audit_row(r, now=NOW, protections=kw.get('protections', []),
                       diagnostics=kw.get('diagnostics', []), item=kw.get('item'),
                       checkpoint_stable=kw.get('stable', True), duplicate_ids=[])


def test_legacy_external_score_without_body_cache_or_old_review_is_supported() -> None:
    r = row()
    r['contentReviewStatus'] = 'needs_manual_review'
    result = audit(r)
    assert result['basicComplete']
    assert result['checks']['reading_path']['state'] == 'passed'
    assert result['checks']['cached_original']['state'] == 'not_applicable'
    assert result['checks']['score']['state'] == 'passed'
    assert result['checks']['semantic_quality']['state'] == 'unverified'


def test_legacy_reason_field_is_evidence_and_not_a_missing_reason() -> None:
    r = row()
    r['distilledScore']['weakPoint'] = ''
    r['scoreReason'] = 'Specific legacy score rationale'
    result = audit(r)
    assert result['checks']['score_evidence']['state'] == 'unverified'
    assert result['checks']['score_evidence']['evidence']['reasonField'] == 'scoreReason'


@pytest.mark.parametrize('change', ['default', 'zero', 'unknown_dimensions', 'nan'])
def test_invalid_score_cannot_count_as_complete(change: str) -> None:
    r = row()
    if change == 'default':
        r['distilledScore']['isDefault'] = True
    elif change == 'zero':
        r['distilledScore']['dimensions'] = dict.fromkeys(q.SERIAL_KEYS.values(), 0)
    elif change == 'unknown_dimensions':
        r['distilledScore']['dimensions'] = dict.fromkeys('abcdefg', 2)
    else:
        r['distilledScore']['total'] = float('nan')
    result = audit(r)
    assert not result['basicComplete']
    assert result['checks']['score']['state'] == 'invalid'
    assert result['checks']['lifecycle']['state'] == 'invalid'


def test_delivered_skim_downgrade_is_valid_but_missing_reader_is_explicit() -> None:
    r = row()
    r.update(tags=[], distilledTier='skim')
    result = audit(r)
    assert result['checks']['score_fields']['state'] == 'passed'
    assert result['checks']['reading_path']['state'] == 'missing'
    assert result['checks']['lifecycle']['evidence']['defaultListGateEligible']


def test_missing_score_with_grade_and_placeholder_summary_is_not_success() -> None:
    r = row()
    r.update(distilledScore=None, body='抓取失败' * 100, interpretation='')
    result = audit(r)
    assert result['checks']['summary']['state'] == 'missing'
    assert result['checks']['judgement']['state'] == 'missing'
    assert result['checks']['score_fields']['state'] == 'invalid'


def test_concurrent_checkpoint_is_not_false_completion_or_failure() -> None:
    r = row()
    r['body'] = ''
    item = {'status': 'complete', 'observedUpdatedAt': str(NOW)}
    assert audit(r, item=item)['checks']['retry']['state'] == 'invalid'
    assert audit(r, item=item, stable=False)['checks']['retry']['state'] == 'unverified'


def test_diagnostics_require_resolution_of_this_insertion_and_complete_brief() -> None:
    r = row()
    ds = [{'id': 'score', 'reasonCode': 'PENDING_SCORE'}, {'id': 'brief', 'reasonCode': 'REPAIR_MODEL_SUMMARY_INVALID'}]
    r['body'] = ''
    result = audit(r, diagnostics=ds)
    assert result['checks']['diagnostics']['evidence']['provablyResolvedIds'] == ['score']


def test_deterministic_retry_limit_and_reference_protection() -> None:
    r = row()
    item = {'observedUpdatedAt': str(NOW), 'status': 'retry_wait', 'attempts': 3,
            'errorCode': 'SOURCE_HTTP_404', 'reason': 'Not found', 'nextAttemptAt': 123}
    result = audit(r, item=item, protections=['user_bookmarks'])
    assert result['protected']
    assert result['checks']['retry']['state'] == 'invalid'


def test_duplicate_title_is_only_a_candidate_and_aggregate_covers_every_id() -> None:
    a, b = row(), row()
    b['canonicalUrl'] = 'https://example.org/other'
    duplicates = q.duplicate_candidates([a, b])
    assert duplicates[a['id']] == [b['id']]
    results = [audit(a), audit(b)]
    assert q.aggregate(results)['total'] == q.aggregate(results)['uniqueIds'] == 2
