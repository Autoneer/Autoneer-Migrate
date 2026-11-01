// Stock quantities are not written by the table import.
//
// The legacy quantity comes in afterwards as the opening stock take
// (gl/glBackfill/openingStock.js), which is what gives that stock its value in
// the GL. A quantity written here would be stock the GL never recognises, and
// would leave the opening stock take nothing to count. So the import inserts
// every stock item with quantity 0, and an update never changes the quantity of
// a stock item that already exists.

const STOCK_TABLE = "stock";
const QUANTITY_COLUMN = "quantity";

function holdsBackQuantity(tableName) {
	return String(tableName || "").toLowerCase() === STOCK_TABLE;
}

function isQuantityColumn(column) {
	return String(column || "").toLowerCase() === QUANTITY_COLUMN;
}

/** Sets the mapped quantity to 0. Returns true when a quantity other than 0 was held back. */
function holdBackQuantity(mappedRow) {
	let held = false;
	for (const key of Object.keys(mappedRow || {})) {
		if (!isQuantityColumn(key)) continue;
		if (Number(mappedRow[key]) !== 0 && mappedRow[key] != null) held = true;
		mappedRow[key] = 0;
	}
	return held;
}

/** The columns an update may write; for stock, never the quantity. */
function updatableColumns(tableName, columns) {
	return holdsBackQuantity(tableName) ? columns.filter((column) => !isQuantityColumn(column)) : columns;
}

function openingStockPendingWarning(count) {
	return {
		code: "OPENING_STOCK_PENDING",
		table: STOCK_TABLE,
		count,
		message: `${count} stock item(s) were imported with quantity 0. Post their legacy quantities with Opening Stock on the GL Backfill page, after the backfill.`
	};
}

module.exports = {
	holdsBackQuantity,
	holdBackQuantity,
	updatableColumns,
	openingStockPendingWarning
};
