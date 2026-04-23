const firebird = require("../db/firebird");

const TRANSACTIONAL_FILTER_METADATA = {
	job_information: {
		dateTargets: ["job_date", "date_received", "date_finished", "status_date"],
		keyGroups: {
			customerJob: ["job_number"]
		}
	},
	invoices: {
		dateTargets: ["invoice_date", "inv_date"],
		keyGroups: {
			customerInvoice: ["invoice_nr"],
			customerJob: ["job_number"]
		}
	},
	payments: {
		dateTargets: ["paydate", "capturedate"],
		keyGroups: {
			customerInvoice: ["invoice_nr"],
			customerJob: ["job_number"],
			customerCredit: ["cnid"]
		}
	},
	credit_notes: {
		dateTargets: ["cdate"],
		keyGroups: {
			customerCredit: ["cnid"],
			customerInvoice: ["invoice_nr"],
			customerJob: ["job_number"]
		}
	},
	invoice_items: {
		dateTargets: ["inv_date"],
		keyGroups: {
			supplierInvoice: ["invoice_nr"],
			customerJob: ["job_number"]
		}
	},
	spares_used: {
		dateTargets: ["date_used"],
		keyGroups: {
			customerInvoice: ["invoice_nr"],
			customerJob: ["job_number"],
			workDone: ["wdid"]
		}
	},
	work_done: {
		dateTargets: ["workdate"],
		keyGroups: {
			workDone: ["wdid"],
			customerInvoice: ["invoice_nr"],
			customerJob: ["job_number"]
		}
	},
	work_timer: {
		dateTargets: ["workdate"],
		keyGroups: {
			workDone: ["wdid"],
			customerJob: ["job_number"]
		}
	},
	work_todo: {
		keyGroups: {
			customerJob: ["job_number"]
		}
	},
	job_report: {
		keyGroups: {
			customerJob: ["job_number"]
		}
	},
	orders: {
		dateTargets: ["orderdate"],
		keyGroups: {
			customerInvoice: ["orderinvoice_nr"],
			customerJob: ["job_number"]
		}
	},
	invoices_supplier: {
		dateTargets: ["inv_date"],
		keyGroups: {
			supplierInvoice: ["invoice_nr"],
			supplierInvoiceId: ["sinvid"]
		}
	},
	payments_suppliers: {
		dateTargets: ["paydate"],
		keyGroups: {
			supplierInvoice: ["invoice_nr"],
			supplierInvoiceId: ["invid"]
		}
	},
	credit_notes_supplier: {
		dateTargets: ["cnotedate"],
		keyGroups: {
			supplierInvoice: ["invoice_nr"],
			supplierInvoiceId: ["sinvid"]
		}
	},
	invoice_general: {
		dateTargets: ["purchdate"],
		keyGroups: {
			supplierInvoice: ["invoice_nr"]
		}
	}
};

const TARGET_SOURCE_ALIASES = {
	job_number: ["JOB_NUMBER", "JOB_NR"],
	invoice_nr: ["INVOICE_NR", "INV_NR", "INVOICENR"],
	orderinvoice_nr: ["ORDERINVOICE_NR"],
	wdid: ["WDID", "WORK_ID"],
	cnid: ["CNID", "CNOTEID"],
	sinvid: ["SINVID"],
	invid: ["INVID", "SINVID"],
	job_date: ["JOB_DATE"],
	date_received: ["DATE_RECEIVED"],
	date_finished: ["DATE_FINISHED"],
	status_date: ["STATUS_DATE"],
	invoice_date: ["INVOICE_DATE", "INV_DATE"],
	inv_date: ["INV_DATE", "INVOICE_DATE"],
	paydate: ["PAYDATE"],
	capturedate: ["CAPTUREDATE"],
	date_used: ["DATE_USED"],
	workdate: ["WORKDATE"],
	cdate: ["CDATE"],
	cnotedate: ["CNOTEDATE"],
	orderdate: ["ORDERDATE"],
	purchdate: ["PURCHDATE"]
};

const FIREBIRD_IN_MEMBER_LIST_LIMIT = 1000;

function normalizeTableName(tableName) {
	return String(tableName || "").trim().toLowerCase();
}

