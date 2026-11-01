const logger = require('../logger');
const { query, runInCompanyTx } = require('../../database/database');
const { toYmd } = require('./dateRange');
const { REPAIR_SOURCE: LABOUR_REPAIR_SOURCE } = require('./workshopLabourCost');
const { parseStoredDecimal, formatCents } = require('./quickQuoteMoney');

const CONTROL_ACCOUNTS = Object.freeze({
	BANK: 3000,
	AR: 3100,
	INVENTORY: 3200,
	WIP: 3772,
	VAT_INPUT: 3300,
	AP: 5000,
	VAT_OUTPUT: 5100,
	SALES: 1000,
	COS: 6000,
	BAD_DEBTS: 2001,
	DISCOUNT: 2350,
	// Created by migration 281 (or the first free number up to 2399 there).
	LOYALTY_REWARDS: 2360,
	CUSTOMER_DEPOSITS: 5200
});
const LEGACY_CONTROL_ACCOUNTS = Object.freeze({
	BANK: 1000,
	AR: 1100,
	INVENTORY: 1200,
	WIP: 0,
	VAT_INPUT: 1300,
	AP: 2000,
	VAT_OUTPUT: 2100,
	SALES: 3100,
	COS: 3200,
	BAD_DEBTS: 2001,
	DISCOUNT: 2350,
	LOYALTY_REWARDS: 2360,
	CUSTOMER_DEPOSITS: 2200
});
const CONTROL_TRANSACTION_TYPES = Object.freeze(['GENERIC', 'PARTS', 'LABOUR', 'SUBLET', 'VEHICLE']);
// Typed controls configured directly in the Control Accounts modal.
const EXPLICIT_TYPED_CONTROL_TYPES = new Set(['PARTS', 'LABOUR']);
// GENERIC controls whose mapping is always the workshop's own, type-restricted
// choice in the Control Accounts modal, so the mapped account only needs an
// active account of a valid type. Auto-selection (no usable mapping) still
// needs a matching account name, so e.g. LOYALTY_REWARDS can never drift onto
// Discounts Allowed.
const EXPLICIT_GENERIC_CONTROL_KEYS = new Set(['LOYALTY_REWARDS']);
const CONTROL_ACCOUNT_CACHE = new Map();
const CONTROL_RESOLUTION_READY = new Map();

function normalizeControlTransactionType(value) {
	const raw = String(value || '').trim().toUpperCase();
	if (!raw || raw === 'DEFAULT' || raw === 'ALL') return 'GENERIC';
	if (CONTROL_TRANSACTION_TYPES.includes(raw)) return raw;
	if (raw === 'PART' || raw === 'PARTS' || raw === 'SPARE' || raw === 'SPARES') return 'PARTS';
	if (raw === 'LABOUR' || raw === 'LABOR' || raw === 'WORK') return 'LABOUR';
	if (raw === 'SUBLET' || raw === 'SUBLETS') return 'SUBLET';
	if (raw === 'VEHICLE' || raw === 'VEHICLES') return 'VEHICLE';
	return 'GENERIC';
}

function typeRankForControl(key, typeCode) {
	const t = String(typeCode || '').toUpperCase();
	if (key === 'BANK') return t === 'ASSET' ? 40 : 0;
	if (key === 'AR') return t === 'ASSET' ? 40 : 0;
	if (key === 'INVENTORY') return t === 'ASSET' ? 40 : 0;
	if (key === 'WIP') return t === 'ASSET' ? 50 : 0;
	if (key === 'VAT_INPUT') return t === 'ASSET' ? 30 : (t === 'LIABILITY' ? 20 : 0);
	if (key === 'AP') return t === 'LIABILITY' ? 40 : 0;
	if (key === 'VAT_OUTPUT') return t === 'LIABILITY' ? 40 : 0;
	if (key === 'SALES') return t === 'INCOME' ? 40 : 0;
	if (key === 'COS') return (t === 'COS' ? 50 : (t === 'EXPENSE' ? 40 : 0));
	if (key === 'BAD_DEBTS') return t === 'EXPENSE' ? 40 : 0;
	if (key === 'DISCOUNT') return t === 'EXPENSE' ? 35 : (t === 'INCOME' ? 25 : 0);
	// EXPENSE only (the Control Accounts setting enforces the same), so neither a
	// mapping nor auto-selection can post a reward to an INCOME account.
	if (key === 'LOYALTY_REWARDS') return t === 'EXPENSE' ? 35 : 0;
	if (key === 'CUSTOMER_DEPOSITS') return t === 'LIABILITY' ? 40 : 0;
	return 0;
}

function minScoreForControl(key) {
	if (key === 'BANK') return 50;
	if (key === 'AR') return 60;
	if (key === 'INVENTORY') return 60;
	if (key === 'WIP') return 60;
	if (key === 'VAT_INPUT') return 50;
	if (key === 'AP') return 60;
	if (key === 'VAT_OUTPUT') return 50;
	if (key === 'SALES') return 60;
	if (key === 'COS') return 60;
	if (key === 'BAD_DEBTS') return 50;
	if (key === 'DISCOUNT') return 45;
	// Both "loyalty" and "reward" in the name of an EXPENSE/INCOME account.
	if (key === 'LOYALTY_REWARDS') return 125;
	if (key === 'CUSTOMER_DEPOSITS') return 50;
	return 50;
}

function scoreAccountForControl(key, account) {
	const upperName = String(account && account.name ? account.name : '').toUpperCase();
	const typeCode = String(account && account.type_code ? account.type_code : '').toUpperCase();
	let score = 0;
	score += typeRankForControl(key, typeCode);
	const has = (token) => upperName.includes(token);

	if (key === 'BANK') {
		if (has('BANK')) score += 30;
		if (has('CASH')) score += 25;
		if (has('ACCOUNT')) score += 5;
		if (has('PAYABLE') || has('RECEIVABLE')) score -= 30;
	}
	if (key === 'AR') {
		if (has('ACCOUNTS RECEIVABLE')) score += 60;
		if (has('RECEIVABLE')) score += 40;
		if (has('DEBTOR')) score += 30;
		if (has('PAYABLE')) score -= 50;
	}
	if (key === 'INVENTORY') {
		if (has('INVENTORY')) score += 50;
		if (has('STOCK')) score += 30;
		if (has('PARTS')) score += 45;
		if (has('VEHICLE')) score -= 10;
		if (has('WORK IN PROGRESS') || has('WIP')) score += 10;
		if (has('RECEIVABLE') || has('PAYABLE')) score -= 20;
	}
	if (key === 'WIP') {
		if (has('WORK IN PROGRESS')) score += 70;
		if (has('WIP')) score += 60;
		if (has('INVENTORY') || has('STOCK')) score += 10;
		if (has('RECEIVABLE') || has('PAYABLE')) score -= 30;
	}
	if (key === 'VAT_INPUT') {
		if (has('VAT')) score += 30;
		if (has('INPUT')) score += 50;
		if (has('PURCHASE')) score += 20;
		if (has('SALES') || has('OUTPUT')) score -= 40;
	}
	if (key === 'AP') {
		if (has('ACCOUNTS PAYABLE')) score += 60;
		if (has('PAYABLE')) score += 40;
		if (has('CREDITOR')) score += 30;
		if (has('RECEIVABLE')) score -= 50;
	}
	if (key === 'VAT_OUTPUT') {
		if (has('VAT')) score += 30;
		if (has('OUTPUT')) score += 50;
		if (has('SALES')) score += 30;
		if (has('INPUT') || has('PURCHASE')) score -= 40;
	}
	if (key === 'SALES') {
		if (has('SALES')) score += 50;
		if (has('REVENUE')) score += 40;
		if (has('DISCOUNT') || has('WRITE OFF') || has('BAD DEBT')) score -= 40;
	}
	if (key === 'COS') {
		if (has('COST OF SALES')) score += 70;
		if (has('COS')) score += 60;
		if (has('COST')) score += 30;
	}
	if (key === 'BAD_DEBTS') {
		if (has('BAD DEBT')) score += 70;
		if (has('BAD DEBTS')) score += 70;
		if (has('WRITE OFF') || has('WRITE-OFF') || has('WRITEOFF')) score += 50;
		if (has('DEBT')) score += 20;
		if (has('SALES') || has('VAT')) score -= 30;
	}
	if (key === 'DISCOUNT') {
		if (has('DISCOUNT')) score += 70;
		if (has('SETTLEMENT')) score += 30;
		if (has('ALLOWED')) score += 20;
		if (has('BANK') || has('VAT')) score -= 30;
	}
	if (key === 'LOYALTY_REWARDS') {
		if (has('LOYALTY')) score += 60;
		if (has('REWARD')) score += 40;
		if (has('BANK') || has('VAT')) score -= 30;
	}
	if (key === 'CUSTOMER_DEPOSITS') {
		if (has('DEPOSIT')) score += 50;
		if (has('CUSTOMER')) score += 20;
		if (has('UNEARNED') || has('ADVANCE')) score += 30;
		if (has('PAYABLE') || has('VAT') || has('SUPPLIER')) score -= 30;
	}

	return score;
}

