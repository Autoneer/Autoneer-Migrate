"use strict";

// The GL control accounts the backfill needs: their status, and fixes that are
// previewed and then applied one control at a time.
//
// The rules follow AUTONEER-PWA: the account types each control accepts
// (workshopLabourCost, rebuildStockAccounting, supplierWipControl), the default
// accounts it seeds (postingEngine.ensureGlSchemaSeed, migrations 043 and 269),
// the VAT Input name check (glBackfill.ensureVatInputAccount) and its account
// number ranges (postingEngine.typeByAccountRange). LABOUR_COST_OFFSET,
// REBUILD_COST_RECOVERY and OPENING_STOCK are never chosen for the user: the
// tenant picks those accounts.

const TYPE_RANGES = Object.freeze({
	INCOME: [1000, 1999],
	EXPENSE: [2000, 2999],
	ASSET: [3000, 3999],
	EQUITY: [4000, 4999],
	LIABILITY: [5000, 5999],
	COS: [6000, 6999]
});
const TYPE_LABELS = Object.freeze({ INCOME: "Income", EXPENSE: "Expense", ASSET: "Asset", EQUITY: "Equity", LIABILITY: "Liability", COS: "Cost of Sales" });
// Category and statement group for a new account, as the PWA seeds them.
const TYPE_GROUPS = Object.freeze({
	INCOME: ["Revenue", "Revenue"],
	EXPENSE: ["Operating Expense", "Operating Expenses"],
	ASSET: ["Current Asset", "Current Assets"],
	EQUITY: ["Equity", "Equity"],
	LIABILITY: ["Current Liability", "Current Liabilities"],
	COS: ["Cost of Sales", "Cost of Sales"]
});

const CONTROLS = Object.freeze({
	AR: { label: "Accounts Receivable", types: ["ASSET"], account: { accnr: 3100, name: "Accounts Receivable", group: "Trade Receivables" } },
	SALES: { label: "Sales", types: ["INCOME"], account: { accnr: 1000, name: "Sales", group: "Revenue" } },
	VAT_OUTPUT: { label: "VAT Output", types: ["LIABILITY"], account: { accnr: 5100, name: "VAT Output", group: "Tax Liabilities" } },
	BANK: { label: "Bank", types: ["ASSET"], account: { accnr: 3000, name: "Bank", group: "Cash and Cash Equivalents" } },
	AP: { label: "Accounts Payable", types: ["LIABILITY"], account: { accnr: 5000, name: "Accounts Payable", group: "Trade Payables" } },
	VAT_INPUT: { label: "VAT Input", types: ["ASSET"], account: { accnr: 3300, name: "VAT Input", group: "Tax Assets" }, fallback: "the backfill uses or creates a VAT Input account" },
	INVENTORY: { label: "Inventory", types: ["ASSET"], account: { accnr: 3200, name: "Inventory", group: "Inventory" } },
	COS: { label: "Cost of Sales", types: ["COS"], account: { accnr: 6000, name: "Cost of Sales", group: "Cost of Sales" } },
	WIP: { label: "Work in Progress", types: ["ASSET"], account: { accnr: 3250, last: 3299, name: "Work In Progress", group: "Inventory" } },
	BAD_DEBTS: { label: "Bad Debts", types: ["EXPENSE"], account: { accnr: 2001, name: "Bad Debts", group: "Operating Expenses" } },
	DISCOUNT: { label: "Discounts Allowed", types: ["EXPENSE"], account: { accnr: 2350, name: "Discounts Allowed", group: "Operating Expenses" } },
	CUSTOMER_DEPOSITS: { label: "Customer Deposits", types: ["LIABILITY"], account: { accnr: 5200, name: "Customer Deposits", group: "Customer Deposits" } },
	LABOUR_COST_OFFSET: { label: "Labour Cost Offset", types: ["ASSET", "LIABILITY", "EXPENSE"], explicit: "customer invoices with labour cost fail" },
	REBUILD_COST_RECOVERY: { label: "Rebuild Cost Recovery", types: ["EXPENSE", "COS"], explicit: "stocked rebuilds fail" },
	// The PWA's opening stock import credits this control (routes/stock-takes.js getOpeningStockAccnr).
	OPENING_STOCK: { label: "Opening Stock", types: ["EQUITY"], account: { accnr: 4900, name: "Opening Balances", group: "Equity" }, explicit: "the opening stock take cannot be posted" }
});

// Copied from AUTONEER-PWA glBackfill.js; tests/glBackfillControls.test.js keeps it identical.
function scoreForVatInput(name, typeCode) {
	const n = String(name || '').toUpperCase();
	const t = String(typeCode || '').toUpperCase();
	let score = t === 'ASSET' ? 30 : (t === 'LIABILITY' ? 20 : 0);
	if (n.includes('VAT')) score += 30;
	if (n.includes('INPUT')) score += 50;
	if (n.includes('PURCHASE')) score += 20;
	if (n.includes('SALES') || n.includes('OUTPUT')) score -= 40;
	return score;
}

function httpError(statusCode, code, message) {
	return Object.assign(new Error(message), { statusCode, code });
}

