const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ROOT, scopeKey, jsonEvidence } = require('./store');
const ORIGINAL_SOURCE = Symbol('auditOriginalSource');
const fingerprint = source => createHash('sha256').update(jsonEvidence(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
const filename = scope => path.join(ROOT, scopeKey(scope), 'corrections.json');
async function readCorrections(scope) {
	try { return JSON.parse(await fs.promises.readFile(filename(scope), 'utf8')); }
	catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
}
let pending = Promise.resolve();
function saveCorrection(scope, table, source, field, value, reset = false) {
	return saveCorrections(scope, [{ table, source, field, value, reset }]);
}
function saveCorrections(scope, changes) {
	const write = pending.catch(() => {}).then(async () => {
		const all = await readCorrections(scope);
		for (const { table, source, field, value, reset = false } of changes) {
		if (['__proto__', 'constructor', 'prototype'].includes(field) || !Object.hasOwn(source, field)) throw new Error('Invalid correction field');
		const key = table + ':' + fingerprint(source);
		const entry = all[key] ||= { source, fields: {} };
		if (reset) delete entry.fields[field]; else entry.fields[field] = value;
		if (!Object.keys(entry.fields).length) delete all[key];
		}
		const file = filename(scope);
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		await fs.promises.writeFile(file + '.tmp', jsonEvidence(all), { mode: 0o600 });
		await fs.promises.rename(file + '.tmp', file);
	});
	pending = write;
	return write;
}
function applyCorrections(all, table, source) {
	const entry = all[table + ':' + fingerprint(source)];
	if (!entry) return source;
	const result = { ...source };
	for (const [field, value] of Object.entries(entry.fields)) {
		if (!Object.hasOwn(result, field)) throw new Error('Correction refers to a missing source field');
		Object.defineProperty(result, field, { value, enumerable: true, writable: true, configurable: true });
	}
	Object.defineProperty(result, ORIGINAL_SOURCE, { value: source });
	return result;
}
module.exports = { fingerprint, readCorrections, saveCorrection, saveCorrections, applyCorrections, ORIGINAL_SOURCE };
