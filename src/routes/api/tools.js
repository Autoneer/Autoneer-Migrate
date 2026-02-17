const express = require("express");
const router = express.Router();

const { state } = require("../../config/state");
const { connectToSchema } = require("../../db/mysql");

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
			const [dupes] = await pool.query(
				`SELECT
					MOD(accnr, 10000) AS gl_accnr,
					COUNT(*) AS duplicate_count,
					GROUP_CONCAT(accnr ORDER BY accnr SEPARATOR ', ') AS source_accnrs
				 FROM accounts
				 WHERE accnr IS NOT NULL
				   AND LOWER(TRIM(acctype)) = 'group account'
				 GROUP BY MOD(accnr, 10000)
				 HAVING COUNT(*) > 1
				 ORDER BY gl_accnr`
			);

			if (dupes.length > 0) {
				const suffix = dupes.length > 10 ? ` (showing first 10 of ${dupes.length})` : "";
				return res.status(400).json({
					success: false,
					message:
						"Cannot rebuild gl_accounts: duplicate Group Account mappings found for MOD(accnr,10000). " +
						formatDuplicateGroups(dupes) +
						suffix,
					duplicates: dupes
				});
			}

			const [rows] = await pool.query("CALL sp_rebuild_gl_accounts(?)", [truncateJournals]);

			// mysql2 returns an array of result sets; last SELECT is typically in rows[0]
			res.json({
				success: true,
				result: rows
			});
		} finally {
			await pool.end();
		}
	} catch (err) {
		// Surface clean message back to UI
		res.status(400).json({
			success: false,
			message: err && err.message ? err.message : "Failed to rebuild gl_accounts"
		});
	}
});

module.exports = router;