function selectBestControlAccount(key, accounts) {
	let best = null;
	let bestScore = -1;
	for (const acc of accounts || []) {
		const score = scoreAccountForControl(key, acc);
		if (
			score > bestScore ||
			(score === bestScore && best && Number(acc.accnr || 0) < Number(best.accnr || 0))
		) {
			bestScore = score;
			best = acc;
		}
	}
	if (!best || bestScore <= 0) return null;
	return { accnr: Number(best.accnr), score: bestScore };
}

function buildControlCacheKey(schema, keys, transactionTypeByKey = {}) {
	const parts = (keys || []).map((key) => {
		const type = normalizeControlTransactionType(transactionTypeByKey[key]);
		return `${key}:${type}`;
	});
	return `${String(schema || '')}|${parts.join('|')}`;
}

function clearControlAccountCache(schema = null) {
	if (!schema) {
		CONTROL_ACCOUNT_CACHE.clear();
		return;
	}
	const prefix = `${String(schema || '')}|`;
	for (const key of CONTROL_ACCOUNT_CACHE.keys()) {
		if (key.startsWith(prefix)) CONTROL_ACCOUNT_CACHE.delete(key);
	}
}

async function getActiveGlAccounts(schema, executeQuery = query) {
	const rows = await executeQuery(
		`SELECT a.accnr, a.name, a.active, t.code AS type_code
		 FROM \`${schema}\`.gl_accounts a
		 LEFT JOIN \`${schema}\`.gl_account_types t ON t.id = a.type_id
		 WHERE a.active = 1
		 ORDER BY a.accnr ASC`
	);
	return Array.isArray(rows) ? rows : [];
}

async function getConfiguredControlAccounts(schema, keys, executeQuery = query) {
	const needed = Array.from(new Set((keys || []).map(k => String(k || '').toUpperCase()).filter(Boolean)));
	if (!needed.length) return new Map();

	const placeholders = needed.map(() => '?').join(',');
	let rows = [];
	try {
		rows = await executeQuery(
			`SELECT c.control_key, c.transaction_type, c.accnr, c.active, a.active AS account_active
			 FROM \`${schema}\`.gl_control_accounts c
			 LEFT JOIN \`${schema}\`.gl_accounts a ON a.accnr = c.accnr
			 WHERE c.control_key IN (${placeholders})`,
			needed
		);
	} catch (err) {
		if (executeQuery !== query) throw err;
		if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')) return new Map();
		throw err;
	}

	const configured = new Map();
	for (const row of rows || []) {
		const key = String(row.control_key || '').toUpperCase();
		if (!key) continue;
		if (Number(row.active || 0) !== 1) continue;
		if (Number(row.account_active || 0) !== 1) continue;
		const txnType = normalizeControlTransactionType(row.transaction_type);
		if (!configured.has(key)) configured.set(key, new Map());
		configured.get(key).set(txnType, Number(row.accnr));
	}
	return configured;
}

async function ensureControlResolutionReady(schema) {
	if (!schema) return;
	const existing = CONTROL_RESOLUTION_READY.get(schema);
	if (existing) {
		await existing;
		return;
	}

	const pending = (async () => {
		try {
			// Avoid recursive validation: resolveControlAccounts() may call this helper.
			await ensureGlSchemaSeed(schema, { validateDefaults: false });
		} finally {
			CONTROL_RESOLUTION_READY.delete(schema);
		}
	})();
	CONTROL_RESOLUTION_READY.set(schema, pending);
	await pending;
}

