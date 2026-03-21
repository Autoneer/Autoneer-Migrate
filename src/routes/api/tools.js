const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

const { state } = require("../../config/state");
const { connectToSchema } = require("../../db/mysql");
const {
	seedAccountTypes,
	validateAccountTypes
} = require("../../migrate/gl/glAccountTypes");
const { runAllChecks: runGLValidationChecks } = require("../../migrate/gl/glValidation");
const { runAllGAAPChecks } = require("../../migrate/gl/glReconciliation");

function formatDuplicateGroups(rows) {
	return rows
		.slice(0, 10)
		.map((r) => `${r.gl_accnr}: ${r.source_accnrs}`)
		.join("; ");
}

router.post("/tools/rebuild-gl", async (req, res, next) => {
	try {
		const truncateJournals = req.body && req.body.truncateJournals ? 1 : 0;

		const pool = await connectToSchema(state.mysql, state.schemaName);
		try {
			// Canonicalize 6200 collisions in staging: keep 1601200 as Group Account,
			// demote any other Group Account that would resolve to 6200.
			await pool.query(
				`UPDATE accounts
					SET acctype = 'Detail Account'
				 WHERE accnr IS NOT NULL
				   AND LOWER(TRIM(acctype)) = 'group account'
				   AND accclass IS NOT NULL
				   AND accclass <> 7
				   AND accnr <> 1601200
				   AND CASE
						WHEN accnr = 1601200 THEN 6200
						WHEN accnr = 1601300 THEN 6301
						WHEN accnr = 6606300 THEN 6302
						ELSE MOD(accnr, 10000)
					   END = 6200`
			);

			// General canonicalization: for any remaining collision groups (where multiple
			// Group Accounts map to the same 4-digit target via MOD), keep whichever account
			// whose accnr already equals the 4-digit target (direct match), or if none,
			// keep the one with the lowest accnr. Demote all others to 'Detail Account'.
			// This handles cases like accnr=5520 and accnr=5995520 both mapping to 5520.
			await pool.query(
				`UPDATE accounts a
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
				   AND a.accclass <> 7`
			);

			const [dupes] = await pool.query(
				`SELECT
					CASE
						WHEN accnr = 1601200 THEN 6200
						WHEN accnr = 1601300 THEN 6301
						WHEN accnr = 6606300 THEN 6302
						ELSE MOD(accnr, 10000)
					END AS gl_accnr,
					COUNT(*) AS duplicate_count,
					GROUP_CONCAT(accnr ORDER BY accnr SEPARATOR ', ') AS source_accnrs
				 FROM accounts
				 WHERE accnr IS NOT NULL
				   AND LOWER(TRIM(acctype)) = 'group account'
				   AND accclass IS NOT NULL
				   AND accclass <> 7
				 GROUP BY
					CASE
						WHEN accnr = 1601200 THEN 6200
						WHEN accnr = 1601300 THEN 6301
						WHEN accnr = 6606300 THEN 6302
						ELSE MOD(accnr, 10000)
					END
				 HAVING COUNT(*) > 1
				 ORDER BY gl_accnr`
			);

			if (dupes.length > 0) {
				const suffix = dupes.length > 10 ? ` (showing first 10 of ${dupes.length})` : "";
				return res.status(400).json({
					success: false,
					message:
						"Cannot rebuild gl_accounts: duplicate Group Account mappings found for target accnr conversion (including collision overrides). " +
						formatDuplicateGroups(dupes) +
						suffix,
					duplicates: dupes
				});
			}

			// Step 1: Seed gl_account_types with the authoritative canonical set
			await seedAccountTypes(pool);

			// Step 2: Install / update the stored procedure from version-controlled SQL
			const spPath = path.join(__dirname, "..", "..", "..", "data", "sql", "sp_rebuild_gl_accounts.sql");
			if (fs.existsSync(spPath)) {
				const spSQL = fs.readFileSync(spPath, "utf8");
				// Split on DELIMITER and execute each block
				// The file uses DELIMITER // ... // DELIMITER ;
				// We need to extract the DROP and CREATE statements
				const dropMatch = spSQL.match(/DROP PROCEDURE IF EXISTS sp_rebuild_gl_accounts/i);
				const createMatch = spSQL.match(/CREATE\s+PROCEDURE\s+sp_rebuild_gl_accounts[\s\S]*?END\s*\$\$/i);
				if (dropMatch) {
					try { await pool.query("DROP PROCEDURE IF EXISTS sp_rebuild_gl_accounts"); } catch (e) { /* ignore */ }
				}
				if (createMatch) {
					try {
						const createSQL = createMatch[0].replace(/\$\$\s*$/i, "").trim();
						await pool.query(createSQL);
					} catch (e) {
						console.warn("[rebuild-gl] Failed to install SP from SQL file:", e.message);
					}
				}
			}

			// Step 3: Call the stored procedure
			const [rows] = await pool.query("CALL sp_rebuild_gl_accounts(?)", [truncateJournals]);

			// Step 4: Validate gl_account_types post-rebuild
			const gatValidation = await validateAccountTypes(pool);

			// Step 5: Run GL validation checks
			let glValidation = null;
			try {
				glValidation = await runGLValidationChecks(pool);
			} catch (e) {
				glValidation = { allPassed: false, error: e.message };
			}

			// Step 6: Report accounts excluded from gl_accounts and why
			const [[{ total_staging }]] = await pool.query(
				"SELECT COUNT(*) AS total_staging FROM accounts WHERE accnr IS NOT NULL"
			);
			const [skippedAccounts] = await pool.query(`
				SELECT
					accnr,
					TRIM(description) AS name,
					acctype,
					accclass,
					CASE
						WHEN LOWER(TRIM(COALESCE(acctype, ''))) != 'group account'
							THEN CONCAT('acctype = "', COALESCE(TRIM(acctype), 'NULL'), '"')
						WHEN accclass IS NULL
							THEN 'accclass is null'
						WHEN accclass = 7
							THEN 'accclass = 7 (control account — excluded by design)'
						ELSE 'unknown'
					END AS skip_reason
				FROM accounts
				WHERE accnr IS NOT NULL
				  AND NOT (
				    LOWER(TRIM(COALESCE(acctype, ''))) = 'group account'
				    AND accclass IS NOT NULL
				    AND accclass <> 7
				  )
				ORDER BY accnr
			`);

			res.json({
				success: true,
				result: rows,
				gl_account_types_valid: gatValidation.valid,
				gl_account_types_errors: gatValidation.errors,
				gl_validation: glValidation,
				accounts_summary: {
					total_staging: Number(total_staging),
					migrated: Number(total_staging) - skippedAccounts.length,
					skipped: skippedAccounts.length
				},
				skipped_accounts: skippedAccounts
			});
		} finally {
			await pool.end();
		}
	} catch (err) {
		res.status(400).json({
			success: false,
			message: err && err.message ? err.message : "Failed to rebuild gl_accounts"
		});
	}
});

