const util = require('util');

const LEVEL_PRIORITY = Object.freeze({
	error: 0,
	warn: 1,
	info: 2,
	debug: 3
});

function resolveLogLevel(value = process.env.LOG_LEVEL) {
	const normalized = String(value || '').trim().toLowerCase();
	return Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, normalized)
		? normalized
		: 'info';
}

function shouldLog(level, configuredLevel = resolveLogLevel()) {
	return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[configuredLevel];
}

function serializeMeta(meta) {
	if (meta === undefined || meta === null || meta === '') return '';
	if (typeof meta === 'string') return meta;
	return util.inspect(meta, {
		depth: 6,
		breakLength: 140,
		compact: false,
		colors: false
	});
}

function write(method, level, message, meta) {
	try {
		const timestamp = new Date().toISOString();
		const serializedMeta = serializeMeta(meta);

		if (serializedMeta) {
			console[method](`[${timestamp}] [${level}] ${message}`, serializedMeta);
			return;
		}

		console[method](`[${timestamp}] [${level}] ${message}`);
	} catch (_) {
		// Logging must never interrupt application processing.
	}
}

module.exports = {
	info(message, meta) {
		if (!shouldLog('info')) return;
		write('log', 'INFO', message, meta);
	},
	warn(message, meta) {
		if (!shouldLog('warn')) return;
		write('warn', 'WARN', message, meta);
	},
	error(message, meta) {
		if (!shouldLog('error')) return;
		write('error', 'ERROR', message, meta);
	},
	debug(message, meta) {
		if (!shouldLog('debug')) return;
		write('log', 'DEBUG', message, meta);
	},
	resolveLogLevel,
	shouldLog
};
