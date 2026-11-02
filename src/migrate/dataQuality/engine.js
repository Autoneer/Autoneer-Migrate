const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ORIGINAL_SOURCE, fingerprint } = require('./corrections');
const { writeRecord, readRecords, jsonEvidence } = require('./store');
const { REQUIRED_IDENTITIES, IDENTITY_ALTERNATIVES, isMissing, invalidIdentity } = require('./rules');
const { transforms, applyTransform } = require('../mappers');
const { mapRow } = require('../rowMapping');
const { applyInvoiceSplitPolicy, buildInvoiceSplitPolicy } = require('../invoiceMigrationSafety');

const lower = value => String(value || '').toLowerCase();
const numericTypes = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'bit']);
const integerBits = { tinyint: 8, smallint: 16, mediumint: 24, int: 32, integer: 32, bigint: 64, bit: 1 };
const issue = (code, column, message, action = 'review') => ({ code, column, message, action });

function canonicalValue(value, column = {}) {
	if (value == null) return null;
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return value.toString('hex');
	if (numericTypes.has(column.type)) {
		const str = String(value).trim();
		if (/^[+-]?\d+$/.test(str)) return BigInt(str).toString();
		return Number.isFinite(Number(str)) ? String(Number(str)) : str;
	}
	let str = String(value).trimEnd();
	if (/_ci$/.test(column.collation || '')) str = str.toLowerCase();
	if (/_ai_|general_ci|unicode_ci/.test(column.collation || '')) str = str.normalize('NFD').replace(/\p{M}/gu, '');
	return str;
}

function tuple(row, columns, metadata, optionalZero = false) {
	const values = columns.map(name => row[lower(name)]);
	if (values.some(value => value == null)) return null; // MySQL composite FK / UNIQUE NULL semantics.
	if (optionalZero && values.some(value => isMissing(value) || Number(value) === 0)) return null;
	return JSON.stringify(values.map((value, index) => canonicalValue(value, metadata.get(lower(columns[index])))));
}

function validateValue(value, col) {
	if (value == null) return col.nullable ? null : 'Required value is NULL';
	if (!col.nullable && col.defaultValue !== '' && /char|text/.test(col.type) && isMissing(value)) return 'Required text is blank';
	if (numericTypes.has(col.type)) {
		if (typeof value === 'boolean') value = Number(value);
		if (isMissing(value) || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value)) || !Number.isFinite(Number(value))) return 'Invalid numeric value';
		if (integerBits[col.type]) {
			if (!/^[+-]?\d+$/.test(String(value))) return 'Integer value required';
			if (typeof value === 'number' && !Number.isSafeInteger(value)) return 'Integer exceeds JavaScript safe precision';
			const bits = BigInt(col.type === 'bit' ? (col.precision || 1) : integerBits[col.type]);
			const unsigned = /unsigned/.test(col.columnType || '') || col.type === 'bit';
			const min = unsigned ? 0n : -(1n << (bits - 1n));
			const max = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
			if (BigInt(String(value)) < min || BigInt(String(value)) > max) return 'Integer exceeds target range';
		} else if (['decimal', 'numeric'].includes(col.type) && col.precision != null) {
			const text = String(value).replace(/^[+-]/, '');
			if (/e/i.test(text)) return 'Scientific notation requires an explicit decimal conversion';
			const [whole, fraction = ''] = text.split('.');
			if (whole.replace(/^0+/, '').length > col.precision - col.scale) return 'Decimal exceeds target precision';
			if (fraction.replace(/0+$/, '').length > col.scale) return 'Decimal would lose fractional precision';
			if (/unsigned/.test(col.columnType || '') && Number(value) < 0) return 'Unsigned value cannot be negative';
		}
	}
	if (col.length != null && /char|text|binary|blob/.test(col.type)) {
		const size = Buffer.isBuffer(value) ? value.length : Array.from(String(value)).length;
		if (size > col.length) return 'Value exceeds target length';
	}
	if (['date', 'datetime', 'timestamp'].includes(col.type)) {
		const text = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : String(value);
		const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?)?$/.exec(text);
		if (!match) return 'Invalid date or timestamp';
		const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
		const date = new Date(Date.UTC(+year, +month - 1, +day));
		if (+year < 1000 || date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59) return 'Invalid date or timestamp';
	}
	if (col.type === 'json') { try { JSON.parse(String(value)); } catch { return 'Invalid JSON'; } }
	if (col.type === 'enum' && !col.enumValues?.includes(String(value))) return 'Value is outside the target ENUM';
	return null;
}

