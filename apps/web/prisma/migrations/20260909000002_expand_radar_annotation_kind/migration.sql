-- The API accepts "highlight_comment", which is 17 characters long.
-- Keep room for future annotation kinds without changing the raw-SQL contract.
ALTER TABLE "radar_annotations"
  ALTER COLUMN "kind" TYPE VARCHAR(32);