/**
 * POST /tools/gl-validate
 * Run GL validation checks without rebuilding.
 */
router.post("/tools/gl-validate", async (req, res) => {
	try {
		const pool = await connectToSchema(state.mysql, state.schemaName);
		try {
			const glValidation = await runGLValidationChecks(pool);
			const gaapChecks = await runAllGAAPChecks(pool, {
				startDate: req.body?.startDate || null,
				endDate: req.body?.endDate || null
			});

			res.json({
				success: true,
				gl_validation: glValidation,
				gaap_checks: gaapChecks,
				allPassed: glValidation.allPassed && gaapChecks.allPassed
			});
		} finally {
			await pool.end();
		}
	} catch (err) {
		res.status(400).json({
			success: false,
			message: err && err.message ? err.message : "Failed to run GL validation"
		});
	}
});

/**
 * POST /tools/convert-transactional-accnr
 * Convert legacy Firebird accnr values to new GL accnr values in all
 * transactional tables (customers, suppliers, invoices, invoices_supplier,
 * stock, spares_used, work_done, payments, payments_suppliers,
 * invoice_items, labour_pricing).
 *
 * Must be run AFTER all transactional tables have been migrated AND after
 * Rebuild GL Accounts has been run (gl_accounts + accounts staging required).
 */
router.post("/tools/convert-transactional-accnr", async (req, res) => {
	try {
		const pool = await connectToSchema(state.mysql, state.schemaName);
		try {
			// Install / update the stored procedure from version-controlled SQL
			const spPath = path.join(__dirname, "..", "..", "..", "data", "sql", "sp_convert_transactional_accnr.sql");
			if (!fs.existsSync(spPath)) {
				return res.status(500).json({ success: false, message: "sp_convert_transactional_accnr.sql not found" });
			}

			const spSQL = fs.readFileSync(spPath, "utf8");
			const dropMatch = spSQL.match(/DROP PROCEDURE IF EXISTS sp_convert_transactional_accnr/i);
			const createMatch = spSQL.match(/CREATE\s+PROCEDURE\s+sp_convert_transactional_accnr[\s\S]*?END\s*\$\$/i);

			if (dropMatch) {
				try { await pool.query("DROP PROCEDURE IF EXISTS sp_convert_transactional_accnr"); } catch (e) { /* ignore */ }
			}
			if (createMatch) {
				try {
					const createSQL = createMatch[0].replace(/\$\$\s*$/i, "").trim();
					await pool.query(createSQL);
				} catch (e) {
					return res.status(500).json({ success: false, message: `Failed to install stored procedure: ${e.message}` });
				}
			}

			// Execute the stored procedure
			const [rows] = await pool.query("CALL sp_convert_transactional_accnr()");

			res.json({ success: true, result: rows });
		} finally {
			await pool.end();
		}
	} catch (err) {
		res.status(400).json({
			success: false,
			message: err && err.message ? err.message : "Failed to convert transactional accnr values"
		});
	}
});

module.exports = router;
