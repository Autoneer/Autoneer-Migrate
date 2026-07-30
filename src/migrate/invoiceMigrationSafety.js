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

function hasMappingDefault(rule = {}) {
	return Object.prototype.hasOwnProperty.call(rule, "default")
		|| Object.prototype.hasOwnProperty.call(rule, "defaultValue");
}

function getMappingDefault(rule = {}) {
	if (Object.prototype.hasOwnProperty.call(rule, "default")) return rule.default;
	return rule.defaultValue;
}

function normalizeIdentityValue(value) {
	if (value === null || value === undefined || String(value).trim() === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? String(number) : String(value).trim();
}

function buildSourceInvoiceIdentityMap(rows, columnsMap = {}) {
	const invoiceSourceColumn = resolveMappedSourceColumn(columnsMap, "invoice_nr");
	const jobSourceColumn = resolveMappedSourceColumn(columnsMap, "job_number");
	const customerSourceColumn = resolveMappedSourceColumn(columnsMap, "cid");
	if (!invoiceSourceColumn) {
		throw new Error("Cannot reconcile invoices: invoice_nr is not mapped.");
	}

	const identities = new Map();
	for (const row of rows || []) {
		const invoiceNr = getRowValue(row, invoiceSourceColumn);
		if (!isValidInvoiceNumber(invoiceNr)) {
			throw new Error(`Cannot reconcile invoices: invalid source invoice number ${String(invoiceNr)}.`);
		}
		const key = String(Number(invoiceNr));
		if (identities.has(key)) {
			throw new Error(`Cannot migrate invoices: source invoice number ${key} occurs more than once.`);
		}
		identities.set(key, {
			invoiceNr: key,
			jobNumber: jobSourceColumn ? normalizeIdentityValue(getRowValue(row, jobSourceColumn)) : undefined,
			cid: customerSourceColumn ? normalizeIdentityValue(getRowValue(row, customerSourceColumn)) : undefined
		});
	}
	return identities;
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
	buildInvoiceSourcePolicy,
	buildSourceInvoiceIdentityMap,
	combineSourceWhere,
	filterValidInvoiceKeys,
	getMappingDefault,
	hasMappingDefault,
	isValidInvoiceNumber,
	reconcileInvoiceIdentities,
	resolveMappedSourceColumn,
	resolveOnDuplicatePolicy
};
