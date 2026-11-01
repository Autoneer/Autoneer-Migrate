const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyJobs, buildJournalLines } = require('../src/migrate/gl/glBackfill/wipWriteOff');

const row = (job_number, wip, last_moved, { in_tenant = 1, status = 'COMPLETED', invoiced = 0 } = {}) => ({ job_number, wip, last_moved, in_tenant, status, invoiced });
const options = (overrides = {}) => ({ keepFrom: '2026-05-01', keepJobs: new Set(), writeOffJobs: new Set(), ...overrides });

test('WIP that can never be invoiced is written off; unfinished jobs keep it only when recent, needed by the opening stock, or kept by hand', () => {
	const rows = [
		row(0, 120, '2019-03-01', { in_tenant: 0, status: '' }),
		row(19546, 41980.1, '2024-11-01', { in_tenant: 0, status: '' }),
		row(8001, 900, '2026-09-01', { invoiced: 1 }),
		row(8002, 300, '2026-10-01', { status: 'CANCELLED' }),
		row(13646, 11942.57, '2020-06-30'),
		row(20256, 34720.24, '2026-06-22', { status: 'QUOTE' }),
		row(24914, 7308.66, '2026-10-07', { status: 'WAITING FOR SPARES' }),
		row(15115, 4936, '2021-08-19'),
		row(24946, 1998.02, '2026-09-11', { status: 'QUOTE' })
	];
	const jobs = classifyJobs(rows, options({ keepJobs: new Set([15115]), writeOffJobs: new Set([24946, 24914]) }), new Set([24914]));
	const byJob = new Map(jobs.map((job) => [job.job_number, job]));
	assert.deepEqual(jobs.map((job) => job.reason), ['NO_JOB', 'NOT_IN_TENANT', 'INVOICED', 'CANCELLED', 'UNFINISHED', 'UNFINISHED', 'UNFINISHED', 'UNFINISHED', 'UNFINISHED']);
	for (const job of [0, 19546, 8001, 8002]) assert.equal(byJob.get(job).writeOff, true, `job ${job} is written off whatever its date`);
	assert.equal(byJob.get(13646).writeOff, true, 'an unfinished job with no WIP since the keep-from date is written off');
	assert.equal(byJob.get(20256).writeOff, false, 'a quote with recent WIP is kept');
	assert.deepEqual([byJob.get(24914).writeOff, byJob.get(24914).locked], [false, true], 'the opening stock counts on this job, so a tick cannot write it off');
	assert.equal(byJob.get(15115).writeOff, false, 'kept by hand');
	assert.equal(byJob.get(24946).writeOff, true, 'written off by hand');
});

test('the journal has a WIP line per job written off, tagged with the job, against the Opening Stock control', () => {
	const jobs = [
		{ job_number: 19546, wip: 41980.1, reason: 'NOT_IN_TENANT', writeOff: true },
		{ job_number: 8001, wip: -50.25, reason: 'INVOICED', writeOff: true },
		{ job_number: 0, wip: 120, reason: 'NO_JOB', writeOff: true },
		{ job_number: 20256, wip: 34720.24, reason: 'UNFINISHED', writeOff: false }
	];
	const lines = buildJournalLines(jobs, { wipAccnr: 3250, openingAccnr: 4900 });
	assert.deepEqual(lines.map(({ accnr, debit, credit, job_number }) => [accnr, debit, credit, job_number]), [
		[3250, 0, 41980.1, 19546],
		[3250, 50.25, 0, 8001],
		[3250, 0, 120, null],
		[4900, 42049.85, 0, undefined]
	]);
	assert.equal(lines[0].ref1, "WIP write-off: Job not in the tenant");
	assert.equal(lines[1].ref1, "WIP write-off: Left after the job's invoice");
	const debit = lines.reduce((sum, line) => sum + line.debit, 0);
	const credit = lines.reduce((sum, line) => sum + line.credit, 0);
	assert.equal(Math.round(debit * 100), Math.round(credit * 100), 'balanced');
	assert.deepEqual(buildJournalLines([{ ...jobs[3] }], { wipAccnr: 3250, openingAccnr: 4900 }), [], 'nothing written off, no journal');
});
