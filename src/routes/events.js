const express = require("express");
const { getEmitter, getRunState } = require("../migrate/runner");
const logger = require("../migrate/logger");

const router = express.Router();

const handleProgressStream = (req, res) => {
	const runIdRaw = req.query.runId;
	const runId = Number(runIdRaw);

	// Fix: Add logging for SSE connections
	console.log(`SSE connection for runId: ${runId} from IP: ${req.ip}`);

	if (!runId) {
		res.status(400).end();
		return;
	}

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	if (typeof res.flushHeaders === "function") {
		res.flushHeaders();
	}

	const emitter = getEmitter(runId);
	const runState = getRunState(runId);
	const logEmitter = logger.getLogEmitter(runId) || logger.startRunLogger(runId);
	const logBuffer = logger.getLogBuffer(runId);
	if (!emitter && !runState) {
		res.write(`event: message\ndata: ${JSON.stringify({ type: "not_found" })}\n\n`);
		res.end();
		return;
	}

	// Root cause note: SSE disconnects previously triggered UI failure even when the runner kept inserting.
	// We now treat SSE drop as non-fatal and rely on server-run state + reconnection.
	logger.logEvent(runId, { level: "info", phase: "progress", status: "client_connected" });

	if (runState) {
		res.write(`event: runState\ndata: ${JSON.stringify(runState)}\n\n`);
	}

	if (logBuffer.length) {
		logBuffer.forEach((entry) => {
			res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
		});
	}

	const onEvent = (payload) => {
		if (payload?.event === "runState") {
			res.write(`event: runState\ndata: ${JSON.stringify(payload.data)}\n\n`);
			return;
		}
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	};

	const onLog = (entry) => {
		res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
	};

	const heartbeat = setInterval(() => {
		res.write(": ping\n\n");
	}, 15000);

	if (emitter) {
		emitter.on("event", onEvent);
	}
	if (logEmitter) {
		logEmitter.on("log", onLog);
	}

	req.on("close", () => {
		if (emitter) {
			emitter.removeListener("event", onEvent);
		}
		if (logEmitter) {
			logEmitter.removeListener("log", onLog);
		}
		logger.logEvent(runId, { level: "warn", phase: "progress", status: "client_disconnected" });
		clearInterval(heartbeat);
	});
	return;
};

router.get("/events", handleProgressStream);
router.get("/run/progress", handleProgressStream);

module.exports = router;
