const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const controls = require("../src/migrate/gl/glBackfill/controlAccounts");
const { extractDeclaration } = require("../src/migrate/gl/glBackfill/mirrorSync");

// An in-memory chart answering the queries controlAccounts.js makes.
// It starts as dm_service_centre did after Rebuild GL Accounts.
function fakeTenant() {
	const types = { ASSET: 3, EXPENSE: 2, LIABILITY: 5, COS: 6, INCOME: 1, EQUITY: 4 };
	const accounts = [
		{ accnr: 1000, name: "Sales", type: "INCOME", active: 1 },
		{ accnr: 2001, name: "Bad Debts", type: "EXPENSE", active: 1 },
		{ accnr: 2100, name: "Salaries and Wages", type: "EXPENSE", active: 1 },
		{ accnr: 2350, name: "Discounts Allowed", type: "EXPENSE", active: 1 },
		{ accnr: 2800, name: "Old Expense", type: "EXPENSE", active: 0 },
		{ accnr: 3000, name: "Bank", type: "ASSET", active: 1 },
		{ accnr: 3100, name: "Accounts Receivable", type: "ASSET", active: 1 },
		{ accnr: 3200, name: "Inventory", type: "ASSET", active: 1 },
		{ accnr: 3250, name: "Vehicle Stock", type: "ASSET", active: 1 },
		{ accnr: 3300, name: "WORK IN PROGRESS", type: "ASSET", active: 1 },
		{ accnr: 5000, name: "Accounts Payable", type: "LIABILITY", active: 1 },
		{ accnr: 5100, name: "VAT Output", type: "LIABILITY", active: 1 },
		{ accnr: 5200, name: "Customer Deposits", type: "LIABILITY", active: 1 },
		{ accnr: 6000, name: "Cost of Sales", type: "COS", active: 1 }
	];
	const mappings = { AR: 3100, SALES: 1000, VAT_OUTPUT: 5100, BANK: 3000, AP: 5000, VAT_INPUT: 3300, INVENTORY: 3200, COS: 6000, WIP: 3251, BAD_DEBTS: 2001, DISCOUNT: 2800, CUSTOMER_DEPOSITS: 5200 };
	const tenant = { accounts, mappings, writes: [] };
	tenant.query = async (sql, params = []) => {
		if (/FROM `t`\.gl_control_accounts c/.test(sql)) {
			return Object.entries(mappings).map(([key, accnr]) => {
				const a = accounts.find((row) => row.accnr === accnr);
				return { control_key: key, accnr, account_accnr: a ? a.accnr : null, name: a?.name, active: a?.active, type: a?.type };
			});
		}
		if (/SELECT a\.accnr, a\.name, a\.active, UPPER\(t\.code\) AS type/.test(sql)) return accounts.map((a) => ({ ...a }));
		if (/SELECT id FROM `t`\.gl_account_types/.test(sql)) return types[params[0]] ? [{ id: types[params[0]] }] : [];
		if (/SELECT accnr FROM `t`\.gl_accounts WHERE accnr = \?/.test(sql)) return accounts.filter((a) => a.accnr === params[0]);
		if (/^INSERT INTO `t`\.gl_accounts/.test(sql)) {
			const [accnr, name, typeId, category, group] = params;
			if (accounts.some((a) => a.accnr === accnr)) throw new Error("ER_DUP_ENTRY");
			const type = Object.keys(types).find((code) => types[code] === typeId);
			accounts.push({ accnr, name, type, active: 1 });
			tenant.writes.push(["account", accnr, name, type, category, group]);
			return { affectedRows: 1 };
		}
		if (/^UPDATE `t`\.gl_accounts SET active = 1/.test(sql)) {
			accounts.find((a) => a.accnr === params[0]).active = 1;
			tenant.writes.push(["reactivate", params[0]]);
			return { affectedRows: 1 };
		}
		if (/^INSERT INTO `t`\.gl_control_accounts/.test(sql)) {
			mappings[params[0]] = params[1];
			tenant.writes.push(["map", params[0], params[1]]);
			return { affectedRows: 1 };
		}
		throw new Error(`Unexpected SQL: ${sql}`);
	};
	return tenant;
}

const byKey = (rows) => Object.fromEntries(rows.map((row) => [row.key, row]));

test("the VAT Input name check is the mirrored PWA rule", () => {
	const mirror = fs.readFileSync(path.join(__dirname, "../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill.js"), "utf8").replace(/\r\n/g, "\n");
	const ours = fs.readFileSync(path.join(__dirname, "../src/migrate/gl/glBackfill/controlAccounts.js"), "utf8").replace(/\r\n/g, "\n");
	assert.equal(extractDeclaration(ours, "scoreForVatInput"), extractDeclaration(mirror, "scoreForVatInput"));
});

test("control statuses follow the PWA rules", async () => {
	const tenant = fakeTenant();
	tenant.mappings.LABOUR_COST_OFFSET = 1000;
	const rows = byKey(await controls.readControls(tenant.query, "t"));
	assert.equal(rows.AR.status, "mapped");
	assert.equal(rows.AR.name, "Accounts Receivable");
	assert.deepEqual([rows.WIP.status, rows.WIP.severity], ["missing", "warning"]);
	assert.match(rows.WIP.reason, /^Account 3251 does not exist: the backfill picks/);
	assert.equal(rows.DISCOUNT.status, "invalid");
	assert.match(rows.DISCOUNT.reason, /Account 2800 is inactive/);
	assert.equal(rows.VAT_INPUT.reason, 'Account 3300 "WORK IN PROGRESS" is not named as VAT Input: the backfill uses or creates a VAT Input account');
	assert.deepEqual([rows.LABOUR_COST_OFFSET.status, rows.LABOUR_COST_OFFSET.severity], ["invalid", "blocked"]);
	assert.match(rows.LABOUR_COST_OFFSET.reason, /is Income; it must be Asset, Liability or Expense: customer invoices with labour cost fail/);
	assert.deepEqual([rows.REBUILD_COST_RECOVERY.status, rows.REBUILD_COST_RECOVERY.reason], ["unmapped", "Not mapped: stocked rebuilds fail"]);

	tenant.mappings.WIP = 3200;
	assert.match(byKey(await controls.readControls(tenant.query, "t")).WIP.reason, /is the Inventory account/);
});

