/**
 * Stock GL Account Resolver — Single Source of Truth
 *
 * Provides centralized, deterministic GL account resolution for every stock
 * item across ALL posting modules.  Every stock-related GL posting in the
 * system MUST call resolveStockGlAccounts() instead of using hardcoded
 * account numbers or ad-hoc control-account resolution.
 *
 * Resolution cascade (per account type):
 *   1. Stock item has a non-NULL gl_*_accnr  → use it
 *   2. Otherwise → use configured system default control account
 *
 * Validation:
 *   - Resolved account must exist in gl_accounts
 *   - Resolved account must be active
 *   - Resolved account must be of the correct type (ASSET for inventory,
 *     INCOME for revenue, COS/EXPENSE for cost of sales)
 *   - If resolution fails, an error is thrown — NEVER post to wrong account
 *
 * Inventory valuation method:
 *   Weighted Average Cost (WAC).  Cost price stored on stock item
 *   (cost_price_exvat) is used at posting time.  The method MUST NOT be
 *   switched silently.
 *
 * Historical integrity:
 *   Changing a stock item's mapping does NOT alter historical journals.
 *   Mapping is resolved at posting time and the resolved accnr is written
 *   to gl_journal_lines.  Past journals are immutable.
 *
 * GAAP references: IAS 2, IAS 8
 *
 * @module lib/finance/stockGlResolver
 */

'use strict';

const logger = require('../logger');
const { query } = require('../../database/database');
const { resolveControlAccounts, CONTROL_ACCOUNTS } = require('./postingEngine');
const { isWorkshopAsset } = require('../../utils/stockClassification');

// ─── Inventory valuation method (documented, enforced) ───
// The system uses Weighted Average Cost.  All COS postings use the stock
// item's cost_price_exvat at the time of posting.  FIFO is NOT used.
// DO NOT change this without a full impact analysis and migration plan.
const INVENTORY_VALUATION_METHOD = 'WEIGHTED_AVERAGE_COST';

// ─── Account type validation mapping ───
const VALID_TYPES_BY_ROLE = Object.freeze({
	asset: new Set(['ASSET']),
	revenue: new Set(['INCOME']),
	cos: new Set(['COS', 'EXPENSE'])
});

// ─── System control account roles ───
const ROLE_MAP = Object.freeze({
	asset: 'INVENTORY',
	revenue: 'SALES',
	cos: 'COS'
});

// ─── Accounts never offered in stock GL mapping dropdowns ───
const PROTECTED_ACCOUNT_NAMES = Object.freeze([
	'VAT INPUT', 'VAT OUTPUT', 'VAT CONTROL',
	'BANK', 'CASH BOOK',
	'ACCOUNTS RECEIVABLE', 'DEBTORS CONTROL',
	'ACCOUNTS PAYABLE', 'CREDITORS CONTROL',
	'RETAINED EARNINGS', 'ACCUMULATED PROFIT'
]);
// Protected accnrs (system control defaults)
const PROTECTED_ACCNRS = new Set([3000, 3100, 3300, 5000, 5100, 4000]);

// Current-asset control roles. Their system default numbers stay excluded as
// Fixed Asset accounts even where a tenant has no mapping row, because control
// resolution falls back to them.
const CURRENT_ASSET_CONTROL_KEYS = Object.freeze(['BANK', 'AR', 'INVENTORY', 'WIP', 'VAT_INPUT']);

function isProtectedMappingAccount(accnr, name) {
	if (PROTECTED_ACCNRS.has(Number(accnr))) return true;
	const upperName = String(name || '').toUpperCase();
	return PROTECTED_ACCOUNT_NAMES.some(p => upperName.includes(p));
}

// ─── Cache to avoid redundant DB hits within a single request cycle ───
// Key: `${schema}:${stock_id}`, TTL: 30 seconds
const STOCK_GL_CACHE = new Map();
const CACHE_TTL_MS = 30 * 1000;

/**
 * Invalidate cached GL mappings for a specific stock item (call after save).
 */
function invalidateStockGlCache(schema, stockId) {
	STOCK_GL_CACHE.delete(`${schema}:${stockId}`);
}

/**
 * Flush the entire stock GL cache (call on control-account config change).
 */
function flushStockGlCache() {
	STOCK_GL_CACHE.clear();
}

