const INVOICE_TABLE = "invoices";

function normalizeName(value) {
	return String(value || "").trim().toLowerCase();
}

function quoteFirebirdIdentifier(identifier) {
	return `"${String(identifier).replace(/"/g, '""')}"`;
}

function getRowValue(row, columnName) {
	if (!row || !columnName) return undefined;
	const wanted = normalizeName(columnName);
	const key = Object.keys(row).find((candidate) => normalizeName(candidate) === wanted);
	return key ? row[key] : undefined;
}

function resolveMappedSourceColumn(columnsMap = {}, targetColumn) {
	const wanted = normalizeName(targetColumn);
	for (const [sourceColumn, rule] of Object.entries(columnsMap || {})) {
		if (!rule || rule.omit) continue;
		const mappedTarget = rule.target ?? rule.targetColumn;
		if (normalizeName(mappedTarget) === wanted) return sourceColumn;
	}
	return null;
}

function buildInvoiceSourcePolicy(tableName, columnsMap = {}) {
	if (normalizeName(tableName) !== INVOICE_TABLE) return null;
	const sourceColumn = resolveMappedSourceColumn(columnsMap, "invoice_nr");
	if (!sourceColumn) {
		throw new Error(
			"Invoice migration safety check failed: the source invoice number is not mapped to invoices.invoice_nr."
		);
	}
	const quoted = quoteFirebirdIdentifier(sourceColumn);
	return {
		sourceColumn,
		clause: `${quoted} IS NOT NULL AND ${quoted} > 0`,
		params: []
	};
}

function combineSourceWhere(baseClause = null, baseParams = [], policy = null) {
	const clauses = [];
	const params = [];
	if (baseClause) {
		clauses.push(`(${baseClause})`);
		params.push(...(baseParams || []));
	}
	if (policy?.clause) {
		clauses.push(`(${policy.clause})`);
		params.push(...(policy.params || []));
	}
	return {
		clause: clauses.join(" AND ") || null,
		params
	};
}

function isValidInvoiceNumber(value) {
	if (value === null || value === undefined || String(value).trim() === "") return false;
	const number = Number(value);
	return Number.isInteger(number) && number > 0;
}

function filterValidInvoiceKeys(keys = []) {
	return (keys || []).filter(isValidInvoiceNumber);
}

function resolveOnDuplicatePolicy(tableName, configuredPolicy) {
	if (normalizeName(tableName) === INVOICE_TABLE) return "ERROR";
	return configuredPolicy || "SKIP";
}

function buildInvoiceSplitPolicy(tableName, columnsMap, targetColumns = []) {
	if (normalizeName(tableName) !== INVOICE_TABLE) return null;
	if (!targetColumns.some(column => normalizeName(column) === 'is_split_invoice')) return null;
	// An explicit mapping remains authoritative. Otherwise preserve the legacy
	// SPLITNR and also populate the modern flag used by the active-job key.
	if (resolveMappedSourceColumn(columnsMap, 'is_split_invoice')) return null;
	const sourceColumn = resolveMappedSourceColumn(columnsMap, 'splitnr');
	return sourceColumn ? { sourceColumn, targetColumn: 'is_split_invoice' } : null;
}

function applyInvoiceSplitPolicy(sourceRow, mappedRow, policy) {
	if (!policy) return;
	const splitNumber = Number(getRowValue(sourceRow, policy.sourceColumn));
	mappedRow[policy.targetColumn] = Number.isInteger(splitNumber) && splitNumber > 0 ? 1 : 0;
}

function hasMappingDefault(rule = {}) {
	return Object.prototype.hasOwnProperty.call(rule, "default")
		|| Object.prototype.hasOwnProperty.call(rule, "defaultValue");
}

function getMappingDefault(rule = {}) {
	if (Object.prototype.hasOwnProperty.call(rule, "default")) return rule.default;
	return rule.defaultValue;
}

const NUMERIC_DATA_TYPES = new Set([
	"tinyint", "smallint", "mediumint", "int", "integer", "bigint",
	"decimal", "numeric", "float", "double", "bit", "year"
]);
// Line invoice numbers: AUTONEER writes NULL for "not invoiced". A blank mapping
// default would reach the INT column as "" and MySQL stores it as 0. Widen this
// list only after confirming how AUTONEER-PWA reads the column.
const BLANK_DEFAULT_NULL_COLUMNS = new Set(["spares_used.invoice_nr", "work_done.invoice_nr"]);

function isNumericDataType(dataType) {
	return NUMERIC_DATA_TYPES.has(normalizeName(dataType));
}

