"use strict";

// The Clean Up page's tools. Each opens a pool on the selected tenant the way
// the GL backfill does, so the mirrored PWA code runs unchanged, and a write
// takes the same one-writer-per-tenant lock as a backfill task.

const glBackfill = require("../gl/glBackfill");
const wipCleanup = require("./wipCleanup");

function httpError(statusCode, code, message) {
	return Object.assign(new Error(message), { statusCode, code });
}

function flag(value) {
	return value === true || ["1", "true", "yes"].includes(String(value).toLowerCase());
}

/** Read-only: what the WIP Cleanup card shows for the given cut-off. */
async function readWipCleanup(config, schema, input = {}) {
	return glBackfill.withSchema(config, schema, async () => ({
		busy: glBackfill.isBusy(config, schema),
		...await wipCleanup.readWipCleanup({ schema, input })
	}));
}

async function releaseCompletedJobs(config, schema, input = {}) {
	if (!flag(input.confirm)) throw httpError(400, "confirmation_required", "Releasing completed jobs needs explicit confirmation.");
	return glBackfill.runTask(config, schema, "the completed-job release", () => wipCleanup.releaseCompletedJobs({ schema, input }));
}

async function undoRelease(config, schema, input = {}) {
	if (!flag(input.confirm)) throw httpError(400, "confirmation_required", "Undoing a release needs explicit confirmation.");
	return glBackfill.runTask(config, schema, "undoing a completed-job release", () => wipCleanup.undoRelease({ schema, input }));
}

module.exports = { readWipCleanup, releaseCompletedJobs, undoRelease };