function rangeType(accnr) {
	return Object.keys(TYPE_RANGES).find((type) => accnr >= TYPE_RANGES[type][0] && accnr <= TYPE_RANGES[type][1]) || null;
}

function describeTypes(types) {
	return types.map((type) => TYPE_LABELS[type]).join(", ").replace(/, ([^,]*)$/, " or $1");
}

/**
 * Why an account cannot serve a control, or null when it can.
 * account: { accnr, name, type, active } from gl_accounts joined to gl_account_types.
 */
function accountProblem(key, account, inventoryAccnr) {
	const spec = CONTROLS[key];
	if (Number(account.active) !== 1) return `Account ${account.accnr} is inactive`;
	if (!spec.types.includes(account.type)) {
		return `Account ${account.accnr} is ${TYPE_LABELS[account.type] || "untyped"}; it must be ${describeTypes(spec.types)}`;
	}
	if (key === "WIP" && Number(account.accnr) === inventoryAccnr) return `Account ${account.accnr} is the Inventory account`;
	if (key === "VAT_INPUT" && scoreForVatInput(account.name, account.type) < 50) {
		return `Account ${account.accnr} "${account.name}" is not named as VAT Input`;
	}
	return null;
}

/** Reads every control's mapping, account and status. */
async function readControls(query, schema) {
	const s = `\`${schema}\``;
	const mappings = await query(
		`SELECT c.control_key, c.accnr, a.accnr AS account_accnr, a.name, a.active, t.code AS type
		 FROM ${s}.gl_control_accounts c
		 LEFT JOIN ${s}.gl_accounts a ON a.accnr = c.accnr
		 LEFT JOIN ${s}.gl_account_types t ON t.id = a.type_id
		 WHERE c.active = 1 AND c.transaction_type = 'GENERIC'`
	);
	const byKey = new Map(mappings.map((row) => [String(row.control_key).toUpperCase(), row]));
	const inventory = byKey.get("INVENTORY");
	const inventoryAccnr = inventory ? Number(inventory.accnr) : null;
	return Object.entries(CONTROLS).map(([key, spec]) => {
		const row = byKey.get(key);
		const accnr = row ? Number(row.accnr) : null;
		const account = row && row.account_accnr != null
			? { accnr, name: row.name, type: String(row.type || "").toUpperCase(), active: Number(row.active) }
			: null;
		let status = "mapped";
		let reason = null;
		if (!row) {
			status = "unmapped";
			reason = "Not mapped";
		} else if (!account) {
			status = "missing";
			reason = `Account ${accnr} does not exist`;
		} else {
			reason = accountProblem(key, account, inventoryAccnr);
			if (reason) status = "invalid";
		}
		if (reason) reason += `: ${spec.explicit || spec.fallback || "the backfill picks one if it can"}`;
		return {
			key, label: spec.label, accnr, name: account ? account.name : null, status, reason,
			severity: status === "mapped" ? "ok" : spec.explicit ? "blocked" : "warning"
		};
	});
}

async function readAccounts(query, schema) {
	const rows = await query(
		`SELECT a.accnr, a.name, a.active, UPPER(t.code) AS type
		 FROM \`${schema}\`.gl_accounts a LEFT JOIN \`${schema}\`.gl_account_types t ON t.id = a.type_id
		 ORDER BY a.accnr`
	);
	return rows.map((row) => ({ accnr: Number(row.accnr), name: row.name, type: row.type || "", active: Number(row.active) }));
}

function firstFree(used, from, to) {
	for (let accnr = from; accnr <= to; accnr++) if (!used.has(accnr)) return accnr;
	return null;
}

/** The ways one control can be fixed, for the preview. Reads only. */
async function readFixOptions(query, schema, key) {
	const spec = CONTROLS[key];
	if (!spec) throw httpError(404, "unknown_control", `Unknown control account ${key}.`);
	const controls = await readControls(query, schema);
	const control = controls.find((row) => row.key === key);
	const inventoryAccnr = controls.find((row) => row.key === "INVENTORY").accnr;
	const accounts = await readAccounts(query, schema);
	const used = new Set(accounts.map((account) => account.accnr));

	let recreate = null;
	if (control.status === "missing") {
		const type = rangeType(control.accnr);
		if (type && spec.types.includes(type) && !(key === "WIP" && control.accnr === inventoryAccnr)) {
			const name = spec.account ? spec.account.name : spec.label;
			if (key !== "VAT_INPUT" || scoreForVatInput(name, type) >= 50) recreate = { accnr: control.accnr, name, type };
		}
	}
	const current = accounts.find((account) => account.accnr === control.accnr);
	const reactivate = current && !current.active && !accountProblem(key, { ...current, active: 1 }, inventoryAccnr)
		? { accnr: current.accnr, name: current.name, type: current.type }
		: null;
	const candidates = accounts.filter((account) => account.accnr !== control.accnr && !accountProblem(key, account, inventoryAccnr));

	const newAccounts = {};
	for (const type of spec.types) {
		const [from, to] = TYPE_RANGES[type];
		const preferred = spec.account && rangeType(spec.account.accnr) === type ? spec.account : null;
		newAccounts[type] = {
			accnr: preferred ? firstFree(used, preferred.accnr, preferred.last || to) : firstFree(used, from, to),
			name: preferred ? preferred.name : spec.label
		};
	}
	return {
		key, label: spec.label, explicit: Boolean(spec.explicit), types: spec.types, typeLabels: TYPE_LABELS,
		ranges: TYPE_RANGES, control, recreate, reactivate, candidates, newAccounts
	};
}