function validateDefinition(table) {
	const errors = [];
	const targets = new Set();
	for (const [source, rule] of Object.entries(table.mapping)) {
		if (rule.omit) continue;
		const target = lower(rule.target ?? rule.targetColumn);
		if (!target) { errors.push(`Mapping ${source} has no target column`); continue; }
		if (!table.sourceColumns.some(c => lower(c) === lower(source))) errors.push(`Missing source column ${source}`);
		if (!table.meta.has(target)) errors.push(`Missing target column ${target}`);
		if (targets.has(target)) errors.push(`More than one source maps to ${target}`);
		if (table.meta.get(target)?.generated) errors.push(`Generated column ${target} must be omitted`);
		if (rule.transform && (typeof rule.transform !== 'string' || typeof transforms[rule.transform] !== 'function' || rule.transform === 'toDecimal')) errors.push(`Unsupported transform for ${source}: ${String(rule.transform)}`);
		targets.add(target);
	}
	for (const col of table.columns) {
		if (!col.nullable && !col.autoIncrement && !col.generated && col.defaultValue == null && !targets.has(col.name)) errors.push(`Required target column ${col.name} is not mapped and has no default`);
	}
	for (const name of Object.keys(REQUIRED_IDENTITIES[table.name] || {})) {
		if (!targets.has(name)) errors.push(`Business identity ${name} must be mapped from the source`);
	}
	for (const name of table.step.dedupeKeys || []) if (!targets.has(lower(name))) errors.push(`Deduplication column ${name} is not mapped`);
	if (!targets.size) errors.push('No columns are mapped');
	return errors;
}

function validateRow(table, source, mapped) {
	const issues = [];
	const identities = REQUIRED_IDENTITIES[table.name] || {};
	for (const [column, type] of Object.entries(identities)) {
		const sourceColumn = Object.entries(table.mapping).find(([, rule]) => !rule.omit && lower(rule.target ?? rule.targetColumn) === column)?.[0];
		const alternative = IDENTITY_ALTERNATIVES[table.name]?.[column];
		if (alternative && !invalidIdentity(mapped[alternative], 'positive')) continue;
		// A default must never manufacture a missing business identity.
		if (invalidIdentity(source[lower(sourceColumn)], type) || invalidIdentity(mapped[column], type)) {
			const hasValue = ['quantity', 'qty', 'cost_price', 'costprice', 'cost_price_exvat', 'salesprice', 'salespriceincvat', 'onorderqty', 'amount', 'amountexvat', 'total', 'paid', 'payable', 'inv_totalexlvat', 'inv_totalinclvat', 'inv_totalvat', 'invoice_total'].some(name => !isMissing(mapped[name] ?? source[name]) && Number(mapped[name] ?? source[name]) !== 0);
			issues.push(issue('MISSING_IDENTITY', column, `Missing or invalid ${column}${hasValue ? '; record carries quantity or monetary value' : ''}`, hasValue ? 'review' : 'quarantine'));
		}
	}
	// Preserve the established REDO exclusion, now recoverable and scoped.
	if (table.name === 'invoices' && String(mapped.status ?? source.status ?? '').trim().toUpperCase() === 'REDO') issues.push(issue('REDO_INVOICE', 'status', 'Legacy REDO invoice', 'quarantine'));
	for (const col of table.columns) {
		if (col.generated || (table.step.keyStrategy === 'rekey' && col.primary)) continue;
		if (col.autoIncrement && !Object.values(table.mapping).some(rule => !rule.omit && lower(rule.target ?? rule.targetColumn) === col.name)) continue;
		if (!Object.hasOwn(mapped, col.name)) continue; // Omitted columns use database defaults.
		const problem = validateValue(mapped[col.name], col);
		if (problem && !issues.some(item => item.column === col.name)) issues.push(issue('INVALID_VALUE', col.name, problem));
		if (col.autoIncrement && col.primary && invalidIdentity(mapped[col.name], 'positive') && !issues.some(item => item.column === col.name)) issues.push(issue('INVALID_PRIMARY_KEY', col.name, 'Preserved auto-increment identity must be a positive integer'));
	}
	for (const [column, rule] of Object.entries(table.mapping)) {
		if (rule.omit || !rule.transform) continue;
		if (!isMissing(source[lower(column)]) && applyTransform(rule.transform, source[lower(column)]) == null) issues.push(issue('LOSSY_TRANSFORM', lower(rule.target ?? rule.targetColumn), `Transform ${rule.transform} discarded a populated source value`));
	}
	for (const column of table.lookupIdentity || []) if (isMissing(mapped[column])) issues.push(issue('MISSING_LOOKUP_IDENTITY', column, 'A referenced source identity is empty'));
	for (const column of table.step.dedupeKeys || []) if (isMissing(mapped[lower(column)])) issues.push(issue('MISSING_DEDUPE_KEY', lower(column), 'Deduplication key is empty'));
	return issues;
}

