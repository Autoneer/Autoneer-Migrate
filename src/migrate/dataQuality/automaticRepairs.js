const { RELATIONSHIPS } = require('./rules');

// These are internal line IDs, not invoice numbers, job numbers or stock codes.
const INTERNAL_LINE_KEYS = { work_done: 'wdid', invoice_items: 'invid' };

async function prepareAutomaticRepairs(tables, metadata, pool, retryOfRunId, report, hasSourceReference = async () => true) {
	report.automaticRepairs = [];
	for (const table of tables) {
		const key = INTERNAL_LINE_KEYS[table.name];
		if (!key || retryOfRunId || table.step.mode !== 'INSERT' || table.step.keyStrategy !== 'preserve' || table.step.dedupeKeys?.length) continue;
		const primary = table.columns.filter(col => col.primary);
		if (primary.length !== 1 || primary[0].name !== key || !primary[0].autoIncrement) continue;
		const incoming = [...metadata.values()].some(meta => meta.relations.some(rel => rel.parent === table.name)) ||
			RELATIONSHIPS.some(rel => rel.parent === table.name) || tables.some(child => Object.values(child.mapping).some(rule => String(rule.lookup?.table || '').toLowerCase() === table.name));
		if (incoming) continue;
		// Autoneer also has application-managed links without SQL foreign keys
		// (for example work_timer.wdid and supplier_rfc_lines.original_invid).
		let linked = false;
		for (const [childName, childMeta] of metadata) {
			if (childName === table.name) continue;
			for (const col of (childMeta.columns || []).filter(col => col.name === key || col.name === 'original_' + key)) {
				const child = tables.find(item => item.name === childName);
				if (child && await hasSourceReference(child, col.name)) { linked = true; break; }
				const quote = name => '`' + name.replace(/`/g, '``') + '`';
				const [rows] = await pool.query(`SELECT 1 FROM ${quote(childName)} WHERE ${quote(col.name)} IS NOT NULL AND ${quote(col.name)} <> 0 LIMIT 1`);
				if (rows.length) { linked = true; break; }
			}
			if (linked) break;
		}
		if (linked) continue;
		// Never append regenerated lines to existing data or change a retry's IDs.
		if (!table.step.cleanBefore) {
			const [existing] = await pool.query('SELECT 1 FROM `' + table.name + '` LIMIT 1');
			if (existing.length) continue;
		}
		table.step.keyStrategy = 'rekey';
		table.indexes = table.indexes.filter(index => index.name !== 'PRIMARY');
		report.automaticRepairs.push({ table: table.name, column: key, action: 'Generate new internal line IDs', explanation: 'The destination is empty or explicitly selected for replacement, and no known table or lookup references these IDs. All line values and business references are preserved.' });
	}
}

module.exports = { prepareAutomaticRepairs };