test("a missing WIP account is recreated at its own number, like migration 269 made it", async () => {
	const tenant = fakeTenant();
	const options = await controls.readFixOptions(tenant.query, "t", "WIP");
	assert.deepEqual(options.recreate, { accnr: 3251, name: "Work In Progress", type: "ASSET" });
	assert.ok(!options.candidates.some((a) => a.accnr === 3200), "never the Inventory account");
	assert.deepEqual(options.newAccounts.ASSET, { accnr: 3251, name: "Work In Progress" }, "the first free number in 3250-3299");

	const applied = await controls.applyFix(tenant.query, "t", "WIP", { action: "recreate", accnr: 3251 });
	assert.deepEqual(applied, ["Added account 3251 Work In Progress (Asset)"]);
	assert.deepEqual(tenant.writes, [["account", 3251, "Work In Progress", "ASSET", "Current Asset", "Inventory"]]);
	assert.equal(byKey(await controls.readControls(tenant.query, "t")).WIP.status, "mapped");
	await assert.rejects(() => controls.applyFix(tenant.query, "t", "WIP", { action: "recreate", accnr: 3251 }), { code: "fix_changed" });
});

test("controls the tenant must choose offer only eligible accounts and never preselect one", async () => {
	const tenant = fakeTenant();
	const options = await controls.readFixOptions(tenant.query, "t", "LABOUR_COST_OFFSET");
	assert.equal(options.explicit, true);
	assert.equal(options.recreate, null);
	assert.deepEqual(options.types, ["ASSET", "LIABILITY", "EXPENSE"]);
	assert.ok(options.candidates.every((a) => ["ASSET", "LIABILITY", "EXPENSE"].includes(a.type) && a.active === 1));
	assert.ok(!options.candidates.some((a) => a.accnr === 1000 || a.accnr === 6000));

	assert.deepEqual(await controls.applyFix(tenant.query, "t", "LABOUR_COST_OFFSET", { action: "map", accnr: 2100 }),
		["Mapped Labour Cost Offset to 2100"]);
	await assert.rejects(() => controls.applyFix(tenant.query, "t", "REBUILD_COST_RECOVERY", { action: "map", accnr: 3000 }), { code: "invalid_account" });
});

test("a new account is checked before anything is written", async () => {
	const tenant = fakeTenant();
	const create = (key, choice) => controls.applyFix(tenant.query, "t", key, { action: "create", ...choice });
	await assert.rejects(() => create("REBUILD_COST_RECOVERY", { type: "ASSET", accnr: 3900, name: "X" }), { code: "invalid_type" });
	await assert.rejects(() => create("REBUILD_COST_RECOVERY", { type: "EXPENSE", accnr: 3900, name: "X" }), { code: "invalid_accnr" });
	await assert.rejects(() => create("REBUILD_COST_RECOVERY", { type: "EXPENSE", accnr: 2100, name: "X" }), { code: "accnr_taken" });
	await assert.rejects(() => create("REBUILD_COST_RECOVERY", { type: "EXPENSE", accnr: 2900, name: "  " }), { code: "invalid_name" });
	await assert.rejects(() => create("VAT_INPUT", { type: "ASSET", accnr: 3350, name: "Prepaid Expenses" }), { code: "invalid_name" });
	assert.deepEqual(tenant.writes, []);

	assert.deepEqual(await create("REBUILD_COST_RECOVERY", { type: "COS", accnr: 6900, name: "Rebuild Cost Recovery" }),
		["Added account 6900 Rebuild Cost Recovery (Cost of Sales)", "Mapped Rebuild Cost Recovery to 6900"]);
	assert.deepEqual(await create("VAT_INPUT", { type: "ASSET", accnr: 3350, name: "VAT Input" }),
		["Added account 3350 VAT Input (Asset)", "Mapped VAT Input to 3350 instead of 3300"]);
	assert.deepEqual(tenant.writes.map((w) => w.slice(0, 3)), [["account", 6900, "Rebuild Cost Recovery"], ["map", "REBUILD_COST_RECOVERY", 6900], ["account", 3350, "VAT Input"], ["map", "VAT_INPUT", 3350]]);
});

test("an inactive account is reactivated rather than replaced", async () => {
	const tenant = fakeTenant();
	const options = await controls.readFixOptions(tenant.query, "t", "DISCOUNT");
	assert.deepEqual(options.reactivate, { accnr: 2800, name: "Old Expense", type: "EXPENSE" });
	assert.deepEqual(await controls.applyFix(tenant.query, "t", "DISCOUNT", { action: "reactivate", accnr: 2800 }), ["Reactivated account 2800 Old Expense"]);
	await assert.rejects(() => controls.readFixOptions(tenant.query, "t", "NOT_A_CONTROL"), { code: "unknown_control" });
});
