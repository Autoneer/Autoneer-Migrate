const test = require('node:test');
const assert = require('node:assert/strict');

const { planJobs, summarizePlan, readOptions, scopeNote, groupGlJobs, auditRow, BUCKETS, KEEP_REASONS, AUDIT_ACTOR, AUDIT_METHOD } = require('../src/migrate/cleanup/wipCleanup');

const row = (job_number, completed_on, total, paid, { status = 'COMPLETED', regnr = `REG${job_number}`, invoices = 1, status_date = null } = {}) =>
	({ job_number, cid: 1, regnr, status, wipstatus: 'COMPLETED', location: 'WORKSHOP', completed_on, status_date, invoices, total, paid, owing: Math.max(0, total - paid) });

const rows = [
	row(1, '2016-06-01', 1000, 1000),
	row(2, '2021-03-10', 500, 1200),          // overpaid: settled
	row(3, '2022-10-05', 800, 0),             // owing
	row(4, '2026-10-20', 300, 300),           // settled but after the cut-off
	row(5, '2019-10-02', 0, 0),               // zero amount
	row(6, null, 200, 200),                   // no completion date
	row(7, '2026-10-30', 2000, 0, { status: 'READY FOR COLLECTION' })
];

test('planJobs buckets the jobs and releases only settled ones on or before the cut-off', () => {
	const jobs = planJobs(rows, { cutoffDate: '2026-10-03' });
	assert.deepEqual(jobs.map((job) => [job.job_number, job.bucket, job.release, job.keep]), [
		[1, 'SETTLED', true, null],
		[2, 'SETTLED', true, null],
		[3, 'OWING', false, 'OWING'],
		[4, 'SETTLED', false, 'RECENT'],
		[5, 'ZERO', true, null],
		[6, 'SETTLED', false, 'NO_DATE'],
		[7, 'OWING', false, 'OWING']
	]);
	assert.equal(jobs[1].owing, 0);
	assert.equal(jobs[6].status, 'READY FOR COLLECTION');
});

test('planJobs releases only the selected buckets and completion years', () => {
	const settledOnly = planJobs(rows, { cutoffDate: '2026-10-03', buckets: ['SETTLED'] });
	assert.equal(settledOnly.find((job) => job.job_number === 5).keep, 'BUCKET');
	assert.equal(settledOnly.filter((job) => job.release).length, 2);

	const zero2019 = planJobs(rows, { cutoffDate: '2026-10-03', buckets: ['ZERO'], years: ['2019'] });
	assert.deepEqual(zero2019.filter((job) => job.release).map((job) => job.job_number), [5]);

	const settled2016 = planJobs(rows, { cutoffDate: '2026-10-03', buckets: ['SETTLED', 'ZERO'], years: ['2016'] });
	assert.deepEqual(settled2016.map((job) => [job.job_number, job.keep]), [[1, null], [2, 'YEAR'], [3, 'OWING'], [4, 'RECENT'], [5, 'YEAR'], [6, 'NO_DATE'], [7, 'OWING']]);
	const s = summarizePlan(settled2016);
	// Each year still says what it would release if ticked.
	assert.deepEqual(s.years.map((y) => [y.period, y.jobs, y.candidates, y.released]), [['2016', 1, 1, 1], ['2019', 1, 1, 0], ['2021', 1, 1, 0], ['2022', 1, 0, 0], ['2026', 2, 0, 0]]);
	assert.equal(s.keptByReason.YEAR.jobs, 2);
	assert.equal(scopeNote({ cutoffDate: '2026-10-03', buckets: ['SETTLED', 'ZERO'], years: ['2016'] }), 'Settled and zero-amount · 2016 · completed on or before 2026-10-03');
	assert.equal(scopeNote({ cutoffDate: '2026-10-03', buckets: ['ZERO'], years: null }), 'Zero-amount only · every year · completed on or before 2026-10-03');
	assert.equal(scopeNote({ cutoffDate: '2026-10-03', buckets: ['ZERO'], years: [] }), 'Zero-amount only · no years · completed on or before 2026-10-03');
	assert.equal(scopeNote({ cutoffDate: '2026-10-03', buckets: ['SETTLED'], years: ['2016', '2017', '2018'] }), 'Settled only · 3 years: 2016, 2017, 2018 · completed on or before 2026-10-03');
});

test('readOptions reads the buckets and years and rejects bad ones', () => {
	assert.deepEqual(readOptions({ buckets: ['zero'], years: ['2019', '2016', '2019'] }).buckets, ['ZERO']);
	assert.deepEqual(readOptions({ buckets: 'ZERO,SETTLED', years: '2019,2016' }).years, ['2016', '2019']);
	assert.deepEqual(readOptions({ buckets: [] }).buckets, []);
	assert.deepEqual(readOptions({ years: [] }).years, []);
	assert.deepEqual(readOptions({ includeZero: false }).buckets, ['SETTLED']);
	assert.throws(() => readOptions({ buckets: ['OWING'] }), /Only the SETTLED and ZERO/);
	assert.throws(() => readOptions({ years: ['19'] }), /YYYY/);
});