async function resolveControlAccounts(schema, keys = Object.keys(CONTROL_ACCOUNTS), { refresh = false, transactionTypeByKey = {}, transactionType = null, queryFn = null } = {}) {
	const needed = Array.from(new Set((keys || []).map(k => String(k || '').toUpperCase()).filter(Boolean)));
	const normalizedTypeMap = {};
	const globalTransactionType = normalizeControlTransactionType(transactionType);
	for (const [rawKey, rawType] of Object.entries(transactionTypeByKey || {})) {
		normalizedTypeMap[String(rawKey || '').toUpperCase()] = normalizeControlTransactionType(rawType);
	}
	for (const key of needed) {
		if (!normalizedTypeMap[key]) normalizedTypeMap[key] = globalTransactionType;
	}

	// Caller-owned financial transactions must never bootstrap/repair schema,
	// use cached mappings, or escape to a pooled connection.
	if (!queryFn) await ensureControlResolutionReady(schema);

	const cacheKey = buildControlCacheKey(schema, needed, normalizedTypeMap);
	const now = Date.now();
	const cached = CONTROL_ACCOUNT_CACHE.get(cacheKey);
	if (!queryFn && !refresh && cached && cached.expiresAt > now) {
		return { ...cached.accounts };
	}

	const [activeAccounts, configuredByKey] = await Promise.all([
		getActiveGlAccounts(schema, queryFn || query),
		getConfiguredControlAccounts(schema, needed, queryFn || query)
	]);
	const accountByAccnr = new Map(activeAccounts.map(a => [Number(a.accnr), a]));
	const repairs = [];

	const resolved = {};
	for (const key of needed) {
		const requestedType = normalizedTypeMap[key] || 'GENERIC';
		const configured = configuredByKey.get(key);
		const minScore = minScoreForControl(key);
		const defaultAccnr = Number(CONTROL_ACCOUNTS[key]);
		const legacyAccnr = Number(LEGACY_CONTROL_ACCOUNTS[key] || 0);
		const defaultAccount = accountByAccnr.get(defaultAccnr);
		const defaultScore = defaultAccount ? scoreAccountForControl(key, defaultAccount) : -1;

		const isValidCandidate = (accnr) => {
			const account = accountByAccnr.get(Number(accnr));
			if (!account) return false;
			return scoreAccountForControl(key, account) >= minScore;
		};

		// A Stock/Parts or Labour mapping is an explicit workshop choice made
		// through the type-restricted Control Accounts modal, so it only needs to
		// be an active account of the right type — not match the name heuristics
		// used to auto-pick GENERIC defaults (e.g. "Labour Income" is valid).
		// Other typed mappings (SUBLET, VEHICLE) keep the scored validation.
		const isValidTypedCandidate = (accnr) => {
			if (!EXPLICIT_TYPED_CONTROL_TYPES.has(requestedType)) return isValidCandidate(accnr);
			const account = accountByAccnr.get(Number(accnr));
			if (!account) return false;
			return typeRankForControl(key, account.type_code) > 0;
		};

		const isValidConfiguredGeneric = (accnr) => {
			if (!EXPLICIT_GENERIC_CONTROL_KEYS.has(key)) return isValidCandidate(accnr);
			const account = accountByAccnr.get(Number(accnr));
			if (!account) return false;
			return typeRankForControl(key, account.type_code) > 0;
		};

		const configuredGenericAccnr = configured && configured.has('GENERIC') ? Number(configured.get('GENERIC')) : null;
		const configuredRequestedAccnr = configured && configured.has(requestedType) ? Number(configured.get(requestedType)) : null;
		const shouldUpgradeLegacyGeneric =
			requestedType === 'GENERIC' &&
			configuredGenericAccnr === legacyAccnr &&
			defaultScore >= minScore;

		if (!shouldUpgradeLegacyGeneric && configured) {
			if (requestedType !== 'GENERIC' && configuredRequestedAccnr && isValidTypedCandidate(configuredRequestedAccnr)) {
				resolved[key] = configuredRequestedAccnr;
				continue;
			}
			if (configuredGenericAccnr && isValidConfiguredGeneric(configuredGenericAccnr)) {
				resolved[key] = configuredGenericAccnr;
				continue;
			}
		}

		if (defaultAccount) {
			if (defaultScore >= minScore) {
				resolved[key] = defaultAccnr;
				if (requestedType === 'GENERIC' && configuredGenericAccnr !== defaultAccnr) {
					repairs.push({ key, accnr: defaultAccnr });
				}
				continue;
			}
		}
		const best = selectBestControlAccount(key, activeAccounts);
		if (best && best.score >= minScore) {
			resolved[key] = best.accnr;
			if (requestedType === 'GENERIC' && configuredGenericAccnr !== Number(best.accnr)) {
				repairs.push({ key, accnr: Number(best.accnr) });
			}
		}
	}

	if (!queryFn && repairs.length) {
		for (const fix of repairs) {
			try {
				await query(
					`INSERT INTO \`${schema}\`.gl_control_accounts (control_key, transaction_type, accnr, active)
					 VALUES (?, 'GENERIC', ?, 1)
					 ON DUPLICATE KEY UPDATE accnr = VALUES(accnr), active = 1`,
					[fix.key, fix.accnr]
				);
			} catch (err) {
				logger.warn('Failed to auto-repair control mapping', {
					schema,
					key: fix.key,
					accnr: fix.accnr,
					message: err && err.message
				});
			}
		}
	}

	if (!queryFn) CONTROL_ACCOUNT_CACHE.set(cacheKey, { expiresAt: now + (5 * 60 * 1000), accounts: { ...resolved } });

	const missing = needed.filter(k => !resolved[k]);
	if (missing.length) {
		const err = new Error(`Control account mapping missing: ${missing.join(', ')}`);
		err.code = 'CONTROL_ACCOUNT_NOT_CONFIGURED';
		err.statusCode = 500;
		throw err;
	}
	return resolved;
}

function round2(v) {
	const num = Number(v) || 0;
	return Math.round(num * 100) / 100;
}

function validateLines(lines, exactAmounts = false) {
	if (!Array.isArray(lines) || lines.length === 0) {
		throw new Error('Journal requires at least one line');
	}
	let debitTotal = exactAmounts ? 0n : 0;
	let creditTotal = exactAmounts ? 0n : 0;
	for (const line of lines) {
		if (!line || typeof line.accnr === 'undefined') throw new Error('Line missing accnr');
		const debit = exactAmounts ? exactJournalCents(line.debit) : round2(line.debit || 0);
		const credit = exactAmounts ? exactJournalCents(line.credit) : round2(line.credit || 0);
		if (debit < 0 || credit < 0) throw new Error('Debit/credit must be non-negative');
		if ((debit > 0 && credit > 0) || (debit === (exactAmounts ? 0n : 0) && credit === (exactAmounts ? 0n : 0))) {
			throw new Error('Each line must be either debit or credit');
		}
		debitTotal += debit;
		creditTotal += credit;
	}
	if (exactAmounts ? debitTotal !== creditTotal : round2(debitTotal) !== round2(creditTotal)) {
		throw new Error('Journal is not balanced');
	}
	return exactAmounts ? { debitTotal: formatCents(debitTotal), creditTotal: formatCents(creditTotal) }
		: { debitTotal: round2(debitTotal), creditTotal: round2(creditTotal) };
}

// Opt-in for exact-money callers. Preserve DECIMAL(18,2) strings all the way
// to MySQL; existing callers retain their established rounding contract.
function exactJournalCents(value = '0.00') {
	if (typeof value !== 'string' || !/^\d{1,16}(?:\.\d{1,2})?$/.test(value)) {
		throw new Error('Exact journal amounts require non-negative DECIMAL(18,2) strings');
	}
	return parseStoredDecimal(value, 2);
}

async function ensureDefaultPeriods(schema, dt = new Date()) {
	await ensureGlSchemaSeed(schema);
	const countRows = await query(`SELECT COUNT(*) AS cnt FROM \`${schema}\`.gl_periods`);
	const count = (countRows && countRows[0] && Number(countRows[0].cnt)) || 0;
	// If no periods exist at all, create a single open period covering the year of dt
	const target = dt instanceof Date ? dt : new Date(dt);
	const year = target.getFullYear();
	const start = `${year}-01-01`;
	const end = `${year}-12-31`;
	if (count === 0) {
		return insertOpenPeriod(schema, year, start, end);
	}

	// If periods exist, ensure there's a period that covers the provided date; if not, create one for that fiscal year
	try {
		const rows = await query(`SELECT id FROM \`${schema}\`.gl_periods WHERE start_date <= ? AND end_date >= ? LIMIT 1`, [target, target]);
		if (Array.isArray(rows) && rows.length) return null;
	} catch (e) {
		// fallthrough to attempt insert
	}

	// No period found covering the date -> insert a single open period for that year
	return insertOpenPeriod(schema, year, start, end);
}

async function getPeriodForDate(schema, dt) {
	await ensureGlSchemaSeed(schema);
	const target = typeof dt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dt)
		? dt
		: (dt instanceof Date ? dt : new Date(dt));
	const rows = await query(
		`SELECT id, status FROM \`${schema}\`.gl_periods WHERE start_date <= ? AND end_date >= ? LIMIT 1`,
		[target, target]
	);
	if (Array.isArray(rows) && rows.length) return rows[0];
	return null;
}

async function getOpenPeriodId(schema, trxdate, queryFn = null) {
	const dt = typeof trxdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(trxdate)
		? trxdate
		: (trxdate ? new Date(trxdate) : new Date());
	let period;
	if (typeof queryFn === 'function') {
		const rows = await queryFn(
			`SELECT id, status FROM \`${schema}\`.gl_periods WHERE start_date <= ? AND end_date >= ? LIMIT 1`,
			[dt, dt]
		);
		period = Array.isArray(rows) && rows.length ? rows[0] : null;
	} else {
		period = await getPeriodForDate(schema, dt);
	}
	if (period) {
		if (String(period.status).toUpperCase() === 'OPEN') return period.id;
		const err = new Error('Accounting period is closed.');
		err.code = 'PERIOD_CLOSED';
		err.statusCode = 409;
		throw err;
	}
	// A caller-owned transaction must not bootstrap/repair GL schema on a second
	// connection after it has acquired journal/account locks. Missing periods are
	// a configuration error and must be resolved before the document transaction.
	if (typeof queryFn === 'function') {
		const err = new Error('Accounting period is not defined for the journal date.');
		err.code = 'PERIOD_NOT_DEFINED';
		err.statusCode = 409;
		throw err;
	}
	const insertedId = await ensureDefaultPeriods(schema, dt);
	if (insertedId) return insertedId;
	const err = new Error('Accounting period is not defined for the journal date.');
	err.code = 'PERIOD_NOT_DEFINED';
	err.statusCode = 409;
	throw err;
}

