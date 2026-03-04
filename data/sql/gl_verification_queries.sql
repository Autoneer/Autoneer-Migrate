-- ============================================================================
-- GL Verification Queries  —  Run after every migration
-- ============================================================================
-- Each query returns rows only if there is a problem.
-- Zero rows = PASS.  Any rows = FAIL with diagnostic detail.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK A: gl_account_types — must contain exactly 6 canonical rows
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK A: Missing or wrong gl_account_types' AS check_name,
       expected.id, expected.code, expected.section,
       actual.code AS actual_code, actual.statement_section AS actual_section
FROM (
    SELECT 1 AS id, 'INCOME'    AS code, 'IncomeStatement' AS section UNION ALL
    SELECT 2,       'EXPENSE',           'IncomeStatement'            UNION ALL
    SELECT 3,       'ASSET',             'BalanceSheet'               UNION ALL
    SELECT 4,       'EQUITY',            'BalanceSheet'               UNION ALL
    SELECT 5,       'LIABILITY',         'BalanceSheet'               UNION ALL
    SELECT 6,       'COS',              'IncomeStatement'
) expected
LEFT JOIN gl_account_types actual ON actual.id = expected.id
WHERE actual.id IS NULL
   OR actual.code != expected.code
   OR actual.statement_section != expected.section;

-- Surplus rows (should be empty)
SELECT 'CHECK A: Unexpected gl_account_types rows' AS check_name,
       gat.*
FROM gl_account_types gat
WHERE gat.id NOT IN (1, 2, 3, 4, 5, 6);

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK B: gl_accounts with invalid or null type_id
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK B: gl_accounts with invalid type_id' AS check_name,
       ga.accnr, ga.name, ga.type_id
FROM gl_accounts ga
LEFT JOIN gl_account_types gat ON gat.id = ga.type_id
WHERE ga.type_id IS NULL OR gat.id IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK C: Account type mismatches vs source ACCCLASS
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK C: Account type mismatch vs ACCCLASS' AS check_name,
       ga.accnr, ga.name, ga.type_id,
       gat.code AS actual_type,
       a.accclass AS source_accclass,
       CASE a.accclass
           WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3
           WHEN 4 THEN 4 WHEN 5 THEN 5 WHEN 6 THEN 6
       END AS expected_type_id
FROM gl_accounts ga
JOIN accounts a ON (a.accnr = ga.accnr
    OR (LOWER(TRIM(a.acctype)) = 'group account' AND MOD(a.accnr, 10000) = ga.accnr))
JOIN gl_account_types gat ON gat.id = ga.type_id
WHERE ga.type_id != CASE a.accclass
           WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3
           WHEN 4 THEN 4 WHEN 5 THEN 5 WHEN 6 THEN 6
       END;

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK D: Orphan posting lines (accnr not in gl_accounts)
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK D: Orphan gl_journal_lines' AS check_name,
       jl.id, jl.header_id, jl.accnr, jl.debit, jl.credit
FROM gl_journal_lines jl
LEFT JOIN gl_accounts ga ON ga.accnr = jl.accnr
WHERE ga.id IS NULL
LIMIT 100;

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK E: Posting lines with null/invalid type_id
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK E: Posting lines with invalid account type' AS check_name,
       jl.id, jl.accnr, ga.type_id
FROM gl_journal_lines jl
JOIN gl_accounts ga ON ga.accnr = jl.accnr
LEFT JOIN gl_account_types gat ON gat.id = ga.type_id
WHERE ga.type_id IS NULL OR gat.id IS NULL
LIMIT 100;

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK F: COS integrity — must be IncomeStatement only
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK F: COS in wrong statement section' AS check_name,
       gat.id, gat.code, gat.statement_section
FROM gl_account_types gat
WHERE gat.code = 'COS'
  AND gat.statement_section != 'IncomeStatement';

-- COS accounts in Balance Sheet
SELECT 'CHECK F: COS accounts in BalanceSheet' AS check_name,
       ga.accnr, ga.name, gat.code, gat.statement_section
FROM gl_accounts ga
JOIN gl_account_types gat ON gat.id = ga.type_id
WHERE gat.code = 'COS'
  AND gat.statement_section != 'IncomeStatement';

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK G: Trial Balance (sum debits must equal sum credits)
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK G: Trial Balance' AS check_name,
       SUM(jl.debit) AS total_debits,
       SUM(jl.credit) AS total_credits,
       ABS(SUM(jl.debit) - SUM(jl.credit)) AS imbalance
FROM gl_journal_lines jl
HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.01;

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK H: Balance Sheet identity (Assets = Liabilities + Equity)
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK H: Balance Sheet Identity' AS check_name,
       bs.total_assets,
       bs.total_liabilities,
       bs.total_equity,
       bs.total_liabilities + bs.total_equity AS liab_plus_equity,
       ABS(bs.total_assets - (bs.total_liabilities + bs.total_equity)) AS imbalance
FROM (
    SELECT
        SUM(CASE WHEN gat.code = 'ASSET'     THEN jl.debit - jl.credit ELSE 0 END) AS total_assets,
        SUM(CASE WHEN gat.code = 'LIABILITY'  THEN jl.credit - jl.debit ELSE 0 END) AS total_liabilities,
        SUM(CASE WHEN gat.code = 'EQUITY'     THEN jl.credit - jl.debit ELSE 0 END) AS total_equity
    FROM gl_journal_lines jl
    JOIN gl_accounts ga ON ga.accnr = jl.accnr
    JOIN gl_account_types gat ON gat.id = ga.type_id
    WHERE gat.statement_section = 'BalanceSheet'
) bs
HAVING ABS(bs.total_assets - (bs.total_liabilities + bs.total_equity)) > 0.01;

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK I: Income Statement purity — no BS accounts in IS
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK I: BS accounts in IncomeStatement section' AS check_name,
       ga.accnr, ga.name, gat.code, gat.statement_section
FROM gl_accounts ga
JOIN gl_account_types gat ON gat.id = ga.type_id
WHERE gat.code IN ('ASSET', 'LIABILITY', 'EQUITY')
  AND gat.statement_section = 'IncomeStatement';

SELECT 'CHECK I: IS accounts in BalanceSheet section' AS check_name,
       ga.accnr, ga.name, gat.code, gat.statement_section
FROM gl_accounts ga
JOIN gl_account_types gat ON gat.id = ga.type_id
WHERE gat.code IN ('INCOME', 'EXPENSE', 'COS')
  AND gat.statement_section = 'BalanceSheet';

-- ──────────────────────────────────────────────────────────────────────────
-- CHECK J: Legacy journal entries with accnr NOT in gl_accounts
-- ──────────────────────────────────────────────────────────────────────────
SELECT 'CHECK J: Legacy journal orphans' AS check_name,
       j.jourid, j.jdate, j.accnr, j.accclass, j.debitamount, j.creditamount
FROM journal j
LEFT JOIN gl_accounts ga ON ga.accnr = j.accnr
WHERE ga.id IS NULL
  AND j.accnr IS NOT NULL
LIMIT 100;
