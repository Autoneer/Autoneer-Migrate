"use strict";

// What the migration opening stock take counts, and the journal that brings
// that stock into the GL. openingStock.js reads the tenant and posts; this file
// only decides, so the rules can be tested without a database.
//
// The import writes every stock item with quantity 0 (stockQuantityHoldback.js).
// The legacy quantity then arrives as an AUTONEER-PWA opening stock take
// (routes/stock-takes.js, source type OPENING_STOCK_IMPORT): a variance from 0
// to the counted quantity, valued at the ex-VAT cost the Inventory
// reconciliation uses (lib/finance/reconciliation.js), posted Dr Inventory and
// Cr the Opening Stock control.

const OPENING_STOCK_SOURCE_TYPE = "OPENING_STOCK_IMPORT";
// Every PWA stock take posts under this source, keyed ST-<takeid>; the PWA's
// rollback deletes the journal by the same key.
const JOURNAL_SOURCE = "STOCK_TAKE";
// stock_takes.import_filename prefix that marks the session Migrate posted.
const IMPORT_FILENAME_PREFIX = "Autoneer-Migrate: ";
// Legacy service items are kept "in stock" with quantities such as 999 or
// 9 999 999 so a job never orders them. From this quantity up an item is
// proposed as a placeholder and set to zero.
const DEFAULT_PLACEHOLDER_MIN_QTY = 900;
const WORKSHOP_ASSET_TYPES = new Set(["ASSET", "TOOL"]);

const REF2 = Object.freeze({ OPEN_JOB: "OPEN JOB STOCK", CLEARING: "BACKFILL CLEARING" });