/** Full scan, then dependency validation, then publish accepted snapshots.
 * Tables expose an async rows() iterator. Only keys and rejected row reasons
 * remain in memory; complete source rows are retained on disk.
 */
async function auditTables({ tables, store, report, loadTargetRows, loadLookupKeys = async function* () {}, checkAbort = () => {}, onProgress = () => {}, mappingOptions = {}, excludeUnresolved = false, excludedRecords = new Set() }) {
	report.excludeUnresolved = excludeUnresolved;
	const selected = new Map(tables.map(table => [table.name, table]));
	const progressFor = (table, stage, phase, detail = {}) => onProgress({ stage, phase, table: table.name, sourceTable: table.sourceTable,
		tableIndex: tables.indexOf(table) + 1, tableCount: tables.length, nextTable: stage === 'links' ? undefined : tables[tables.indexOf(table) + 1]?.name, ...detail });
	for (const [index, table] of tables.entries()) {
		progressFor(table, 'rows', 'validating_definition', { scanned: 0 });
		table.meta = new Map(table.columns.map(col => [col.name, col]));
		table.rejected = new Map();
		table.stageFile = path.join(store.dir, `${index}.stage`);
		table.acceptedFile = path.join(store.dir, `${index}.accepted`);
		table.summary = { sourceTable: table.sourceTable, table: table.name, scanned: 0, accepted: 0, quarantined: 0, review: 0, rules: {}, errors: [...(table.errors || []), ...validateDefinition(table)], coverage: ['required values', 'types and lengths', 'primary and unique keys', 'mapped relationships'], businessRules: Object.keys(REQUIRED_IDENTITIES[table.name] || {}) };
		report.tables.push(table.summary);
		if (table.summary.errors.length) {
			progressFor(table, 'rows', 'table_blocked', { errors: table.summary.errors.length });
			continue;
		}
		const unique = table.unique = table.indexes.map(def => ({ ...def, seen: new Map() }));
		table.primaryByOrdinal = new Map();
		table.invoiceOwners = new Map();
		const exactRows = new Map();
		const splitPolicy = buildInvoiceSplitPolicy(table.name, table.mapping, table.columns.map(col => col.name));
		const handle = await fs.promises.open(table.stageFile, 'wx', 0o600);
		let pending = [];
		const flush = async () => {
			if (!pending.length) return;
			if (table.evaluate) await table.evaluate(pending);
			for (const record of pending) {
				const { ordinal, source, mapped, originalSource } = record;
				const reasons = [...record.reasons, ...validateRow(table, source, mapped)];
				if (excludedRecords.has(table.name + ':' + fingerprint(originalSource || source))) reasons.push(issue('EXCLUDED_BY_DECISION', null, 'Left out by a saved group decision; the original source and existing destination records are retained', 'quarantine'));
				if (reasons.length) table.rejected.set(ordinal, reasons);
				table.primaryByOrdinal.set(ordinal, tuple(mapped, table.columns.filter(col => col.primary).map(col => col.name), table.meta));
				if (table.name === 'invoices') table.invoiceOwners.set(ordinal, Object.fromEntries(['job_number', 'cid'].filter(key => Object.hasOwn(mapped, key)).map(key => [key, mapped[key]])));
				const primary = table.primaryByOrdinal.get(ordinal);
				if (primary && table.columns.some(col => col.primary) && table.step.keyStrategy !== 'rekey' && !reasons.length) {
					const fingerprint = createHash('sha256').update(jsonEvidence({ source, mapped })).digest('hex');
					if (exactRows.get(primary) === fingerprint) {
						table.rejected.set(ordinal, [issue('IDENTICAL_DUPLICATE', null, 'Repeated copy with the same primary key and identical source and mapped values; keep one copy', 'quarantine')]);
						await writeRecord(handle, { ordinal, source, mapped, originalSource });
						continue;
					}
					if (!exactRows.has(primary)) exactRows.set(primary, fingerprint);
				}
				for (const index of reasons.some(reason => reason.code === 'EXCLUDED_BY_DECISION') || (reasons.length && reasons.every(reason => reason.action === 'quarantine')) ? [] : unique) {
					const key = tuple(mapped, index.columns, table.meta);
					if (key == null) continue;
					if (index.seen.has(key)) {
						for (const row of [index.seen.get(key), ordinal]) {
							const existing = table.rejected.get(row) || [];
							if (!existing.some(item => item.code === 'DUPLICATE_KEY' && item.column === index.columns.join(','))) existing.push(issue('DUPLICATE_KEY', index.columns.join(','), 'Duplicate ' + index.name + '; resolve conflicting identities'));
							table.rejected.set(row, existing);
						}
					} else index.seen.set(key, ordinal);
				}
				await writeRecord(handle, { ordinal, source, mapped, originalSource });
			}
			pending = [];
		};
		try {
			for await (const raw of table.rows()) {
				checkAbort();
				const source = Object.fromEntries(Object.entries(raw).map(([key, value]) => [lower(key), value]));
				const ordinal = table.summary.scanned++;
				let mapped = {}, reasons = [];
				try {
					mapped = await mapRow(source, table.mapping, async (_parent, value) => value, { ...mappingOptions, targetTable: table.name, columnTypes: new Map(table.columns.map(col => [col.name, col.type])) });
					mapped = Object.fromEntries(Object.entries(mapped).map(([key, value]) => [lower(key), value]));
					applyInvoiceSplitPolicy(source, mapped, splitPolicy);
				} catch (err) { reasons.push(issue('TRANSFORM_FAILED', null, err.message)); }
				pending.push({ ordinal, source, mapped, reasons, originalSource: raw[ORIGINAL_SOURCE] });
				if (pending.length === 200) await flush();
				if (table.summary.scanned % 200 === 0) progressFor(table, 'rows', table.sourceProgress ? 'reading' : 'validating_rows', { scanned: table.summary.scanned, ...table.sourceProgress, flagged: table.rejected.size });
			}
			await flush();
		} finally { await handle.close(); }
		table.scanComplete = true;
		progressFor(table, 'rows', 'scan_complete', { scanned: table.summary.scanned, flagged: table.rejected.size });
	}

	// Existing target keys are checked before any truncate or insert. Retry runs
	// may retain primary-key matches; their normal identity reconciliation still runs.
	for (const table of tables) {
		if (table.summary.errors.length || table.step.cleanBefore || !table.unique.length) continue;
		progressFor(table, 'links', 'target_keys');
		const primary = table.columns.filter(col => col.primary).map(col => col.name);
		const columns = [...new Set([...primary, ...table.unique.filter(index => !index.sourceOnly).flatMap(index => index.columns), ...(table.name === 'invoices' ? ['job_number', 'cid'].filter(name => table.meta.has(name)) : [])])];
		for await (const row of loadTargetRows(table.name, columns)) {
			checkAbort();
			for (const index of table.unique) {
				if (index.sourceOnly) continue;
				const key = tuple(row, index.columns, table.meta);
				if (key == null || !index.seen.has(key)) continue;
				const ordinal = index.seen.get(key);
				const samePrimary = primary.length && table.primaryByOrdinal.get(ordinal) === tuple(row, primary, table.meta);
				const sameInvoiceOwner = table.name !== 'invoices' || Object.entries(table.invoiceOwners.get(ordinal) || {}).every(([name, value]) => canonicalValue(value, table.meta.get(name)) === canonicalValue(row[name], table.meta.get(name)));
				if (samePrimary && sameInvoiceOwner && (table.step.mode === 'UPSERT' || table.retry || table.name === 'invoices')) continue;
				const reasons = table.rejected.get(ordinal) || [];
				reasons.push(issue('TARGET_KEY_CONFLICT', index.columns.join(','), 'Key already exists in target (' + index.name + '); resolve it or select truncate first'));
				table.rejected.set(ordinal, reasons);
			}
		}
	}

	// Build only the key indexes used by relationships. Excluded parent keys are
	// retained separately to distinguish missing parents from removed parents.
	const parentIndexes = new Map();
	onProgress({ phase: 'checking_relationships' });
	for (const table of tables) for (const relation of table.relations) {
		const signature = `${relation.parent}:${relation.parentColumns.join(',')}`;
		if (parentIndexes.has(signature)) continue;
		progressFor(table, 'links', 'parent_keys', { relatedTable: relation.parent });
		const parent = selected.get(relation.parent);
		const meta = parent?.meta || new Map((relation.parentMetadata || []).map(col => [col.name, col]));
		const entry = { selected: new Map(), existing: new Set(), lookupExisting: new Set(), meta, parent };
		parentIndexes.set(signature, entry);
		if (parent && !parent.summary.errors.length) {
			for await (const record of readRecords(parent.stageFile)) {
				checkAbort();
				const key = tuple(record.mapped, relation.parentColumns, meta);
				if (key != null) {
					if (!entry.selected.has(key)) entry.selected.set(key, []);
					entry.selected.get(key).push(record.ordinal);
				}
			}
		}
		if (!parent?.step.cleanBefore) {
			for await (const row of loadTargetRows(relation.parent, relation.parentColumns)) {
				checkAbort();
				const key = tuple(row, relation.parentColumns, meta);
				if (key != null) entry.existing.add(key);
			}
			for await (const row of loadLookupKeys(relation.parent, relation.parentColumns)) {
				const key = tuple(row, relation.parentColumns, meta);
				if (key != null) entry.lookupExisting.add(key);
			}
		}
	}

	// Repeat until no new rejected parents are discovered (including cycles).
	let changed = true, pass = 0;
	while (changed) {
		pass++;
		changed = false;
		for (const table of tables) {
			if (table.summary.errors.length) continue;
			progressFor(table, 'links', 'checking_relationships', { scanned: 0, total: table.summary.scanned, pass });
			for await (const record of readRecords(table.stageFile)) {
				checkAbort();
				if ((record.ordinal + 1) % 1000 === 0) progressFor(table, 'links', 'checking_relationships', { scanned: record.ordinal + 1, total: table.summary.scanned, pass });
				for (const relation of table.relations) {
					const index = parentIndexes.get(`${relation.parent}:${relation.parentColumns.join(',')}`);
					const values = Object.fromEntries(relation.columns.map((name, i) => [relation.parentColumns[i], record.mapped[name]]));
					const key = tuple(values, relation.parentColumns, index.meta, relation.optionalZero);
					if (key == null) continue;
					const parentRows = index.selected.get(key) || [];
					const acceptedParent = parentRows.some(ordinal => !index.parent.rejected.has(ordinal));
					const existingParent = relation.lookup ? index.lookupExisting.has(key) : index.existing.has(key);
					if (acceptedParent && !existingParent && relation.kind === 'foreign key' && tables.indexOf(index.parent) > tables.indexOf(table)) {
						const reasons = table.rejected.get(record.ordinal) || [];
						if (!reasons.some(item => item.code === 'PARENT_ORDER' && item.column === relation.columns.join(','))) {
							reasons.push(issue('PARENT_ORDER', relation.columns.join(','), `Migrate ${relation.parent} before ${table.name} to satisfy the target foreign key`));
							table.rejected.set(record.ordinal, reasons); changed = true;
						}
						continue;
					}
					if (acceptedParent || existingParent) continue;
					const reasons = table.rejected.get(record.ordinal) || [];
					const column = relation.columns.join(',');
					if (!reasons.some(item => item.code === 'MISSING_PARENT' && item.column === column)) {
						reasons.push({ ...issue('MISSING_PARENT', column, `No accepted ${relation.parent} parent (${relation.parentColumns.join(',')})${parentRows.length ? '; its source record was rejected' : ''}`), parentTable: relation.parent, parentOrdinals: parentRows });
						table.rejected.set(record.ordinal, reasons); changed = true;
					}
					if (parentRows.length && parentRows.every(ordinal => index.parent.rejected.get(ordinal)?.some(reason => ['EXCLUDED_BY_DECISION', 'EXCLUDED_WITH_PARENT'].includes(reason.code))) && !reasons.some(reason => reason.code === 'EXCLUDED_WITH_PARENT')) {
						reasons.push(issue('EXCLUDED_WITH_PARENT', column, `Left out with ${relation.parent} by a saved group decision`, 'quarantine'));
						table.rejected.set(record.ordinal, reasons); changed = true;
					}
					// Referenced stock is not empty junk, even when its quantity is 0.
					if (index.parent?.name === 'stock') for (const ordinal of parentRows) {
						const reasons = index.parent.rejected.get(ordinal) || [];
						if (!reasons.some(item => item.code === 'MISSING_IDENTITY' && item.column === 'partnr')) continue;
						if (!reasons.some(item => item.code === 'REFERENCED_STOCK')) {
							reasons.push(issue('REFERENCED_STOCK', 'partnr', 'Stock without a usable identity is referenced by transaction data'));
							index.parent.rejected.set(ordinal, reasons); changed = true;
						}
					}
				}
			}
		}
	}

	for (const parent of tables) {
		if (parent.summary.errors.length) continue;
		const checked = new Set();
		for (const relation of parent.existingChildren || []) {
			const signature = JSON.stringify([relation.child, relation.columns, relation.parentColumns]);
			if (checked.has(signature)) continue;
			checked.add(signature);
			progressFor(parent, 'links', 'existing_children', { relatedTable: relation.child });
			const acceptedKeys = new Set();
			for await (const record of readRecords(parent.stageFile)) {
				checkAbort();
				if (!parent.rejected.has(record.ordinal)) acceptedKeys.add(tuple(record.mapped, relation.parentColumns, parent.meta));
			}
			let missing = 0;
			for await (const row of loadTargetRows(relation.child, relation.columns)) {
				checkAbort();
				const values = Object.fromEntries(relation.columns.map((col, index) => [relation.parentColumns[index], row[col]]));
				const key = tuple(values, relation.parentColumns, parent.meta, relation.optionalZero);
				if (key != null && (!acceptedKeys.has(key) || (parent.step.keyStrategy === 'rekey' && relation.parentColumns.some(col => parent.meta.get(col).primary)))) missing++;
			}
			if (missing) parent.summary.errors.push(`Truncate first would break ${missing} existing ${relation.child} references (${relation.columns.join(',')}). Include and rebuild the dependent data or preserve the parent table.`);
		}
	}

	const evidence = await fs.promises.open(path.join(store.dir, 'quarantine.ndjson'), 'wx', 0o600);
	onProgress({ phase: 'saving_quarantine' });
	try {
		for (const table of tables) {
			if (!table.scanComplete) continue;
			progressFor(table, 'results', 'saving_quarantine', { scanned: 0, total: table.summary.scanned });
			const accepted = await fs.promises.open(table.acceptedFile, 'wx', 0o600);
			const hash = createHash('sha256');
			try {
				for await (const record of readRecords(table.stageFile)) {
					checkAbort();
					const reasons = table.rejected.get(record.ordinal);
					if (reasons) {
						const needsReview = !reasons.some(item => ['EXCLUDED_BY_DECISION', 'EXCLUDED_WITH_PARENT'].includes(item.code)) && reasons.some(item => item.action === 'review');
						const action = needsReview && !excludeUnresolved ? 'review' : 'quarantine';
						if (needsReview && excludeUnresolved) reasons.push(issue('EXCLUDED_BY_POLICY', null, 'Excluded from this migration by the selected unresolved-record policy; original data is retained', 'quarantine'));
						table.summary[action === 'review' ? 'review' : 'quarantined']++;
						for (const reason of reasons) table.summary.rules[reason.code] = (table.summary.rules[reason.code] || 0) + 1;
						const entry = { table: table.name, sourceTable: table.sourceTable, ordinal: record.ordinal, action, reasons, source: record.originalSource || record.source, mapped: record.mapped };
						await evidence.write(jsonEvidence(entry) + '\n');
						if ((table.summary.samples ||= []).length < 10) table.summary.samples.push({ ordinal: record.ordinal, action, reasons });
					} else {
						await writeRecord(accepted, record.source);
						hash.update(jsonEvidence(record.source));
						table.summary.accepted++;
					}
					if ((record.ordinal + 1) % 1000 === 0) progressFor(table, 'results', 'saving_quarantine', { scanned: record.ordinal + 1, total: table.summary.scanned });
				}
			} finally { await accepted.close(); }
			table.summary.acceptedHash = hash.digest('hex');
		}
	} finally { await evidence.close(); }
	checkAbort();
	report.totals = report.tables.reduce((sum, table) => {
		if (table.scanned !== table.accepted + table.quarantined + table.review) throw new Error(`Audit row accounting failed for ${table.table}`);
		for (const key of ['scanned', 'accepted', 'quarantined', 'review']) sum[key] += table[key];
		sum.errors += table.errors.length;
		return sum;
	}, { scanned: 0, accepted: 0, quarantined: 0, review: 0, errors: 0 });
	report.status = report.totals.review || report.totals.errors ? 'blocked' : 'ready';
	report.completedAt = new Date().toISOString();
	await store.save(report);
	return { report, tables: selected };
}

module.exports = { auditTables, validateDefinition, validateRow, validateValue, canonicalValue, tuple };
