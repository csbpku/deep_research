// Public-score contract, mirrored in ai_engine/radar/score_validity.py.
// No version upgrade or score write is implied by this read-only gate.
const aliases = [["informationGain", "info_increment"], ["analysisDepth", "analysis_depth"], ["actionability", "actionability"], ["factualReliability", "fact_credibility"], ["currentApplicability", "timeliness"], ["expressionQuality", "expression_quality"], ["audienceFit", "audience_fit"]] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function hasPublicRadarScore(summary: {
  distilledScore?: unknown; distilledTier?: string | null; tags?: string[] | null;
}): boolean {
  const score = object(summary.distilledScore);
  const dimensions = object(score?.dimensions);
  if (!score || !dimensions || Object.keys(dimensions).length !== 7) return false;
  if ((score.isDefault ?? score.is_default) !== false) return false;
  const values = aliases.map(([current, legacy]) => dimensions[current] ?? dimensions[legacy]);
  if (!values.every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3)
      || !values.some(value => typeof value === 'number' && value > 0)) return false;
  if (typeof score.total !== 'number' || !Number.isFinite(score.total) || score.total < 0 || score.total > 100) return false;
  if (typeof score.profile !== 'string' || !['paper', 'engineering', 'tech_blog', 'news'].includes(score.profile)) return false;
  if (typeof score.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(score.version)
      || /\s/.test(score.version)) return false;
  if (typeof score.tier !== 'string' || !['collection', 'deep_read', 'skim'].includes(score.tier)) return false;
  return summary.distilledTier === score.tier || (
    summary.distilledTier === 'skim' && ['collection', 'deep_read'].includes(score.tier)
    && !summary.tags?.includes('external_reading')
  );
}

// Fixed alias s, trusted static SQL only. CASE prevents jsonb_each on malformed JSON.
export const RADAR_PUBLIC_SCORE_SQL = String.raw`COALESCE(CASE
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
END, false)`;
