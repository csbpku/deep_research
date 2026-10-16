"""Confirmed noise is disposable; fetch failures alone never establish noise."""
from __future__ import annotations

from typing import Any

from ai_engine.radar.distilled_scorer import DISTILLED_VERSION
from ai_engine.radar.score_validity import has_public_radar_score

NOISE_POLICY = 'current_valid_noise_v1'
# 5.1 changes reading labels, not the noise decision. Minimal 5.0 skip
# receipts remain valid so the taxonomy migration cannot trigger paid repeats.
NOISE_RECEIPT_VERSIONS = ('5.0', '5.1') if DISTILLED_VERSION == '5.1' else (DISTILLED_VERSION,)


def confirmed_noise(score: Any) -> bool:
    """Use the shared seven-dimension validity gate, admitting only current noise.

    Source completeness and quotations are deliberately not deletion gates under
    the owner's standing policy. Defaults, all-zero and legacy scores fail closed.
    """
    return bool(isinstance(score, dict) and score.get('tier') == 'noise'
                and score.get('version') == DISTILLED_VERSION
                and has_public_radar_score({
                    'distilledScore': {**score, 'tier': 'skim'},
                    'distilledTier': 'skim', 'tags': ['external_reading'],
                }))
