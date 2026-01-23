-- Add mapping_profile_id to migration_plans and backfill from legacy columns
-- Idempotent: safe to re-run

-- Ensure column exists
ALTER TABLE migration_plans
  ADD COLUMN
IF NOT EXISTS mapping_profile_id INT NULL;

-- Backfill from legacy mapping_id if present
UPDATE migration_plans p
JOIN migration_mapping_profiles m
ON m.id = p.mapping_id
SET p
.mapping_profile_id = m.id
WHERE p.mapping_profile_id IS NULL AND p.mapping_id IS NOT NULL;

-- Note: Legacy mapping_json migration requires application-level logic
-- (see mysql.ensureMigrationTables or runStore migration helpers).

-- Add index (if missing)
CREATE INDEX
IF NOT EXISTS idx_mapping_profile_id ON migration_plans
(mapping_profile_id);

-- Add FK constraint if missing
SET @sql = (SELECT
IF(
  EXISTS(
    SELECT 1
	FROM information_schema.TABLE_CONSTRAINTS
	WHERE CONSTRAINT_SCHEMA = DATABASE()
	AND TABLE_NAME = 'migration_plans'
	AND CONSTRAINT_NAME = 'fk_plans_mapping_profile'
  ),
  'SELECT "FK constraint fk_plans_mapping_profile already exists" AS message',
  'ALTER TABLE migration_plans ADD CONSTRAINT fk_plans_mapping_profile FOREIGN KEY (mapping_profile_id) REFERENCES migration_mapping_profiles(id) ON DELETE RESTRICT'
));

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Enforce NOT NULL when safe (only if no NULLs remain)
SET @sql2 = (SELECT
IF(
  (SELECT COUNT(*)
FROM migration_plans
WHERE mapping_profile_id IS NULL) = 0,
  'ALTER TABLE migration_plans MODIFY COLUMN mapping_profile_id INT NOT NULL',
  'SELECT "mapping_profile_id still has NULLs" AS message'
));

PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
