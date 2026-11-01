const test = require("node:test");
const assert = require("node:assert/strict");

const { fixActions, readFixOptions, applyFix } = require("../src/migrate/gl/glBackfill/rfcOriginals");

const noReturn = { payments: { count: 0, total: 0 }, returns: [], targetTaken: false, journalLines: 0, renumber: [] };
const invoice = (fields) => ({ sinvid: 1, suppid: 5, invoice_nr: "INV1", amount: 100, paid: 0, payable: 0, rfcamount: 0, ...fields });
const offered = (actions) => actions.map((item) => `${item.action}${item.recommended ? "*" : ""}`);

test("each kind of unpaired invoice is offered the fixes its data supports", () => {
	// dm_service_centre's seven, by kind.
	assert.deepEqual(offered(fixActions({ ...noReturn, invoice: invoice({ amount: 5753.1, paid: 5753.1 }), payments: { count: 3, total: 5753.1 } })),
		["done*"], "paid in full, no return: post it");
	assert.deepEqual(offered(fixActions({ ...noReturn, invoice: invoice({ amount: 3565.23, paid: 3565.23 }), payments: { count: 1, total: 3565.23 },
		returns: [{ sinvid: 2, invoice_nr: "INV1-2-RFC" }] })), ["pair*", "done"], "a renumbered return: pair it");
	assert.deepEqual(offered(fixActions({ ...noReturn, invoice: invoice({ amount: 857.2, rfcamount: -857.2 }) })),
		["void*"], "fully returned and unpaid: void it, never post it");
	assert.deepEqual(offered(fixActions({ ...noReturn, invoice: invoice({ amount: 0 }), payments: { count: 2, total: 0 } })),
		["done", "void*"], "an invoice for nothing: void it");
	// Cases the data cannot decide.
	assert.deepEqual(offered(fixActions({ ...noReturn, invoice: invoice({}) })), ["done", "void"], "unpaid, no return: the user decides");
	assert.deepEqual(offered(fixActions({ ...noReturn, invoice: invoice({ paid: 40, rfcamount: -60 }), payments: { count: 1, total: 40 } })),
		[], "part paid with a return recorded: no automatic fix");
});

test("a return is paired only when it is the only candidate and its new number is free", () => {
	const facts = { ...noReturn, invoice: invoice({ paid: 100 }), payments: { count: 1, total: 100 } };
	const two = [{ sinvid: 2, invoice_nr: "INV1-2-RFC" }, { sinvid: 3, invoice_nr: "INV1-3-RFC" }];
	assert.deepEqual(offered(fixActions({ ...facts, returns: two })), ["done*"]);
	assert.deepEqual(offered(fixActions({ ...facts, returns: two.slice(0, 1), targetTaken: true })), ["done*"]);
	assert.deepEqual(offered(fixActions({ ...facts, returns: two.slice(0, 1), journalLines: 1 })), ["done*"], "a posted return is left alone");
});

test("posting it as normal sets the amount owing to what is still unpaid", () => {
	const [done] = fixActions({ ...noReturn, invoice: invoice({ paid: 30, payable: 0 }), payments: { count: 1, total: 30 } });
	assert.deepEqual(done.changes, [
		"Change its status from RFC-ORIGINAL to DONE",
		"Set the amount owing from 0.00 to 70.00",
		"The backfill then posts 100.00 to the supplier's account"
	]);
});

