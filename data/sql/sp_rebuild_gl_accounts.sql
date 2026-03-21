DELIMITER $$

DROP PROCEDURE IF EXISTS sp_rebuild_gl_accounts $$
CREATE PROCEDURE sp_rebuild_gl_accounts(IN p_truncate_journals TINYINT)
BEGIN
  DECLARE v_dup_count BIGINT DEFAULT 0;
  DECLARE v_jnl_count BIGINT DEFAULT 0;
  DECLARE v_old_fk INT DEFAULT 1;

  DECLARE v_id_income INT;
  DECLARE v_id_expense INT;
  DECLARE v_id_asset INT;
  DECLARE v_id_equity INT;
  DECLARE v_id_liability INT;
  DECLARE v_id_cos INT;

  /* Load required type IDs from canonical gl_account_types.code values */
  SELECT id INTO v_id_income FROM gl_account_types WHERE code = 'INCOME' LIMIT 1;
  SELECT id INTO v_id_expense FROM gl_account_types WHERE code = 'EXPENSE' LIMIT 1;
  SELECT id INTO v_id_asset FROM gl_account_types WHERE code = 'ASSET' LIMIT 1;
  SELECT id INTO v_id_equity FROM gl_account_types WHERE code = 'EQUITY' LIMIT 1;
  SELECT id INTO v_id_liability FROM gl_account_types WHERE code = 'LIABILITY' LIMIT 1;
  SELECT id INTO v_id_cos FROM gl_account_types WHERE code = 'COS' LIMIT 1;

  IF v_id_income IS NULL OR v_id_expense IS NULL OR v_id_asset IS NULL
     OR v_id_equity IS NULL OR v_id_liability IS NULL OR v_id_cos IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'gl_account_types missing one or more required codes: INCOME, EXPENSE, ASSET, EQUITY, LIABILITY, COS.';
  END IF;

  /* Canonicalize known 6200 collision: keep 1601200 as Group Account */
  UPDATE accounts a
  SET a.acctype = 'Detail Account'
  WHERE a.accnr IS NOT NULL
    AND LOWER(TRIM(a.acctype)) = 'group account'
    AND a.accclass IS NOT NULL
    AND a.accclass <> 7
    AND a.accnr <> 1601200
    AND CASE
      WHEN a.accnr = 1601200 THEN 6200
      WHEN a.accnr = 1601300 THEN 6301
      WHEN a.accnr = 6606300 THEN 6302
      ELSE MOD(a.accnr, 10000)
    END = 6200;

  /* General canonicalization: for any remaining collision groups (where multiple
     Group Accounts map to the same 4-digit target via MOD), keep whichever account
     whose accnr already equals the 4-digit target (direct match), or if none,
     keep the one with the lowest accnr. Demote all others to 'Detail Account'.
     This handles cases like accnr=5520 and accnr=5995520 both mapping to 5520. */
  UPDATE accounts a
  INNER JOIN (
    SELECT
      COALESCE(
        MIN(CASE WHEN accnr = target_accnr THEN accnr ELSE NULL END),
        MIN(accnr)
      ) AS keep_accnr,
      target_accnr
    FROM (
      SELECT
        accnr,
        CASE
          WHEN accnr = 1601200 THEN 6200
          WHEN accnr = 1601300 THEN 6301
          WHEN accnr = 6606300 THEN 6302
          ELSE MOD(accnr, 10000)
        END AS target_accnr
      FROM accounts
      WHERE accnr IS NOT NULL
        AND LOWER(TRIM(acctype)) = 'group account'
        AND accclass IS NOT NULL
        AND accclass <> 7
    ) sub
    GROUP BY target_accnr
    HAVING COUNT(*) > 1
  ) collision ON CASE
    WHEN a.accnr = 1601200 THEN 6200
    WHEN a.accnr = 1601300 THEN 6301
    WHEN a.accnr = 6606300 THEN 6302
    ELSE MOD(a.accnr, 10000)
  END = collision.target_accnr
    AND a.accnr <> collision.keep_accnr
  SET a.acctype = 'Detail Account'
  WHERE a.accnr IS NOT NULL
    AND LOWER(TRIM(a.acctype)) = 'group account'
    AND a.accclass IS NOT NULL
    AND a.accclass <> 7;

  /* Refuse rebuild if conversion to target accnr would create duplicates */
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT
      CASE
        WHEN a.accnr = 1601200 THEN 6200
        WHEN a.accnr = 1601300 THEN 6301
        WHEN a.accnr = 6606300 THEN 6302
        ELSE MOD(a.accnr, 10000)
      END AS new_accnr,
      COUNT(*) AS cnt
    FROM accounts a
    WHERE a.accnr IS NOT NULL
      AND LOWER(TRIM(a.acctype)) = 'group account'
      AND a.accclass IS NOT NULL
      AND a.accclass <> 7
    GROUP BY
      CASE
        WHEN a.accnr = 1601200 THEN 6200
        WHEN a.accnr = 1601300 THEN 6301
        WHEN a.accnr = 6606300 THEN 6302
        ELSE MOD(a.accnr, 10000)
      END
    HAVING COUNT(*) > 1
  ) d;

  IF v_dup_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Cannot rebuild gl_accounts: duplicates found after converting accnr to target 4-digit values (including collision overrides).';
  END IF;

  /* If journals exist, either truncate them or refuse */
  SELECT COUNT(*) INTO v_jnl_count FROM gl_journal_lines;

  IF v_jnl_count > 0 AND (p_truncate_journals IS NULL OR p_truncate_journals = 0) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'gl_journal_lines is not empty. Pass p_truncate_journals=1 to wipe journals too, or clear them manually.';
  END IF;

  /* Wipe tables safely */
  SET v_old_fk = @@FOREIGN_KEY_CHECKS;
  SET FOREIGN_KEY_CHECKS = 0;

  IF p_truncate_journals = 1 THEN
    TRUNCATE TABLE gl_journal_lines;
    TRUNCATE TABLE gl_journal_headers;
  END IF;

  TRUNCATE TABLE gl_accounts;
  SET FOREIGN_KEY_CHECKS = v_old_fk;

  /* Rebuild gl_accounts from staging accounts */
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
    CASE
      WHEN a.accnr = 1601200 THEN 6200
      WHEN a.accnr = 1601300 THEN 6301
      WHEN a.accnr = 6606300 THEN 6302
      ELSE MOD(a.accnr, 10000)
    END AS accnr,

    TRIM(a.description) AS name,

    CASE
      WHEN a.accclass = 1 THEN v_id_income
      WHEN a.accclass = 2 THEN v_id_expense
      WHEN a.accclass = 3 THEN v_id_asset
      WHEN a.accclass = 4 THEN v_id_equity
      WHEN a.accclass = 5 THEN v_id_liability
      WHEN a.accclass = 6 THEN v_id_cos
      ELSE v_id_asset
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
      WHEN UPPER(TRIM(a.status)) IN ('ACTIVE', 'OPEN', 'YES', '1', 'NEW') THEN 1
      ELSE 0
    END AS active,

    NULL AS tax_reporting_code
  FROM accounts a
  WHERE a.accnr IS NOT NULL
    AND LOWER(TRIM(a.acctype)) = 'group account'
    AND a.accclass IS NOT NULL
    AND a.accclass <> 7;

  SELECT
    'OK' AS status,
    (SELECT COUNT(*) FROM gl_accounts) AS gl_accounts_rows,
    p_truncate_journals AS journals_truncated;
END $$

DELIMITER ;
