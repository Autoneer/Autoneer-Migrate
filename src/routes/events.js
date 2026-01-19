const express = require("express");
const { getEmitter, getRunState } = require("../migrate/runner");

const router = express.Router();

const handleProgressStream = (req, res) => {
	const runId = req.query.runId;
	if (!runId) {
		res.status(400).end();
		return;
	}

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");

	const emitter = getEmitter(runId);
	const runState = getRunState(runId);
	if (!emitter && !runState) {
		res.write(`event: message\ndata: ${JSON.stringify({ type: "not_found" })}\n\n`);
		res.end();
		return;
	}

	if (runState) {
		res.write(`event: runState\ndata: ${JSON.stringify(runState)}\n\n`);
	}

	const onEvent = (payload) => {
		if (payload?.event === "runState") {
			res.write(`event: runState\ndata: ${JSON.stringify(payload.data)}\n\n`);
			return;
		}
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	};

	if (emitter) {
		emitter.on("event", onEvent);
	}

	req.on("close", () => {
		if (emitter) {
			emitter.removeListener("event", onEvent);
		}
	});
	return;
};

router.get("/events", handleProgressStream);
router.get("/run/progress", handleProgressStream);

module.exports = router;
