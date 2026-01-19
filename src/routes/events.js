const express = require("express");
const { getEmitter } = require("../migrate/runner");

const router = express.Router();

router.get("/events", (req, res) => {
	const runId = req.query.runId;
	if (!runId) {
		res.status(400).end();
		return;
	}

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");

	const emitter = getEmitter(runId);
	if (!emitter) {
		res.write(`event: message\ndata: ${JSON.stringify({ type: "not_found" })}\n\n`);
		res.end();
		return;
	}

	const onEvent = (payload) => {
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	};

	emitter.on("event", onEvent);

	req.on("close", () => {
		emitter.removeListener("event", onEvent);
	});
});

module.exports = router;
