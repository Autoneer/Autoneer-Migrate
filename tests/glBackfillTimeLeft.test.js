const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
	const context = vm.createContext({ window: {}, document: {}, console });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/tools/gl-backfill-common.js'), 'utf8'), context);
	return context.window.GlBackfill;
}

test('the time left follows the rate of the last two minutes, once there are 10 seconds to go on', () => {
	const { timeLeft } = load();
	const start = 1_000_000;
	assert.equal(timeLeft('run:DEBTOR_INVOICE', 0, 1000, start), null, 'one reading has no rate');
	assert.equal(timeLeft('run:DEBTOR_INVOICE', 20, 1000, start + 5000), null, 'five seconds is too little');
	// 80 documents in 20 s: 4 a second, 920 left.
	assert.equal(timeLeft('run:DEBTOR_INVOICE', 80, 1000, start + 20000), 230000);
	// Two minutes on, the first readings have dropped out: 400 in the last 100 s, still 4 a second.
	assert.equal(timeLeft('run:DEBTOR_INVOICE', 480, 1000, start + 120000), 130000);
	assert.equal(timeLeft('run:DEBTOR_INVOICE', 1000, 1000, start + 130000), null, 'finished');
	assert.equal(timeLeft('run:OTHER', 0, 50, start), null, 'each stage keeps its own readings');
});

test('the time left reads as minutes or hours and minutes, with the time it should finish', () => {
	const { formatTimeLeft } = load();
	assert.equal(formatTimeLeft(30000), 'less than a minute left');
	assert.match(formatTimeLeft(230000), /^about 4 min left, done around \d{1,2}:\d{2}/);
	assert.match(formatTimeLeft(62 * 60000), /^about 1 h 2 min left, done around /);
});
