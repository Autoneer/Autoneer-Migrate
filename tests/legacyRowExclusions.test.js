const test = require("node:test");
const assert = require("node:assert/strict");

const { legacyRowExclusion } = require("../src/migrate/legacyRowExclusions");

test("reversed supplier payments are left out by their status", () => {
	const rule = legacyRowExclusion("payments_suppliers", { STATUS: { target: "status" } });
	assert.equal(rule.reasonFor({ status: " reversed " }), "reversed supplier payments");
	assert.equal(rule.matches({ status: " reversed " }), true);
	assert.equal(rule.matches({ status: "DONE" }), false);
	assert.equal(rule.matches({ status: null }), false);
});

test("customer payments are left out by their payment method, each with its reason", () => {
	const rule = legacyRowExclusion("PAYMENTS", { PAYMETHOD: { target: "paymethod" } });
	assert.equal(rule.reasonFor({ paymethod: "REVERSED" }), "reversed customer payments");
	assert.equal(rule.reasonFor({ paymethod: " invoice " }), "released-with-invoice markers");
	assert.equal(rule.reasonFor({ paymethod: "Redo Invoice" }), "redo-invoice markers");
});

test("settlements the invoice's paid amount counts are kept", () => {
	const rule = legacyRowExclusion("payments", { PAYMETHOD: { target: "paymethod" } });
	for (const paymethod of ["CASH", "ELECTRONIC TRANSFER", "CREDIT NOTE", "DISCOUNT", "BAD DEBT", "INTERNAL", "ROUNDING", "WARRANTY", "REFUND", "", null, "constructor"]) {
		assert.equal(rule.reasonFor({ paymethod }), null, String(paymethod));
		assert.equal(rule.matches({ paymethod }), false, String(paymethod));
	}
});

test("the rule reads the source column the mapping names, or the target's own name", () => {
	assert.equal(legacyRowExclusion("payments", { PAY_TYPE: { target: "paymethod" } }).matches({ pay_type: "REVERSED", paymethod: "CASH" }), true);
	assert.equal(legacyRowExclusion("payments", { PAYMETHOD: { target: "paymethod", omit: true } }).matches({ paymethod: "REVERSED" }), true);
	assert.equal(legacyRowExclusion("payments", {}).matches({ paymethod: "REVERSED" }), true);
});

test("other tables keep every row", () => {
	assert.equal(legacyRowExclusion("invoices", {}), null);
	assert.equal(legacyRowExclusion("credit_notes", {}), null);
});
