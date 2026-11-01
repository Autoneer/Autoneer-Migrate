// Declarations copied verbatim from AUTONEER-PWA src/services/suppliers/supplierInvoices.service.js,
// only those the GL backfill uses. scripts/sync_pwa_gl_backfill.js keeps them in step.

const { resolveControlAccounts } = require('../../lib/finance/postingEngine');
const { resolveStockGlAccounts, resolveWorkshopAssetPurchaseAccount } = require('../../lib/finance/stockGlResolver');
const { isWorkshopAsset } = require('../../utils/stockClassification');
const { JOB_LINK_MESSAGE } = require('./workshopAssetPurchases.service');
const { resolveSupplierWipAccount, requireSupplierWipAccount } = require('../../lib/finance/supplierWipControl');
const logger = require('../../lib/logger');

function normalizeJobNumber(value) {
	const str = value == null ? '' : String(value).trim();
	return str && str !== '0' ? str : null;
}

async function resolveCreditorInvoiceLineAccount(schema, line, controls, queryFn = null) {
	const jobNumber = normalizeJobNumber(line.jobNumber ?? line.job_number);
	if (isWorkshopAsset(line) || Number(line.workshopAssetAccnr) > 0) {
		if (jobNumber !== null) {
			const err = new Error(JOB_LINK_MESSAGE);
			err.statusCode = 409;
			err.code = 'WORKSHOP_ASSET_JOB_LINK_FORBIDDEN';
			throw err;
		}
		if (Number(line.workshopAssetAccnr) > 0) return Number(line.workshopAssetAccnr);
		const resolved = await resolveWorkshopAssetPurchaseAccount({
			schema,
			stockId: line.stockId || line.stock_id || null,
			partnr: line.partnr || line.partNumber || null,
			queryFn
		});
		return resolved.assetAccnr;
	}
	const executeQuery = typeof queryFn === 'function' ? queryFn : null;
	let authoritativeStock = null;
	if (executeQuery && (line.stockId || line.stock_id || line.partnr || line.partNumber)) {
		const stockId = line.stockId || line.stock_id || null;
		const rows = await executeQuery(
			stockId
				? `SELECT stock_id, partnr, stocktype, gl_asset_accnr FROM ${schema}.stock WHERE stock_id = ? LIMIT 1`
				: `SELECT stock_id, partnr, stocktype, gl_asset_accnr FROM ${schema}.stock WHERE UPPER(TRIM(partnr)) = UPPER(TRIM(?)) ORDER BY stock_id ASC LIMIT 1`,
			[stockId || line.partnr || line.partNumber]
		);
		authoritativeStock = rows && rows[0] ? rows[0] : null;
	}
	if (authoritativeStock && isWorkshopAsset(authoritativeStock)) {
		if (jobNumber !== null) {
			const err = new Error(JOB_LINK_MESSAGE);
			err.statusCode = 409;
			err.code = 'WORKSHOP_ASSET_JOB_LINK_FORBIDDEN';
			throw err;
		}
		const historicalAssetAccnr = Number(line.accasset ?? (line.original && line.original.accasset));
		if (Number.isFinite(historicalAssetAccnr) && historicalAssetAccnr > 0) {
			return historicalAssetAccnr;
		}
		const resolved = await resolveWorkshopAssetPurchaseAccount({
			schema,
			stockId: authoritativeStock.stock_id,
			queryFn: executeQuery
		});
		const lineId = Number(line.invid ?? line.lineId) || 0;
		if (lineId) {
			await executeQuery(`UPDATE ${schema}.invoice_items SET accasset = ? WHERE invid = ?`, [resolved.assetAccnr, lineId]);
		}
		return resolved.assetAccnr;
	}
	// Direct-to-job parts are an asset until the customer invoice recognises
	// their matching revenue. Posting them to COS here and again at finalise
	// double-counts cost and expenses unfinished work before it is earned.
	// They need a valid WIP control: Inventory is never a silent substitute.
	if (jobNumber !== null) return requireSupplierWipAccount(controls, jobNumber);
	try {
		const itemAccounts = await resolveStockGlAccounts({
			schema,
			stockId: line.stockId || line.stock_id || null,
			partnr: line.partnr || line.partNumber || null,
			txnType: 'PARTS'
		});
		return itemAccounts.assetAccnr;
	} catch (resolveErr) {
		logger.warn('Supplier invoice: stock GL resolution failed, using control defaults', {
			stock_id: line.stockId || line.stock_id || null,
			partnr: line.partnr || line.partNumber || null,
			message: resolveErr && resolveErr.message
		});
		return controls.INVENTORY;
	}
}

async function resolveSupplierAssetControls(schema) {
	const controls = await resolveControlAccounts(schema, ['AP', 'VAT_INPUT', 'INVENTORY']);
	// WIP stays null when missing or invalid. Only job-linked lines need it and
	// they fail closed in resolveCreditorInvoiceLineAccount; stock-only invoices
	// still post to Inventory.
	const wip = await resolveSupplierWipAccount(schema, { inventoryAccnr: controls.INVENTORY });
	controls.WIP = wip.wipAccnr;
	controls.wipSetupError = wip.wipSetupError;
	return controls;
}

module.exports = {
	normalizeJobNumber,
	resolveCreditorInvoiceLineAccount,
	resolveSupplierAssetControls
};
