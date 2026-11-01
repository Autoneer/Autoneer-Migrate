'use strict';

// The cost source/control account must be chosen explicitly. Labour costing is
// independent of payroll; never guess a payable or use parts inventory by default.
const OFFSET_CONTROL_KEY = 'LABOUR_COST_OFFSET';
const OFFSET_LABEL = 'Labour Cost Offset';
const OFFSET_ACCOUNT_TYPES = Object.freeze(['ASSET', 'LIABILITY', 'EXPENSE']);
const COS_REF = 'WORKSHOP_LABOUR_COS';
const OFFSET_REF = 'WORKSHOP_LABOUR_OFFSET';
const REPAIR_SOURCE = 'WORKSHOP_LABOUR_COST';

function accountingError(message, code = 'LABOUR_COST_SETUP_REQUIRED') {
	return Object.assign(new Error(message), { code, statusCode: 409 });
}

function round2(value) {
	return Math.round(Number(value || 0) * 100) / 100;
}

async function buildWorkshopLabourCostLines({ queryFn, schema, jobNumber, cid = null, invoiceNr = null, includeExcludedCost = false, costRows = null }) {
	if (typeof queryFn !== 'function') throw new Error('A tenant query function is required.');
	if (!/^[a-zA-Z0-9_]+$/.test(String(schema || ''))) throw new Error('Invalid tenant schema.');
	if (!Number.isSafeInteger(Number(jobNumber)) || Number(jobNumber) <= 0) throw new Error('A workshop job number is required.');
	// A locked costing adapter can supply freshly calculated timer costs for a
	// read-only preview; account resolution and journal rules stay shared here.
	const rows = costRows || await queryFn(
		`SELECT wd.siid AS cos_accnr,
		        COALESCE(SUM(CAST(COALESCE(wd.workcost, 0) AS DECIMAL(18,2))), 0) AS cost
		 FROM \`${schema}\`.work_done wd
		 WHERE wd.job_number = ?${includeExcludedCost ? '' : '\n\t\t   AND COALESCE(wd.is_excluded_from_quote, 0) = 0'}
		 GROUP BY wd.siid`,
		[Number(jobNumber)]
	);
	const costs = (rows || []).map(row => ({ accnr: Number(row.cos_accnr), cost: round2(row.cost) }));
	if (costs.some(row => !Number.isFinite(row.cost) || row.cost < 0)) {
		throw accountingError('Workshop labour contains an invalid or negative cost. Correct the labour lines before posting.', 'LABOUR_COST_INVALID');
	}
	const nonzero = costs.filter(row => row.cost > 0);
	if (!nonzero.length) return [];

	const mappings = await queryFn(
		`SELECT c.control_key, c.transaction_type, c.accnr,
		        a.active AS account_active, t.code AS type_code
		 FROM \`${schema}\`.gl_control_accounts c
		 LEFT JOIN \`${schema}\`.gl_accounts a ON a.accnr = c.accnr
		 LEFT JOIN \`${schema}\`.gl_account_types t ON t.id = a.type_id
		 WHERE c.active = 1 AND (
		   (c.control_key = 'COS' AND c.transaction_type IN ('LABOUR', 'GENERIC'))
		   OR (c.control_key = ? AND c.transaction_type = 'GENERIC'))`,
		[OFFSET_CONTROL_KEY]
	);
	const validAccount = row => row && Number(row.account_active) === 1;
	const type = row => String(row.type_code || '').toUpperCase();
	const offset = (mappings || []).find(row => row.control_key === OFFSET_CONTROL_KEY);
	const setupHint = 'Configure Labour Cost of Sales and Labour Cost Offset under Accounting > Account List > Control Accounts.';
	if (!validAccount(offset) || !OFFSET_ACCOUNT_TYPES.includes(type(offset))) {
		throw accountingError(`Labour Cost Offset must map to an active asset, liability or expense account carrying the labour cost. ${setupHint}`);
	}
	const defaultCos = (mappings || []).find(row => row.control_key === 'COS' && row.transaction_type === 'LABOUR')
		|| (mappings || []).find(row => row.control_key === 'COS' && row.transaction_type === 'GENERIC');
	const snapshots = Array.from(new Set(nonzero.map(row => row.accnr).filter(accnr => Number.isSafeInteger(accnr) && accnr > 0)));
	const accounts = snapshots.length ? await queryFn(
		`SELECT a.accnr FROM \`${schema}\`.gl_accounts a
		 JOIN \`${schema}\`.gl_account_types t ON t.id = a.type_id
		 WHERE a.active = 1 AND t.code = 'COS' AND a.accnr IN (${snapshots.map(() => '?').join(',')})`,
		snapshots
	) : [];
	const validSnapshots = new Set((accounts || []).map(row => Number(row.accnr)));
	const byAccount = new Map();
	for (const row of nonzero) {
		const accnr = validSnapshots.has(row.accnr) ? row.accnr : Number(defaultCos && defaultCos.accnr);
		if (!validSnapshots.has(row.accnr) && (!validAccount(defaultCos) || type(defaultCos) !== 'COS')) {
			throw accountingError(`Labour Cost of Sales must map to an active Cost of Sales account. ${setupHint}`);
		}
		byAccount.set(accnr, round2((byAccount.get(accnr) || 0) + row.cost));
	}
	const refs = { job_number: Number(jobNumber), cid, invoice_nr: invoiceNr };
	const lines = Array.from(byAccount, ([accnr, debit]) => ({ accnr, debit, ref1: COS_REF, ...refs }));
	lines.push({ accnr: Number(offset.accnr), credit: round2(lines.reduce((sum, line) => sum + line.debit, 0)), ref1: OFFSET_REF, ...refs });
	return lines;
}

module.exports = { OFFSET_CONTROL_KEY, OFFSET_LABEL, OFFSET_ACCOUNT_TYPES, COS_REF, OFFSET_REF, REPAIR_SOURCE, buildWorkshopLabourCostLines };
