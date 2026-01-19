-- SQL migration to add migration_plans, migration_runs, migration_run_errors
-- Intended for MySQL

CREATE TABLE
IF NOT EXISTS migration_plans
(
  plan_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR
(150) NOT NULL,
  source_type ENUM
('FIREBIRD') NOT NULL DEFAULT 'FIREBIRD',
  source_schema_signature VARCHAR
(64) NULL,
  target_schema_signature VARCHAR
(64) NULL,
  mapping_json JSON NOT NULL,
  created_by_staff_id INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT NULL
);

CREATE TABLE
IF NOT EXISTS migration_runs
(
  run_id INT AUTO_INCREMENT PRIMARY KEY,
  plan_id INT NULL,
  run_label VARCHAR
(150) NULL,
  source_conn_name VARCHAR
(150) NULL,
  target_schema_name VARCHAR
(150) NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  status ENUM
('RUNNING','SUCCESS','FAILED','CANCELLED') NOT NULL DEFAULT 'RUNNING',
  table_summary_json JSON NULL,
  error_count INT DEFAULT 0,
  warn_count INT DEFAULT 0,
  INDEX idx_runs_status_started
(status, started_at),
  FOREIGN KEY
(plan_id) REFERENCES migration_plans
(plan_id)
);

CREATE TABLE
IF NOT EXISTS migration_run_errors
(
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  table_name VARCHAR
(100) NOT NULL,
  source_pk VARCHAR
(100) NULL,
  field_name VARCHAR
(100) NULL,
  error_code VARCHAR
(50) NULL,
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_run_errors_run
(run_id, table_name),
  FOREIGN KEY
(run_id) REFERENCES migration_runs
(run_id)
);

-- Note: This migration is additive. It does not alter existing business tables.