// A tenant with invoice 213776 and its return numbered 213776-2-RFC.
function tenant({
	invoiceRow = { sinvid: 25132, suppid: 5, invoice_nr: "213776", amount: "3565.23", paid: "3565.23", payable: "0.00", rfcamount: "0.00" },
	payments = { n: 1, total: "3565.23" },
	returns = [{ sinvid: 25136, invoice_nr: "213776-2-RFC" }],
	affected = 1
} = {}) {
	const executed = [];
	const query = async (sql, params = []) => {
		const text = sql.replace(/\s+/g, " ").trim();
		executed.push({ sql: text, params });
		if (/^SELECT o\.sinvid, o\.suppid, o\.invoice_nr, o\.amount/.test(text)) return invoiceRow ? [invoiceRow] : [];
		if (/FROM `t`\.suppliers/.test(text)) return [{ supplier: "DIESEL-ELECTRIC" }];
		if (/FROM `t`\.payments_suppliers WHERE \(invid/.test(text)) return [payments];
		if (/JOIN `t`\.invoices_supplier r ON/.test(text)) return returns;
		if (/^SELECT COUNT\(\*\) AS n FROM `t`\.invoices_supplier WHERE suppid = \?/.test(text)) return [{ n: 0 }];
		if (/information_schema\.columns/.test(text)) {
			return ["invoice_items", "orders", "payments_suppliers", "credit_notes_supplier"].flatMap((t) =>
				[{ t, c: "suppid" }, { t, c: t === "orders" ? "orderinvoice_nr" : "invoice_nr" }]);
		}
		if (/^SELECT COUNT\(\*\) AS n FROM `t`\.`invoice_items`/.test(text)) return [{ n: 2 }];
		if (/^SELECT COUNT\(\*\) AS n FROM `t`\.`/.test(text)) return [{ n: 0 }];
		if (/FROM `t`\.gl_journal_lines/.test(text)) return [{ n: 0 }];
		if (/^UPDATE `t`\.`invoice_items`/.test(text)) return { affectedRows: 2 };
		if (/^UPDATE/.test(text)) return { affectedRows: affected };
		throw new Error(`Unhandled SQL: ${text}`);
	};
	return { query, executed };
}

test("the preview describes invoice 213776 and suggests pairing its return", async () => {
	const { query, executed } = tenant();
	const options = await readFixOptions(query, "t", 25132);
	assert.equal(options.supplier, "DIESEL-ELECTRIC");
	assert.deepEqual(options.unpairedReturns, ["213776-2-RFC"]);
	assert.deepEqual(offered(options.actions), ["pair*", "done"]);
	assert.deepEqual(options.actions[0].changes, ["Renumber return 213776-2-RFC to 213776-RFC", "Renumber its 2 invoice lines", "Then run card 2 to migrate the pair"]);
	assert.ok(executed.every((q) => /^SELECT/.test(q.sql)), "the preview only reads");
	assert.ok(executed.every((q) => !/FOR UPDATE/.test(q.sql)));
});

test("pairing renumbers the return's lines, then the return, scoped by supplier", async () => {
	const { query, executed } = tenant();
	const result = await applyFix(query, "t", 25132, { action: "pair" });
	assert.equal(result.action, "pair");
	assert.match(executed[0].sql, /FOR UPDATE$/, "the invoice is locked first");
	const updates = executed.filter((q) => /^UPDATE/.test(q.sql));
	assert.deepEqual(updates.map((q) => [q.sql, q.params]), [
		["UPDATE `t`.`invoice_items` SET `invoice_nr` = ? WHERE suppid = ? AND `invoice_nr` = ?", ["213776-RFC", 5, "213776-2-RFC"]],
		["UPDATE `t`.invoices_supplier SET invoice_nr = ? WHERE sinvid = ? AND invoice_nr = ?", ["213776-RFC", 25136, "213776-2-RFC"]]
	]);
});

test("posting and voiding change only an invoice still in RFC-ORIGINAL", async () => {
	let { query, executed } = tenant();
	await applyFix(query, "t", 25132, { action: "done" });
	const done = executed.filter((q) => /^UPDATE/.test(q.sql));
	assert.deepEqual(done.map((q) => [q.sql, q.params]), [
		["UPDATE `t`.invoices_supplier SET status = 'DONE', payable = ? WHERE sinvid = ? AND status = 'RFC-ORIGINAL'", [0, 25132]]
	]);

	({ query, executed } = tenant({
		invoiceRow: { sinvid: 30719, suppid: 5, invoice_nr: "391905", amount: "857.20", paid: "0.00", payable: "0.00", rfcamount: "-857.20" },
		payments: { n: 0, total: 0 },
		returns: []
	}));
	await applyFix(query, "t", 30719, { action: "void" });
	const voided = executed.filter((q) => /^UPDATE/.test(q.sql));
	assert.equal(voided.length, 1);
	assert.match(voided[0].sql, /SET status = 'VOID', payable = 0, voided_at = NOW\(\), voided_by = NULL, void_reason = \? WHERE sinvid = \? AND status = 'RFC-ORIGINAL'$/);
	assert.equal(voided[0].params[1], 30719);
});

test("a fix that no longer fits, or a row that changed, is refused", async () => {
	const { query } = tenant();
	await assert.rejects(applyFix(query, "t", 25132, { action: "void" }), /does not fit this invoice any more/, "a paid invoice cannot be voided");
	await assert.rejects(applyFix(tenant({ affected: 0 }).query, "t", 25132, { action: "done" }), /changed while it was being fixed/);
	await assert.rejects(applyFix(tenant({ invoiceRow: null }).query, "t", 25132, { action: "done" }), /no longer an unpaired RFC-ORIGINAL invoice/);
	await assert.rejects(readFixOptions(query, "t", "abc"), /Choose an invoice/);
});
