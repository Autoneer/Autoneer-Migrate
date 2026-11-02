"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPreviewSql, inspectJournal } = require("../scripts/preview_general_invoice_gl");

test("preview permits only scratch seed/run-log writes and rejects journals, DDL and tenant writes", () => {
	const schema = "glbf_test_preview";
	for (const sql of ["SELECT * FROM gl_accounts", "INSERT INTO glbf_test_preview.gl_backfill_runs (id) VALUES (1)", "UPDATE `glbf_test_preview`.`gl_backfill_runs` SET status='DONE'"]) assert.doesNotThrow(() => assertPreviewSql(sql, schema));
	for (const sql of ["CREATE TABLE t(id INT)", "COMMIT", "DELETE FROM glbf_test_preview.gl_journal_headers", "INSERT INTO glbf_test_preview.gl_journal_headers (id) VALUES (1)", "UPDATE dm_service_centre.gl_backfill_runs SET status='DONE'", "UPDATE glbf_test_preview.stock SET quantity=0"]) assert.throws(() => assertPreviewSql(sql, schema));
	assert.throws(() => assertPreviewSql("SELECT 1", "dm_service_centre"));
});

test("preview permits the approved 6300/3400 sublet split without including it in Inventory", () => {
	const invoice = { invoice_nr: 1, inv_totalinclvat: "115.00", inv_totalvat: "15.00", parts_cost: "50.00", sublet_cost: "10.00" };
	const lines = [[3100,115,0],[5100,0,15],[1000,0,100],[6050,40,0],[3200,0,40],[6300,10,0],[3400,0,10]].map(([accnr,debit,credit]) => ({ accnr,debit,credit,job_number:0,invoice_nr:1 }));
	assert.deepEqual(inspectJournal(invoice, lines), []);
	lines[5].accnr=6050; lines[6].accnr=3200;
	assert.equal(inspectJournal(invoice, lines).length,4);
});

test("journal review catches omitted return cost even when the journal balances", () => {
	const invoice = { invoice_nr: 1, inv_totalinclvat: "115.00", inv_totalvat: "15.00", parts_cost: "50.00" };
	const lines = [[3100,115,0],[5100,0,15],[1000,0,100],[6050,60,0],[3200,0,60]].map(([accnr,debit,credit]) => ({ accnr,debit,credit,job_number:0,invoice_nr:1 }));
	assert.equal(inspectJournal(invoice, lines).length, 2);
	lines.push({ accnr:6050,debit:0,credit:10,job_number:0,invoice_nr:1 }, { accnr:3200,debit:10,credit:0,job_number:0,invoice_nr:1 });
	assert.deepEqual(inspectJournal(invoice, lines), []);
	lines.push({ accnr:3250,debit:1,credit:1,job_number:0,invoice_nr:1 });
	assert.ok(inspectJournal(invoice, lines).includes("Contains WIP 3250"));
});