async function assertAccountsActive(txQuery, schema, lines) {
	const accnrs = Array.from(new Set(lines.map(l => Number(l.accnr))));
	const placeholders = accnrs.map(() => '?').join(',');
	const rows = await txQuery(`SELECT accnr, active FROM \`${schema}\`.gl_accounts WHERE accnr IN (${placeholders})`, accnrs);
	const activeSet = new Map(rows.map(r => [Number(r.accnr), Number(r.active || 0)]));
	for (const acc of accnrs) {
		if (!activeSet.has(acc)) throw new Error(`Account ${acc} not found`);
		if (activeSet.get(acc) === 0) throw new Error(`Account ${acc} is inactive`);
	}
}

/**
 * Closed bank-reconciliation guard.
 *
 * Closing a bank's reconciliation protects only THAT bank's GL account up to
 * the reconciliation's end date; it never closes a GL period and never affects
 * another bank. Every bank-linked GL account a journal touches (banks.gl_accnr)
 * is checked against that bank's CLOSED reconciliations: if any ends on or
 * after the journal's effective date, the whole journal is refused. A journal
 * with no bank-linked account costs one lookup and is otherwise unchanged.
 *
 * The bank's reconciliation rows (open and closed) are read with LOCK IN SHARE
 * MODE, so a posting and the closing of the same bank's reconciliation cannot
 * interleave: the closing UPDATE waits for the posting to commit, and a posting
 * that starts after the close reads CLOSED. bank_recon is already a stage-5
 * guard table in the payment lock order (paymentLockOrder.js).
 */
function bankReconClosedError(bankName, cutoffYmd, effectiveYmd) {
	const err = new Error(`Bank reconciliation is closed for ${bankName} up to ${cutoffYmd}. A GL posting to this bank account dated ${effectiveYmd} is not allowed; use a date after ${cutoffYmd}.`);
	err.code = 'BANK_RECON_CLOSED';
	err.statusCode = 409;
	return err;
}

async function assertBankReconAllowsPosting(txQuery, schema, accnrs, trxdate) {
	const touched = Array.from(new Set((accnrs || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)));
	const effectiveYmd = toYmd(trxdate);
	if (!touched.length || !effectiveYmd) return;
	let banks;
	let recons;
	try {
		banks = await txQuery(
			`SELECT bankid, bankname FROM \`${schema}\`.banks WHERE gl_accnr IN (${touched.map(() => '?').join(',')})`,
			touched
		);
		if (!Array.isArray(banks) || !banks.length) return;
		const bankIds = banks.map((b) => Number(b.bankid));
		recons = await txQuery(
			`SELECT id, bankid, status, period_end
			 FROM \`${schema}\`.bank_recon
			 WHERE bankid IN (${bankIds.map(() => '?').join(',')}) AND period_end >= ?
			 LOCK IN SHARE MODE`,
			[...bankIds, effectiveYmd]
		);
	} catch (err) {
		// A tenant without banks / bank_recon has nothing to protect.
		if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)) return;
		throw err;
	}
	const closed = (Array.isArray(recons) ? recons : [])
		.filter((r) => String(r.status || '').toUpperCase() === 'CLOSED')
		.sort((a, b) => String(toYmd(b.period_end)).localeCompare(String(toYmd(a.period_end))));
	if (!closed.length) return;
	const hit = closed[0];
	const bank = banks.find((b) => Number(b.bankid) === Number(hit.bankid));
	throw bankReconClosedError((bank && bank.bankname) || `bank ${hit.bankid}`, toYmd(hit.period_end), effectiveYmd);
}

/**
 * The same guard for an already-posted journal about to be deleted: its own
 * date and bank lines decide. Does nothing when the journal does not exist.
 */
async function assertPostedJournalNotInClosedBankRecon(txQuery, schema, headerId) {
	const headers = await txQuery(`SELECT trxdate FROM \`${schema}\`.gl_journal_headers WHERE id = ? LIMIT 1`, [headerId]);
	if (!headers || !headers.length) return;
	const lines = await txQuery(`SELECT DISTINCT accnr FROM \`${schema}\`.gl_journal_lines WHERE header_id = ?`, [headerId]);
	await assertBankReconAllowsPosting(txQuery, schema, (lines || []).map((l) => l.accnr), headers[0].trxdate);
}

