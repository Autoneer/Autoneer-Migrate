const Firebird = require('node-firebird');
const firebird = require('../../db/firebird');
const { normalizePlanSteps } = require('../planNormalize');
const { resolveTargetTableName } = require('../utils/tableNameCanonical');
const { prepareLegacyMapping } = require('../prepareLegacyMapping');
const { convertLegacyGroupAccnr } = require('../rowMapping');
const { buildTransactionalLinkContextWithDb, buildTransactionalTableFilter } = require('../transactionalDateFilter');
const { auditTables } = require('./engine');
const { createStore } = require('./store');
const { RELATIONSHIPS } = require('./rules');
const { prepareAutomaticRepairs } = require('./automaticRepairs');
const { readCorrections, applyCorrections } = require('./corrections');
const { makeEvaluator, generatedExpressionFromDDL } = require('./targetExpressions');

const lower = value => String(value || '').toLowerCase();
const quoteFb = value => `"${String(value).replace(/"/g, '""')}"`;
const quoteMy = value => '`' + String(value).replace(/`/g, '``') + '`';
// Keep snapshot isolation, replacing the driver's TPB write flag with read-only.
const READ_ONLY_SNAPSHOT = [...Firebird.ISOLATION_REPEATABLE_READ];
READ_ONLY_SNAPSHOT[1] = Firebird.ISOLATION_READ_COMMITTED_READ_ONLY[1];

async function readTargetMetadata(pool) {
	const [columns] = await pool.query(`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
		COLUMN_DEFAULT, EXTRA, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, COLLATION_NAME,
		GENERATION_EXPRESSION, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
	const [indexes] = await pool.query(`SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
	const [foreignKeys] = await pool.query(`SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
		FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
		ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`);
	const [checks] = await pool.query(`SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
		FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc
		ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
		WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'`);
	const result = new Map();
	for (const row of columns) {
		const name = lower(row.TABLE_NAME);
		if (!result.has(name)) result.set(name, { columns: [], indexes: [], relations: [], checks: [] });
		result.get(name).columns.push({
			name: lower(row.COLUMN_NAME), type: lower(row.DATA_TYPE), columnType: row.COLUMN_TYPE,
			nullable: row.IS_NULLABLE === 'YES', defaultValue: row.COLUMN_DEFAULT, primary: row.COLUMN_KEY === 'PRI',
			autoIncrement: /auto_increment/i.test(row.EXTRA || ''), generated: !!row.GENERATION_EXPRESSION,
			expression: row.GENERATION_EXPRESSION,
			defaultExpression: /DEFAULT_GENERATED/i.test(row.EXTRA || ''),
			length: row.CHARACTER_MAXIMUM_LENGTH == null ? null : Number(row.CHARACTER_MAXIMUM_LENGTH),
			precision: row.NUMERIC_PRECISION == null ? null : Number(row.NUMERIC_PRECISION), scale: Number(row.NUMERIC_SCALE || 0),
			collation: row.COLLATION_NAME,
			enumValues: row.DATA_TYPE === 'enum' ? [...row.COLUMN_TYPE.matchAll(/'((?:[^'\\]|\\.|'')*)'/g)].map(match => match[1].replace(/''/g, "'").replace(/\\(.)/g, '$1')) : undefined
		});
	}
	for (const row of indexes) {
		const table = result.get(lower(row.TABLE_NAME));
		let index = table.indexes.find(item => item.name === row.INDEX_NAME);
		if (!index) table.indexes.push(index = { name: row.INDEX_NAME, columns: [], prefix: false });
		index.columns.push(lower(row.COLUMN_NAME)); index.prefix ||= row.SUB_PART != null;
	}
	for (const row of foreignKeys) {
		const table = result.get(lower(row.TABLE_NAME));
		let relation = table.relations.find(item => item.name === row.CONSTRAINT_NAME);
		if (!relation) table.relations.push(relation = { name: row.CONSTRAINT_NAME, columns: [], parent: lower(row.REFERENCED_TABLE_NAME), parentColumns: [], kind: 'foreign key' });
		relation.columns.push(lower(row.COLUMN_NAME)); relation.parentColumns.push(lower(row.REFERENCED_COLUMN_NAME));
	}
	for (const row of checks) result.get(lower(row.TABLE_NAME))?.checks.push({ name: row.CONSTRAINT_NAME, expression: row.CHECK_CLAUSE });
	// MySQL 8 can return escaped quote delimiters in GENERATION_EXPRESSION.
	// Obtain the original SQL instead of changing escapes inside business literals.
	const affected = [...result].filter(([, table]) => table.columns.some(col => col.generated && /\\'/.test(col.expression)));
	if (affected.length) {
		const [[session]] = await pool.query('SELECT @@SESSION.sql_mode AS sql_mode');
		for (const [name, table] of affected) {
			const [[definition]] = await pool.query(`SHOW CREATE TABLE ${quoteMy(name)}`);
			const ddl = definition['Create Table'];
			if (!ddl) throw new Error(`Cannot read executable generated expressions for ${name}`);
			for (const col of table.columns.filter(col => col.generated)) col.expression = generatedExpressionFromDDL(ddl, col.name, String(session.sql_mode).split(',').includes('NO_BACKSLASH_ESCAPES'));
		}
	}
	return result;
}

function resolveSource(source, available) {
	const names = [source, /IES$/i.test(source) ? source.slice(0, -3) + 'Y' : '', /S$/i.test(source) ? source.slice(0, -1) : ''];
	return names.map(name => available.find(item => lower(item) === lower(name))).find(Boolean);
}

const linkCache = new WeakMap();
function inDateScope(row, filter) {
	if (!filter) return true;
	if (filter.sourceColumn) {
		const value = row[lower(filter.sourceColumn)];
		// node-firebird decodes DATE/TIMESTAMP into local calendar Date objects.
		const date = value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : String(value || '').slice(0, 10);
		if (date && date >= filter.startDate) return true;
	}
	if (!linkCache.has(filter)) {
		const links = new Map();
		for (const plan of filter.linkPlans) {
			const column = /^"((?:[^"]|"")+)" IN \(/i.exec(plan.clause)?.[1]?.replace(/""/g, '"');
			if (!column) throw new Error('Unsupported transactional link predicate');
			if (!links.has(lower(column))) links.set(lower(column), new Set());
			for (const key of plan.params) links.get(lower(column)).add(String(key).trim());
		}
		linkCache.set(filter, links);
	}
	return [...linkCache.get(filter)].some(([column, keys]) => row[column] != null && keys.has(String(row[column]).trim()));
}

