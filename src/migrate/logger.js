const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");

const logEmitters = new Map();
const logStreams = new Map();
const logBuffers = new Map();

const LOG_BUFFER_SIZE = 200;
const logsDir = path.join(__dirname, "..", "..", "logs", "migrate");

function ensureLogsDir() {
	try {
		fs.mkdirSync(logsDir, { recursive: true });
	} catch (err) {
		// ignore
	}
}

function getLogEmitter(runId) {
	return logEmitters.get(runId) || null;
}

function getLogBuffer(runId) {
	return logBuffers.get(runId) || [];
}

function getLogFilePath(runId) {
	return path.join(logsDir, `${runId}.log`);
}

function startRunLogger(runId) {
	if (!runId) return null;
	if (logEmitters.has(runId)) return logEmitters.get(runId);
	ensureLogsDir();
	const emitter = new EventEmitter();
	logEmitters.set(runId, emitter);
	logBuffers.set(runId, []);
	try {
		const stream = fs.createWriteStream(getLogFilePath(runId), { flags: "a" });
		logStreams.set(runId, stream);
	} catch (err) {
		// ignore
	}
	return emitter;
}

function logEvent(runId, payload) {
	if (!runId) return;
	const emitter = logEmitters.get(runId) || startRunLogger(runId);
	const event = {
		timestamp: new Date().toISOString(),
		runId,
		...payload
	};
	const line = `${JSON.stringify(event)}\n`;
	const stream = logStreams.get(runId);
	if (stream) {
		try {
			stream.write(line);
		} catch (err) {
			// ignore
		}
	}
	if (process.env.NODE_ENV !== "production") {
		try {
			console.log(line.trim());
		} catch (err) {
			// ignore
		}
	}
	const buffer = logBuffers.get(runId) || [];
	buffer.push(event);
	while (buffer.length > LOG_BUFFER_SIZE) {
		buffer.shift();
	}
	logBuffers.set(runId, buffer);
	if (emitter) {
		emitter.emit("log", event);
	}
}

function closeRunLogger(runId) {
	const stream = logStreams.get(runId);
	if (stream) {
		try {
			stream.end();
		} catch (err) {
			// ignore
		}
	}
	logStreams.delete(runId);
	logEmitters.delete(runId);
	logBuffers.delete(runId);
}

module.exports = {
	startRunLogger,
	logEvent,
	closeRunLogger,
	getLogEmitter,
	getLogBuffer,
	getLogFilePath
};
