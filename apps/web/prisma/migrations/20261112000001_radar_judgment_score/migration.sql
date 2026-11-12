-- P0-4 判断参与排序：把 read/later/pilot/inaccurate 聚合成一个可排序的分值，
-- 由反馈接口在同一事务内重算，列表无需逐页 join，分页结果保持确定。
-- 权重：pilot +2 / later +1 / read -1 / inaccurate -2；±20 封顶。
ALTER TABLE "summaries"
  ADD COLUMN "judgmentScore" INTEGER NOT NULL DEFAULT 0;

-- 一次性回填已存在的判断，避免上线后旧判断要等用户再点一次才生效。
-- 没有任何判断记录的历史行保持 DEFAULT 0（不参与同分再平衡）。
UPDATE "summaries" AS s
SET "judgmentScore" = LEAST(
  20,
  GREATEST(
    -20,
    COALESCE(
      (
        SELECT SUM(
          CASE f."feedbackType"
            WHEN 'pilot' THEN 2
            WHEN 'later' THEN 1
            WHEN 'read' THEN -1
            WHEN 'inaccurate' THEN -2
            ELSE 0
          END
        )
        FROM "radar_feedback" AS f
        WHERE f."summaryId" = s.id
      ),
      0
    )
  )
)
WHERE EXISTS (
  SELECT 1
  FROM "radar_feedback" AS f
  WHERE f."summaryId" = s.id
    AND f."feedbackType" IN ('read', 'later', 'pilot', 'inaccurate')
);