function normalizeColumnName(columnName) {
	return String(columnName || "").trim().toUpperCase();
}

function quoteIdentifier(name) {
	return `"${String(name || "").replace(/"/g, '""')}"`;
}

function normalizeTransactionalDateFilterConfig(config = {}) {
	const rawFilter = config?.transactionalDateFilter;
	const enabled = rawFilter?.enabled === true;
	const startDate = typeof rawFilter?.startDate === "string" ? rawFilter.startDate.trim() : "";
	const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate) && !Number.isNaN(new Date(`${startDate}T00:00:00Z`).getTime());

	return {
		enabled,
		startDate: isValidDate ? startDate : null
	};
}

function getTableMetadata(tableName) {
	return TRANSACTIONAL_FILTER_METADATA[normalizeTableName(tableName)] || null;
}

function isTransactionalTable(tableName) {
	return !!getTableMetadata(tableName);
}

function getColumnEntries(columnsMap) {
	if (!columnsMap) return [];
	if (columnsMap instanceof Map) {
		return Array.from(columnsMap.entries());
	}
	return Object.entries(columnsMap);
}

function getAvailableColumnMap(availableSourceColumns = []) {
	const map = new Map();
	for (const column of availableSourceColumns || []) {
		map.set(normalizeColumnName(column), column);
	}
	return map;
}

function resolveSourceColumnForTarget(targetColumn, columnsMap, availableSourceColumns = []) {
	const normalizedTarget = String(targetColumn || "").trim().toLowerCase();
	for (const [sourceColumn, rule] of getColumnEntries(columnsMap)) {
		const mappedTarget = String(rule?.targetColumn || rule?.target || "").trim().toLowerCase();
		if (mappedTarget === normalizedTarget) {
			return sourceColumn;
		}
	}

	const availableColumnMap = getAvailableColumnMap(availableSourceColumns);
	const aliasCandidates = TARGET_SOURCE_ALIASES[normalizedTarget] || [normalizedTarget.toUpperCase()];
	for (const candidate of aliasCandidates) {
		const found = availableColumnMap.get(normalizeColumnName(candidate));
		if (found) return found;
	}

	return null;
}

function resolveTransactionalSourceDateColumn(tableName, columnsMap, availableSourceColumns = []) {
	const metadata = getTableMetadata(tableName);
	const targetCandidates = metadata?.dateTargets || [];
	for (const targetColumn of targetCandidates) {
		const sourceColumn = resolveSourceColumnForTarget(targetColumn, columnsMap, availableSourceColumns);
		if (sourceColumn) return sourceColumn;
	}
	return null;
}

function resolveLinkSourceColumns(tableName, columnsMap, availableSourceColumns = []) {
	const metadata = getTableMetadata(tableName);
	const resolved = {};
	for (const [groupName, targetColumns] of Object.entries(metadata?.keyGroups || {})) {
		const sourceColumns = [];
		for (const targetColumn of targetColumns) {
			const sourceColumn = resolveSourceColumnForTarget(targetColumn, columnsMap, availableSourceColumns);
			if (sourceColumn && !sourceColumns.includes(sourceColumn)) {
				sourceColumns.push(sourceColumn);
			}
		}
		if (sourceColumns.length > 0) {
			resolved[groupName] = sourceColumns;
		}
	}
	return resolved;
}

function getRowValue(row, columnName) {
	if (!row || !columnName) return null;
	return row[columnName]
		?? row[String(columnName).toLowerCase()]
		?? row[String(columnName).toUpperCase()]
		?? null;
}

function normalizeLinkValue(value) {
	if (value === null || value === undefined) return null;
	const normalized = String(value).trim();
	return normalized.length > 0 ? normalized : null;
}

function createEmptyKeySets() {
	return {
		customerJob: new Set(),
		customerInvoice: new Set(),
		customerCredit: new Set(),
		workDone: new Set(),
		supplierInvoice: new Set(),
		supplierInvoiceId: new Set()
	};
}

