const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const {
	planOpenPartVatLine,
	runOpenPartVatPostImport
} = require("../src/migrate/openPartVatPostImport");

// Load AUTONEER-PWA's rule read-only, with its database and finalise modules
// stubbed so nothing connects or writes.
function loadPwaRule() {
	const checkout = path.resolve(process.env.AUTONEER_PWA_PATH || path.join(__dirname, "..", "..", "autoneer-PWA"));
	const servicePath = path.join(checkout, "src", "services", "finalise", "openJobPartVat.service.js");
	if (!fs.existsSync(servicePath)) return null;
	const stub = (file, exports) => {
		const filename = require.resolve(file);
		const mod = new Module(filename);
		Object.assign(mod, { filename, loaded: true, exports });
		require.cache[filename] = mod;
	};
	stub(path.join(checkout, "src", "database", "database.js"), { runInCompanyTx: null, tenantQuery: null });
	stub(path.join(checkout, "src", "services", "finalise", "finalise.service.js"), { getCompanyVatRate: null });
	return require(servicePath);
}

test("open part VAT plan matches the AUTONEER-PWA rule", { skip: !loadPwaRule() && "AUTONEER-PWA checkout not found" }, () => {
	const pwa = loadPwaRule();
	const rows = [];
	let id = 0;
	for (const partnr of ["BD-FRONT", "GENERIC", "gen-123", "SUNDRY", "SUNDRY-9", " sundry ", "GENERICS", null])
		for (const stock_vat of ["YES", "NO", " yes ", "N", null])
			for (const vat_rate of [null, 0.15, "0.150000", 0, -1, "bad"])
				for (const [sales_price, vat] of [[1477.8, 277.09], [100, 0], [100, 15], ["50.00", "7.50"], [0, 5], [-20, -3], [33.335, null], [19.99, 2.9985]])
					for (const discountamount of [0, 10])
						rows.push({ spares_id: ++id, partnr, stock_vat, vat_rate, sales_price, vat, discountamount });
	for (const companyVatRate of [0.15, 0.16]) {
		for (const row of rows) {
			const expected = pwa.planOpenPartVatLine(row, companyVatRate);
			assert.deepEqual(planOpenPartVatLine(row, companyVatRate), expected, JSON.stringify({ row, companyVatRate }));
		}
	}
	// The worked example from the WIP report.
	assert.deepEqual(planOpenPartVatLine({ spares_id: 1, partnr: "BD", stock_vat: "YES", vat_rate: null, sales_price: 1477.8, vat: 277.09 }, 0.15),
		{ spares_id: 1, vatRate: 0.15, vat: 221.67, salesPriceIncVat: 1699.47 });
});

function fakePool({ taxpercent = 15, nullRate = 0, outside = 0, zeroLines = 0 } = {}) {
	return {
		async query(sql) {
			if (/information_schema\.tables/.test(sql)) return [[{ name: "stock" }, { name: "company_prefferences" }]];
			if (/from company_prefferences/.test(sql)) return [taxpercent == null ? [] : [{ taxpercent }]];
			if (/su\.vat_rate is null/.test(sql)) return [[{ total: nullRate, outside_repair: outside }]];
			if (/where invoice_nr = 0/.test(sql)) return [[{ total: zeroLines }]];
			throw new Error(`unexpected query: ${sql}`);
		},
		async getConnection() {
			throw new Error("repair must not write");
		}
	};
}

test("a missing tenant VAT rate fails the repair instead of guessing 15%", async () => {
	for (const taxpercent of [null, 0]) {
		const result = await runOpenPartVatPostImport({ pool: fakePool({ taxpercent }), importedTables: new Set(["spares_used"]) });
		assert.match(result.error, /company_prefferences has no taxpercent/);
	}
});

test("verification warns about open lines without vat_rate and invoice_nr = 0 lines", async () => {
	const result = await runOpenPartVatPostImport({
		pool: fakePool({ nullRate: 4, outside: 1, zeroLines: 7 }),
		importedTables: new Set(["spares_used", "work_done"]), repair: false
	});
	assert.equal(result.error, null);
	assert.deepEqual(result.warnings.map(w => [w.code, w.table, w.count]), [
		["OPEN_PART_VAT_RATE_NULL", "spares_used", 4],
		["INVOICE_NR_ZERO", "spares_used", 7],
		["INVOICE_NR_ZERO", "work_done", 7]
	]);
	const clean = await runOpenPartVatPostImport({ pool: fakePool(), importedTables: new Set(["stock"]) });
	assert.deepEqual(clean, { error: null, warnings: [] });
});
