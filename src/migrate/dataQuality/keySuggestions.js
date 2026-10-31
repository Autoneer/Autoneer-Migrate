// Free values for invalid auto-increment IDs (for example customers.cid = 0): the suggestion is the next
// number above every ID used by the scanned legacy records and the destination table, and a correction
// is refused when its ID is already taken.
const fs = require('node:fs');
const path = require('node:path');
const { readRecords } = require('./store');
const { evidence } = require('./review');

const quoteMy = name => '`' + String(name).replace(/`/g, '``') + '`';
const positive = value => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; };

// IDs used in the scan (accepted snapshot plus every reported record), cached per audit, table and column.
const scanCache = new Map();
function scannedIds(dir, report, table, column) {
	const key = [dir, table, column].join('|');
	if (!scanCache.has(key)) scanCache.set(key, (async () => {
		const used = new Set();
		const add = value => { const n = positive(value); if (n) used.add(n); };
		const index = (report.tables || []).findIndex(item => item.table === table);
		const accepted = path.join(dir, `${index}.accepted`);
		if (index >= 0 && fs.existsSync(accepted)) for await (const record of readRecords(accepted)) add(record?.[column]);
		for await (const row of evidence(dir)) if (row.table === table) add(row.mapped?.[column]);
		return used;
	})().catch(err => { scanCache.delete(key); throw err; }));
	return scanCache.get(key);
}

// pool is optional; without a destination connection the suggestion only reflects the scanned records.
async function destinationMax(pool, table, column) {
	if (!pool) return 0;
	const [[row]] = await pool.query(`SELECT MAX(${quoteMy(column)}) AS max FROM ${quoteMy(table)}`);
	return positive(row?.max) || 0;
}

/** Next free ID above everything used, plus the set used by the scan. */
async function keySuggestion({ dir, report, table, column, pool }) {
	const used = await scannedIds(dir, report, table, column);
	const scanMax = used.size ? Math.max(...used) : 0;
	const destMax = pool ? await destinationMax(pool, table, column).catch(() => null) : null;
	return { column, scanMax, destinationMax: destMax || 0, destinationChecked: destMax !== null, next: Math.max(scanMax, destMax || 0) + 1, used };
}

/** Why an ID cannot be used, or null when it is free. */
async function keyProblem({ dir, report, table, column, value, pool, otherCorrections = [] }) {
	const n = positive(value);
	if (!n) return `${column} must be a whole number above 0.`;
	if ((await scannedIds(dir, report, table, column)).has(n)) return `${column} ${n} is already used by another ${table} record.`;
	if (otherCorrections.some(item => positive(item) === n)) return `${column} ${n} is already used by another saved correction.`;
	if (pool) {
		const [[row]] = await pool.query(`SELECT 1 AS found FROM ${quoteMy(table)} WHERE ${quoteMy(column)} = ? LIMIT 1`, [n]);
		if (row) return `${column} ${n} already exists in the destination ${table} table.`;
	}
	return null;
}

module.exports = { keySuggestion, keyProblem };