function collectKeyValues(rows, linkSourceColumns, keySets) {
	let changed = false;
	for (const row of rows || []) {
		for (const [groupName, sourceColumns] of Object.entries(linkSourceColumns || {})) {
			const keySet = keySets[groupName];
			if (!keySet) continue;
			for (const sourceColumn of sourceColumns) {
				const normalizedValue = normalizeLinkValue(getRowValue(row, sourceColumn));
				if (normalizedValue && !keySet.has(normalizedValue)) {
					keySet.add(normalizedValue);
					changed = true;
				}
			}
		}
	}
	return changed;
}

function chunkValues(values, chunkSize = FIREBIRD_IN_MEMBER_LIST_LIMIT) {
	const chunks = [];
	for (let index = 0; index < values.length; index += chunkSize) {
		chunks.push(values.slice(index, index + chunkSize));
	}
	return chunks;
}

function buildInClause(sourceColumn, values) {
	if (!sourceColumn || !values || values.length === 0) return null;
	return {
		clause: `${quoteIdentifier(sourceColumn)} IN (${values.map(() => "?").join(", ")})`,
		params: values
	};
}


function buildLinkQueryPlans(linkSourceColumns, keySets) {
	const plans = [];

	for (const [groupName, sourceColumns] of Object.entries(linkSourceColumns || {})) {
		const keySet = keySets?.[groupName];
		if (!keySet || keySet.size === 0) continue;
		const values = Array.from(keySet.values());
		for (const sourceColumn of sourceColumns) {
			for (const chunk of chunkValues(values)) {
				const clause = buildInClause(sourceColumn, chunk);
				if (clause) {
					plans.push(clause);
				}
			}
		}
	}

	return plans;
}

async function queryDistinctRowsWithDb(db, sourceTable, selectColumns, whereClause = null, params = []) {
	const uniqueColumns = Array.from(new Set((selectColumns || []).filter(Boolean)));
	if (uniqueColumns.length === 0) return [];
	const sql = [
		`SELECT DISTINCT ${uniqueColumns.map(quoteIdentifier).join(", ")} `,
		`FROM ${quoteIdentifier(sourceTable)}`,
		whereClause ? ` WHERE ${whereClause}` : ""
	].join("");
	return firebird.queryWithDb(db, sql, params);
}

async function queryDistinctRowsByPlansWithDb(db, sourceTable, selectColumns, queryPlans = []) {
	const rows = [];
	for (const plan of queryPlans || []) {
		try {
			const result = await queryDistinctRowsWithDb(db, sourceTable, selectColumns, plan.clause, plan.params);
			rows.push(...result);
		} catch (err) {
			// Skip chunks where collected string keys are incompatible with this column's
			// type (e.g. "46-CREDIT" against an INTEGER column). Those values can't match.
			if (String(err.message || '').includes('Conversion error')) continue;
			throw err;
		}
	}
	return rows;
}

function sortKeyValues(values = []) {
	return [...values].sort((left, right) => {
		const leftNum = Number(left);
		const rightNum = Number(right);
		if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
			return leftNum - rightNum;
		}
		return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
	});
}

async function collectMatchingKeyValuesWithDb({ db, sourceTable, keyColumn, filter }) {
	const uniqueValues = new Map();
	const addRows = (rows) => {
		for (const row of rows || []) {
			const value = getRowValue(row, keyColumn);
			const normalizedValue = normalizeLinkValue(value);
			if (normalizedValue && !uniqueValues.has(normalizedValue)) {
				uniqueValues.set(normalizedValue, value);
			}
		}
	};

	if (filter?.datePlan) {
		addRows(await queryDistinctRowsWithDb(db, sourceTable, [keyColumn], filter.datePlan.clause, filter.datePlan.params));
	}

	if (filter?.linkPlans?.length) {
		addRows(await queryDistinctRowsByPlansWithDb(db, sourceTable, [keyColumn], filter.linkPlans));
	}

	return sortKeyValues(Array.from(uniqueValues.values()));
}

async function fetchFirstMatchingRowWithDb({ db, sourceTable, columns, orderBy, filter }) {
	if (filter?.datePlan) {
		const rows = await firebird.fetchBatchWithDbWhere(db, sourceTable, columns, 0, 1, orderBy, filter.datePlan.clause, filter.datePlan.params);
		if (rows?.length) return rows[0];
	}

	for (const plan of filter?.linkPlans || []) {
		const rows = await firebird.fetchBatchWithDbWhere(db, sourceTable, columns, 0, 1, orderBy, plan.clause, plan.params);
		if (rows?.length) return rows[0];
	}

	return null;
}

