const express = require("express");

const { state } = require("../../config/state");
const firebird = require("../../db/firebird");
const glBackfill = require("../../migrate/gl/glBackfill");

const router = express.Router();

function sendError(res, err, fallback) {
	res.status(err.statusCode || 500).json({
		success: false,
		code: err.code || null,
		message: err && err.message ? err.message : fallback
	});
}

// Streams a long task as NDJSON: progress events, then one complete or error event.
async function streamTask(res, fallback, work) {
	res.setHeader("Content-Type", "application/x-ndjson");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders();
	const send = (event) => {
		if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
	};
	const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
	try {
		const result = await work((progress) => send({ type: "progress", ...progress }));
		send({ type: "complete", success: true, ...result });
	} catch (err) {
		send({ type: "error", success: false, code: err.code || null, message: err && err.message ? err.message : fallback });
	} finally {
		clearInterval(heartbeat);
		res.end();
	}
}

/**
 * GET /tools/gl-backfill/scope
 * Read-only preflight: missing tables, document date range, control accounts,
 * closed periods and the latest run.
 */
router.get("/tools/gl-backfill/scope", async (req, res) => {
	try {
		const scope = await glBackfill.readScope(state.mysql, state.schemaName);
		res.json({ success: true, ...scope });
	} catch (err) {
		sendError(res, err, "Failed to read the GL backfill scope");
	}
});

/**
 * POST /tools/gl-backfill/run
 * Body: { fromDate, toDate, types[], dryRun, clearPrevious, confirm }.
 * Returns once the run is recorded; the run continues in the background.
 */
router.post("/tools/gl-backfill/run", async (req, res) => {
	try {
		const result = await glBackfill.startRun(state.mysql, state.schemaName, req.body || {});
		res.json({ success: true, ...result });
	} catch (err) {
		sendError(res, err, "Failed to start the GL backfill");
	}
});

/**
 * GET /tools/gl-backfill/status/:runId?itemStatus=FAILED,SKIPPED&itemLimit=200
 */
router.get("/tools/gl-backfill/status/:runId", async (req, res) => {
	try {
		const itemStatuses = String(req.query.itemStatus || "").split(",").map((s) => s.trim()).filter(Boolean);
		const status = await glBackfill.readRunStatus(state.mysql, state.schemaName, req.params.runId, {
			itemStatuses: itemStatuses.length ? itemStatuses : ["FAILED"],
			itemLimit: Number(req.query.itemLimit) || 200
		});
		res.set("Cache-Control", "no-store");
		res.json({ success: true, ...status });
	} catch (err) {
		sendError(res, err, "Failed to read the GL backfill run");
	}
});

/**
 * GET /tools/gl-backfill/repairs
 * Read-only: what each repair tool would work on.
 */
router.get("/tools/gl-backfill/repairs", async (req, res) => {
	try {
		const scope = await glBackfill.readRepairScope(state.mysql, state.schemaName);
		res.set("Cache-Control", "no-store");
		res.json({ success: true, ...scope });
	} catch (err) {
		sendError(res, err, "Failed to read the repair tools");
	}
});

/** POST /tools/gl-backfill/legacy-rfcs  Body: { limit, dryRun, parkLegacyRfcRow, rewriteGlSourceId, confirm } */
router.post("/tools/gl-backfill/legacy-rfcs", (req, res) => streamTask(res, "Legacy RFC migration failed",
	(onProgress) => glBackfill.migrateLegacyRfcs(state.mysql, state.schemaName, req.body || {}, onProgress)));

/** POST /tools/gl-backfill/post-repair  Body: { limit, dryRun, confirm } */
router.post("/tools/gl-backfill/post-repair", (req, res) => streamTask(res, "Post-backfill repair failed",
	(onProgress) => glBackfill.postBackfillRepair(state.mysql, state.schemaName, req.body || {}, onProgress)));

