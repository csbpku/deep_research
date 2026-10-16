from copy import deepcopy

import pytest

from ai_engine.radar import repair
from ai_engine.radar.distilled_scorer import DIM_NAMES, DISTILLED_VERSION
from ai_engine.radar.reviewed_noise import REVIEWED_ZERO_NOISE_POLICY, reviewed_zero_noise


def packet():
    actor='37cd474a-b0f7-44fb-a1e8-2c9afb6d4b34'
    row={'id':'content','canonicalUrl':'https://example.org/article','fingerprint':'snapshot',
         'updatedAt':'now','distilledScore':None}
    evidence=repair.Evidence('The practical next step is to take a step back, move forward carefully. ' * 20,
                             'source_excerpt',False)
    review={'policy':REVIEWED_ZERO_NOISE_POLICY,'decision':'delete_as_noise','actorId':actor,'contentId':'content',
            'canonicalUrl':row['canonicalUrl'],'snapshotFingerprint':'snapshot','snapshotUpdatedAt':'now',
            'scoreVersion':DISTILLED_VERSION,'sourceEvidenceSha256':evidence.sha256,
            'reviewReason':'来源可读但全文只包含空泛自我反思措辞，没有技术对象、事实、方法或可执行步骤。已逐项复核引文和现行量表，明确为噪声。',
            'providerUsageEventId':'a0000000-0000-0000-0000-000000000001',
            'providerRequestId':'radar-repair:verified-request:1',
            'modelAssessment':{**dict.fromkeys(DIM_NAMES,0),'veto':None,
                'weak_point':'全文仅有空泛措辞，未提供可核查事实或任何具体工程方法与步骤。',
                'weak_point_evidence':'The practical next step is to take a step back'}}
    return row,evidence,review,actor


def test_explicit_source_bound_review_can_establish_noise_without_a_fabricated_score():
    row,evidence,review,actor=packet()
    assert reviewed_zero_noise(row,evidence,review,actor)
    assert row['distilledScore'] is None
    assert not repair.has_score(row)


@pytest.mark.parametrize('field,value',[
    ('decision','pending'),('actorId','someone-else'),('snapshotFingerprint','other'),
    ('sourceEvidenceSha256','other'),('snapshotUpdatedAt','later'),('scoreVersion','legacy'),
    ('reviewReason',''),('providerUsageEventId',''),
])
def test_incomplete_or_stale_reviews_never_authorize_deletion(field,value):
    row,evidence,review,actor=packet()
    review[field]=value
    assert not reviewed_zero_noise(row,evidence,review,actor)


@pytest.mark.parametrize('veto',['title_content_mismatch','unsafe_content'])
def test_a_hard_veto_is_not_evidence_of_content_noise(veto):
    row,evidence,review,actor=packet()
    review['modelAssessment']['veto']=veto
    assert not reviewed_zero_noise(row,evidence,review,actor)


def test_all_zero_alone_or_an_ungrounded_criticism_is_insufficient():
    row,evidence,review,actor=packet()
    assert not reviewed_zero_noise(row,evidence,None,actor)
    changed=deepcopy(review)
    changed['modelAssessment']['weak_point_evidence']='An invented source quotation.'
    assert not reviewed_zero_noise(row,evidence,changed,actor)
    changed=deepcopy(review)
    changed['modelAssessment']['信息增量']=None
    assert not reviewed_zero_noise(row,evidence,changed,actor)
    row['distilledScore']={'isDefault':False,'dimensions':dict.fromkeys(DIM_NAMES,2)}
    assert not reviewed_zero_noise(row,evidence,review,actor)