async function buildTransactionalLinkContextWithDb({ db, tableConfigs = [], planConfig = {}, onProgress = null, firebirdConfig = null }) {
	const filter = normalizeTransactionalDateFilterConfig(planConfig);
	if (!filter.enabled || !filter.startDate) return null;

	const keySets = createEmptyKeySets();
	const tableConfigsByName = new Map();

	for (const tableConfig of tableConfigs || []) {
		const tableName = normalizeTableName(tableConfig?.tableName);
		if (!tableName || !tableConfig?.sourceTable || !isTransactionalTable(tableName)) continue;
		const availableSourceColumns = tableConfig.availableSourceColumns || await firebird.listColumnsWithDb(db, tableConfig.sourceTable);
		const dateSourceColumn = resolveTransactionalSourceDateColumn(tableName, tableConfig.columnsMap, availableSourceColumns);
		const linkSourceColumns = resolveLinkSourceColumns(tableName, tableConfig.columnsMap, availableSourceColumns);
		tableConfigsByName.set(tableName, {
			tableName,
			sourceTable: tableConfig.sourceTable,
			dateSourceColumn,
			linkSourceColumns,
			availableSourceColumns
		});
	}

	onProgress?.('collecting_seed_keys', { tables: tableConfigsByName.size });
	for (const tableConfig of tableConfigsByName.values()) {
		if (!tableConfig.dateSourceColumn) continue;
		const selectColumns = Object.values(tableConfig.linkSourceColumns || {}).flat();
		const rows = await queryDistinctRowsWithDb(
			db,
			tableConfig.sourceTable,
			selectColumns,
			`${quoteIdentifier(tableConfig.dateSourceColumn)} >= ?`,
			[filter.startDate]
		);
		collectKeyValues(rows, tableConfig.linkSourceColumns, keySets);
		onProgress?.('seed_keys_collected', { table: tableConfig.tableName, keyCounts: Object.fromEntries(Object.entries(keySets).map(([k, v]) => [k, v.size])) });
	}

	// Open one dedicated connection per table for parallel traversal.
	// This lets all tables query simultaneously per pass instead of sequentially,
	// turning each pass from sum(table times) to max(slowest table time).
	const tableConnections = new Map();
	if (firebirdConfig) {
		await Promise.all(
			Array.from(tableConfigsByName.keys()).map(async (tableName) => {
				try {
					const conn = await firebird.attachWithRetry(firebirdConfig);
					tableConnections.set(tableName, conn);
				} catch {
					// Fall back to shared db for this table if connection fails
				}
			})
		);
	}

	try {
		let iteration = 0;
		// Stop early when a pass adds fewer than this many new keys — the remaining
		// passes would add negligible data but still run the full query set.
		const CONVERGENCE_THRESHOLD = 50;

		while (iteration < 8) {
			const keyCountBefore = Object.values(keySets).reduce((sum, s) => sum + s.size, 0);
			iteration += 1;

			// Snapshot key sets at the start of each pass so all tables query the same
			// input. Without this, early tables add keys mid-pass, causing later tables
			// to build exponentially larger IN clauses.
			const keySetsSnapshot = Object.fromEntries(
				Object.entries(keySets).map(([k, v]) => [k, new Set(v)])
			);

			onProgress?.('link_traversal', { iteration, keyCounts: Object.fromEntries(Object.entries(keySets).map(([k, v]) => [k, v.size])) });

			const tableEntries = Array.from(tableConfigsByName.values()).filter((tableConfig) => {
				const selectColumns = Object.values(tableConfig.linkSourceColumns || {}).flat();
				return selectColumns.length > 0 && buildLinkQueryPlans(tableConfig.linkSourceColumns, keySetsSnapshot).length > 0;
			});

			if (tableConnections.size > 0) {
				const results = await Promise.all(
					tableEntries.map(async (tableConfig) => {
						const selectColumns = Object.values(tableConfig.linkSourceColumns || {}).flat();
						const linkPlans = buildLinkQueryPlans(tableConfig.linkSourceColumns, keySetsSnapshot);
						onProgress?.('link_traversal_table', { iteration, table: tableConfig.tableName, plans: linkPlans.length });
						const conn = tableConnections.get(tableConfig.tableName) || db;
						const rows = await queryDistinctRowsByPlansWithDb(conn, tableConfig.sourceTable, selectColumns, linkPlans);
						return { tableConfig, rows };
					})
				);
				for (const { tableConfig, rows } of results) {
					collectKeyValues(rows, tableConfig.linkSourceColumns, keySets);
				}
			} else {
				for (const tableConfig of tableEntries) {
					const selectColumns = Object.values(tableConfig.linkSourceColumns || {}).flat();
					const linkPlans = buildLinkQueryPlans(tableConfig.linkSourceColumns, keySetsSnapshot);
					onProgress?.('link_traversal_table', { iteration, table: tableConfig.tableName, plans: linkPlans.length });
					const rows = await queryDistinctRowsByPlansWithDb(db, tableConfig.sourceTable, selectColumns, linkPlans);
					collectKeyValues(rows, tableConfig.linkSourceColumns, keySets);
				}
			}

			const newKeys = Object.values(keySets).reduce((sum, s) => sum + s.size, 0) - keyCountBefore;
			if (newKeys < CONVERGENCE_THRESHOLD) {
				onProgress?.('link_traversal_converged', { iteration, newKeys });
				break;
			}
		}
	} finally {
		for (const conn of tableConnections.values()) {
			try { conn.detach(); } catch { /* ignore */ }
		}
	}

	return {
		enabled: true,
		startDate: filter.startDate,
		keySets,
		tableConfigsByName
	};
}

