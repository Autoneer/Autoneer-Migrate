"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { displayLines } = require("../scripts/backfill_general_invoice_lines");

test("general-invoice POS return keeps a negative quantity and positive unit price/cost", () => {
	const [line] = displayLines({ invoice_nr:12329,cid:24,inv_totalexlvat:4175.54,inv_totalvat:626.33 }, [
		{ quantity:-1,sales_price:-4175.54,discountamount:0,vat:-626.33,cost_price:3630.90,partnr:"902062MR09",spare:"TOOL BOX" }
	], []);
	assert.equal(line.qty,-1);
	assert.equal(line.unit_price_exvat,4175.54);
	assert.equal(line.cost_exvat,3630.90);
	assert.equal(line.qty*line.cost_exvat,-3630.90);
	assert.equal(line.total_exvat,-4175.54);
	assert.equal(line.total_incvat,-4801.87);
	assert.equal(line.vat_rate,0.15);
});

test("zero-quantity legacy POS line retains its amount without division by zero", () => {
	const [line] = displayLines({ invoice_nr:1,cid:1,inv_totalexlvat:100,inv_totalvat:15 }, [{ quantity:0,sales_price:100,vat:15,cost_price:0 }], []);
	assert.equal(line.qty,1); assert.equal(line.unit_price_exvat,100); assert.equal(line.total_incvat,115);
});

test("rounded zero is stable when a dry-run report is serialized to JSON", () => {
	const [line] = displayLines({ invoice_nr:1,cid:1,inv_totalexlvat:100,inv_totalvat:15 }, [{ quantity:1,sales_price:-0.001,vat:0,cost_price:0 }], []);
	assert.equal(Object.is(line.total_exvat,-0),false);
	assert.deepEqual(JSON.parse(JSON.stringify(line)),line);
});