async function postJournal({ schema, source, sourceId, trxdate, description, lines, userId, extraRefs = {}, status = 'POSTED', postedAt, createdAt, queryFn = null, exactAmounts = false }) {
	if (!schema) throw new Error('Schema is required for journal posting');
	if (!source || typeof sourceId === 'undefined' || sourceId === null) throw new Error('Source and sourceId are required');
	const trxDateValue = trxdate || new Date();
	validateLines(lines, exactAmounts);
	const periodId = await getOpenPeriodId(schema, trxDateValue, queryFn);
	const normalizedDate = typeof trxDateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(trxDateValue)
		? trxDateValue
		: new Date(trxDateValue);
	// Allow callers (e.g. backfill) to override posted_at / created_at so that
	// journal entries carry the original document date instead of NOW().
	const postedAtValue = postedAt ? new Date(postedAt) : null;
	const createdAtValue = createdAt ? new Date(createdAt) : null;

	const writeJournal = async (tx) => {
		// idempotency check
		const existing = await tx.query(`SELECT id FROM \`${schema}\`.gl_journal_headers WHERE source = ? AND source_id = ? LIMIT 1`, [source, String(sourceId)]);
		if (existing && existing.length) {
			return { id: existing[0].id, status: 'exists' };
		}

		await assertAccountsActive(tx.query, schema, lines);
		// Before the header insert, so a refusal leaves no header or lines behind.
		await assertBankReconAllowsPosting(tx.query, schema, lines.map((l) => l.accnr), normalizedDate);

		const headerResult = await tx.query(
			`INSERT INTO \`${schema}\`.gl_journal_headers (trxdate, source, source_id, description, status, period_id, posted_by, posted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
			[normalizedDate, source, String(sourceId), description || null, status, periodId, userId || null, postedAtValue || new Date(), createdAtValue || new Date()]
		);
		const headerId = headerResult.insertId;

		let lineNo = 1;
		for (const ln of lines) {
			const debit = exactAmounts ? formatCents(exactJournalCents(ln.debit)) : round2(ln.debit || 0);
			const credit = exactAmounts ? formatCents(exactJournalCents(ln.credit)) : round2(ln.credit || 0);
			// Ensure invoice_nr is numeric before inserting into the INT column.
			// If invoice identifier is non-numeric (e.g., alphanumeric invoice numbers),
			// store it in ref2 instead and leave invoice_nr NULL to avoid SQL errors.
			let invoiceNrValue = (extraRefs && extraRefs.invoice_nr) || ln.invoice_nr || null;
			let invoiceNrInt = null;
			let ref2Fallback = extraRefs && extraRefs.ref2 ? extraRefs.ref2 : (ln.ref2 || null);
			if (invoiceNrValue !== null && invoiceNrValue !== undefined) {
				const s = String(invoiceNrValue).trim();
				if (/^\d+$/.test(s) && String(parseInt(s, 10)) === s) {
					invoiceNrInt = parseInt(s, 10);
				} else if (s.length) {
					// Non-numeric identifiers, and numeric ones the int cast would
					// corrupt (leading zeros like '08072026', or > Number precision),
					// go into ref2 so the exact identifier stays searchable.
					ref2Fallback = ref2Fallback || s;
				}
			}

			await tx.query(
				`INSERT INTO \`${schema}\`.gl_journal_lines (header_id, accnr, debit, credit, tax_code_id, ref1, ref2, cid, suppid, job_number, invoice_nr, line_no, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[
					headerId,
					ln.accnr,
					debit,
					credit,
					typeof ln.tax_code_id !== 'undefined' ? ln.tax_code_id : null,
					extraRefs.ref1 || ln.ref1 || null,
					ref2Fallback,
					extraRefs.cid || ln.cid || null,
					extraRefs.suppid || ln.suppid || null,
					extraRefs.job_number || ln.job_number || null,
					invoiceNrInt,
					lineNo++,
					createdAtValue || new Date()
				]
			);
		}

		return { id: headerId, status: 'posted' };
	};

	// Callers that already own a transaction (for example a compound refund
	// document) can keep the journal in that same transaction.  Existing callers
	// continue to receive the original self-contained transaction behaviour.
	if (typeof queryFn === 'function') return writeJournal({ query: queryFn });
	return runInCompanyTx(writeJournal);
}

async function deleteGlJournalBySource(schema, source, sourceId, queryFn = query) {
	if (['DEBTOR_INVOICE', 'SPLIT_INVOICE'].includes(source) && queryFn === query) {
		return runInCompanyTx(tx => deleteGlJournalBySource(schema, source, sourceId, tx.query.bind(tx)));
	}
	const execQuery = typeof queryFn === 'function' ? queryFn : query;
	const headers = await execQuery(
		`SELECT id FROM \`${schema}\`.gl_journal_headers WHERE source = ? AND source_id = ? LIMIT 1${['DEBTOR_INVOICE', 'SPLIT_INVOICE'].includes(source) ? ' FOR UPDATE' : ''}`,
		[source, String(sourceId)]
	);
	if (!headers || !headers.length) return { deleted: false };
	const headerId = headers[0].id;
	if (['DEBTOR_INVOICE', 'SPLIT_INVOICE'].includes(source)) {
		const corrections = await execQuery(`SELECT id FROM \`${schema}\`.gl_journal_headers WHERE source = ? AND source_id = ? LIMIT 1 FOR UPDATE`, [LABOUR_REPAIR_SOURCE, String(headerId)]);
		if (corrections && corrections.length) {
			throw Object.assign(new Error('This invoice has a posted labour correction. Reverse or void the invoice before changing its accounting.'), { code: 'LABOUR_CORRECTION_REQUIRES_REVERSAL', statusCode: 409 });
		}
	}
	await assertPostedJournalNotInClosedBankRecon(execQuery, schema, headerId);
	await execQuery(`DELETE FROM \`${schema}\`.gl_journal_lines WHERE header_id = ?`, [headerId]);
	await execQuery(`DELETE FROM \`${schema}\`.gl_journal_headers WHERE id = ?`, [headerId]);
	return { deleted: true, id: headerId };
}

async function getJournalBySource(schema, source, sourceId, queryFn = query, forUpdate = false) {
	const execQuery = typeof queryFn === 'function' ? queryFn : query;
	const headers = await execQuery(
		`SELECT id, trxdate, description, source, source_id
		 FROM \`${schema}\`.gl_journal_headers
		 WHERE source = ? AND source_id = ?
		 LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
		[source, String(sourceId)]
	);
	if (!headers || !headers[0]) {
		const err = new Error('Journal not found for source');
		err.code = 'JOURNAL_NOT_FOUND';
		throw err;
	}
	const header = headers[0];
	const lines = await execQuery(
		`SELECT accnr, debit, credit, tax_code_id, ref1, ref2, cid, suppid, job_number, invoice_nr
		 FROM \`${schema}\`.gl_journal_lines
		 WHERE header_id = ?
		 ORDER BY line_no, id${forUpdate ? ' FOR UPDATE' : ''}`,
		[header.id]
	);
	return { header, lines: Array.isArray(lines) ? lines : [] };
}

async function postReversalJournal({ schema, source, sourceId, reversalSource, reversalSourceId, description, userId, trxdate, queryFn = null, exactAmounts = false }) {
	if (!schema) throw new Error('Schema is required for reversal posting');
	if (!source || typeof sourceId === 'undefined' || sourceId === null) throw new Error('Source and sourceId are required for reversal');
	if (!reversalSource) throw new Error('reversalSource is required');
	// Cost-only corrections belong to the original document. Serialise their
	// posting and reversal on that header and reverse the stored amounts exactly.
	const includesLabourCorrection = ['DEBTOR_INVOICE', 'SPLIT_INVOICE'].includes(source);
	if (includesLabourCorrection && typeof queryFn !== 'function') {
		// Preserve normal period provisioning, outside the locked transaction.
		await getOpenPeriodId(schema, trxdate || new Date());
		return runInCompanyTx(tx => postReversalJournal({ schema, source, sourceId, reversalSource, reversalSourceId, description, userId, trxdate, queryFn: tx.query.bind(tx), exactAmounts }));
	}
	const original = await getJournalBySource(schema, source, sourceId, queryFn || query, includesLabourCorrection || (exactAmounts && typeof queryFn === 'function'));
	if (includesLabourCorrection && original.header && original.header.id) {
		try {
			const correction = await getJournalBySource(schema, LABOUR_REPAIR_SOURCE, original.header.id, queryFn, true);
			original.lines = [...original.lines, ...correction.lines];
		} catch (err) { if (err.code !== 'JOURNAL_NOT_FOUND') throw err; }
	}
	const reversedLines = (original.lines || []).map((ln) => ({
		accnr: ln.accnr,
		debit: exactAmounts ? ln.credit : Number(ln.credit) || 0,
		credit: exactAmounts ? ln.debit : Number(ln.debit) || 0,
		tax_code_id: ln.tax_code_id,
		ref1: ln.ref1,
		ref2: ln.ref2,
		cid: ln.cid,
		suppid: ln.suppid,
		job_number: ln.job_number,
		invoice_nr: ln.invoice_nr
	}));

	return postJournal({
		schema,
		source: reversalSource,
		sourceId: typeof reversalSourceId !== 'undefined' && reversalSourceId !== null ? reversalSourceId : sourceId,
		trxdate: trxdate || new Date(),
		description: description || `Reversal of ${source} ${sourceId}`,
		lines: reversedLines,
		userId,
		extraRefs: {},
		queryFn,
		exactAmounts
	});
}

async function ensureAutoIncrementPrimaryKey(schema, table, column, type) {
	const colRows = await query(
		`SELECT COLUMN_KEY, EXTRA
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
		 LIMIT 1`,
		[schema, table, column]
	);
	if (!Array.isArray(colRows) || colRows.length === 0) return;
	const col = colRows[0] || {};
	const hasPrimaryKey = String(col.COLUMN_KEY || '').toUpperCase() === 'PRI';
	const hasAutoIncrement = String(col.EXTRA || '').toLowerCase().includes('auto_increment');
	const refRows = await query(
		`SELECT COUNT(*) AS cnt
		 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
		 WHERE REFERENCED_TABLE_SCHEMA = ?
		   AND REFERENCED_TABLE_NAME = ?
		   AND REFERENCED_COLUMN_NAME = ?`,
		[schema, table, column]
	);
	const referencedByForeignKey = Number((refRows && refRows[0] && refRows[0].cnt) || 0) > 0;

	if (!hasPrimaryKey) {
		try {
			await query(`ALTER TABLE \`${schema}\`.\`${table}\` ADD PRIMARY KEY (\`${column}\`)`);
		} catch (err) {
			logger.warn('ensureAutoIncrementPrimaryKey add primary key failed', { schema, table, column, message: err && err.message });
		}
	}

	if (!hasAutoIncrement) {
		// MySQL blocks MODIFY on referenced key columns without dropping/re-adding FKs.
		// In this case we keep the existing PK and let seed logic handle explicit ids.
		if (referencedByForeignKey) return;
		try {
			await query(`ALTER TABLE \`${schema}\`.\`${table}\` MODIFY COLUMN \`${column}\` ${type} NOT NULL AUTO_INCREMENT`);
		} catch (err) {
			logger.warn('ensureAutoIncrementPrimaryKey add auto_increment failed', { schema, table, column, message: err && err.message });
		}
	}
}

async function hasAutoIncrementColumn(schema, table, column) {
	const rows = await query(
		`SELECT EXTRA
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = ?
		   AND TABLE_NAME = ?
		   AND COLUMN_NAME = ?
		 LIMIT 1`,
		[schema, table, column]
	);
	const extra = String((rows && rows[0] && rows[0].EXTRA) || '').toLowerCase();
	return extra.includes('auto_increment');
}

async function insertOpenPeriod(schema, year, start, end) {
	const idIsAutoIncrement = await hasAutoIncrementColumn(schema, 'gl_periods', 'id');
	if (idIsAutoIncrement) {
		const insert = await query(
			`INSERT INTO \`${schema}\`.gl_periods (fiscal_year, period_no, start_date, end_date, status) VALUES (?,?,?,?, 'OPEN')`,
			[year, 1, start, end]
		);
		return insert && insert.insertId ? insert.insertId : null;
	}

	await query(
		`INSERT INTO \`${schema}\`.gl_periods (id, fiscal_year, period_no, start_date, end_date, status)
		 SELECT COALESCE(MAX(id), 0) + 1, ?, 1, ?, ?, 'OPEN' FROM \`${schema}\`.gl_periods`,
		[year, start, end]
	);
	const rows = await query(
		`SELECT id FROM \`${schema}\`.gl_periods
		 WHERE fiscal_year = ? AND period_no = 1 AND start_date = ? AND end_date = ?
		 ORDER BY id DESC LIMIT 1`,
		[year, start, end]
	);
	return rows && rows[0] ? rows[0].id : null;
}

async function upsertGlAccountTypes(schema) {
	// Normalize legacy LIAB code into LIABILITY to prevent duplicate type rows.
	const legacyRows = await query(`SELECT id FROM \`${schema}\`.gl_account_types WHERE code = 'LIAB' LIMIT 1`);
	const liabilityRows = await query(`SELECT id FROM \`${schema}\`.gl_account_types WHERE code = 'LIABILITY' LIMIT 1`);
	const legacy = Array.isArray(legacyRows) && legacyRows.length ? legacyRows[0] : null;
	const liability = Array.isArray(liabilityRows) && liabilityRows.length ? liabilityRows[0] : null;
	if (legacy && legacy.id) {
		if (liability && liability.id) {
			await query(
				`UPDATE \`${schema}\`.gl_accounts
				 SET type_id = ?
				 WHERE type_id = ?`,
				[liability.id, legacy.id]
			);
			await query(`DELETE FROM \`${schema}\`.gl_account_types WHERE id = ?`, [legacy.id]);
		} else {
			await query(
				`UPDATE \`${schema}\`.gl_account_types
				 SET code = 'LIABILITY',
					 statement_section = 'BalanceSheet',
					 display_order = 5
				 WHERE id = ?`,
				[legacy.id]
			);
		}
	}

	const seeds = [
		{ code: 'INCOME', section: 'IncomeStatement', order: 1 },
		{ code: 'EXPENSE', section: 'IncomeStatement', order: 2 },
		{ code: 'ASSET', section: 'BalanceSheet', order: 3 },
		{ code: 'EQUITY', section: 'BalanceSheet', order: 4 },
		{ code: 'LIABILITY', section: 'BalanceSheet', order: 5 },
		{ code: 'COS', section: 'IncomeStatement', order: 6 }
	];
	const idIsAutoIncrement = await hasAutoIncrementColumn(schema, 'gl_account_types', 'id');

	for (const seed of seeds) {
		const rows = await query(`SELECT id FROM \`${schema}\`.gl_account_types WHERE code = ? LIMIT 1`, [seed.code]);
		const existing = Array.isArray(rows) && rows.length ? rows[0] : null;
		if (existing && existing.id) {
			await query(
				`UPDATE \`${schema}\`.gl_account_types
				 SET statement_section = ?, display_order = ?
				 WHERE id = ?`,
				[seed.section, seed.order, existing.id]
			);
			continue;
		}

		if (idIsAutoIncrement) {
			await query(
				`INSERT INTO \`${schema}\`.gl_account_types (code, statement_section, display_order)
				 VALUES (?, ?, ?)`,
				[seed.code, seed.section, seed.order]
			);
			continue;
		}

		await query(
			`INSERT INTO \`${schema}\`.gl_account_types (id, code, statement_section, display_order)
			 SELECT COALESCE(MAX(id), 0) + 1, ?, ?, ? FROM \`${schema}\`.gl_account_types`,
			[seed.code, seed.section, seed.order]
		);
	}
}

function typeByAccountRange(accnr) {
	const n = Number(accnr || 0);
	if (n >= 1000 && n <= 1999) return { type: 'INCOME' };
	if (n >= 2000 && n <= 2999) return { type: 'EXPENSE' };
	if (n >= 3000 && n <= 3999) return { type: 'ASSET' };
	if (n >= 4000 && n <= 4999) return { type: 'EQUITY' };
	if (n >= 5000 && n <= 5999) return { type: 'LIABILITY' };
	if (n >= 6000 && n <= 6999) return { type: 'COS', fallbackType: 'EXPENSE' };
	return { type: null };
}

async function seedDefaultControlMappings(schema) {
	const configuredRows = await query(
		`SELECT control_key, accnr
		 FROM \`${schema}\`.gl_control_accounts
		 WHERE transaction_type = 'GENERIC'`
	);
	const configuredByKey = new Map(
		(configuredRows || []).map((r) => [String(r.control_key || '').toUpperCase(), Number(r.accnr || 0)])
	);
	const activeAccounts = await getActiveGlAccounts(schema);
	const accountByAccnr = new Map(activeAccounts.map(a => [Number(a.accnr), a]));

	for (const key of Object.keys(CONTROL_ACCOUNTS)) {
		if (configuredByKey.has(key)) {
			const currentAccnr = Number(configuredByKey.get(key) || 0);
			const legacyAccnr = Number(LEGACY_CONTROL_ACCOUNTS[key] || 0);
			const defaultAccnr = Number(CONTROL_ACCOUNTS[key] || 0);
			const defaultAccount = accountByAccnr.get(defaultAccnr);
			if (
				currentAccnr === legacyAccnr &&
				legacyAccnr !== defaultAccnr &&
				defaultAccount &&
				scoreAccountForControl(key, defaultAccount) >= minScoreForControl(key)
			) {
				await query(
					`UPDATE \`${schema}\`.gl_control_accounts
					 SET accnr = ?, active = 1
					 WHERE control_key = ? AND transaction_type = 'GENERIC'`,
					[defaultAccnr, key]
				);
			}
			continue;
		}

		let selectedAccnr = null;
		const defaultAccnr = Number(CONTROL_ACCOUNTS[key]);
		const defaultAccount = accountByAccnr.get(defaultAccnr);
		if (defaultAccount) {
			const defaultScore = scoreAccountForControl(key, defaultAccount);
			if (defaultScore >= minScoreForControl(key)) selectedAccnr = defaultAccnr;
		}
		if (!selectedAccnr) {
			const best = selectBestControlAccount(key, activeAccounts);
			if (best && best.score >= minScoreForControl(key)) selectedAccnr = Number(best.accnr);
		}
		if (!selectedAccnr) continue;

		await query(
			`INSERT INTO \`${schema}\`.gl_control_accounts (control_key, transaction_type, accnr, active)
			 VALUES (?, 'GENERIC', ?, 1)
			 ON DUPLICATE KEY UPDATE accnr = VALUES(accnr), active = 1`,
			[key, selectedAccnr]
		);
	}
}

async function getExistingTableNames(schema, tableNames) {
	if (!Array.isArray(tableNames) || tableNames.length === 0) return new Set();
	const placeholders = tableNames.map(() => '?').join(',');
	const rows = await query(
		`SELECT TABLE_NAME
		 FROM INFORMATION_SCHEMA.TABLES
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
		[schema, ...tableNames]
	);
	return new Set((rows || []).map((r) => String(r.TABLE_NAME || '').toLowerCase()));
}

async function ensureGlSchemaSeed(schema, options = {}) {
	const { allowDdl = false, validateDefaults = true } = options;
	const requiredTables = [
		'gl_account_types',
		'gl_accounts',
		'gl_periods',
		'gl_journal_headers',
		'tax_codes',
		'gl_journal_lines',
		'gl_control_accounts'
	];
	const existingTables = await getExistingTableNames(schema, requiredTables);
	const missingTables = requiredTables.filter((name) => !existingTables.has(name));
	const shouldRunDdl = allowDdl || missingTables.length > 0;

	if (shouldRunDdl) {
		if (!allowDdl && missingTables.length > 0) {
			const err = new Error(
				`Accounting schema not initialized for '${schema}'. Missing tables: ${missingTables.join(', ')}. Run tenant migrations first.`
			);
			err.code = 'GL_SCHEMA_MIGRATION_REQUIRED';
			err.statusCode = 500;
			throw err;
		}

		// Create tables if missing (idempotent)
		await query(`CREATE TABLE IF NOT EXISTS \`${schema}\`.gl_account_types (\n\t id INT AUTO_INCREMENT PRIMARY KEY,\n\t code VARCHAR(20) NOT NULL UNIQUE,\n\t statement_section ENUM('BalanceSheet','IncomeStatement') NOT NULL,\n\t display_order INT DEFAULT 0,\n\t created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
		await query(`CREATE TABLE IF NOT EXISTS \`${schema}\`.gl_accounts (\n\t id INT AUTO_INCREMENT PRIMARY KEY,\n\t accnr INT NOT NULL,\n\t name VARCHAR(150) NOT NULL,\n\t type_id INT NOT NULL,\n\t category VARCHAR(100) DEFAULT NULL,\n\t statement_group VARCHAR(100) DEFAULT NULL,\n\t parent_accnr INT DEFAULT NULL,\n\t active TINYINT(1) DEFAULT 1,\n\t tax_reporting_code VARCHAR(50) DEFAULT NULL,\n\t created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n\t updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,\n\t UNIQUE KEY uk_gl_accounts_accnr (accnr),\n\t INDEX idx_gl_accounts_type (type_id),\n\t CONSTRAINT fk_gl_accounts_type FOREIGN KEY (type_id) REFERENCES \`${schema}\`.gl_account_types(id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
		await query(`CREATE TABLE IF NOT EXISTS \`${schema}\`.gl_periods (\n\t id INT AUTO_INCREMENT PRIMARY KEY,\n\t fiscal_year INT NOT NULL,\n\t period_no INT NOT NULL,\n\t start_date DATE NOT NULL,\n\t end_date DATE NOT NULL,\n\t status ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',\n\t locked_by INT DEFAULT NULL,\n\t locked_at TIMESTAMP NULL DEFAULT NULL,\n\t UNIQUE KEY uk_gl_periods_range (start_date, end_date),\n\t INDEX idx_gl_periods_status (status),\n\t INDEX idx_gl_periods_year (fiscal_year, period_no)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
		await query(`CREATE TABLE IF NOT EXISTS \`${schema}\`.gl_journal_headers (\n\t id BIGINT AUTO_INCREMENT PRIMARY KEY,\n\t trxdate DATE NOT NULL,\n\t source VARCHAR(50) NOT NULL,\n\t source_id VARCHAR(50) NOT NULL,\n\t description VARCHAR(255) DEFAULT NULL,\n\t status ENUM('DRAFT','POSTED') NOT NULL DEFAULT 'POSTED',\n\t period_id INT NOT NULL,\n\t posted_by INT DEFAULT NULL,\n\t posted_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,\n\t created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n\t updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,\n\t UNIQUE KEY uk_gl_journal_headers_source (source, source_id),\n\t INDEX idx_gl_journal_headers_trxdate (trxdate),\n\t INDEX idx_gl_journal_headers_period (period_id),\n\t INDEX idx_gl_journal_headers_status (status),\n\t CONSTRAINT fk_gl_journal_headers_period FOREIGN KEY (period_id) REFERENCES \`${schema}\`.gl_periods(id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
		await query(`CREATE TABLE IF NOT EXISTS \`${schema}\`.tax_codes (\n\t id INT AUTO_INCREMENT PRIMARY KEY,\n\t code VARCHAR(20) NOT NULL UNIQUE,\n\t description VARCHAR(150) NOT NULL,\n\t rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,\n\t input_output ENUM('INPUT','OUTPUT','NONE') NOT NULL DEFAULT 'NONE',\n\t created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
		await query(`CREATE TABLE IF NOT EXISTS \`${schema}\`.gl_journal_lines (\n\t id BIGINT AUTO_INCREMENT PRIMARY KEY,\n\t header_id BIGINT NOT NULL,\n\t accnr INT NOT NULL,\n\t debit DECIMAL(18,2) NOT NULL DEFAULT 0.00,\n\t credit DECIMAL(18,2) NOT NULL DEFAULT 0.00,\n\t tax_code_id INT DEFAULT NULL,\n\t ref1 VARCHAR(100) DEFAULT NULL,\n\t ref2 VARCHAR(100) DEFAULT NULL,\n\t cid INT DEFAULT NULL,\n\t suppid INT DEFAULT NULL,\n\t job_number INT DEFAULT NULL,\n\t invoice_nr INT DEFAULT NULL,\n\t line_no INT DEFAULT NULL,\n\t created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n\t INDEX idx_gl_journal_lines_accnr (accnr),\n\t INDEX idx_gl_journal_lines_header (header_id),\n\t CONSTRAINT fk_gl_journal_lines_header FOREIGN KEY (header_id) REFERENCES \`${schema}\`.gl_journal_headers(id) ON DELETE CASCADE,\n\t CONSTRAINT fk_gl_journal_lines_accnr FOREIGN KEY (accnr) REFERENCES \`${schema}\`.gl_accounts(accnr),\n\t CONSTRAINT fk_gl_journal_lines_tax FOREIGN KEY (tax_code_id) REFERENCES \`${schema}\`.tax_codes(id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
		await query(`CREATE TABLE IF NOT EXISTS \`${schema}\`.gl_control_accounts (\n\t id INT AUTO_INCREMENT PRIMARY KEY,\n\t control_key VARCHAR(64) NOT NULL,\n\t transaction_type ENUM('GENERIC','PARTS','LABOUR','SUBLET','VEHICLE') NOT NULL DEFAULT 'GENERIC',\n\t accnr INT NOT NULL,\n\t active TINYINT(1) NOT NULL DEFAULT 1,\n\t created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n\t updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,\n\t UNIQUE KEY uk_gl_control_accounts_key (control_key, transaction_type),\n\t INDEX idx_gl_control_accounts_accnr (accnr),\n\t CONSTRAINT fk_gl_control_accounts_accnr FOREIGN KEY (accnr) REFERENCES \`${schema}\`.gl_accounts(accnr)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

		// Legacy schema compatibility: normalize PK + AUTO_INCREMENT on known id columns.
		await ensureAutoIncrementPrimaryKey(schema, 'gl_account_types', 'id', 'INT');
		await ensureAutoIncrementPrimaryKey(schema, 'gl_accounts', 'id', 'INT');
		await ensureAutoIncrementPrimaryKey(schema, 'gl_periods', 'id', 'INT');
		await ensureAutoIncrementPrimaryKey(schema, 'gl_journal_headers', 'id', 'BIGINT');
		await ensureAutoIncrementPrimaryKey(schema, 'tax_codes', 'id', 'INT');
		await ensureAutoIncrementPrimaryKey(schema, 'gl_journal_lines', 'id', 'BIGINT');
		await ensureAutoIncrementPrimaryKey(schema, 'gl_control_accounts', 'id', 'INT');
	}

	// Seeds
	await upsertGlAccountTypes(schema);

	const ctrlAccounts = [
		{ accnr: 1000, name: 'Sales', type: 'INCOME', category: 'Revenue', group: 'Revenue' },
		{ accnr: 2000, name: 'Operating Expenses', type: 'EXPENSE', category: 'Operating Expense', group: 'Operating Expenses' },
		{ accnr: 3000, name: 'Bank', type: 'ASSET', category: 'Current Asset', group: 'Cash and Cash Equivalents' },
		{ accnr: 3100, name: 'Accounts Receivable', type: 'ASSET', category: 'Current Asset', group: 'Trade Receivables' },
		{ accnr: 3200, name: 'Inventory', type: 'ASSET', category: 'Current Asset', group: 'Inventory' },
		{ accnr: 3300, name: 'VAT Input', type: 'ASSET', category: 'Current Asset', group: 'Tax Assets' },
		{ accnr: 4000, name: 'Retained Earnings', type: 'EQUITY', category: 'Equity', group: 'Retained Earnings' },
		{ accnr: 5000, name: 'Accounts Payable', type: 'LIABILITY', category: 'Current Liability', group: 'Trade Payables' },
		{ accnr: 5100, name: 'VAT Output', type: 'LIABILITY', category: 'Current Liability', group: 'Tax Liabilities' },
		{ accnr: 6000, name: 'Cost of Sales', type: 'COS', fallbackType: 'EXPENSE', category: 'Cost of Sales', group: 'Cost of Sales' },
		{ accnr: 2001, name: 'Bad Debts', type: 'EXPENSE', category: 'Operating Expense', group: 'Operating Expenses' },
		{ accnr: 2350, name: 'Discounts Allowed', type: 'EXPENSE', category: 'Operating Expense', group: 'Operating Expenses' },
		{ accnr: 5200, name: 'Customer Deposits', type: 'LIABILITY', category: 'Current Liability', group: 'Customer Deposits' }
	];
	for (const baseAcc of ctrlAccounts) {
		const rangeType = typeByAccountRange(baseAcc.accnr);
		const acc = {
			...baseAcc,
			type: rangeType.type || baseAcc.type,
			fallbackType: rangeType.fallbackType || baseAcc.fallbackType
		};
		const rowsType = await query(
			`SELECT id FROM \`${schema}\`.gl_account_types WHERE code IN (?, ?) ORDER BY CASE code WHEN ? THEN 0 ELSE 1 END LIMIT 1`,
			[acc.type, acc.fallbackType || acc.type, acc.type]
		);
		const typeRow = Array.isArray(rowsType) && rowsType.length ? rowsType[0] : null;
		if (!typeRow || !typeRow.id) continue;
		await query(
			`INSERT INTO \`${schema}\`.gl_accounts (accnr, name, type_id, category, statement_group, active) VALUES (?,?,?,?,?,1)\n			 ON DUPLICATE KEY UPDATE accnr = accnr`,
			[acc.accnr, acc.name, typeRow.id, acc.category, acc.group]
		);
	}

	await seedDefaultControlMappings(schema);

	await query(`INSERT INTO \`${schema}\`.tax_codes (code, description, rate, input_output) VALUES\n		('STD15','Standard VAT 15%',15.00,'OUTPUT'),\n		('ZERO','Zero Rated',0.00,'NONE'),\n		('EXEMPT','Exempt/No VAT',0.00,'NONE')\n	ON DUPLICATE KEY UPDATE description=VALUES(description), rate=VALUES(rate), input_output=VALUES(input_output)`);

	// ─── Stock GL mapping columns (013_stock_gl_mapping) ───
	// Add per-stock-item GL account mapping columns if not present.
	// These are nullable: NULL = use system default control account.
	if (allowDdl) {
		try {
			const stockGlCols = await query(
				`SELECT COLUMN_NAME
				 FROM INFORMATION_SCHEMA.COLUMNS
				 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'stock'
				   AND COLUMN_NAME IN ('gl_asset_accnr', 'gl_revenue_accnr', 'gl_cos_accnr')`,
				[schema]
			);
			const existingStockGlCols = new Set((stockGlCols || []).map(c => (c.COLUMN_NAME || c.column_name)));
			if (!existingStockGlCols.has('gl_asset_accnr')) {
				await query(`ALTER TABLE \`${schema}\`.stock ADD COLUMN gl_asset_accnr INT NULL DEFAULT NULL COMMENT 'GL Inventory (Asset) account override. NULL = use system default.'`);
			}
			if (!existingStockGlCols.has('gl_revenue_accnr')) {
				await query(`ALTER TABLE \`${schema}\`.stock ADD COLUMN gl_revenue_accnr INT NULL DEFAULT NULL COMMENT 'GL Revenue (Income) account override. NULL = use system default.'`);
			}
			if (!existingStockGlCols.has('gl_cos_accnr')) {
				await query(`ALTER TABLE \`${schema}\`.stock ADD COLUMN gl_cos_accnr INT NULL DEFAULT NULL COMMENT 'GL Cost of Sales account override. NULL = use system default.'`);
			}
		} catch (stockGlErr) {
			// stock table may not exist for some tenants yet — non-fatal
			logger.warn('ensureGlSchemaSeed: stock GL columns skipped', { schema, message: stockGlErr && stockGlErr.message });
		}
	}

	// ─── Validate default control accounts are configured ───
	// INVENTORY, SALES, and COS defaults are REQUIRED for stock GL posting.
	// This runs at bootstrap to catch misconfiguration early.
	if (validateDefaults) {
		try {
			await resolveControlAccounts(schema, ['INVENTORY', 'SALES', 'COS']);
		} catch (ctrlErr) {
			logger.error('CRITICAL: Default stock control accounts not configured', {
				schema,
				message: ctrlErr && ctrlErr.message,
				hint: 'Ensure INVENTORY, SALES, and COS mappings exist in gl_control_accounts'
			});
			// Do not throw — allow the system to boot. Posting will fail with a
			// descriptive error at transaction time if controls are missing.
		}
	}
}

module.exports = {
	CONTROL_ACCOUNTS,
	clearControlAccountCache,
	normalizeControlTransactionType,
	resolveControlAccounts,
	postJournal,
	postReversalJournal,
	deleteGlJournalBySource,
	assertBankReconAllowsPosting,
	assertPostedJournalNotInClosedBankRecon,
	getJournalBySource,
	getOpenPeriodId,
	getPeriodForDate,
	ensureDefaultPeriods,
	validateLines,
	ensureGlSchemaSeed
};
