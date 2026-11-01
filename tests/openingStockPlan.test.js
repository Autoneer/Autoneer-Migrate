const test = require("node:test");
const assert = require("node:assert/strict");

const plan = require("../src/migrate/gl/glBackfill/openingStockPlan");
const holdback = require("../src/migrate/stockQuantityHoldback");

const item = (stock_id, legacy_quantity, extra = {}) => ({
	stock_id, partnr: `P${stock_id}`, description: `Item ${stock_id}`, stocktype: "PARTS", binnr: "", tracking_mode: "NORMAL",
	cost_price_exvat: 10, quantity: 0, has_movements: false, legacy_quantity, ...extra
});

test("legacy quantities are counted, placeholders and negatives become 0, and stocked items are left alone", () => {
	const items = [
		item(1, 5),
		item(2, 9999880, { cost_price_exvat: 99.13 }),
		item(3, -4),
		item(4, 3, { quantity: 3 }),
		item(5, 2, { has_movements: true }),
		item(6, 1, { stocktype: " tool " }),
		item(7, 1, { tracking_mode: "REBUILD_LISTED" }),
		item(8, 0),
		item(9, 7, { cost_price_exvat: 0 }),
		item(10, 950, { cost_price_exvat: 1 }),
		item(11, 93, { cost_price_exvat: 1550 }),
		item(12, 2, { cost_price_exvat: -5 })
	];
	const groups = plan.classifyItems(items, plan.readPlanOptions({ keepStockIds: [10], zeroStockIds: [11] }));
	assert.deepEqual(groups.counted.map((r) => r.stock_id), [10, 1, 12, 9], "largest value first");
	assert.deepEqual(groups.counted.map((r) => r.value), [950, 50, -10, 0]);
	assert.deepEqual(groups.negativeCost.map((r) => r.stock_id), [12]);
	assert.equal(groups.counted[0].candidate, true, "a kept placeholder candidate stays marked");
	assert.deepEqual(groups.placeholders.map((r) => [r.stock_id, r.candidate]), [[2, true], [11, false]]);
	assert.deepEqual(groups.negatives.map((r) => r.stock_id), [3]);
	assert.deepEqual(groups.alreadyStocked.map((r) => r.stock_id), [4, 5]);
	assert.deepEqual(groups.workshopAssets.map((r) => r.stock_id), [6]);
	assert.deepEqual(groups.rebuildListed.map((r) => r.stock_id), [7]);
	assert.deepEqual(groups.zeroCost.map((r) => r.stock_id), [9]);
});

test("the placeholder threshold defaults to 900 and ignores bad input", () => {
	assert.equal(plan.readPlanOptions({}).placeholderMinQty, 900);
	assert.equal(plan.readPlanOptions({ placeholderMinQty: "abc" }).placeholderMinQty, 900);
	assert.equal(plan.readPlanOptions({ placeholderMinQty: 0 }).placeholderMinQty, 900);
	assert.equal(plan.readPlanOptions({ placeholderMinQty: "250" }).placeholderMinQty, 250);
	assert.deepEqual([...plan.readPlanOptions({ keepStockIds: ["4", "x", -1, 2.5] }).keepStockIds], [4]);
});

test("take lines move each counted item from 0 to its legacy quantity at ex-VAT cost", () => {
	const groups = plan.classifyItems([item(1, 3, { cost_price_exvat: 12.3456 })], plan.readPlanOptions());
	assert.deepEqual(plan.buildTakeLines(groups.counted, "2026-10-31"), [{
		stock_id: 1, partnr: "P1", description: "Item 1", quantity: 0, stocktype: "PARTS", cost_price: 12.35,
		newquantity: 3, takedate: "2026-10-31", status: "FINALISED", diffquantity: 3, binnr: "", costoverunder: 37.04
	}]);
});

test("the journal pairs each item, adds open-job stock and reverses the backfill's Inventory balance", () => {
	const takeLines = [{ partnr: "A", costoverunder: 100 }, { partnr: "B", costoverunder: 0 }, { partnr: "C", costoverunder: 25.5 }, { partnr: "D", costoverunder: -10 }];
	const openJobLines = [{ job_number: 41, accnr: 3200, amount: 40 }, { job_number: 41, accnr: 3400, amount: 2 }];
	const lines = plan.buildJournalLines({ takeLines, openJobLines, inventoryBalance: 1000, inventoryAccnr: 3200, openingAccnr: 4900, takedate: "2026-10-31" });
	assert.deepEqual(lines.slice(0, 2), [
		{ accnr: 3200, debit: 100, credit: 0, ref1: "ST-2026-10-31", ref2: "A" },
		{ accnr: 4900, debit: 0, credit: 100, ref1: "ST-2026-10-31", ref2: "A" }
	], "PWA finalise posts Dr Inventory then Cr the counter account per item");
	assert.equal(lines.filter((l) => l.ref2 === "B").length, 0, "an item with no value posts nothing");
	assert.deepEqual(lines.filter((l) => l.ref2 === "D").map((l) => [l.accnr, l.debit, l.credit]), [[4900, 10, 0], [3200, 0, 10]],
		"a negative cost is credited to Inventory, as the reconciliation values it");
	assert.deepEqual(lines.filter((l) => l.ref2 === plan.REF2.OPEN_JOB).map((l) => [l.accnr, l.debit, l.credit, l.job_number]),
		[[3200, 40, 0, 41], [4900, 0, 40, 41], [3400, 2, 0, 41], [4900, 0, 2, 41]]);
	assert.deepEqual(lines.filter((l) => l.ref2 === plan.REF2.CLEARING).map((l) => [l.accnr, l.debit, l.credit]), [[3200, 0, 1000], [4900, 1000, 0]]);
	assert.equal(plan.sumLines(lines), 0, "balanced");
	assert.equal(plan.round2(1000 + plan.sumLines(lines, 3200)), 155.5, "Inventory ends at counted stock plus its open-job stock");

	const negative = plan.buildJournalLines({ takeLines: [], inventoryBalance: -28000.5, inventoryAccnr: 3200, openingAccnr: 4900, takedate: "2026-10-31" });
	assert.deepEqual(negative.map((l) => [l.accnr, l.debit, l.credit]), [[3200, 28000.5, 0], [4900, 0, 28000.5]]);
	assert.deepEqual(plan.buildJournalLines({ takeLines: [], inventoryBalance: 0.004, inventoryAccnr: 3200, openingAccnr: 4900, takedate: "2026-10-31" }), []);
});

test("the stock import holds back the quantity, in either case, and never updates it", () => {
	assert.equal(holdback.holdsBackQuantity("STOCK"), true);
	assert.equal(holdback.holdsBackQuantity("stock_take"), false);
	const row = { STOCK_ID: 1, QUANTITY: "12.5", PARTNR: "A" };
	assert.equal(holdback.holdBackQuantity(row), true);
	assert.deepEqual(row, { STOCK_ID: 1, QUANTITY: 0, PARTNR: "A" });
	assert.equal(holdback.holdBackQuantity({ quantity: 0 }), false);
	assert.equal(holdback.holdBackQuantity({ quantity: null }), false);
	assert.equal(holdback.holdBackQuantity({ partnr: "A" }), false);
	assert.deepEqual(holdback.updatableColumns("stock", ["stock_id", "QUANTITY", "cost_price"]), ["stock_id", "cost_price"]);
	assert.deepEqual(holdback.updatableColumns("spares_used", ["quantity"]), ["quantity"]);
	assert.equal(holdback.openingStockPendingWarning(3).code, "OPENING_STOCK_PENDING");
});