/**
 * Resolve GL accounts for a stock item.
 *
 * @param {Object} opts
 * @param {string} opts.schema        – Tenant schema name
 * @param {number} opts.stockId       – stock.stock_id
 * @param {string} [opts.partnr]      – stock.partnr (alternative lookup)
 * @param {string} [opts.txnType]     – Transaction type hint ('PARTS','LABOUR',etc.)
 *                                      for control-account resolution fallback
 * @returns {Promise<{assetAccnr: number, revenueAccnr: number, cosAccnr: number}>}
 * @throws {Error} if any account cannot be resolved or is invalid
 */
async function resolveStockGlAccounts({ schema, stockId, partnr, txnType, queryFn = null, controlAccounts = null }) {
	if (!schema) throw new Error('schema is required for stock GL resolution');
	if (!stockId && !partnr) throw new Error('stockId or partnr is required for stock GL resolution');
	const executeQuery = typeof queryFn === 'function' ? queryFn : query;
	const callerOwnsTransaction = typeof queryFn === 'function';

	// ── Cache check ──
	const cacheKey = `${schema}:${stockId || partnr}`;
	const now = Date.now();
	const cached = STOCK_GL_CACHE.get(cacheKey);
	if (!callerOwnsTransaction && cached && cached.expiresAt > now) {
		return { ...cached.accounts };
	}

	// ── 1. Read stock-item-level overrides ──
	let itemOverrides = { gl_asset_accnr: null, gl_revenue_accnr: null, gl_cos_accnr: null };
	try {
		const lookupSql = stockId
			? `SELECT gl_asset_accnr, gl_revenue_accnr, gl_cos_accnr FROM \`${schema}\`.stock WHERE stock_id = ? LIMIT 1`
			: `SELECT gl_asset_accnr, gl_revenue_accnr, gl_cos_accnr FROM \`${schema}\`.stock WHERE partnr = ? LIMIT 1`;
		const rows = await executeQuery(lookupSql, [stockId || partnr]);
		if (rows && rows[0]) {
			itemOverrides = rows[0];
		}
	} catch (err) {
		// If stock table doesn't have the columns yet (migration hasn't run),
		// silently fall through to defaults.  This preserves backward compat.
		if (callerOwnsTransaction) throw err;
		if (err && (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE')) {
			// columns don't exist yet — use defaults
		} else {
			throw err;
		}
	}

	// ── 2. Resolve system default control accounts ──
	const controlKeys = [];
	const txnTypeByKey = {};
	const normalizedTxnType = txnType || 'PARTS';

	if (!itemOverrides.gl_asset_accnr) { controlKeys.push('INVENTORY'); txnTypeByKey.INVENTORY = normalizedTxnType; }
	if (!itemOverrides.gl_revenue_accnr) { controlKeys.push('SALES'); txnTypeByKey.SALES = normalizedTxnType; }
	if (!itemOverrides.gl_cos_accnr) { controlKeys.push('COS'); txnTypeByKey.COS = normalizedTxnType; }

	let defaults = {};
	if (controlKeys.length > 0) {
		if (controlAccounts && typeof controlAccounts === 'object') {
			defaults = controlAccounts;
		} else if (callerOwnsTransaction) {
			throw new Error('controlAccounts are required when resolving stock GL accounts inside a caller-owned transaction');
		} else {
			defaults = await resolveControlAccounts(schema, controlKeys, {
				transactionTypeByKey: txnTypeByKey
			});
		}
	}

	// ── 3. Build resolved set ──
	const resolved = {
		assetAccnr: itemOverrides.gl_asset_accnr ? Number(itemOverrides.gl_asset_accnr) : Number(defaults.INVENTORY),
		revenueAccnr: itemOverrides.gl_revenue_accnr ? Number(itemOverrides.gl_revenue_accnr) : Number(defaults.SALES),
		cosAccnr: itemOverrides.gl_cos_accnr ? Number(itemOverrides.gl_cos_accnr) : Number(defaults.COS)
	};

	// ── 4. Validate all resolved accounts ──
	await validateResolvedAccounts(schema, resolved, executeQuery);

	// ── 5. Cache result ──
	if (!callerOwnsTransaction) {
		STOCK_GL_CACHE.set(cacheKey, {
			expiresAt: now + CACHE_TTL_MS,
			accounts: { ...resolved }
		});
	}

	return resolved;
}

/**
 * Resolve the purchase debit for a workshop-owned ASSET/TOOL. Unlike normal
 * stock resolution this has no Inventory fallback and does not require sales
 * or COS mappings.
 */
async function resolveWorkshopAssetPurchaseAccount({ schema, stockId, partnr, queryFn = null, lockForUpdate = false }) {
	if (!schema) throw new Error('schema is required for workshop asset GL resolution');
	if (!stockId && !partnr) throw new Error('stockId or partnr is required for workshop asset GL resolution');
	const executeQuery = typeof queryFn === 'function' ? queryFn : query;
	const lookup = stockId ? 'stock_id = ?' : 'UPPER(TRIM(partnr)) = UPPER(TRIM(?))';
	const rows = await executeQuery(
		`SELECT stock_id, partnr, stocktype, gl_asset_accnr
		 FROM \`${schema}\`.stock
		 WHERE ${lookup}
		 ORDER BY stock_id ASC LIMIT 1${lockForUpdate ? ' FOR UPDATE' : ''}`,
		[stockId || partnr]
	);
	const stock = rows && rows[0];
	if (!stock || !isWorkshopAsset(stock)) {
		const err = new Error('An existing Asset/Tool stock master is required before posting this purchase.');
		err.code = 'WORKSHOP_ASSET_STOCK_REQUIRED';
		err.statusCode = 409;
		throw err;
	}
	const assetAccnr = Number(stock.gl_asset_accnr);
	if (!Number.isFinite(assetAccnr) || assetAccnr <= 0) {
		const err = new Error('Select a valid Fixed Asset GL account for this Asset/Tool before posting the supplier invoice.');
		err.code = 'WORKSHOP_ASSET_GL_REQUIRED';
		err.statusCode = 409;
		throw err;
	}
	if (!(await isValidFixedAssetAccount(schema, assetAccnr, executeQuery))) {
		const err = new Error('Select a valid Fixed Asset GL account for this Asset/Tool before posting the supplier invoice.');
		err.code = 'WORKSHOP_ASSET_GL_INVALID';
		err.statusCode = 409;
		throw err;
	}
	return { assetAccnr, stock };
}

/**
 * Account numbers a Workshop Asset/Tool may never be capitalised to: every
 * bank ledger account, every account serving an active control-account role
 * (Bank, Accounts Receivable, Inventory, WIP, VAT, ...) and the system default
 * number of each current-asset control. Plain reads only (no control
 * resolution or seeding), so it is safe on a caller-owned transaction.
 *
 * @returns {Promise<Set<number>>}
 */
async function getNonFixedAssetAccnrs(schema, queryFn = query) {
	const excluded = new Set(CURRENT_ASSET_CONTROL_KEYS.map(key => Number(CONTROL_ACCOUNTS[key])).filter(n => n > 0));
	const reads = [
		`SELECT accnr FROM \`${schema}\`.gl_control_accounts WHERE COALESCE(active, 1) = 1`,
		`SELECT gl_accnr AS accnr FROM \`${schema}\`.banks WHERE gl_accnr IS NOT NULL`
	];
	for (const sql of reads) {
		let rows = [];
		try {
			rows = await queryFn(sql, []);
		} catch (err) {
			if (!(err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR'))) throw err;
		}
		for (const row of rows || []) {
			const accnr = Number(row.accnr);
			if (accnr > 0) excluded.add(accnr);
		}
	}
	return excluded;
}

/**
 * A Fixed Asset account for a Workshop Asset/Tool: an active ASSET account
 * that the stock mapping dropdown offers and that is not a bank, control or
 * current-asset control default account. Saving a stock item and posting its
 * supplier invoice both apply this same rule.
 */
async function isValidFixedAssetAccount(schema, accnr, queryFn = query) {
	const assetAccnr = Number(accnr);
	if (!Number.isFinite(assetAccnr) || assetAccnr <= 0) return false;
	const accountRows = await queryFn(
		`SELECT a.accnr, a.name, a.active, t.code AS type_code
		 FROM \`${schema}\`.gl_accounts a
		 LEFT JOIN \`${schema}\`.gl_account_types t ON t.id = a.type_id
		 WHERE a.accnr = ? LIMIT 1`,
		[assetAccnr]
	);
	const account = accountRows && accountRows[0];
	if (!account || Number(account.active) !== 1 || String(account.type_code || '').trim().toUpperCase() !== 'ASSET') return false;
	if (isProtectedMappingAccount(assetAccnr, account.name)) return false;
	return !(await getNonFixedAssetAccnrs(schema, queryFn)).has(assetAccnr);
}

/**
 * Resolve GL accounts for multiple stock items in one batch.
 * Accepts an array of { stockId, partnr } and returns a Map keyed by stockId or partnr.
 *
 * @param {Object} opts
 * @param {string} opts.schema
 * @param {Array<{stockId?: number, partnr?: string}>} opts.items
 * @param {string} [opts.txnType]
 * @returns {Promise<Map<string|number, {assetAccnr: number, revenueAccnr: number, cosAccnr: number}>>}
 */
async function resolveStockGlAccountsBatch({ schema, items, txnType }) {
	const result = new Map();
	for (const item of (items || [])) {
		const key = item.stockId || item.partnr;
		try {
			const accounts = await resolveStockGlAccounts({
				schema,
				stockId: item.stockId,
				partnr: item.partnr,
				txnType
			});
			result.set(key, accounts);
		} catch (err) {
			logger.warn('Batch stock GL resolution failed for item', {
				key, schema, message: err && err.message
			});
			// Re-throw — we do not silently skip resolution failures
			throw err;
		}
	}
	return result;
}

/**
 * Validate that all resolved account numbers exist, are active, and are of
 * the correct type for their role.
 *
 * @param {string} schema
 * @param {{assetAccnr: number, revenueAccnr: number, cosAccnr: number}} resolved
 * @throws {Error} if any account fails validation
 */
async function validateResolvedAccounts(schema, resolved, queryFn = query) {
	const accnrs = [resolved.assetAccnr, resolved.revenueAccnr, resolved.cosAccnr].filter(Boolean);
	if (accnrs.length === 0) {
		throw new Error('Stock GL resolution produced no accounts — check control account configuration');
	}

	const uniqueAccnrs = Array.from(new Set(accnrs));
	const placeholders = uniqueAccnrs.map(() => '?').join(',');

	let rows;
	try {
		rows = await queryFn(
			`SELECT a.accnr, a.active, t.code AS type_code
			 FROM \`${schema}\`.gl_accounts a
			 LEFT JOIN \`${schema}\`.gl_account_types t ON t.id = a.type_id
			 WHERE a.accnr IN (${placeholders})`,
			uniqueAccnrs
		);
	} catch (err) {
		if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')) {
			// GL tables not yet bootstrapped — skip type validation, accounts will be
			// validated again by postJournal's assertAccountsActive().
			return;
		}
		throw err;
	}

	const accountMap = new Map(
		(rows || []).map(r => [Number(r.accnr), {
			active: Number(r.active || 0),
			typeCode: String(r.type_code || '').toUpperCase()
		}])
	);

	// Validate each role
	const checks = [
		{ accnr: resolved.assetAccnr, role: 'asset', label: 'Inventory (Asset)' },
		{ accnr: resolved.revenueAccnr, role: 'revenue', label: 'Revenue (Income)' },
		{ accnr: resolved.cosAccnr, role: 'cos', label: 'Cost of Sales' }
	];

	for (const check of checks) {
		const acc = accountMap.get(check.accnr);
		if (!acc) {
			throw Object.assign(
				new Error(`Stock GL account ${check.accnr} (${check.label}) not found in chart of accounts`),
				{ code: 'STOCK_GL_ACCOUNT_NOT_FOUND', accnr: check.accnr, role: check.role }
			);
		}
		if (acc.active !== 1) {
			throw Object.assign(
				new Error(`Stock GL account ${check.accnr} (${check.label}) is inactive`),
				{ code: 'STOCK_GL_ACCOUNT_INACTIVE', accnr: check.accnr, role: check.role }
			);
		}
		const validTypes = VALID_TYPES_BY_ROLE[check.role];
		if (validTypes && acc.typeCode && !validTypes.has(acc.typeCode)) {
			throw Object.assign(
				new Error(`Stock GL account ${check.accnr} (${check.label}) has type '${acc.typeCode}' but requires one of: ${Array.from(validTypes).join(', ')}`),
				{ code: 'STOCK_GL_ACCOUNT_WRONG_TYPE', accnr: check.accnr, role: check.role, expected: Array.from(validTypes), actual: acc.typeCode }
			);
		}
	}
}

/**
 * Get the list of GL accounts valid for a given role, filtered for the
 * stock item GL mapping dropdown UI.
 *
 * Excludes:
 *   - VAT control accounts
 *   - System control accounts (Bank, AR, AP)
 *   - Retained earnings
 *   - Inactive accounts
 *
 * @param {string} schema
 * @param {'asset'|'revenue'|'cos'} role
 * @returns {Promise<Array<{accnr: number, name: string, type_code: string}>>}
 */
async function getAccountsForRole(schema, role) {
	const validTypes = VALID_TYPES_BY_ROLE[role];
	if (!validTypes) throw new Error(`Invalid role: ${role}`);

	const typeCodes = Array.from(validTypes);
	const placeholders = typeCodes.map(() => '?').join(',');

	let rows;
	try {
		rows = await query(
			`SELECT a.accnr, a.name AS accname, t.code AS type_code
			 FROM \`${schema}\`.gl_accounts a
			 JOIN \`${schema}\`.gl_account_types t ON t.id = a.type_id
			 WHERE a.active = 1
			   AND t.code IN (${placeholders})
			 ORDER BY a.accnr ASC`,
			typeCodes
		);
	} catch (err) {
		if (err && (err.code === 'ER_NO_SUCH_TABLE')) return [];
		throw err;
	}

	// ── Filter out protected system accounts ──
	// These account roles must NEVER be selectable in stock GL mapping dropdowns
	return (rows || []).filter(r => !isProtectedMappingAccount(r.accnr, r.accname));
}

/**
 * Flag each asset-role dropdown account with whether a Workshop Asset/Tool may
 * use it as its Fixed Asset account. The Inventory list is unchanged; the stock
 * detail page shows only flagged options while the item type is Asset/Tool.
 */
async function markFixedAssetEligibility(schema, assetAccounts) {
	const excluded = await getNonFixedAssetAccnrs(schema);
	return (assetAccounts || []).map(a => ({ ...a, fixedAssetEligible: !excluded.has(Number(a.accnr)) }));
}

/**
 * Get the current system default control accounts for display.
 *
 * Stock item screens pass 'PARTS' and Labour Pricing screens pass 'LABOUR' so
 * "Use Default (...)" shows the typed control posting falls back to (typed
 * mapping first, then GENERIC).
 *
 * @param {string} schema
 * @param {string} [transactionType='GENERIC']
 * @returns {Promise<{INVENTORY: string, SALES: string, COS: string}>}
 */
async function getDefaultControlAccountsDisplay(schema, transactionType = 'GENERIC') {
	const type = transactionType || 'GENERIC';
	const defaults = await resolveControlAccounts(schema, ['INVENTORY', 'SALES', 'COS'], {
		transactionTypeByKey: { INVENTORY: type, SALES: type, COS: type }
	});

	const accnrs = [defaults.INVENTORY, defaults.SALES, defaults.COS].filter(Boolean);
	if (accnrs.length === 0) return { inventory: null, revenue: null, cos: null };

	const placeholders = accnrs.map(() => '?').join(',');
	let rows = [];
	try {
		rows = await query(
			`SELECT accnr, name FROM \`${schema}\`.gl_accounts WHERE accnr IN (${placeholders})`,
			accnrs
		);
	} catch (_) { /* GL tables may not exist yet */ }

	const nameMap = new Map((rows || []).map(r => [Number(r.accnr), r.name]));

	// Return uppercase keys with formatted display strings for direct use in templates.
	// Template references: glDefaults.INVENTORY, glDefaults.SALES, glDefaults.COS
	const fmt = (accnr, fallback) => {
		const name = nameMap.get(accnr);
		return accnr ? `${accnr} - ${name || fallback}` : fallback;
	};
	return {
		INVENTORY: fmt(defaults.INVENTORY, 'Inventory'),
		SALES: fmt(defaults.SALES, 'Sales'),
		COS: fmt(defaults.COS, 'Cost of Sales')
	};
}

module.exports = {
	INVENTORY_VALUATION_METHOD,
	resolveStockGlAccounts,
	resolveWorkshopAssetPurchaseAccount,
	isValidFixedAssetAccount,
	resolveStockGlAccountsBatch,
	validateResolvedAccounts,
	getAccountsForRole,
	markFixedAssetEligibility,
	getDefaultControlAccountsDisplay,
	invalidateStockGlCache,
	flushStockGlCache
};
