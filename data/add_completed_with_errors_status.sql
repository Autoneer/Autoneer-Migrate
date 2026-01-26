-- Migration: Add COMPLETED_WITH_ERRORS status to migration_runs table
-- Description: Support continue-on-error mode where migrations complete with some table failures

-- Check if the status enum already includes COMPLETED_WITH_ERRORS
-- If not, alter the column to add the new status value

ALTER TABLE migration_runs MODIFY COLUMN status enum
('RUNNING','SUCCESS','FAILED','CANCELLED','COMPLETED_WITH_ERRORS') NOT NULL DEFAULT 'RUNNING';

-- Log the migration
SELECT 'Migration completed: Added COMPLETED_WITH_ERRORS status to migration_runs.status enum' AS migration_status;
