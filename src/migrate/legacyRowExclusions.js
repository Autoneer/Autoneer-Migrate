// Legacy rows that never migrate, whatever the plan says. Each one is a row the
// legacy system kept beside the real record, so the new schema has no use for it.
// `values` maps each left-out value to the reason the run summary reports.
const LEFT_OUT = {
	// A voided supplier payment. Legacy keeps the re-captured payment as its own
	// row, and the invoice's paid amount counts only that row.
	payments_suppliers: { target: "status", values: { REVERSED: "reversed supplier payments" } },
	payments: {
		target: "paymethod",
		values: {
			// A voided customer payment. The PWA leaves these out of every balance,
			// statement and journal.
			REVERSED: "reversed customer payments",
			// A job released on account. The money arrives later as its own payment
			// row and the invoice's paid amount counts only that row; the PWA's
			// "Released with Invoice" writes no payment at all.
			INVOICE: "released-with-invoice markers",
			// An invoice redone in legacy. It carries the invoice total, not money,
			// and the invoice's paid amount counts only the real payment beside it.
			"REDO INVOICE": "redo-invoice markers"
		}
	}
};

/**
 * The rule for one target table, or null. `reasonFor(row)` names why a Firebird
 * row (lower-case keys) is left out, or returns null to keep it, reading the
 * column the mapping reads the target column from.
 */
function legacyRowExclusion(tableName, mapping = {}) {
	const rule = LEFT_OUT[String(tableName || "").toLowerCase()];
	if (!rule) return null;
	const mapped = Object.entries(mapping || {})
		.find(([, column]) => column && !column.omit && String(column.target ?? column.targetColumn ?? "").toLowerCase() === rule.target);
	const source = (mapped ? mapped[0] : rule.target).toLowerCase();
	const reasonFor = (row) => {
		const value = String(row?.[source] ?? "").trim().toUpperCase();
		return Object.hasOwn(rule.values, value) ? rule.values[value] : null;
	};
	return { reasonFor, matches: (row) => reasonFor(row) !== null };
}

module.exports = { legacyRowExclusion };
