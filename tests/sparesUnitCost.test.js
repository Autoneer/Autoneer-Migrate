const test = require('node:test');
const assert = require('node:assert/strict');
const { unitCost, isUnitCost, convertsCost, toUnitCost, planRepair } = require('../src/migrate/sparesUnitCost');

// Real dm_service_centre lines.
const drum = { quantity: 210, cost_price: 5951.4, markup: 41.42, sales_price: 8416.42 };
const alreadyUnit = { quantity: 3, cost_price: 41.12, markup: 50, sales_price: 185.04 };
const gearOil = { quantity: 50, cost_price: 1337.5, markup: 100, sales_price: 3113 };
const returned = { quantity: -1, cost_price: -1750, markup: 50, sales_price: -1925 };

test('a whole-line legacy cost becomes the cost of one unit', () => {
	assert.equal(unitCost(drum), 28.34);
	assert.equal(unitCost({ quantity: 3, cost_price: 100 }), 33.333333, 'no markup or sale to judge by: a line total, like nearly every legacy line');
	assert.equal(unitCost(gearOil), 26.75, 'neither reading gives the sale exactly; the line total is far closer');
	assert.equal(unitCost(returned), 1750, 'a return keeps its sign through cost × quantity');
});

test('quantity 0 or 1, no cost, and costs already per unit are left as they are', () => {
	assert.equal(unitCost({ ...drum, quantity: 1 }), null);
	assert.equal(unitCost({ ...drum, quantity: 0 }), null);
	assert.equal(unitCost({ ...drum, cost_price: 0 }), null);
	assert.equal(unitCost({ ...drum, cost_price: null }), null);
	assert.equal(isUnitCost(alreadyUnit), true);
	assert.equal(unitCost(alreadyUnit), null);
	assert.equal(isUnitCost(drum), false);
});

test('the import stores spares_used costs per unit and leaves other tables alone', () => {
	assert.equal(convertsCost('spares_used'), true);
	assert.equal(convertsCost('SPARES_USED'), true);
	assert.equal(convertsCost('stock'), false);
	const row = { ...drum };
	assert.equal(toUnitCost(row), true);
	assert.equal(row.cost_price, 28.34);
	const one = { ...drum, quantity: 1 };
	assert.equal(toUnitCost(one), false);
	assert.equal(one.cost_price, 5951.4);
});

test('the repair converts only lines that still hold their legacy cost, so a second run finds nothing', () => {
	const legacy = new Map([
		[1, { job_number: 7905, ...drum }],
		[2, { job_number: 100, ...alreadyUnit }],
		[3, { job_number: 101, quantity: 1, cost_price: 50, markup: 50, sales_price: 75 }],
		[4, { job_number: 102, quantity: 4, cost_price: 400, markup: 50, sales_price: 600 }],
		[5, { job_number: 103, quantity: 4, cost_price: 400, markup: 50, sales_price: 600 }],
		[6, { job_number: 104, quantity: 2, cost_price: 80, markup: 50, sales_price: 120 }],
		[8, { job_number: 999, quantity: 2, cost_price: 80, markup: 50, sales_price: 120 }]
	]);
	const target = [
		{ spares_id: 1, job_number: 7905, invoice_nr: 9835, quantity: '210.00', cost_price: '5951.400000' },
		{ spares_id: 2, job_number: 100, invoice_nr: 1, quantity: '3.00', cost_price: '41.120000' },
		{ spares_id: 3, job_number: 101, invoice_nr: 2, quantity: '1.00', cost_price: '50.000000' },
		{ spares_id: 4, job_number: 102, invoice_nr: 3, quantity: '4.00', cost_price: '120.000000' }, // cost edited in the PWA
		{ spares_id: 5, job_number: 103, invoice_nr: 4, quantity: '5.00', cost_price: '400.000000' }, // quantity edited
		{ spares_id: 6, job_number: 104, invoice_nr: null, quantity: '2.00', cost_price: '40.000000' }, // converted already
		{ spares_id: 7, job_number: 105, invoice_nr: null, quantity: '2.00', cost_price: '10.000000' }, // added in the PWA
		{ spares_id: 8, job_number: 106, invoice_nr: null, quantity: '2.00', cost_price: '80.000000' } // id reused for another job
	];
	const plan = planRepair(target, legacy);
	assert.deepEqual(plan.convert, [{ spares_id: 1, job_number: 7905, invoice_nr: 9835, quantity: 210, before: 5951.4, after: 28.34 }]);
	assert.equal(plan.converted, 1);
	assert.deepEqual(plan.keptUnitCost.map((l) => l.spares_id), [2]);
	assert.deepEqual(plan.edited.map((l) => l.spares_id), [4, 5]);
	assert.equal(plan.unchanged, 1);
	assert.equal(plan.notLegacy, 1);
	assert.equal(plan.otherJob, 1);

	const afterWrite = target.map((row) => (row.spares_id === 1 ? { ...row, cost_price: '28.340000' } : row));
	const again = planRepair(afterWrite, legacy);
	assert.equal(again.convert.length, 0);
	assert.equal(again.converted, 2);
});
