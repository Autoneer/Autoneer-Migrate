-- ============================================================================
-- GL Idempotent Patches  —  Correct already-migrated data
-- ============================================================================
-- Safe to run multiple times.  Each patch is wrapped in a transaction-safe
-- pattern (most MySQL DDL is implicitly committed, but DML is safe).
--
-- Run AFTER sp_rebuild_gl_accounts to fix any residual issues.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- PATCH 1: Ensure gl_account_types has the canonical 6 rows
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO gl_account_types (id, code, statement_section, display_order) VALUES
    (1, 'INCOME',    'IncomeStatement', 1),
    (2, 'EXPENSE',   'IncomeStatement', 2),
    (3, 'ASSET',     'BalanceSheet',    3),
    (4, 'EQUITY',    'BalanceSheet',    4),
    (5, 'LIABILITY', 'BalanceSheet',    5),
    (6, 'COS',       'IncomeStatement', 6)
ON DUPLICATE KEY UPDATE
    code              = VALUES(code),
    statement_section = VALUES(statement_section),
    display_order     = VALUES(display_order);

-- Remove any non-canonical rows (orphan types)
DELETE FROM gl_account_types
WHERE id NOT IN (1, 2, 3, 4, 5, 6);


-- ──────────────────────────────────────────────────────────────────────────
-- PATCH 2: Fix gl_accounts.type_id based on source ACCCLASS
-- ──────────────────────────────────────────────────────────────────────────
-- For Group Accounts (matched by MOD(accnr, 10000)):
UPDATE gl_accounts ga
JOIN accounts a ON MOD(a.accnr, 10000) = ga.accnr
    AND LOWER(TRIM(a.acctype)) = 'group account'
SET ga.type_id = CASE a.accclass
    WHEN 1 THEN 1
    WHEN 2 THEN 2
    WHEN 3 THEN 3
    WHEN 4 THEN 4
    WHEN 5 THEN 5
    WHEN 6 THEN 6
END
WHERE a.accclass IN (1, 2, 3, 4, 5, 6)
  AND ga.type_id != CASE a.accclass
    WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3
    WHEN 4 THEN 4 WHEN 5 THEN 5 WHEN 6 THEN 6
  END;

-- For detail accounts (direct accnr match):
UPDATE gl_accounts ga
JOIN accounts a ON a.accnr = ga.accnr
    AND (LOWER(TRIM(a.acctype)) != 'group account' OR a.acctype IS NULL)
SET ga.type_id = CASE a.accclass
    WHEN 1 THEN 1
    WHEN 2 THEN 2
    WHEN 3 THEN 3
    WHEN 4 THEN 4
    WHEN 5 THEN 5
    WHEN 6 THEN 6
END
WHERE a.accclass IN (1, 2, 3, 4, 5, 6)
  AND ga.type_id != CASE a.accclass
    WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3
    WHEN 4 THEN 4 WHEN 5 THEN 5 WHEN 6 THEN 6
  END;


-- ──────────────────────────────────────────────────────────────────────────
-- PATCH 3: Flag / report gl_accounts that still have no valid type_id
-- ──────────────────────────────────────────────────────────────────────────
-- These accounts cannot be used in postings and must be resolved manually.
SELECT
    'PATCH 3: Accounts with unresolvable type_id' AS patch,
    ga.accnr,
    ga.name,
    ga.type_id
FROM gl_accounts ga
LEFT JOIN gl_account_types gat ON gat.id = ga.type_id
WHERE ga.type_id IS NULL OR gat.id IS NULL;


-- ──────────────────────────────────────────────────────────────────────────
-- PATCH 4: Detect and report orphan gl_journal_lines
-- ──────────────────────────────────────────────────────────────────────────
-- These lines reference accnr values not in gl_accounts.
-- They CANNOT be automatically fixed (would change financial data).
-- Report them for manual resolution.
SELECT
    'PATCH 4: Orphan journal lines (accnr not in gl_accounts)' AS patch,
    jl.id AS line_id,
    jl.header_id,
    jl.accnr,
    jl.debit,
    jl.credit
FROM gl_journal_lines jl
LEFT JOIN gl_accounts ga ON ga.accnr = jl.accnr
WHERE ga.id IS NULL
LIMIT 200;


-- ──────────────────────────────────────────────────────────────────────────
-- PATCH 5: Ensure statement_group for COS accounts is distinct from EXPENSE
-- ──────────────────────────────────────────────────────────────────────────
-- If COS and EXPENSE accounts share the same statement_group, set COS
-- accounts to 'Cost of Sales' to ensure separate reporting.
UPDATE gl_accounts ga
JOIN gl_account_types gat ON gat.id = ga.type_id
SET ga.statement_group = 'Cost of Sales'
WHERE gat.code = 'COS'
  AND (ga.statement_group IS NULL
       OR ga.statement_group IN (
           SELECT DISTINCT ga2.statement_group
           FROM gl_accounts ga2
           JOIN gl_account_types gat2 ON gat2.id = ga2.type_id
           WHERE gat2.code = 'EXPENSE'
             AND ga2.statement_group IS NOT NULL
       ));
