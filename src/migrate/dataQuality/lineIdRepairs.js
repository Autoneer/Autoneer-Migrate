const fs = require('node:fs/promises');
const path = require('node:path');
const { writeRecord, readRecords } = require('./store');
const { fingerprint, ORIGINAL_SOURCE } = require('./corrections');
const INTERNAL_KEYS = { work_done: 'wdid', invoice_items: 'invid' };
const keyOf = value => value == null ? null : /^[+-]?\d+$/.test(String(value).trim()) ? BigInt(String(value).trim()).toString() : String(value);

// Repair only unreferenced technical IDs. Referenced duplicates remain ambiguous.
// The wrapper changes the migration copy before mapping and constraint checks.
function wrapLineIdRepairs(table, references, store, report, checkAbort) {
	const key = INTERNAL_KEYS[table.name];
	const pair = Object.entries(table.mapping).find(([, rule]) => !rule.omit && String(rule.target ?? rule.targetColumn).toLowerCase() === key);
	if (!pair || pair[1].transform || pair[1].lookup || references == null) return;
	const sourceName = pair[0].toLowerCase();
	const originalRows = table.rows;
	table.rows = async function* () {
		const file = path.join(store.dir, table.name + '.line-id-source');
		const handle = await fs.open(file, 'wx', 0o600);
		const counts = new Map();
		let sourceCount = 0;
		let highest = 0n;
		for (const value of references) if (/^\d+$/.test(value)) highest = BigInt(value) > highest ? BigInt(value) : highest;
		try {
			for await (const source of originalRows()) {
				checkAbort();
				sourceCount++;
				const field = Object.keys(source).find(name => name.toLowerCase() === sourceName);
				const id = keyOf(source[field]);
				if (id != null && /^\d+$/.test(id) && BigInt(id) > highest) highest = BigInt(id);
				const hash = fingerprint(source);
				const prior = counts.get(id);
				if (!prior) counts.set(id, { first: hash, conflicting: false });
				else if (prior.first !== hash) prior.conflicting = true;
				await writeRecord(handle, { source, original: source[ORIGINAL_SOURCE], field, id, hash });
			}
		} finally { await handle.close(); }
		let repaired = 0;
		let processed = 0;
		table.sourceProgress = { scanned: 0, total: sourceCount };
		const assigned = new Map();
		for await (const row of readRecords(file)) {
			checkAbort();
			table.sourceProgress.scanned = ++processed;
			const invalid = row.id == null || !/^\d+$/.test(row.id) || BigInt(row.id) <= 0n;
			if ((invalid || counts.get(row.id)?.conflicting) && !references.has(row.id)) {
				const original = row.original || { ...row.source };
				const identity = JSON.stringify([row.id, row.hash]);
				if (!assigned.has(identity)) assigned.set(identity, String(++highest));
				row.source[row.field] = assigned.get(identity);
				repaired++;
				Object.defineProperty(row.source, ORIGINAL_SOURCE, { value: original });
			} else if (row.original) Object.defineProperty(row.source, ORIGINAL_SOURCE, { value: row.original });
			yield row.source;
		}
		if (repaired) report.automaticRepairs.push({ table: table.name, column: key, count: repaired, action: `Repair ${repaired} unreferenced internal line IDs`, explanation: 'Only missing or conflicting technical IDs without known incoming references were reassigned. Business identifiers and line values are preserved; the destination table is empty. Referenced conflicting IDs still require a decision.' });
		if (table.summary.sourceRows != null) table.summary.outOfScope = table.summary.sourceRows - table.summary.scanned - (table.summary.leftOut || []).reduce((sum, item) => sum + item.count, 0);
		await fs.unlink(file);
	};
}

async function prepareLineIdRepairs(tables, metadata, pool, store, report, readSourceReferences, checkAbort) {
	for (const table of tables) {
		const key = INTERNAL_KEYS[table.name];
		if (!key || table.retry || table.step.keyStrategy !== 'preserve' || table.step.mode !== 'INSERT' || table.step.dedupeKeys?.length) continue;
		const primary = table.columns.filter(col => col.primary);
		if (primary.length !== 1 || primary[0].name !== key || !primary[0].autoIncrement) continue;
		const quote = name => '`' + name.replace(/`/g, '``') + '`';
		const [existing] = await pool.query(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`);
		if (existing.length) continue;
		const references = new Set();
		let supported = true;
		for (const [name, meta] of metadata) {
			const columns = new Set((meta.columns || []).filter(col => name !== table.name && [key, 'original_' + key].includes(col.name)).map(col => col.name));
			for (const rel of meta.relations.filter(rel => rel.parent === table.name)) {
				if (rel.columns?.length !== 1 || rel.parentColumns?.[0] !== key) { supported = false; break; }
				columns.add(rel.columns[0]);
			}
			const child = tables.find(item => item.name === name);
			for (const [source, rule] of Object.entries(child?.mapping || {})) {
				if (!rule.omit && String(rule.lookup?.table || '').toLowerCase() === table.name) columns.add(String(rule.target ?? rule.targetColumn).toLowerCase());
			}
			for (const column of columns) {
				checkAbort();
				if (!(meta.columns || []).some(col => col.name === column)) { supported = false; break; }
				const [rows] = await pool.query(`SELECT DISTINCT ${quote(column)} AS ref FROM ${quote(name)} WHERE ${quote(column)} IS NOT NULL`);
				for (const row of rows) references.add(keyOf(row.ref));
				if (child) {
					const values = await readSourceReferences(child, column);
					if (values == null) { supported = false; break; }
					for (const value of values) references.add(keyOf(value));
				}
			}
			if (!supported) break;
		}
		if (supported) wrapLineIdRepairs(table, references, store, report, checkAbort);
	}
}
module.exports = { prepareLineIdRepairs, wrapLineIdRepairs };
