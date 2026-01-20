-- Migration script for refactoring: Add new tables for improved architecture
-- Run this script on your MySQL database

-- Create migration_mappings table for storing persistent mapping profiles
CREATE TABLE
IF NOT EXISTS migration_mappings
(
  mapping_id VARCHAR
(36) PRIMARY KEY,
  name VARCHAR
(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON
UPDATE CURRENT_TIMESTAMP,
  mapping_json LONGTEXT
NOT NULL,
  INDEX idx_name
(name),
  INDEX idx_created
(created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create migration_plans table for storing session-specific plans
CREATE TABLE
IF NOT EXISTS migration_plans
(
  plan_id INT AUTO_INCREMENT PRIMARY KEY,
  mapping_id VARCHAR
(36) NOT NULL,
  mapping_name VARCHAR
(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON
UPDATE CURRENT_TIMESTAMP,
  plan_json LONGTEXT
NOT NULL,
  is_validated BOOLEAN DEFAULT FALSE,
  validation_errors TEXT,
  validation_warnings TEXT,
  INDEX idx_mapping
(mapping_id),
  INDEX idx_created
(created_at),
  FOREIGN KEY
(mapping_id) REFERENCES migration_mappings
(mapping_id) ON
DELETE CASCADE
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create migration_schemas table for caching database schema metadata
CREATE TABLE
IF NOT EXISTS migration_schemas
(
  schema_id INT AUTO_INCREMENT PRIMARY KEY,
  db_name VARCHAR
(50) NOT NULL,  -- 'firebird' or 'mysql'
  schema_json LONGTEXT NOT NULL,
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_db
(db_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Modify migration_runs table to link to plan (if not already present)
ALTER TABLE migration_runs
ADD COLUMN
IF NOT EXISTS plan_id INT,
ADD COLUMN
IF NOT EXISTS mapping_id VARCHAR
(36),
ADD INDEX
IF NOT EXISTS idx_plan
(plan_id),
ADD INDEX
IF NOT EXISTS idx_mapping
(mapping_id);

-- Add foreign key constraints if they don't exist
-- Note: This will fail gracefully if constraints already exist
SET @sql = (SELECT
IF(
  EXISTS(
    SELECT 1
	FROM information_schema.TABLE_CONSTRAINTS
	WHERE CONSTRAINT_SCHEMA = DATABASE()
	AND TABLE_NAME = 'migration_runs'
	AND CONSTRAINT_NAME = 'fk_runs_plan'
  ),
  'SELECT "FK constraint fk_runs_plan already exists" AS message',
  'ALTER TABLE migration_runs ADD CONSTRAINT fk_runs_plan FOREIGN KEY (plan_id) REFERENCES migration_plans(plan_id) ON DELETE SET NULL'
));

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create an index on migration_runs for faster queries
CREATE INDEX
IF NOT EXISTS idx_runs_status ON migration_runs
(status);
CREATE INDEX
IF NOT EXISTS idx_runs_started ON migration_runs
(started_at);

-- Create migration_settings table for storing application settings
CREATE TABLE
IF NOT EXISTS migration_settings
(
  setting_key VARCHAR
(100) PRIMARY KEY,
  setting_value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON
UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default settings
INSERT INTO migration_settings
	(setting_key, setting_value)
VALUES
	('default_mapping_id', NULL),
	('schema_cache_ttl', '3600000'),
	('default_batch_size', '500')
ON DUPLICATE KEY
UPDATE setting_key = setting_key;

-- Add comments to tables
ALTER TABLE migration_mappings 
COMMENT = 'Stores reusable mapping profiles defining source-to-target column transformations';

ALTER TABLE migration_plans 
COMMENT = 'Stores session-specific migration plans with execution configuration';

ALTER TABLE migration_schemas 
COMMENT = 'Caches discovered database schema metadata for performance';

-- Success message
SELECT 'Refactoring migration completed successfully!' AS message,
	'New tables created: migration_mappings, migration_plans, migration_schemas, migration_settings' AS tables_created,
	'Existing tables updated: migration_runs' AS tables_modified;