function round2(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

function idSet(values) {
	return new Set((Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0));
}

function readPlanOptions(input = {}) {
	const minQty = Number(input.placeholderMinQty);
	return {
		placeholderMinQty: Number.isFinite(minQty) && minQty > 0 ? minQty : DEFAULT_PLACEHOLDER_MIN_QTY,
		keepStockIds: idSet(input.keepStockIds),
		zeroStockIds: idSet(input.zeroStockIds)
	};
}

/**
 * Sorts every target stock item into what the opening stock take does with it.
 *
 * item: { stock_id, partnr, description, stocktype, binnr, tracking_mode,
 *         cost_price_exvat, quantity (target now), has_movements, legacy_quantity }
 *
 * Only items with no quantity and no stock movement in the tenant are counted,
 * so live stock and stock imported before quantities were held back are never
 * overwritten.
 */
function classifyItems(items, options) {
	const { placeholderMinQty, keepStockIds, zeroStockIds } = options;
	const result = { counted: [], placeholders: [], negatives: [], zeroCost: [], negativeCost: [], alreadyStocked: [], workshopAssets: [], rebuildListed: [] };
	for (const item of items) {
		const legacy = Number(item.legacy_quantity) || 0;
		if (legacy === 0) continue;
		const cost = Number(item.cost_price_exvat) || 0;
		const row = { ...item, legacy_quantity: legacy, cost_price_exvat: cost, legacy_value: round2(legacy * cost) };
		if (WORKSHOP_ASSET_TYPES.has(String(item.stocktype || "").trim().toUpperCase())) {
			result.workshopAssets.push(row);
		} else if (String(item.tracking_mode || "NORMAL").toUpperCase() === "REBUILD_LISTED") {
			result.rebuildListed.push(row);
		} else if (Number(item.quantity) !== 0 || item.has_movements) {
			result.alreadyStocked.push(row);
		} else if (legacy < 0) {
			result.negatives.push(row);
		} else if (zeroStockIds.has(Number(item.stock_id)) || (legacy >= placeholderMinQty && !keepStockIds.has(Number(item.stock_id)))) {
			result.placeholders.push({ ...row, candidate: legacy >= placeholderMinQty });
		} else {
			const counted = { ...row, quantity: legacy, value: row.legacy_value, candidate: legacy >= placeholderMinQty };
			result.counted.push(counted);
			if (cost === 0) result.zeroCost.push(counted);
			if (cost < 0) result.negativeCost.push(counted);
		}
	}
	const byValue = (a, b) => Math.abs(b.legacy_value) - Math.abs(a.legacy_value) || a.stock_id - b.stock_id;
	for (const list of [result.counted, result.placeholders, result.negatives, result.negativeCost, result.alreadyStocked, result.workshopAssets, result.rebuildListed]) {
		list.sort(byValue);
	}
	result.zeroCost.sort((a, b) => b.quantity - a.quantity || a.stock_id - b.stock_id);
	return result;
}

/** stock_take rows for the counted items, as a finalised PWA opening import holds them. */
function buildTakeLines(counted, takedate) {
	return counted.map((item) => ({
		stock_id: item.stock_id,
		partnr: item.partnr || "",
		description: item.description || "",
		quantity: 0,
		stocktype: item.stocktype || "",
		cost_price: round2(item.cost_price_exvat),
		newquantity: item.quantity,
		takedate,
		status: "FINALISED",
		diffquantity: item.quantity,
		binnr: item.binnr || "",
		costoverunder: item.value
	}));
}

/**
 * The single STOCK_TAKE journal, balanced against the Opening Stock control:
 *   - per counted item, Dr Inventory / Cr Opening Stock, as PWA finalise posts it.
 *     An item with a negative cost is credited, because the Inventory
 *     reconciliation values it at quantity × that cost;
 *   - per job, the stock already issued to open jobs that finalising them will
 *     relieve from its asset account (legacy took it out of stock already);
 *   - the Inventory balance the backfill left at cut-over, reversed, so the
 *     account holds exactly the stock just counted plus that open-job stock.
 *
 * openJobLines: [{ job_number, accnr, amount }]; inventoryBalance: Inventory at cut-over before this journal.
 */
function buildJournalLines({ takeLines, openJobLines = [], inventoryBalance = 0, inventoryAccnr, openingAccnr, takedate }) {
	const ref1 = `ST-${takedate}`;
	const lines = [];
	for (const line of takeLines) {
		const amount = round2(line.costoverunder);
		if (amount > 0) {
			lines.push({ accnr: inventoryAccnr, debit: amount, credit: 0, ref1, ref2: line.partnr });
			lines.push({ accnr: openingAccnr, debit: 0, credit: amount, ref1, ref2: line.partnr });
		} else if (amount < 0) {
			lines.push({ accnr: openingAccnr, debit: -amount, credit: 0, ref1, ref2: line.partnr });
			lines.push({ accnr: inventoryAccnr, debit: 0, credit: -amount, ref1, ref2: line.partnr });
		}
	}
	for (const open of openJobLines) {
		const amount = round2(open.amount);
		if (amount <= 0) continue;
		lines.push({ accnr: open.accnr, debit: amount, credit: 0, ref1, ref2: REF2.OPEN_JOB, job_number: open.job_number });
		lines.push({ accnr: openingAccnr, debit: 0, credit: amount, ref1, ref2: REF2.OPEN_JOB, job_number: open.job_number });
	}
	const clearing = round2(-inventoryBalance);
	if (Math.abs(clearing) > 0.009) {
		lines.push({ accnr: inventoryAccnr, debit: Math.max(clearing, 0), credit: Math.max(-clearing, 0), ref1, ref2: REF2.CLEARING });
		lines.push({ accnr: openingAccnr, debit: Math.max(-clearing, 0), credit: Math.max(clearing, 0), ref1, ref2: REF2.CLEARING });
	}
	return lines;
}

function sumLines(lines, accnr) {
	return round2(lines.filter((line) => accnr == null || line.accnr === accnr)
		.reduce((sum, line) => sum + (Number(line.debit) || 0) - (Number(line.credit) || 0), 0));
}

module.exports = {
	OPENING_STOCK_SOURCE_TYPE,
	JOURNAL_SOURCE,
	IMPORT_FILENAME_PREFIX,
	DEFAULT_PLACEHOLDER_MIN_QTY,
	REF2,
	round2,
	readPlanOptions,
	classifyItems,
	buildTakeLines,
	buildJournalLines,
	sumLines
};