/** POST /tools/gl-backfill/general-invoices  Body: { accnr, description, suppid, dryRun, confirm } */
router.post("/tools/gl-backfill/general-invoices", (req, res) => streamTask(res, "Assigning general invoice accounts failed",
	(onProgress) => glBackfill.assignGeneralInvoiceAccounts(state.mysql, state.schemaName, req.body || {}, onProgress)));

/** POST /tools/gl-backfill/history/clear  Body: { confirm } */
router.post("/tools/gl-backfill/history/clear", async (req, res) => {
	try {
		const result = await glBackfill.clearRunHistory(state.mysql, state.schemaName, req.body || {});
		res.json({ success: true, ...result });
	} catch (err) {
		sendError(res, err, "Failed to clear the run history");
	}
});

/**
 * POST /tools/gl-backfill/opening-stock/preview
 * Read-only. Body: { cutoverDate, placeholderMinQty, keepStockIds[], zeroStockIds[] }.
 */
router.post("/tools/gl-backfill/opening-stock/preview", async (req, res) => {
	try {
		const preview = await glBackfill.readOpeningStock(state.mysql, state.schemaName, firebird.resolveFirebirdConfig({ ...state.firebird }), req.body || {});
		res.set("Cache-Control", "no-store");
		res.json({ success: true, ...preview });
	} catch (err) {
		sendError(res, err, "Failed to read the opening stock");
	}
});

/** POST /tools/gl-backfill/opening-stock/post  Body: the preview's body plus { confirm } */
router.post("/tools/gl-backfill/opening-stock/post", (req, res) => streamTask(res, "Posting the opening stock failed",
	(onProgress) => glBackfill.postOpeningStock(state.mysql, state.schemaName, firebird.resolveFirebirdConfig({ ...state.firebird }), req.body || {}, onProgress)));

/** POST /tools/gl-backfill/opening-stock/undo  Body: { confirm } */
router.post("/tools/gl-backfill/opening-stock/undo", async (req, res) => {
	try {
		const result = await glBackfill.undoOpeningStock(state.mysql, state.schemaName, req.body || {});
		res.json({ success: true, ...result });
	} catch (err) {
		sendError(res, err, "Failed to undo the opening stock");
	}
});

/**
 * GET /tools/gl-backfill/controls/:key
 * Read-only: how one control account can be fixed, for the preview.
 */
router.get("/tools/gl-backfill/controls/:key", async (req, res) => {
	try {
		const options = await glBackfill.readControlFix(state.mysql, state.schemaName, req.params.key);
		res.json({ success: true, ...options });
	} catch (err) {
		sendError(res, err, "Failed to read the control account");
	}
});

/**
 * POST /tools/gl-backfill/controls/:key
 * Body: { action: "recreate" | "reactivate" | "map" | "create", accnr, name, type }.
 */
router.post("/tools/gl-backfill/controls/:key", async (req, res) => {
	try {
		const result = await glBackfill.applyControlFix(state.mysql, state.schemaName, req.params.key, req.body || {});
		res.json({ success: true, ...result });
	} catch (err) {
		sendError(res, err, "Failed to fix the control account");
	}
});

/**
 * GET /tools/gl-backfill/rfc-originals/:sinvid
 * Read-only: how one unpaired RFC-ORIGINAL supplier invoice can be fixed, for the preview.
 */
router.get("/tools/gl-backfill/rfc-originals/:sinvid", async (req, res) => {
	try {
		const options = await glBackfill.readRfcOriginalFix(state.mysql, state.schemaName, req.params.sinvid);
		res.json({ success: true, ...options });
	} catch (err) {
		sendError(res, err, "Failed to read the invoice");
	}
});

/**
 * POST /tools/gl-backfill/rfc-originals/:sinvid
 * Body: { action: "pair" | "done" | "void" }.
 */
router.post("/tools/gl-backfill/rfc-originals/:sinvid", async (req, res) => {
	try {
		const result = await glBackfill.applyRfcOriginalFix(state.mysql, state.schemaName, req.params.sinvid, req.body || {});
		res.json({ success: true, ...result });
	} catch (err) {
		sendError(res, err, "Failed to fix the invoice");
	}
});

module.exports = router;
