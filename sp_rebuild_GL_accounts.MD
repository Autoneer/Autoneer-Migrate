DROP PROCEDURE IF EXISTS sp_rebuild_gl_accounts;

DELIMITER //

CREATE PROCEDURE sp_rebuild_gl_accounts(IN p_truncate_journals TINYINT)
BEGIN
  DECLARE v_dup_count BIGINT DEFAULT 0;
  DECLARE v_jnl_count BIGINT DEFAULT 0;
  DECLARE v_old_fk INT DEFAULT 1;

  /* Build key: (accclass*10000) + last4 */
  /* 1) Refuse if duplicates on this new key (Group Account only, accclass != 7) */
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT ((accclass * 10000) + MOD(accnr, 10000)) AS new_accnr, COUNT(*) AS cnt
    FROM accounts
    WHERE accnr IS NOT NULL
      AND acctype = 'Group Account'
      AND accclass IS NOT NULL
      AND accclass <> 7
    GROUP BY ((accclass * 10000) + MOD(accnr, 10000))
    HAVING COUNT(*) > 1
  ) d;

  IF v_dup_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Cannot rebuild gl_accounts: duplicates found after transforming accnr to (accclass*10000 + last4).';
  END IF;

  /* 2) If journals exist, either truncate them or refuse */
  SELECT COUNT(*) INTO v_jnl_count FROM gl_journal_lines;

  IF v_jnl_count > 0 AND (p_truncate_journals IS NULL OR p_truncate_journals = 0) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'gl_journal_lines is not empty. Pass p_truncate_journals=1 to wipe journals too, or clear them manually.';
  END IF;

  /* 3) Wipe tables safely */
  SET v_old_fk = @@FOREIGN_KEY_CHECKS;
  SET FOREIGN_KEY_CHECKS = 0;

  IF p_truncate_journals = 1 THEN
    TRUNCATE TABLE gl_journal_lines;
    TRUNCATE TABLE gl_journal_headers;
  END IF;

  TRUNCATE TABLE gl_accounts;

  SET FOREIGN_KEY_CHECKS = v_old_fk;

  /* 4) Rebuild gl_accounts from staging accounts
        new accnr = (accclass*10000 + last4)
        type_id = your gl_account_types ids:
          1 ASSET, 2 LIAB, 3 EQUITY, 4 INCOME, 5 EXPENSE, 6 COS
        ignore accclass 7
  */
  INSERT INTO gl_accounts
  (
    accnr,
    name,
    type_id,
    category,
    statement_group,
    parent_accnr,
    active,
    tax_reporting_code
  )
  SELECT
    ((a.accclass * 10000) + MOD(a.accnr, 10000)) AS accnr,
    TRIM(a.description) AS name,

    CASE
      WHEN a.accclass = 1 THEN 4  /* INCOME */
      WHEN a.accclass = 2 THEN 5  /* EXPENSE */
      WHEN a.accclass = 3 THEN 1  /* ASSET */
      WHEN a.accclass = 4 THEN 3  /* EQUITY */
      WHEN a.accclass = 5 THEN 2  /* LIAB */
      WHEN a.accclass = 6 THEN 6  /* COS */
      ELSE 1
    END AS type_id,

    CASE
      WHEN a.accclass = 1 THEN 'Income'
      WHEN a.accclass = 2 THEN 'Expense'
      WHEN a.accclass = 3 THEN 'Asset'
      WHEN a.accclass = 4 THEN 'Equity'
      WHEN a.accclass = 5 THEN 'Liability'
      WHEN a.accclass = 6 THEN 'Cost of Sales'
      ELSE NULL
    END AS category,

    NULLIF(TRIM(a.accountgroup), '') AS statement_group,

    NULL AS parent_accnr,

    CASE
      WHEN a.status IS NULL THEN 1
      WHEN UPPER(TRIM(a.status)) IN ('ACTIVE','OPEN','YES','1','NEW') THEN 1
      ELSE 0
    END AS active,

    NULL AS tax_reporting_code
  FROM accounts a
  WHERE a.accnr IS NOT NULL
    AND a.acctype = 'Group Account'
    AND a.accclass IS NOT NULL
    AND a.accclass <> 7;

  SELECT
    'OK' AS status,
    (SELECT COUNT(*) FROM gl_accounts) AS gl_accounts_rows,
    p_truncate_journals AS journals_truncated;
END//

DELIMITER ;
