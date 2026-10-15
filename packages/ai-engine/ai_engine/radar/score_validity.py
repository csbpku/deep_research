"""Read-only public score gate. Keep the Web SQL mirror byte-identical."""
from __future__ import annotations

from typing import Any
import math
import re

ALIASES = [('informationGain', 'info_increment'), ('analysisDepth', 'analysis_depth'), ('actionability', 'actionability'), ('factualReliability', 'fact_credibility'), ('currentApplicability', 'timeliness'), ('expressionQuality', 'expression_quality'), ('audienceFit', 'audience_fit')]


def has_public_radar_score(row: dict[str, Any]) -> bool:
    score = row.get('distilledScore')
    if not isinstance(score, dict):
        return False
    dimensions = score.get('dimensions')
    if not isinstance(dimensions, dict) or len(dimensions) != 7:
        return False
    flag = score.get('isDefault')
    if flag is None:
        flag = score.get('is_default')
    if flag is not False:
        return False
    values = [dimensions.get(a) if dimensions.get(a) is not None else dimensions.get(b) for a, b in ALIASES]
    if (not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                and math.isfinite(v) and v in (0, 1, 2, 3) for v in values)
            or not any(values)):
        return False
    total = score.get('total')
    if (not isinstance(total, (int, float)) or isinstance(total, bool)
            or not math.isfinite(total) or not 0 <= total <= 100):
        return False
    if score.get('profile') not in ('paper', 'engineering', 'tech_blog', 'news'):
        return False
    version = score.get('version')
    if not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,63}', version):
        return False
    tier = score.get('tier')
    if tier not in ('collection', 'deep_read', 'skim'):
        return False
    return bool(row.get('distilledTier') == tier or (
        row.get('distilledTier') == 'skim' and tier in ('collection', 'deep_read')
        and 'external_reading' not in (row.get('tags') or [])))


RADAR_PUBLIC_SCORE_SQL = """COALESCE(CASE
  WHEN jsonb_typeof(s."distilledScore") = 'object'
    AND jsonb_typeof(s."distilledScore"->'dimensions') = 'object'
  THEN
    COALESCE(NULLIF(s."distilledScore"->'isDefault', 'null'::jsonb),
             s."distilledScore"->'is_default') = 'false'::jsonb
    AND (SELECT count(*) FROM jsonb_each(s."distilledScore"->'dimensions')) = 7
    AND EXISTS (
      SELECT 1 FROM (
        SELECT jsonb_build_array(
          COALESCE(NULLIF(s."distilledScore"->'dimensions'->'informationGain', 'null'::jsonb), s."distilledScore"->'dimensions'->'info_increment'),
          COALESCE(NULLIF(s."distilledScore"->'dimensions'->'analysisDepth', 'null'::jsonb), s."distilledScore"->'dimensions'->'analysis_depth'),
          COALESCE(NULLIF(s."distilledScore"->'dimensions'->'actionability', 'null'::jsonb), s."distilledScore"->'dimensions'->'actionability'),
          COALESCE(NULLIF(s."distilledScore"->'dimensions'->'factualReliability', 'null'::jsonb), s."distilledScore"->'dimensions'->'fact_credibility'),
          COALESCE(NULLIF(s."distilledScore"->'dimensions'->'currentApplicability', 'null'::jsonb), s."distilledScore"->'dimensions'->'timeliness'),
          COALESCE(NULLIF(s."distilledScore"->'dimensions'->'expressionQuality', 'null'::jsonb), s."distilledScore"->'dimensions'->'expression_quality'),
          COALESCE(NULLIF(s."distilledScore"->'dimensions'->'audienceFit', 'null'::jsonb), s."distilledScore"->'dimensions'->'audience_fit')
        ) AS dimensions
      ) normalized
      WHERE normalized.dimensions <@ '[0,1,2,3]'::jsonb
        AND NOT (normalized.dimensions <@ '[0]'::jsonb)
    )
    AND CASE WHEN jsonb_typeof(s."distilledScore"->'total') = 'number'
      THEN (s."distilledScore"->>'total')::numeric BETWEEN 0 AND 100 ELSE false END
    AND s."distilledScore"->>'profile' IN ('paper','engineering','tech_blog','news')
    AND jsonb_typeof(s."distilledScore"->'version') = 'string'
    AND s."distilledScore"->>'version' ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
    AND s."distilledScore"->>'tier' IN ('collection','deep_read','skim')
    AND (
      s."distilledTier" = s."distilledScore"->>'tier'
      OR (s."distilledTier" = 'skim'
          AND s."distilledScore"->>'tier' IN ('collection','deep_read')
          AND NOT ('external_reading' = ANY(COALESCE(s.tags, ARRAY[]::text[]))))
    )
  ELSE false
END, false)"""
