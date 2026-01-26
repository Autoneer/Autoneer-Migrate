-- SQL Migration: Add Mapping Persistence and ID Tracking Tables
-- Purpose: Enable deterministic plan reuse, FK resolution, and full auditability
-- Run this on your MySQL target database

-- ============================================================================
-- Table: migration_run_mappings
-- Purpose: Store immutable per-run mapping snapshots for deterministic reuse
-- ============================================================================
CREATE TABLE
IF NOT EXISTS migration_run_mappings
(
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  plan_id INT NULL,
  mapping_profile_id VARCHAR
(36) NULL,
  table_name VARCHAR
(100) NOT NULL COMMENT 'Canonical uppercase TARGET table name',
  source_table VARCHAR
(100) NOT NULL COMMENT 'Firebird source table name',
  target_table VARCHAR
(100) NOT NULL COMMENT 'MySQL target table name',
  mapping_json LONGTEXT NOT NULL COMMENT 'Full resolved column mappings (no placeholders)',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_run_id
(run_id),
  INDEX idx_plan_id
(plan_id),
  INDEX idx_table_name
(table_name),
  UNIQUE KEY uk_run_table
(run_id, table_name),
  
  FOREIGN KEY
(run_id) REFERENCES migration_runs
(run_id) ON
DELETE CASCADE,
  FOREIGN KEY (plan_id)
REFERENCES migration_plans
(plan_id) ON
DELETE
SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Immutable per-run mapping snapshots for deterministic reuse';

-- ============================================================================
-- Table: migration_id_map
-- Purpose: Track source PK → target PK mappings for FK resolution
-- ============================================================================
CREATE TABLE
IF NOT EXISTS migration_id_map
(
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  table_name VARCHAR
(100) NOT NULL COMMENT 'Canonical uppercase TARGET table name',
  source_pk VARCHAR
(255) NOT NULL COMMENT 'Source primary key value (composite keys pipe-delimited)',
  target_pk VARCHAR
(255) NOT NULL COMMENT 'Target primary key value (composite keys pipe-delimited)',
  operation ENUM
('INSERT', 'SKIP', 'UPDATE') NOT NULL COMMENT 'INSERT=new row, SKIP=duplicate found, UPDATE=updated existing',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_run_id
(run_id),
  INDEX idx_table_name
(table_name),
  INDEX idx_source_pk
(table_name, source_pk
(100)),
  INDEX idx_run_table_source
(run_id, table_name, source_pk
(100)),
  UNIQUE KEY uk_run_table_source
(run_id, table_name, source_pk
(255)),
  
  FOREIGN KEY
(run_id) REFERENCES migration_runs
(run_id) ON
DELETE CASCADE
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Source → target PK mappings for FK resolution and auditability';

-- ============================================================================
-- Success Message
-- ============================================================================
SELECT
	'Mapping persistence tables created successfully!' AS message,
	'New tables: migration_run_mappings, migration_id_map' AS tables_created,
	'Ready for deterministic plan reuse and FK tracking' AS status;
