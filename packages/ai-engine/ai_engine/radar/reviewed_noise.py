"""An explicit Admin review may establish noise independently of scoreability."""
from __future__ import annotations

import re
from typing import Any

from ai_engine.radar.distilled_scorer import DIM_NAMES, DISTILLED_VERSION

REVIEWED_ZERO_NOISE_POLICY = 'reviewed_zero_noise_v1'


def reviewed_zero_noise(row: dict[str, Any], evidence: Any, review: dict[str, Any] | None,
                        actor: str) -> bool:
    """Never infer noise from all-zero/default/veto output alone.

    The caller verifies a real Admin, locks references and checks the row
    version. This additional proof binds the explicit decision to a readable
    source, its current snapshot and a reason supported by a verbatim quote.
    Existing valid scores remain outside this exceptional review path.
    """
    if not review or evidence is None or row.get('distilledScore') is not None:
        return False
    parsed = review.get('modelAssessment')
    if not isinstance(parsed, dict):
        return False
    dimensions = {key: parsed[key] for key in DIM_NAMES if key in parsed}
    if (len(dimensions) != 7 or any(type(value) is not int or value != 0 for value in dimensions.values())
            or parsed.get('veto') is not None or parsed.get('hard_veto') is not None):
        return False
    quote = str(parsed.get('weak_point_evidence') or '').strip()
    def normalize(text: str) -> str:
        return re.sub(r'\s+', ' ', text).strip()
    return bool(
        review.get('policy') == REVIEWED_ZERO_NOISE_POLICY
        and review.get('decision') == 'delete_as_noise'
        and review.get('actorId') == actor
        and review.get('contentId') == str(row['id'])
        and review.get('canonicalUrl') == row.get('canonicalUrl')
        and review.get('snapshotFingerprint') == row.get('fingerprint')
        and review.get('snapshotUpdatedAt') == str(row.get('updatedAt'))
        and review.get('scoreVersion') == DISTILLED_VERSION
        and review.get('sourceEvidenceSha256') == evidence.sha256
        and len(evidence.text.strip()) >= 500
        and 8 <= len(normalize(quote)) <= 120
        and normalize(quote) in normalize(evidence.text)
        and len(str(parsed.get('weak_point') or '').strip()) >= 20
        and len(str(review.get('reviewReason') or '').strip()) >= 40
        and len(str(review.get('providerUsageEventId') or '')) == 36
        and str(review.get('providerRequestId') or '').startswith('radar-repair:')
    )