// Mapping default for a NULL source value, given the target column's MySQL data
// type. An empty-string default on a numeric line invoice number stays NULL;
// explicit defaults such as "0" are returned unchanged.
function resolveMappingDefault(rule = {}, { targetTable, targetColumn, dataType } = {}) {
	const value = getMappingDefault(rule);
	if (value !== "" || !isNumericDataType(dataType)) return value;
	const column = `${normalizeName(targetTable)}.${normalizeName(targetColumn ?? rule.target ?? rule.targetColumn)}`;
	return BLANK_DEFAULT_NULL_COLUMNS.has(column) ? null : value;
}

function normalizeIdentityValue(value) {
	if (value === null || value === undefined || String(value).trim() === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? String(number) : String(value).trim();
}

function buildSourceInvoiceSelection(rows, columnsMap = {}) {
	const invoiceSourceColumn = resolveMappedSourceColumn(columnsMap, "invoice_nr");
	const jobSourceColumn = resolveMappedSourceColumn(columnsMap, "job_number");
	const customerSourceColumn = resolveMappedSourceColumn(columnsMap, "cid");
	if (!invoiceSourceColumn) {
		throw new Error("Cannot reconcile invoices: invoice_nr is not mapped.");
	}

	const identities = new Map();
	const selectedOffsets = new Map();
	for (const [offset, row] of (rows || []).entries()) {
		const invoiceNr = getRowValue(row, invoiceSourceColumn);
		if (!isValidInvoiceNumber(invoiceNr)) {
			throw new Error(`Cannot reconcile invoices: invalid source invoice number ${String(invoiceNr)}.`);
		}
		const key = String(Number(invoiceNr));
		const jobNumber = jobSourceColumn ? normalizeIdentityValue(getRowValue(row, jobSourceColumn)) : undefined;
		const existing = identities.get(key);
		// Keep the first source row, unless a later duplicate has a real job
		// number and the current choice belongs to job zero.
		if (existing && !(existing.jobNumber === "0" && jobNumber != null && jobNumber !== "0")) continue;
		identities.set(key, {
			invoiceNr: key,
			jobNumber,
			cid: customerSourceColumn ? normalizeIdentityValue(getRowValue(row, customerSourceColumn)) : undefined
		});
		selectedOffsets.set(key, offset);
	}
	return { identities, selectedOffsets: new Set(selectedOffsets.values()) };
}

function buildSourceInvoiceIdentityMap(rows, columnsMap = {}) {
	return buildSourceInvoiceSelection(rows, columnsMap).identities;
}

function reconcileInvoiceIdentities(sourceIdentities, targetRows = []) {
	const targetByInvoice = new Map();
	for (const row of targetRows || []) {
		const invoiceNr = normalizeIdentityValue(getRowValue(row, "invoice_nr"));
		if (invoiceNr !== null) targetByInvoice.set(invoiceNr, row);
	}

	const issues = [];
	for (const [invoiceNr, expected] of sourceIdentities || []) {
		const actual = targetByInvoice.get(invoiceNr);
		if (!actual) {
			issues.push(`invoice ${invoiceNr} is missing from the target`);
			continue;
		}
		if (expected.jobNumber !== undefined) {
			const actualJob = normalizeIdentityValue(getRowValue(actual, "job_number"));
			if (actualJob !== expected.jobNumber) {
				issues.push(
					`invoice ${invoiceNr} belongs to source job ${expected.jobNumber ?? "NULL"} but target job ${actualJob ?? "NULL"}`
				);
			}
		}
		if (expected.cid !== undefined) {
			const actualCid = normalizeIdentityValue(getRowValue(actual, "cid"));
			if (actualCid !== expected.cid) {
				issues.push(
					`invoice ${invoiceNr} belongs to source customer ${expected.cid ?? "NULL"} but target customer ${actualCid ?? "NULL"}`
				);
			}
		}
	}
	return issues;
}

module.exports = {
	applyInvoiceSplitPolicy,
	buildInvoiceSplitPolicy,
	buildInvoiceSourcePolicy,
	buildSourceInvoiceSelection,
	buildSourceInvoiceIdentityMap,
	combineSourceWhere,
	filterValidInvoiceKeys,
	getMappingDefault,
	hasMappingDefault,
	isNumericDataType,
	isValidInvoiceNumber,
	reconcileInvoiceIdentities,
	resolveMappedSourceColumn,
	resolveMappingDefault,
	resolveOnDuplicatePolicy
};
