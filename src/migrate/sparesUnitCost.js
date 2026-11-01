// Legacy job part costs are whole-line amounts; AUTONEER-PWA reads them per unit.
//
// AUTONEER keeps SPARES_USED.COST_PRICE, like SALES_PRICE, as the total for the
// line. AUTONEER-PWA treats spares_used.cost_price as the cost of one unit and
// multiplies it by the quantity (stock rebuilds, job costing, and the GL
// backfill's cost of sales), so 210 L of oil at a drum cost of 5,951.40 became
// 1,249,794. The import therefore stores cost ÷ quantity.
//
// A few legacy lines already hold a unit cost. Their cost × quantity, marked up,
// is the sale price while the cost alone is not, and they are kept as they are.

const TABLE = "spares_used";
// cost_price is DECIMAL(18,6).
const COST_SCALE = 1e6;

function toNumber(value) {
	if (value == null || value === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

// Legacy screens round the markup, so a cost "gives" the sale within 2%, or 1.00 on small lines.
function givesSale(cost, markup, sale) {
	return Math.abs(cost * (1 + markup / 100) - sale) <= Math.max(0.02 * Math.abs(sale), 1);
}

/** Whether a legacy line already holds a unit cost: only cost × quantity, marked up, gives its sale price. */
function isUnitCost(row) {
	const quantity = toNumber(row.quantity);
	const cost = toNumber(row.cost_price);
	const markup = toNumber(row.markup);
	const sale = toNumber(row.sales_price);
	if (!quantity || !cost || markup == null || !sale) return false;
	return !givesSale(cost, markup, sale) && givesSale(cost * quantity, markup, sale);
}

/**
 * The unit cost for a legacy line, or null when its cost stays as it is:
 * quantity 0 or 1, no cost, or a cost that is already per unit.
 */
function unitCost(row) {
	const quantity = toNumber(row.quantity);
	const cost = toNumber(row.cost_price);
	if (!quantity || quantity === 1 || !cost || isUnitCost(row)) return null;
	return Math.round((cost / quantity) * COST_SCALE) / COST_SCALE;
}

function convertsCost(tableName) {
	return String(tableName || "").toLowerCase() === TABLE;
}

/** Import hook: sets the mapped cost_price to the unit cost. Returns true when it changed. */
function toUnitCost(mappedRow) {
	const unit = unitCost(mappedRow || {});
	if (unit == null) return false;
	mappedRow.cost_price = unit;
	return true;
}

const sameCost = (a, b) => Math.abs(Number(a) - Number(b)) < 0.5 / COST_SCALE;

/**
 * For a tenant imported before the import converted costs: what to change.
 * A line is converted only while it still holds the legacy amount, so a second
 * run, or a run after a re-import, finds nothing, and a cost or quantity edited
 * in AUTONEER-PWA since is left alone.
 *
 * targetRows: spares_used { spares_id, job_number, quantity, cost_price }
 * legacyRows: SPARES_USED keyed by SPARES_ID, as { job_number, quantity, cost_price, markup, sales_price }
 */
function planRepair(targetRows, legacyRows) {
	const plan = { convert: [], converted: 0, keptUnitCost: [], edited: [], otherJob: 0, notLegacy: 0, unchanged: 0 };
	for (const row of targetRows) {
		const legacy = legacyRows.get(Number(row.spares_id));
		if (!legacy) {
			plan.notLegacy += 1;
			continue;
		}
		// Ids are preserved; a different job means the id belongs to another line.
		if (Number(legacy.job_number) !== Number(row.job_number)) {
			plan.otherJob += 1;
			continue;
		}
		const unit = unitCost(legacy);
		if (unit == null) {
			if (isUnitCost(legacy)) plan.keptUnitCost.push({ ...pick(row), cost: Number(legacy.cost_price), markup: Number(legacy.markup), sale: Number(legacy.sales_price) });
			else plan.unchanged += 1;
			continue;
		}
		const quantityKept = Number(row.quantity) === Number(legacy.quantity);
		if (quantityKept && sameCost(row.cost_price, legacy.cost_price)) {
			plan.convert.push({ ...pick(row), before: Number(legacy.cost_price), after: unit });
		} else if (quantityKept && sameCost(row.cost_price, unit)) {
			plan.converted += 1;
		} else {
			plan.edited.push({ ...pick(row), legacyQuantity: Number(legacy.quantity), legacyCost: Number(legacy.cost_price), cost: Number(row.cost_price) });
		}
	}
	return plan;
}

function pick(row) {
	return { spares_id: Number(row.spares_id), job_number: Number(row.job_number), invoice_nr: row.invoice_nr == null ? null : Number(row.invoice_nr), quantity: Number(row.quantity) };
}

module.exports = {
	isUnitCost,
	unitCost,
	convertsCost,
	toUnitCost,
	planRepair
};
