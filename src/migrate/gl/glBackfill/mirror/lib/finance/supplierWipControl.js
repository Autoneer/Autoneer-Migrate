const { tenantQuery } = require('../../database/database');
const { resolveControlAccounts } = require('./postingEngine');

/**
 * Work in Progress control for job-linked supplier costs.
 *
 * A job-linked supplier invoice line debits WIP, and its RFC credits WIP, so
 * finalise and rebuild capitalisation can relieve the job's real balance. If
 * WIP is missing or unusable those postings must fail closed: silently using
 * Inventory hides the job cost from WIP relief and leaves it stranded in stock.
 * Non-job stock purchases never need WIP and are unaffected.
 */

const SUPPLIER_WIP_SETUP_ERROR_CODE = 'SUPPLIER_WIP_NOT_CONFIGURED';

/**
 * Resolve and validate the WIP control. Never throws for a setup problem;
 * the caller decides whether a job-linked line needs it
 * (requireSupplierWipAccount). Unknown failures are rethrown.
 *
 * Valid means: mapped, an active ASSET account, and not the Inventory control.
 *
 * @returns {Promise<{wipAccnr:number|null, wipSetupError:string|null}>}
 */
async function resolveSupplierWipAccount(schema, {
	inventoryAccnr = null,
	resolveControlAccountsFn = resolveControlAccounts,
	queryFn = null
} = {}) {
	const invalid = (reason) => ({ wipAccnr: null, wipSetupError: reason });
	let wipAccnr = null;
	try {
		const resolved = await resolveControlAccountsFn(schema, ['WIP']);
		wipAccnr = Number(resolved && resolved.WIP) || null;
	} catch (err) {
		if (!err || err.code !== 'CONTROL_ACCOUNT_NOT_CONFIGURED') throw err;
	}
	if (!wipAccnr) return invalid('no WIP control account is mapped');
	if (inventoryAccnr && Number(inventoryAccnr) === wipAccnr) {
		return invalid(`the WIP control resolves to the Inventory account ${wipAccnr}`);
	}

	const q = typeof queryFn === 'function' ? queryFn : (sql, params) => tenantQuery(schema, sql, params);
	const rows = await q(
		`SELECT a.accnr, a.active, t.code AS type_code
		 FROM ${schema}.gl_accounts a
		 LEFT JOIN ${schema}.gl_account_types t ON t.id = a.type_id
		 WHERE a.accnr IN (?)`,
		[wipAccnr]
	);
	const account = (rows || []).find((row) => Number(row.accnr) === wipAccnr);
	if (!account) return invalid(`WIP account ${wipAccnr} does not exist`);
	if (Number(account.active) !== 1) return invalid(`WIP account ${wipAccnr} is inactive`);
	if (String(account.type_code || '').toUpperCase() !== 'ASSET') {
		return invalid(`WIP account ${wipAccnr} is not an ASSET account`);
	}
	return { wipAccnr, wipSetupError: null };
}

function supplierWipSetupError(reason, jobNumber = null) {
	const err = new Error(
		`Work in Progress is not set up correctly${jobNumber ? ` for job-linked supplier cost on job ${jobNumber}` : ''}: ${reason || 'no WIP control account is mapped'}. `
		+ 'Job-linked supplier costs post to Work in Progress and are never moved to Inventory instead. '
		+ 'Map an active ASSET account to the WIP control account, then retry.'
	);
	err.code = SUPPLIER_WIP_SETUP_ERROR_CODE;
	err.status = 422;
	err.statusCode = 422;
	return err;
}

/**
 * The WIP account for a job-linked supplier line, or a setup error.
 * `controls` carries WIP and wipSetupError from resolveSupplierWipAccount.
 */
function requireSupplierWipAccount(controls, jobNumber = null) {
	const wipAccnr = Number(controls && controls.WIP) || null;
	if (wipAccnr) return wipAccnr;
	throw supplierWipSetupError(controls && controls.wipSetupError, jobNumber);
}

module.exports = {
	SUPPLIER_WIP_SETUP_ERROR_CODE,
	resolveSupplierWipAccount,
	requireSupplierWipAccount,
	supplierWipSetupError
};