test('summarizePlan gives the buckets, the year and month breakdowns and what the release leaves', () => {
	const s = summarizePlan(planJobs(rows, { cutoffDate: '2026-10-03' }));
	assert.deepEqual(s.awaiting, { jobs: 7, total: 4800, owing: 2800, oldest: '2016-06-01', newest: '2026-10-30' });
	assert.deepEqual(s.buckets.SETTLED, { jobs: 4, total: 2000, owing: 0, oldest: '2016-06-01', newest: '2026-10-20' });
	assert.deepEqual(s.buckets.OWING, { jobs: 2, total: 2800, owing: 2800, oldest: '2022-10-05', newest: '2026-10-30' });
	assert.deepEqual(s.buckets.ZERO, { jobs: 1, total: 0, owing: 0, oldest: '2019-10-02', newest: '2019-10-02' });
	assert.deepEqual(s.byYear.map((y) => [y.period, y.jobs, y.owing, y.released]), [
		['2016', 1, 0, 1], ['2021', 1, 0, 1], ['2022', 1, 800, 0], ['2026', 2, 2000, 0], ['unknown', 1, 0, 0]
	]);
	assert.deepEqual(s.owingByMonth.map((m) => [m.period, m.jobs, m.owing]), [['2022-10', 1, 800], ['2026-10', 1, 2000]]);
	assert.deepEqual(s.zeroByMonth.map((m) => [m.period, m.jobs, m.unpaid, m.released]), [['2019-10', 1, 0, 1]]);
	assert.deepEqual(s.release, { jobs: 3, total: 1500, owing: 0, oldest: '2016-06-01', newest: '2021-03-10' });
	assert.equal(s.kept.jobs, 4);
	assert.deepEqual(Object.fromEntries(Object.keys(KEEP_REASONS).map((r) => [r, s.keptByReason[r].jobs])), { OWING: 2, BUCKET: 0, NO_DATE: 1, RECENT: 1, YEAR: 0 });
	assert.deepEqual(Object.keys(BUCKETS), ['SETTLED', 'OWING', 'ZERO']);
});

test('readOptions defaults the cut-off to 30 days back and rejects bad input', () => {
	const options = readOptions({});
	assert.match(options.cutoffDate, /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(options.cutoffDate, options.defaultCutoff);
	assert.deepEqual(options.buckets, ['SETTLED', 'ZERO']);
	assert.equal(options.years, null);
	assert.equal(options.expectedJobs, null);
	const days = Math.round((Date.now() - new Date(`${options.cutoffDate}T00:00:00`).getTime()) / 86400000);
	assert.ok(days >= 30 && days <= 31, `cut-off is ${days} days back`);
	assert.deepEqual(readOptions({ cutoffDate: '2026-09-30', buckets: ['SETTLED'], years: ['2021'], expectedJobs: '12' }),
		{ cutoffDate: '2026-09-30', defaultCutoff: options.defaultCutoff, buckets: ['SETTLED'], years: ['2021'], expectedJobs: 12, dryRun: false });
	assert.throws(() => readOptions({ cutoffDate: '30/09/2026' }), /YYYY-MM-DD/);
	assert.throws(() => readOptions({ expectedJobs: 'many' }), /whole number/);
});

test('auditRow mirrors the PWA release audit row, dated on the status date and marked as a clean-up', () => {
	const [job] = planJobs([row(42, '2021-03-10', 500, 500, { status_date: '2021-03-12' })], { cutoffDate: '2026-10-03' });
	const values = auditRow(job, 3, new Date('2026-11-02T08:15:00Z'));
	assert.equal(values.length, 16);
	assert.deepEqual(values.slice(0, 7), [42, 1, 'JOB', 'RELEASED', 'job_information', '42', 'Vehicle released (migration clean-up)']);
	assert.match(values[7], /from COMPLETED to RELEASED by the Autoneer-Migrate clean-up run on 2026-11-02/);
	assert.match(values[7], /dated on its status date, 2021-03-12/);
	assert.deepEqual(JSON.parse(values[8]), { status: 'COMPLETED', wipstatus: 'COMPLETED', location: 'WORKSHOP' });
	assert.deepEqual(JSON.parse(values[9]), {
		status: 'RELEASED', wipstatus: 'RELEASED', location: 'WITH OWNER',
		migration_cleanup: true, cleanup_batch: 3, cleanup_run_on: '2026-11-02', release_dated_on: '2021-03-12'
	});
	assert.deepEqual(JSON.parse(values[10]), ['status', 'wipstatus', 'location']);
	assert.deepEqual(values.slice(11), [null, AUDIT_ACTOR, '/tools/cleanup/wip/release', AUDIT_METHOD, '2021-03-12 00:00:00']);

	// Without a status date the completion date stands in.
	const [noStatusDate] = planJobs([row(43, '2021-03-10', 500, 500)], { cutoffDate: '2026-10-03' });
	const fallback = auditRow(noStatusDate, 3, new Date('2026-11-02T08:15:00Z'));
	assert.match(fallback[7], /dated on its completion date, 2021-03-10/);
	assert.equal(fallback[15], '2021-03-10 00:00:00');
	assert.equal(JSON.parse(fallback[9]).release_dated_on, '2021-03-10');
	assert.equal(readOptions({ dryRun: 'true' }).dryRun, true);
	assert.equal(readOptions({}).dryRun, false);
});

test('groupGlJobs splits the jobs carrying GL WIP by status and invoiced, biggest first', () => {
	const gl = (job_number, wip, status, { in_tenant = 1, invoiced = 0 } = {}) => ({ job_number, wip, status, in_tenant, invoiced, last_moved: '2026-10-01' });
	const wip = groupGlJobs([gl(10, 100, 'QUOTE'), gl(11, 50, 'QUOTE'), gl(12, 300, 'NEW', { in_tenant: 0 }), gl(0, 7, null), gl(13, 20, 'RELEASED', { invoiced: 1 })]);
	assert.deepEqual(wip.total, { jobs: 5, value: 477 });
	assert.deepEqual(wip.groups.map((g) => [g.status, g.invoiced, g.jobs, g.value]), [
		['Job not in the tenant', false, 1, 300], ['QUOTE', false, 2, 150], ['RELEASED', true, 1, 20], ['No job on the line', false, 1, 7]
	]);
});
