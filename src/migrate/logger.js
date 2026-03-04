const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");

const logEmitters = new Map();
const logStreams = new Map();
const logBuffers = new Map();
const consoleProgressStates = new Map();

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
	consoleProgressStates.set(runId, {
		tableOrder: [],
		tableIndex: new Map(),
		totalTables: 0,
		completedTables: 0
	});
	try {
		const stream = fs.createWriteStream(getLogFilePath(runId), { flags: "a" });
		logStreams.set(runId, stream);
	} catch (err) {
		// ignore
	}
	return emitter;
}

function updateTableOrder(state, tables) {
	const names = Array.isArray(tables) ? tables : [];
	state.tableOrder = names
		.map((t) => (typeof t === "string" ? t : t?.table))
		.filter(Boolean)
		.map((name) => String(name).toUpperCase());
	state.tableIndex = new Map(state.tableOrder.map((name, idx) => [name, idx + 1]));
	state.totalTables = state.tableOrder.length;
}

function resolveTablePosition(state, tableName) {
	const normalized = String(tableName || "").toUpperCase();
	if (!normalized) {
		return { index: 0, total: state.totalTables || 0 };
	}
	if (!state.tableIndex.has(normalized)) {
		state.tableOrder.push(normalized);
		state.tableIndex.set(normalized, state.tableOrder.length);
		state.totalTables = Math.max(state.totalTables, state.tableOrder.length);
	}
	return {
		index: state.tableIndex.get(normalized) || 0,
		total: state.totalTables || state.tableOrder.length
	};
}

function formatProgressLine(event, state) {
	const runId = event.runId;
	const level = String(event.level || "").toLowerCase();
	if (level === "debug") return null;

	if (event.phase === "run_start") {
		updateTableOrder(state, event.tables);
		const mode = event.dryRun ? "Dry run" : "Migration";
		return `[Run ${runId}] ${mode} started: ${state.totalTables} table(s).`;
	}

	if (event.phase === "preflight") {
		const action = event.action ? String(event.action).replace(/_/g, " ") : "connectivity check";
		if (event.status === "start") return `[Run ${runId}] Preflight: ${action}...`;
		if (event.status === "passed" || event.status === "ok") return `[Run ${runId}] Preflight: ${action} passed.`;
		if (event.status === "failed") return `[Run ${runId}] Preflight: ${action} failed (${event.error || "unknown error"}).`;
	}

	if (event.type === "table_cleaning_started") {
		const pos = resolveTablePosition(state, event.table);
		return `[Run ${runId}] Table ${pos.index}/${pos.total} ${event.table}: cleaning target...`;
	}

	if (event.type === "table_cleaned") {
		const pos = resolveTablePosition(state, event.table);
		return `[Run ${runId}] Table ${pos.index}/${pos.total} ${event.table}: cleaned (${event.method || "DELETE"}).`;
	}

	if (event.phase === "table_start") {
		const pos = resolveTablePosition(state, event.tableName);
		return `[Run ${runId}] Table ${pos.index}/${pos.total} ${event.tableName}: migrating...`;
	}

	if (event.phase === "fetch" && typeof event.sourceRows === "number") {
		const pos = resolveTablePosition(state, event.tableName);
		return `[Run ${runId}] Table ${pos.index}/${pos.total} ${event.tableName}: ${event.sourceRows} source row(s).`;
	}

	if (event.phase === "table_finalize") {
		const pos = resolveTablePosition(state, event.tableName);
		if (event.status === "success" || event.status === "failed") {
			state.completedTables += 1;
		}
		if (event.status === "success") {
			return `[Run ${runId}] Table ${pos.index}/${pos.total} ${event.tableName}: done (inserted ${event.inserted || 0}, updated ${event.updated || 0}, skipped ${event.skipped || 0}). Progress ${state.completedTables}/${state.totalTables}.`;
		}
		if (event.status === "failed") {
			return `[Run ${runId}] Table ${pos.index}/${pos.total} ${event.tableName}: failed (${event.error || "unknown error"}). Progress ${state.completedTables}/${state.totalTables}.`;
		}
	}

	if (event.phase === "run_finalize") {
		if (event.status === "success") return `[Run ${runId}] Migration completed successfully.`;
		if (event.status === "completed_with_errors") return `[Run ${runId}] Migration completed with errors (${event.tableErrorCount || 0} table failure(s)).`;
		if (event.status === "failed") return `[Run ${runId}] Migration failed (${event.error || "unknown error"}).`;
	}

	if (event.phase === "run_aborted") {
		return `[Run ${runId}] Migration stopped (${event.message || "aborted"}).`;
	}

	if (level === "error") {
		return `[Run ${runId}] Error${event.phase ? ` (${event.phase})` : ""}: ${event.error || event.message || "unknown error"}.`;
	}
	if (level === "warn") {
		return `[Run ${runId}] Warning${event.phase ? ` (${event.phase})` : ""}: ${event.error || event.message || "check details in log file"}.`;
	}

	return null;
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
			const state = consoleProgressStates.get(runId) || {
				tableOrder: [],
				tableIndex: new Map(),
				totalTables: 0,
				completedTables: 0
			};
			consoleProgressStates.set(runId, state);
			const progressLine = formatProgressLine(event, state);
			if (progressLine) {
				const writer = String(event.level || "").toLowerCase() === "error"
					? console.error
					: String(event.level || "").toLowerCase() === "warn"
						? console.warn
						: console.log;
				writer(progressLine);
			}
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
	consoleProgressStates.delete(runId);
}

module.exports = {
	startRunLogger,
	logEvent,
	closeRunLogger,
	getLogEmitter,
	getLogBuffer,
	getLogFilePath
};
