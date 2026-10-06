const { reconcileInvoiceIdentities } = require('./invoiceMigrationSafety');

const quote = value => `\`${String(value).replace(/`/g, '``')}\``;
const valueOf = (row, column) => row[Object.keys(row).find(key => key.toLowerCase() === column.toLowerCase())];
const keyOf = values => JSON.stringify(values.map(value => {
	const text = String(value).trim();
	return /^[+-]?\d+$/.test(text) ? BigInt(text).toString() : text;
}));
const ready = values => values.length && values.every(value => value != null);

async function readMatches(conn, tableName, keys, tuples, columns) {
	const matches = new Map();
	const unique = [...new Map(tuples.filter(ready).map(tuple => [keyOf(tuple), tuple])).values()];
	for (let start = 0; start < unique.length; start += 500) {
		const page = unique.slice(start, start + 500);
		const where = keys.length === 1
			? `${quote(keys[0])} IN (${page.map(() => '?').join(',')})`
			: `(${keys.map(quote).join(',')}) IN (${page.map(() => `(${keys.map(() => '?').join(',')})`).join(',')})`;
		const [existing] = await conn.query(
			`SELECT ${[...new Set([...keys, ...columns])].map(quote).join(', ')} FROM ${quote(tableName)} WHERE ${where}`,
			page.flat()
		);
		for (const row of existing) {
			const key = keyOf(keys.map(column => valueOf(row, column)));
			if (matches.has(key)) throw new Error(`Cannot retry ${tableName}: multiple target records match the retry identity.`);
			matches.set(key, row);
		}
	}
	return matches;
}

// Match records by preserved primary keys, or by prior ID mappings/natural keys
// for re-keyed tables. A different invoice sharing a job never counts as migrated.
async function findExistingRetryRows({ conn, pool, previousRunId, tableName, primaryKeys, keyStrategy, dedupeKeys = [], rows, invoiceIdentities, targetColumns = [] }) {
	const results = new Map();
	if (!rows.length) return results;
	const invoice = tableName.toLowerCase() === 'invoices';
	const columns = [...primaryKeys, ...(invoice ? ['job_number', 'cid'].filter(name => targetColumns.includes(name)) : [])];
	let tuples = rows.map(row => primaryKeys.map(column => valueOf(row.mappedRow, column)));
	if (keyStrategy === 'rekey') {
		tuples = rows.map(() => []);
		if (primaryKeys.length === 1) {
			const sourceIds = [...new Set(rows.filter(row => row.sourceId != null).map(row => String(row.sourceId)))];
			const prior = new Map();
			for (let start = 0; start < sourceIds.length; start += 500) {
				const page = sourceIds.slice(start, start + 500);
				const [mappings] = await pool.query(`SELECT source_pk, target_pk FROM migration_id_map
					WHERE run_id = ? AND table_name = ? AND source_pk IN (${page.map(() => '?').join(',')})`,
				[previousRunId, tableName.toUpperCase(), ...page]);
				for (const mapping of mappings) prior.set(String(mapping.source_pk), mapping.target_pk);
			}
			tuples = rows.map(row => prior.has(String(row.sourceId)) ? [prior.get(String(row.sourceId))] : []);
		}
	}
	const primaryMatches = primaryKeys.length ? await readMatches(conn, tableName, primaryKeys, tuples, columns) : new Map();
	const naturalMatches = keyStrategy === 'rekey' && dedupeKeys.length
		? await readMatches(conn, tableName, dedupeKeys, rows.map(row => row.dedupeValues), columns)
		: new Map();
	for (const [index, row] of rows.entries()) {
		const existing = ready(tuples[index]) ? primaryMatches.get(keyOf(tuples[index])) : undefined;
		const natural = ready(row.dedupeValues || []) ? naturalMatches.get(keyOf(row.dedupeValues)) : undefined;
		const actual = existing || natural;
		if (!actual) continue;
		const targetPk = primaryKeys.length === 1 ? valueOf(actual, primaryKeys[0]) : undefined;
		let issue = null;
		if (invoice) {
			const invoiceNr = String(Number(valueOf(row.mappedRow, 'invoice_nr')));
			const expected = invoiceIdentities.get(invoiceNr);
			const issues = reconcileInvoiceIdentities(new Map([[invoiceNr, expected]]), [actual]);
			if (issues.length) issue = `Existing invoice identity conflict: ${issues.join('; ')}.`;
		}
		results.set(index, { targetPk, issue });
	}
	return results;
}

module.exports = { findExistingRetryRows };
