const express = require("express");

const { state } = require("../../config/state");
const cleanup = require("../../migrate/cleanup");

const router = express.Router();

function sendError(res, err, fallback) {
	res.status(err.statusCode || 500).json({
		success: false,
		code: err.code || null,
		message: err && err.message ? err.message : fallback
	});
}

/**
 * POST /tools/cleanup/wip/preview
 * Body: { cutoffDate, includeZero }. Read-only: the jobs the Pulse card counts
 * as Ready for Collection, their buckets, and what a release would change.
 */
router.post("/tools/cleanup/wip/preview", async (req, res) => {
	try {
		const preview = await cleanup.readWipCleanup(state.mysql, state.schemaName, req.body || {});
		res.set("Cache-Control", "no-store");
		res.json({ success: true, ...preview });
	} catch (err) {
		sendError(res, err, "Failed to read the WIP clean-up");
	}
});

/** POST /tools/cleanup/wip/release  Body: the preview's body plus { expectedJobs, confirm } */
router.post("/tools/cleanup/wip/release", async (req, res) => {
	try {
		const result = await cleanup.releaseCompletedJobs(state.mysql, state.schemaName, req.body || {});
		res.json({ success: true, ...result });
	} catch (err) {
		sendError(res, err, "Releasing the completed jobs failed");
	}
});

/** POST /tools/cleanup/wip/undo  Body: { batchId?, confirm } */
router.post("/tools/cleanup/wip/undo", async (req, res) => {
	try {
		const result = await cleanup.undoRelease(state.mysql, state.schemaName, req.body || {});
		res.json({ success: true, ...result });
	} catch (err) {
		sendError(res, err, "Failed to undo the release");
	}
});

module.exports = router;
