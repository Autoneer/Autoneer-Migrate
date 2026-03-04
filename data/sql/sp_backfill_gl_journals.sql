-- ============================================================================
-- sp_backfill_gl_journals  —  Backfill gl_journal_headers + gl_journal_lines
-- ============================================================================
-- Creates normalised GL journal entries from the legacy flat `journal` table.
--
-- Prerequisites:
--   • gl_account_types must be seeded (run sp_rebuild_gl_accounts first).
--   • gl_accounts must be populated.
--   • gl_periods must have at least one row matching the journal dates.
--
-- Parameters:
--   p_force  INT  —  1 = truncate existing journal headers/lines first
--                     0 = refuse if any gl_journal_lines exist
--
-- Idempotent when p_force=1.
-- ============================================================================

DELIMITER
//

CREATE PROCEDURE sp_backfill_gl_journals(IN p_force INT)
BEGIN
	DECLARE v_existing BIGINT DEFAULT 0;

SELECT COUNT(*)
INTO v_existing
FROM gl_journal_lines;

IF v_existing > 0 AND COALESCE(p_force, 0) = 0 THEN
        SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT
= 'gl_journal_lines is not empty. Pass force=1 to truncate and rebuild.';
END
IF;

    IF COALESCE(p_force, 0) = 1 THEN
SET FOREIGN_KEY_CHECKS
= 0;
TRUNCATE TABLE gl_journal_lines;
TRUNCATE TABLE gl_journal_headers;
SET FOREIGN_KEY_CHECKS
= 1;
END
IF;

    -- ----------------------------------------------------------------
    -- Step 1: Create journal headers from distinct (source, sourceid, jdate)
    -- ----------------------------------------------------------------
    -- Each unique combination of source + sourceid in the legacy journal
    -- becomes one gl_journal_header.
    INSERT INTO gl_journal_headers
	(jdate, source, source_id, description, status, period_id, posted_by)
SELECT
	j.jdate,
	COALESCE(j.source, 'LEGACY'),
	CAST(j.sourceid AS CHAR(50)),
	MAX(j.description),
	'POSTED',
	(
            SELECT gp.id
	FROM gl_periods gp
	WHERE j.jdate BETWEEN gp.start_date AND gp.end_date
	ORDER BY gp.start_date
            LIMIT 1
        ),
        j.staff_id
FROM journal j
WHERE j.jdate IS NOT NULL
	AND j.sourceid IS NOT NULL
	AND j.accnr IS NOT NULL
GROUP BY j.source, j.sourceid, j.jdate, j.staff_id
ON DUPLICATE KEY
UPDATE
        description = VALUES
(description);

-- ----------------------------------------------------------------
-- Step 2: Create journal lines
-- ----------------------------------------------------------------
-- Each legacy journal row becomes a gl_journal_line linked to its header.
-- HARD CONSTRAINT: jl.accnr must exist in gl_accounts (FK enforced).
INSERT INTO gl_journal_lines
	(header_id, accnr, debit, credit, ref1, ref2, cid, suppid, line_no)
SELECT
	jh.id                                      AS header_id,
	j.accnr                                    AS accnr,
	COALESCE(j.debitamount, 0)                 AS debit,
	COALESCE(j.creditamount, 0)                AS credit,
	j.source2                                  AS ref1,
	j.sourcename                               AS ref2,
	j.cid,
	j.suppid,
	ROW_NUMBER() OVER (
            PARTITION BY jh.id
            ORDER BY j.jourid
        )                                          AS line_no
FROM journal j
	JOIN gl_journal_headers jh
	ON jh.source = COALESCE(j.source, 'LEGACY')
		AND jh.source_id = CAST(j.sourceid AS CHAR(50))
		AND jh.jdate = j.jdate
	JOIN gl_accounts ga ON ga.accnr = j.accnr
WHERE j.jdate IS NOT NULL
	AND j.sourceid IS NOT NULL
	AND j.accnr IS NOT NULL;

-- ----------------------------------------------------------------
-- Step 3: Report orphan journal rows (accnr not in gl_accounts)
-- ----------------------------------------------------------------
SELECT
	j.jourid,
	j.jdate,
	j.accnr,
	j.accclass,
	j.debitamount,
	j.creditamount,
	j.source,
	j.description,
	'ORPHAN: accnr not found in gl_accounts' AS reason
FROM journal j
	LEFT JOIN gl_accounts ga ON ga.accnr = j.accnr
WHERE ga.id IS NULL
	AND j.accnr IS NOT NULL;

END //

DELIMITER ;