async function insertAccount(query, schema, { accnr, name, type, group }) {
	const [typeRow] = await query(`SELECT id FROM \`${schema}\`.gl_account_types WHERE UPPER(code) = ? LIMIT 1`, [type]);
	if (!typeRow) throw httpError(409, "missing_type", `gl_account_types has no ${type} type.`);
	const [category, defaultGroup] = TYPE_GROUPS[type];
	// Plain INSERT: an existing account number fails rather than being repurposed.
	await query(
		`INSERT INTO \`${schema}\`.gl_accounts (accnr, name, type_id, category, statement_group, active) VALUES (?, ?, ?, ?, ?, 1)`,
		[accnr, name, typeRow.id, category, group || defaultGroup]
	);
}

/**
 * Applies one fix inside the caller's transaction, after checking it against
 * the current chart. choice: { action: "recreate" | "reactivate" | "map" | "create", accnr, name, type }.
 * Returns the changes made, in words.
 */
async function applyFix(query, schema, key, choice = {}) {
	const options = await readFixOptions(query, schema, key);
	const spec = CONTROLS[key];
	const s = `\`${schema}\``;
	const accnr = Number(choice.accnr);
	const typeLabel = (type) => TYPE_LABELS[type] || type;
	const applied = [];
	let target;

	if (choice.action === "recreate") {
		if (!options.recreate || options.recreate.accnr !== accnr) throw httpError(409, "fix_changed", "That account can no longer be recreated. Check the tenant again.");
		await insertAccount(query, schema, { ...options.recreate, group: spec.account && spec.account.group });
		applied.push(`Added account ${accnr} ${options.recreate.name} (${typeLabel(options.recreate.type)})`);
		target = accnr;
	} else if (choice.action === "reactivate") {
		if (!options.reactivate || options.reactivate.accnr !== accnr) throw httpError(409, "fix_changed", "That account can no longer be reactivated. Check the tenant again.");
		await query(`UPDATE ${s}.gl_accounts SET active = 1 WHERE accnr = ? AND active = 0`, [accnr]);
		applied.push(`Reactivated account ${accnr} ${options.reactivate.name}`);
		target = accnr;
	} else if (choice.action === "map") {
		const account = options.candidates.find((candidate) => candidate.accnr === accnr);
		if (!account) throw httpError(400, "invalid_account", `Account ${choice.accnr} cannot be used for ${spec.label}.`);
		target = accnr;
	} else if (choice.action === "create") {
		const type = String(choice.type || "").toUpperCase();
		const name = String(choice.name || "").trim();
		if (!spec.types.includes(type)) throw httpError(400, "invalid_type", `${spec.label} must be ${describeTypes(spec.types)}.`);
		const [from, to] = TYPE_RANGES[type];
		if (!Number.isSafeInteger(accnr) || accnr < from || accnr > to) {
			throw httpError(400, "invalid_accnr", `${typeLabel(type)} accounts are numbered ${from} to ${to}.`);
		}
		if (!name || name.length > 150) throw httpError(400, "invalid_name", "Enter an account name of up to 150 characters.");
		if (key === "VAT_INPUT" && scoreForVatInput(name, type) < 50) {
			throw httpError(400, "invalid_name", "Name the account as VAT Input, or the backfill maps another account.");
		}
		const [existing] = await query(`SELECT accnr FROM ${s}.gl_accounts WHERE accnr = ? LIMIT 1`, [accnr]);
		if (existing) throw httpError(409, "accnr_taken", `Account ${accnr} already exists. Map it instead, or choose a free number.`);
		await insertAccount(query, schema, { accnr, name, type, group: spec.account && rangeType(spec.account.accnr) === type ? spec.account.group : null });
		applied.push(`Added account ${accnr} ${name} (${typeLabel(type)})`);
		target = accnr;
	} else {
		throw httpError(400, "invalid_action", "Choose how to fix the control account.");
	}

	if (options.control.accnr !== target || options.control.status === "unmapped") {
		await query(
			`INSERT INTO ${s}.gl_control_accounts (control_key, transaction_type, accnr, active) VALUES (?, 'GENERIC', ?, 1)
			 ON DUPLICATE KEY UPDATE accnr = VALUES(accnr), active = 1`,
			[key, target]
		);
		applied.push(options.control.accnr ? `Mapped ${spec.label} to ${target} instead of ${options.control.accnr}` : `Mapped ${spec.label} to ${target}`);
	}
	return applied;
}

module.exports = {
	CONTROLS,
	TYPE_RANGES,
	scoreForVatInput,
	readControls,
	readFixOptions,
	applyFix
};