function buildTransactionalTableFilter(tableName, columnsMap, config = {}, options = {}) {
	const filter = normalizeTransactionalDateFilterConfig(config);
	const normalizedTable = normalizeTableName(tableName);
	if (!filter.enabled || !filter.startDate || !isTransactionalTable(normalizedTable)) {
		return null;
	}

	const availableSourceColumns = options.availableSourceColumns || [];
	const contextConfig = options.context?.tableConfigsByName?.get(normalizedTable);
	const dateSourceColumn = contextConfig?.dateSourceColumn || resolveTransactionalSourceDateColumn(normalizedTable, columnsMap, availableSourceColumns);
	const linkSourceColumns = contextConfig?.linkSourceColumns || resolveLinkSourceColumns(normalizedTable, columnsMap, availableSourceColumns);
	const datePlan = dateSourceColumn
		? {
			clause: `${quoteIdentifier(dateSourceColumn)} >= ?`,
			params: [filter.startDate]
		}
		: null;
	const linkPlans = buildLinkQueryPlans(linkSourceColumns, options.context?.keySets || createEmptyKeySets());

	return {
		enabled: true,
		startDate: filter.startDate,
		tableName: normalizedTable,
		sourceColumn: dateSourceColumn,
		linkSourceColumns,
		datePlan,
		linkPlans,
		clause: datePlan && linkPlans.length === 0 ? datePlan.clause : null,
		params: datePlan && linkPlans.length === 0 ? datePlan.params : [],
		hasPredicate: !!datePlan || linkPlans.length > 0,
		hasDateClause: !!datePlan,
		hasLinkClause: linkPlans.length > 0
	};
}

function summarizeTransactionalContext(context) {
	if (!context?.keySets) return null;
	return Object.fromEntries(
		Object.entries(context.keySets).map(([groupName, values]) => [groupName, values.size])
	);
}

module.exports = {
	TRANSACTIONAL_FILTER_METADATA,
	normalizeTransactionalDateFilterConfig,
	isTransactionalTable,
	resolveSourceColumnForTarget,
	resolveTransactionalSourceDateColumn,
	resolveLinkSourceColumns,
	buildTransactionalLinkContextWithDb,
	buildTransactionalTableFilter,
	collectMatchingKeyValuesWithDb,
	fetchFirstMatchingRowWithDb,
	summarizeTransactionalContext,
	buildLinkQueryPlans,
	createEmptyKeySets,
	FIREBIRD_IN_MEMBER_LIST_LIMIT
};
