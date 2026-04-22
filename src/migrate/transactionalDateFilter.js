const TRANSACTIONAL_TABLE_DATE_TARGETS = {
	job_information: ["job_date", "date_received", "date_finished", "status_date"],
	invoices: ["invoice_date", "inv_date"],
	invoices_supplier: ["inv_date", "invoice_date"],
	payments: ["paydate", "capturedate"],
	payments_suppliers: ["paydate", "capturedate"],
	spares_used: ["date_used"]
};

function normalizeTableName(tableName) {
	return String(tableName || "").trim().toLowerCase();
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

function isTransactionalTable(tableName) {
	return Object.prototype.hasOwnProperty.call(
		TRANSACTIONAL_TABLE_DATE_TARGETS,
		normalizeTableName(tableName)
	);
}

function getColumnEntries(columnsMap) {
	if (!columnsMap) return [];
	if (columnsMap instanceof Map) {
		return Array.from(columnsMap.entries());
	}
	return Object.entries(columnsMap);
}

function resolveTransactionalSourceDateColumn(tableName, columnsMap) {
	const normalizedTableName = normalizeTableName(tableName);
	const targetCandidates = TRANSACTIONAL_TABLE_DATE_TARGETS[normalizedTableName] || [];
	if (targetCandidates.length === 0) return null;

	for (const [sourceColumn, rule] of getColumnEntries(columnsMap)) {
		const targetColumn = String(rule?.targetColumn || rule?.target || "").trim().toLowerCase();
		if (targetCandidates.includes(targetColumn)) {
			return sourceColumn;
		}
	}

	return null;
}

function buildTransactionalDateFilter(tableName, columnsMap, config = {}) {
	const filter = normalizeTransactionalDateFilterConfig(config);
	if (!filter.enabled || !filter.startDate || !isTransactionalTable(tableName)) {
		return null;
	}

	const sourceColumn = resolveTransactionalSourceDateColumn(tableName, columnsMap);
	if (!sourceColumn) {
		return {
			enabled: true,
			startDate: filter.startDate,
			sourceColumn: null,
			clause: null,
			params: []
		};
	}

	return {
		enabled: true,
		startDate: filter.startDate,
		sourceColumn,
		clause: `${quoteIdentifier(sourceColumn)} >= ?`,
		params: [filter.startDate]
	};
}

module.exports = {
	TRANSACTIONAL_TABLE_DATE_TARGETS,
	normalizeTransactionalDateFilterConfig,
	isTransactionalTable,
	resolveTransactionalSourceDateColumn,
	buildTransactionalDateFilter
};