async function materializeRow(row, tx) {
	for (const [key, value] of Object.entries(row)) {
		if (typeof value !== 'function') continue;
		row[key] = await new Promise((resolve, reject) => value(tx, (err, _name, stream) => {
			if (err) return reject(err);
			const chunks = [];
			stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			stream.on('error', reject);
			stream.on('end', () => resolve(Buffer.concat(chunks)));
		}));
	}
	return row;
}

async function createAudit({ pool, firebirdConfig, mysqlConfig, schemaName, plan, planConfig = {}, mapping, planId = null, runId = null, retryOfRunId = null, root, auditStore, onProgress = () => {}, checkAbort = () => {} }) {
	const store = auditStore || await createStore({ mysqlConfig, schemaName }, root);
	const report = { id: store.id, version: 2, status: 'running', createdAt: new Date().toISOString(), planId, runId, schemaName,
		source: { host: firebirdConfig.host, database: firebirdConfig.database }, tables: [], totals: null,
		policy: 'quarantine confirmed junk; block unresolved records; preserve the legacy database',
		scope: 'All selected tables; transactional date/link selection applies before row validation' };
	await store.save(report);
	let db, tx;
	try {
		checkAbort();
		const corrections = await readCorrections({ mysqlConfig, schemaName });
		const decisions = await require('./decisions').readDecisions({ mysqlConfig, schemaName });
		report.inputFingerprint = require('./history').inputFingerprint(plan, mapping, firebirdConfig, { corrections, decisions });
		report.savedDecisions = Object.entries(decisions).map(([id, item]) => ({ id, description: item.description, records: item.records.length }));
		report.savedCorrectionCount = Object.keys(corrections).length;
		report.appliedCorrectionCount = 0;
		onProgress({ stage: 'prepare', phase: 'target_metadata' });
		const target = await readTargetMetadata(pool);
		checkAbort();
		const preparedMapping = structuredClone(mapping);
		prepareLegacyMapping(preparedMapping);
		const steps = normalizePlanSteps(plan, preparedMapping).filter(step => step.include);
		if (!steps.length) throw new Error('Select at least one table to audit');
		report.plan = { tables: steps, config: planConfig };
		onProgress({ stage: 'prepare', phase: 'connecting_source', tableCount: steps.length });
		db = await firebird.attachWithRetry(firebirdConfig);
		checkAbort();
		tx = await new Promise((resolve, reject) => db.transaction(READ_ONLY_SNAPSHOT, (err, transaction) => err ? reject(err) : resolve(transaction)));
		const sourceTables = await firebird.listTablesWithDb(tx);
		const tables = [];
		for (const step of steps) {
			checkAbort();
			const name = lower(resolveTargetTableName(step.table, preparedMapping));
			onProgress({ stage: 'prepare', phase: 'table_metadata', table: name, tableIndex: tables.length + 1, tableCount: steps.length });
			if (tables.some(table => table.name === name)) throw new Error(`Table ${name} is selected more than once`);
			const pair = Object.entries(preparedMapping.tables || {}).find(([, value]) => lower(value.target ?? value.targetTable) === name);
			if (!pair) throw new Error(`No mapping found for selected table ${name}`);
			const sourceTable = resolveSource(pair[0], sourceTables);
			if (!sourceTable) throw new Error(`Source table ${pair[0]} does not exist`);
			const metadata = target.get(name);
			if (!metadata) throw new Error(`Target table ${name} does not exist`);
			const sourceColumns = await firebird.listColumnsWithDb(tx, sourceTable);
			const columnsMap = pair[1].columns || {};
			const columns = metadata.columns;
			const actualStep = { ...step, cleanBefore: !retryOfRunId && step.cleanBefore };
			if (name === 'invoices') Object.assign(actualStep, { mode: 'INSERT', keyStrategy: 'preserve', dedupeKeys: [] });
			const errors = [];
			const indexes = metadata.indexes.filter(index => !(actualStep.keyStrategy === 'rekey' && index.name === 'PRIMARY'));
			for (const index of indexes) {
				if (index.prefix || index.columns.some(col => !col)) errors.push(`Unique index ${index.name} uses functional or prefix values; resolve this constraint before migration`);
			}
			if (actualStep.dedupeKeys?.length) indexes.push({ name: 'migration deduplication key', columns: actualStep.dedupeKeys.map(lower) });
			tables.push({ name, sourceTable, sourceColumns, columns, indexes, mapping: columnsMap, step: actualStep,
				relations: metadata.relations.map(relation => ({ ...relation })), checks: metadata.checks, retry: !!retryOfRunId, errors });
		}
		await prepareAutomaticRepairs(tables, target, pool, retryOfRunId, report, async (child, column) => {
			checkAbort();
			const pair = Object.entries(child.mapping).find(([, rule]) => !rule.omit && lower(rule.target ?? rule.targetColumn) === column);
			if (!pair) return false;
			const [source, rule] = pair;
			if (rule.transform || rule.lookup || (rule.defaultValue && Number(rule.defaultValue) !== 0) || !child.sourceColumns.some(col => lower(col) === lower(source))) return true;
			const actualSource = child.sourceColumns.find(col => lower(col) === lower(source));
			const rows = await firebird.queryWithDb(tx, `SELECT FIRST 1 ${quoteFb(actualSource)} FROM ${quoteFb(child.sourceTable)} WHERE ${quoteFb(actualSource)} IS NOT NULL AND ${quoteFb(actualSource)} <> 0`);
			return rows.length > 0;
		});
		for (const table of tables) {
			for (const [source, rule] of Object.entries(table.mapping)) {
				const column = table.columns.find(col => col.name === lower(rule.target ?? rule.targetColumn));
				const property = Object.hasOwn(rule, 'default') ? 'default' : 'defaultValue';
				if (!rule.omit && column?.nullable && /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|bit)$/.test(column.type) && rule[property] === '') {
					rule[property] = null;
					report.automaticRepairs.push({ table: table.name, column: column.name, action: 'Keep missing optional numeric values as NULL', explanation: `Removed an invalid empty-text default for ${source}. The destination permits NULL; populated source values and explicit numeric defaults are unchanged.` });
				}
			}
			table.evaluate = makeEvaluator(pool, table);
			const mapped = new Map(Object.entries(table.mapping).filter(([, rule]) => !rule.omit).map(([source, rule]) => [lower(rule.target ?? rule.targetColumn), { source, rule }]));
			for (const rule of RELATIONSHIPS.filter(rule => rule.table === table.name)) {
				if (rule.columns.every(col => mapped.has(col))) table.relations.push({ ...rule });
			}
			for (const [column, { rule }] of mapped) if (rule.lookup) {
				const parentName = lower(resolveTargetTableName(rule.lookup.table, preparedMapping));
				rule.lookup.table = parentName;
				const parent = tables.find(item => item.name === parentName);
				const pks = target.get(parentName)?.columns.filter(col => col.primary).map(col => col.name) || [];
				if ((!parent && !retryOfRunId) || pks.length !== 1) table.errors.push(`Lookup ${column} requires selected parent ${parentName} with a single primary key, or a valid prior-run mapping when retrying`);
				else if (!parent) table.relations.push({ columns: [column], parent: parentName, parentColumns: pks, lookup: true, kind: 'lookup' });
				else {
					if (tables.indexOf(parent) >= tables.indexOf(table)) table.errors.push(`Lookup parent ${parentName} must migrate before ${table.name}`);
					const parentTargets = Object.values(parent.mapping).filter(rule => !rule.omit).map(rule => lower(rule.target ?? rule.targetColumn));
					if (!pks.every(col => parentTargets.includes(col))) table.errors.push(`Lookup parent ${parentName} must map its original primary key`);
					parent.lookupIdentity = pks;
					if (parent.step.keyStrategy === 'rekey' && !parent.indexes.some(index => index.name === 'source lookup identity')) parent.indexes.push({ name: 'source lookup identity', columns: pks, sourceOnly: true });
					table.relations.push({ columns: [column], parent: parentName, parentColumns: pks, lookup: true, kind: 'lookup' });
				}
			}
			for (const relation of table.relations) {
				const parentMeta = target.get(relation.parent);
				if (!parentMeta || !relation.parentColumns.every(col => parentMeta.columns.some(item => item.name === col))) {
					table.errors.push(`Cannot validate parent ${relation.parent} (${relation.parentColumns.join(',')})`); continue;
				}
				relation.parentMetadata = parentMeta.columns;
				const parent = tables.find(item => item.name === relation.parent);
				if (parent?.step.keyStrategy === 'rekey' && relation.parentColumns.some(col => parent.columns.find(item => item.name === col)?.primary)) {
					if (!relation.columns.every(col => mapped.get(col)?.rule.lookup)) table.errors.push(`Reference to rekeyed ${relation.parent} requires an ID lookup mapping`);
				}
			}
			table.relations = table.relations.filter(relation => target.has(relation.parent) && (relation.kind === 'foreign key' || relation.columns.every(col => mapped.has(col))));
		}
		// Emptying a selected parent must not strand existing target children,
		// including tables outside this migration's selection.
		for (const parent of tables.filter(table => table.step.cleanBefore)) {
			parent.existingChildren = [];
			for (const [childName, metadata] of target) {
				if (tables.find(table => table.name === childName)?.step.cleanBefore) continue;
				const relations = [...metadata.relations, ...RELATIONSHIPS.filter(rule => rule.table === childName)];
				for (const relation of relations.filter(relation => relation.parent === parent.name)) {
					if (relation.columns.every(col => metadata.columns.some(item => item.name === col)) && relation.parentColumns.every(col => parent.columns.some(item => item.name === col))) parent.existingChildren.push({ ...relation, child: childName });
				}
			}
		}
		const progressFor = (table, phase, detail = {}) => onProgress({ stage: 'rows', phase, table: table.name, sourceTable: table.sourceTable, tableIndex: tables.indexOf(table) + 1, tableCount: tables.length, nextTable: tables[tables.indexOf(table) + 1]?.name, ...detail });
		checkAbort();
		onProgress({ stage: 'prepare', phase: 'date_scope', tableCount: tables.length });
		const context = await buildTransactionalLinkContextWithDb({ db: tx, tableConfigs: tables.map(table => ({ tableName: table.name, sourceTable: table.sourceTable, columnsMap: table.mapping })), planConfig,
			onProgress: (phase, detail) => { checkAbort(); onProgress({ stage: 'prepare', phase, tableCount: tables.length, ...detail }); } });
		onProgress({ stage: 'prepare', phase: 'account_mapping', tableCount: tables.length });
		const accnrConversionMap = new Map();
		let accountRows = null;
		const accountSource = resolveSource(Object.entries(preparedMapping.tables || {}).find(([, value]) => lower(value.target ?? value.targetTable) === 'accounts')?.[0] || 'ACCOUNTS', sourceTables);
		if (accountSource) {
			const cols = (await firebird.listColumnsWithDb(tx, accountSource)).map(lower);
			if (['accnr', 'acctype', 'accclass'].every(col => cols.includes(col))) {
				accountRows = await firebird.queryWithDb(tx, `SELECT ACCNR, ACCTYPE, ACCCLASS FROM ${quoteFb(accountSource)}`);
			}
		}
		if (!accountRows && ['accnr', 'acctype', 'accclass'].every(name => target.get('accounts')?.columns.some(col => col.name === name))) {
			[accountRows] = await pool.query('SELECT accnr, acctype, accclass FROM accounts');
		}
		for (const row of accountRows || []) {
			if (lower(row.acctype).trim() === 'group account' && row.accclass != null && Number(row.accclass) !== 7) accnrConversionMap.set(Number(row.accnr), convertLegacyGroupAccnr(row.accnr));
		}
		for (const table of tables) {
			const filter = buildTransactionalTableFilter(table.name, table.mapping, planConfig, { availableSourceColumns: table.sourceColumns, context });
			if (filter && !filter.hasPredicate) table.errors.push('Date filter has no usable date or link columns');
			table.rows = async function* () {
				progressFor(table, 'counting');
				const expected = await firebird.countRowsWithDb(tx, table.sourceTable);
				let scanned = 0;
				table.sourceProgress = { scanned: 0, total: Number(expected) };
				progressFor(table, 'reading', { scanned, total: Number(expected) });
				while (scanned < expected) {
					checkAbort();
					const page = await firebird.fetchBatchWithDb(tx, table.sourceTable, [], scanned, 1000, 'RDB$DB_KEY');
					if (!page.length) throw new Error(`Source scan ended early for ${table.sourceTable}: ${scanned}/${expected}`);
					for (const [index, row] of page.entries()) {
						checkAbort();
						table.sourceProgress.scanned = scanned + index + 1;
						if (inDateScope(row, filter)) {
							const original = await materializeRow(row, tx);
							const corrected = applyCorrections(corrections, table.name, original);
							if (corrected !== original) report.appliedCorrectionCount++;
							yield corrected;
						}
					}
					scanned += page.length;
					progressFor(table, 'reading', { scanned, total: Number(expected) });
				}
				if (scanned !== Number(expected)) throw new Error(`Source count changed for ${table.sourceTable}`);
				table.summary.sourceRows = Number(expected);
				table.summary.outOfScope = Number(expected) - table.summary.scanned;
			};
		}
		await require('./lineIdRepairs').prepareLineIdRepairs(tables, target, pool, store, report, async (child, column) => {
			const pair = Object.entries(child.mapping).find(([, rule]) => !rule.omit && lower(rule.target ?? rule.targetColumn) === column);
			if (!pair) return [];
			const [source, rule] = pair;
			if (rule.transform || rule.lookup) return null;
			const actual = child.sourceColumns.find(col => lower(col) === lower(source));
			if (!actual) return null;
			const rows = await firebird.queryWithDb(tx, `SELECT DISTINCT ${quoteFb(actual)} AS REF FROM ${quoteFb(child.sourceTable)} WHERE ${quoteFb(actual)} IS NOT NULL`);
			const values = rows.map(row => row.REF ?? row.ref);
			const defaultValue = Object.hasOwn(rule, 'default') ? rule.default : rule.defaultValue;
			if (defaultValue != null && defaultValue !== '') values.push(defaultValue);
			for (const [key, entry] of Object.entries(corrections)) if (key.startsWith(child.name + ':')) for (const [field, value] of Object.entries(entry.fields)) if (lower(field) === lower(actual)) values.push(value);
			return values;
		}, checkAbort);
		const loadTargetRows = async function* (name, columns) {
			if (!target.has(name) || !columns.every(col => target.get(name).columns.some(item => item.name === col))) throw new Error(`Cannot validate target references in ${name}`);
			let offset = 0;
			while (true) {
				checkAbort();
				const [rows] = await pool.query(`SELECT ${columns.map(quoteMy).join(',')} FROM ${quoteMy(name)} ORDER BY ${columns.map(quoteMy).join(',')} LIMIT 1000 OFFSET ${offset}`);
				for (const row of rows) yield row;
				offset += rows.length;
				if (rows.length < 1000) break;
			}
		};
		const loadLookupKeys = async function* (name, columns) {
			if (!retryOfRunId || columns.length !== 1 || !target.get(name)?.columns.some(col => col.name === columns[0] && col.primary)) return;
			const [rows] = await pool.query(`SELECT m.source_pk AS source_pk FROM migration_id_map m
				JOIN ${quoteMy(name)} p ON p.${quoteMy(columns[0])} = m.target_pk WHERE m.run_id = ? AND m.table_name = ?`, [retryOfRunId, name.toUpperCase()]);
			for (const row of rows) yield { [columns[0]]: row.source_pk };
		};
		report.mapping = Object.fromEntries(tables.map(table => [table.sourceTable, { target: table.name, columns: table.mapping }]));
		const result = await auditTables({ tables, store, report, loadTargetRows, loadLookupKeys, checkAbort, onProgress, mappingOptions: { accnrConversionMap }, excludeUnresolved: planConfig.dataQuality?.excludeUnresolved === true, excludedRecords: require('./decisions').decisionKeys(decisions) });
		return { ...result, mapping: preparedMapping, context, accnrConversionMap };
	} catch (err) {
		report.status = err.code === 'AUDIT_CANCELLED' ? 'cancelled' : 'failed'; report.error = err.message; report.completedAt = new Date().toISOString();
		await store.save(report);
		err.auditId = store.id;
		throw err;
	} finally {
		if (tx) await new Promise(resolve => tx.rollback(() => resolve()));
		if (db) await new Promise(resolve => db.detach(() => resolve()));
	}
}

module.exports = { createAudit, readTargetMetadata, inDateScope, resolveSource, quoteMy };
