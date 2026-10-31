const fs = require('node:fs/promises');
const path = require('node:path');
const { ROOT, scopeKey, jsonEvidence } = require('./store');
const { fingerprint } = require('./corrections');
const fileFor = scope => path.join(ROOT, scopeKey(scope), 'decisions.json');
async function readDecisions(scope) {
	try { return JSON.parse(await fs.readFile(fileFor(scope), 'utf8')); }
	catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
}
let pending = Promise.resolve();
function saveDecision(scope, id, rows, description, reset = false) {
	const write = pending.catch(() => {}).then(async () => {
		const all = await readDecisions(scope);
		if (reset) delete all[id];
		else all[id] = { description, savedAt: new Date().toISOString(), records: rows.map(row => row.table + ':' + fingerprint(row.source)) };
		const file = fileFor(scope);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file + '.tmp', jsonEvidence(all), { mode: 0o600 });
		await fs.rename(file + '.tmp', file);
	});
	pending = write;
	return write;
}
function decisionKeys(decisions) { return new Set(Object.values(decisions).flatMap(item => item.records || [])); }
module.exports = { readDecisions, saveDecision, decisionKeys };
