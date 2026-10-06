const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");

const logEmitters = new Map();
const logStreams = new Map();
const logBuffers = new Map();
const tableResultBuffers = new Map();

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
	return logEmitters.get(String(runId)) || null;
}

function getLogBuffer(runId) {
	return logBuffers.get(String(runId)) || [];
}

function getLogFilePath(runId) {
	return path.join(logsDir, `${runId}.log`);
}

function startRunLogger(runId, options = {}) {
	if (!runId) return null;
	if (logEmitters.has(String(runId))) return logEmitters.get(String(runId));
	const truncate = options.truncate === true;
	ensureLogsDir();
	const emitter = new EventEmitter();
	logEmitters.set(String(runId), emitter);
	logBuffers.set(String(runId), []);
	tableResultBuffers.set(String(runId), new Map());
	try {
		const stream = fs.createWriteStream(getLogFilePath(runId), { flags: truncate ? "w" : "a" });
		logStreams.set(String(runId), stream);
	} catch (err) {
		// ignore
	}
	return emitter;
}

function getTableResultBuffer(runId) {
	const results = tableResultBuffers.get(String(runId));
	return results ? Array.from(results.values()) : null;
}

function tableResultKey(event) {
	if (event.phase !== "table_finalize" || !["success", "failed"].includes(String(event.status).toLowerCase())) return null;
	return String(event.tableName || event.table || "").trim().toLowerCase() || null;
}

function formatTableResult(event) {
	const singleLine = value => String(value || "").replace(/\s+/g, " ").trim();
	const prefix = `[Run ${event.runId}] ${singleLine(event.tableName || event.table)}`;
	if (String(event.status).toLowerCase() === "success") {
		return `${prefix}: completed — inserted ${Number(event.inserted || 0).toLocaleString()}, updated ${Number(event.updated || 0).toLocaleString()}, skipped ${Number(event.skipped || 0).toLocaleString()}`;
	}
	const errorCount = Number(event.errors) || Number(String(event.error || "").match(/(?:failed with|completed with) ([\d,]+) (?:row )?errors?/i)?.[1]?.replaceAll(",", "")) || 0;
	const reason = errorCount > 0 ? `${errorCount.toLocaleString()} row error${errorCount === 1 ? '' : 's'}` : singleLine(event.error || "Table migration failed").slice(0, 160);
	return `${prefix}: failed — ${reason}. See Migration History for details.`;
}

function logEvent(runId, payload) {
	if (!runId) return;
	const emitter = logEmitters.get(String(runId)) || startRunLogger(runId);
	const event = {
		timestamp: new Date().toISOString(),
		runId,
		...payload
	};
	const line = `${JSON.stringify(event)}\n`;
	const stream = logStreams.get(String(runId));
	if (stream) {
		try {
			stream.write(line);
		} catch (err) {
			// ignore
		}
	}
	const tableKey = tableResultKey(event);
	if (tableKey) {
		const results = tableResultBuffers.get(String(runId));
		// Only one console line per table; retain all detailed events in the file.
		if (results && !results.has(tableKey) && process.env.NODE_ENV !== "production") {
			try {
				const writer = String(event.status).toLowerCase() === "failed" ? console.error : console.log;
				writer(formatTableResult(event));
			} catch { /* Console output must not interrupt a migration. */ }
		}
		if (results) results.set(tableKey, event);
	}

	const buffer = logBuffers.get(String(runId)) || [];
	buffer.push(event);
	while (buffer.length > LOG_BUFFER_SIZE) {
		buffer.shift();
	}
	logBuffers.set(String(runId), buffer);
	if (emitter) {
		emitter.emit("log", event);
	}
}

function closeRunLogger(runId) {
	const stream = logStreams.get(String(runId));
	if (stream) {
		try {
			stream.end();
		} catch (err) {
			// ignore
		}
	}
	logStreams.delete(String(runId));
	logEmitters.delete(String(runId));
	logBuffers.delete(String(runId));
	tableResultBuffers.delete(String(runId));
}

module.exports = {
	startRunLogger,
	logEvent,
	closeRunLogger,
	getLogEmitter,
	getLogBuffer,
	getTableResultBuffer,
	getLogFilePath
};
