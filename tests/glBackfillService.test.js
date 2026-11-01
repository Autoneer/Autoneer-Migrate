const test = require("node:test");
const assert = require("node:assert/strict");

const service = require("../src/migrate/gl/glBackfill");
const { query } = require("../src/migrate/gl/glBackfill/mirror/database/database");

const config = { host: "localhost", port: 3306, user: "u", password: "" };
const range = { fromDate: "2020-01-01", toDate: "2020-12-31", types: ["DEBTOR_INVOICE", "CREDITOR_INVOICE"] };

// Answers the PWA route's guard queries; `running` and `lastLiveAge` (seconds) drive them,
// and `writeOffDate` dates a posted WIP write-off.
function fakePool({ running = 0, lastLiveAge = null, writeOffDate = null } = {}) {
	const pool = { sql: [], ended: 0 };
	pool.query = async (sql, params = []) => {
		pool.sql.push(sql);
		if (/COUNT\(\*\) AS cnt/.test(sql)) return [[{ cnt: running }]];
		if (/AS age_seconds/.test(sql)) return [lastLiveAge == null ? [] : [{ age_seconds: lastLiveAge }]];
		if (params[0] === "WIP_WRITE_OFF") return [writeOffDate ? [{ id: 9, source_id: `WO-${writeOffDate}`, trxdate: writeOffDate, period_status: "OPEN" }] : []];
		return [[{ ok: 1 }]];
	};
	pool.end = async () => { pool.ended++; };
	return pool;
}

function fakeBackfill() {
	let finish;
	const backfill = { calls: [], done: new Promise((resolve) => { finish = resolve; }) };
	backfill.finish = () => finish();
	backfill.clearPreviousBackfillScope = async (args) => { backfill.calls.push(["clear", args]); return { deleted: 3 }; };
	backfill.createRun = async (args) => { backfill.calls.push(["create", args]); return 41; };
	backfill.runBackfillJob = async (args) => {
		backfill.calls.push(["job", args]);
		backfill.jobQuery = await query("SELECT from_job");
		await backfill.done;
	};
	return backfill;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("run options follow the PWA route's rules", () => {
	assert.deepEqual(service.readRunOptions({ ...range, types: ["debtor_invoice", "CREDITOR_INVOICE"], dryRun: "1" }), {
		...range, types: ["CREDITOR_INVOICE", "DEBTOR_INVOICE"], dryRun: true, clearPrevious: false, confirm: false
	});
	assert.throws(() => service.readRunOptions({ ...range, dryRun: true, clearPrevious: true }), { code: "invalid_params" });
	assert.throws(() => service.readRunOptions({ ...range, dryRun: false }), { code: "confirmation_required" });
	assert.throws(() => service.readRunOptions({ ...range, types: ["DEBTOR_INVOICE", "JOURNAL"], dryRun: true }), { code: "invalid_params" });
	assert.throws(() => service.readRunOptions({ ...range, types: [], dryRun: true }), { code: "invalid_params" });
	assert.throws(() => service.readRunOptions({ ...range, fromDate: "2021-01-01", dryRun: true }), { code: "invalid_params" });
	assert.throws(() => service.readRunOptions({ ...range, toDate: "2020-02-30", dryRun: true }), { code: "invalid_params" });
});

test("a run is recorded, then the job runs on its own pool and releases it", async () => {
	const pool = fakePool();
	const backfill = fakeBackfill();
	const started = await service.startRun(config, "tenant_a", { ...range, dryRun: true }, { backfill, openPool: () => pool });
	assert.deepEqual(started, { runId: 41, dryRun: true, types: ["CREDITOR_INVOICE", "DEBTOR_INVOICE"] });
	assert.equal(pool.sql.length, 0, "dry runs skip the live-run guards");
	await settle();
	const { shouldStop, ...job } = backfill.calls.find(([kind]) => kind === "job")[1];
	assert.deepEqual(job, { companyDb: "tenant_a", schema: "tenant_a", runId: 41, fromDate: range.fromDate, toDate: range.toDate, types: ["CREDITOR_INVOICE", "DEBTOR_INVOICE"], dryRun: true, staffId: 0 });
	assert.equal(typeof shouldStop, "function");
	assert.deepEqual(backfill.jobQuery, [{ ok: 1 }], "the job's queries reach the run's pool");

	await assert.rejects(() => service.startRun(config, "tenant_a", { ...range, dryRun: true }, { backfill: fakeBackfill(), openPool: fakePool }), { statusCode: 409 });
	assert.equal(pool.ended, 0);
	backfill.finish();
	await settle();
	await settle();
	assert.equal(pool.ended, 1);

	const next = fakeBackfill();
	await service.startRun(config, "tenant_a", { ...range, dryRun: true }, { backfill: next, openPool: fakePool });
	next.finish();
});

test("a live run applies the PWA guards and clears the scope only when asked", async () => {
	const busy = fakePool({ running: 1 });
	await assert.rejects(() => service.startRun(config, "tenant_b", { ...range, confirm: true }, { backfill: fakeBackfill(), openPool: () => busy }), { code: "run_in_progress" });
	assert.equal(busy.ended, 1);
	assert.match(busy.sql[0], /SET status = 'FAILED'.*started_at < UTC_TIMESTAMP\(\) - INTERVAL 30 MINUTE/);

	const recent = fakePool({ lastLiveAge: 60 });
	await assert.rejects(() => service.startRun(config, "tenant_b", { ...range, confirm: true }, { backfill: fakeBackfill(), openPool: () => recent }),
		{ code: "rate_limited", statusCode: 429, message: "Please wait 540 seconds before starting another live run." });

	const backfill = fakeBackfill();
	const started = await service.startRun(config, "tenant_b", { ...range, confirm: "yes", clearPrevious: true }, { backfill, openPool: () => fakePool() });
	assert.equal(started.runId, 41, "the run is recorded before anything is deleted, so its page can follow the delete");
	await settle();
	const [create, clear, job] = backfill.calls;
	assert.equal(create[0], "create");
	assert.equal(create[1].dryRun, false);
	assert.deepEqual(clear, ["clear", { companyDb: "tenant_b", schema: "tenant_b", fromDate: range.fromDate, toDate: range.toDate, types: ["CREDITOR_INVOICE", "DEBTOR_INVOICE"] }]);
	assert.equal(job[0], "job");
	backfill.finish();
	await settle();
});

test("a live backfill on or before a posted WIP write-off is refused until it is undone", async () => {
	const posted = fakePool({ writeOffDate: "2020-12-31" });
	await assert.rejects(() => service.startRun(config, "tenant_g", { ...range, confirm: true }, { backfill: fakeBackfill(), openPool: () => posted }),
		{ code: "wip_write_off_posted", statusCode: 409, message: /The WIP write-off was posted on 2020-12-31\. Undo it before a live backfill/ });
	assert.equal(posted.ended, 1);

	const later = fakeBackfill();
	await service.startRun(config, "tenant_g", { ...range, fromDate: "2021-01-01", toDate: "2021-06-30", confirm: true }, { backfill: later, openPool: () => fakePool({ writeOffDate: "2020-12-31" }) });
	later.finish();
	await settle();
});

test("a stop during the delete ends the run as FAILED and posts nothing; Stop needs the running run", async () => {
	const backfill = fakeBackfill();
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	backfill.clearPreviousBackfillScope = async (args, { onProgress, shouldStop }) => {
		backfill.calls.push(["clear", args]);
		onProgress({ deleted: 0, total: 1000 });
		await gate;
		if (shouldStop()) throw new Error("Stopped while deleting existing journals: 0 of 1000 deleted.");
	};
	backfill.updateRunSummary = async (args) => { backfill.calls.push(["summary", args]); };
	const started = await service.startRun(config, "tenant_e", { ...range, confirm: true, clearPrevious: true }, { backfill, openPool: () => fakePool() });
	await settle();
	assert.throws(() => service.stopRun(config, "tenant_e", 999), { code: "not_running" });
	assert.deepEqual(service.stopRun(config, "tenant_e", started.runId), { runId: 41, stopping: true });
	release();
	await settle();
	await settle();
	const summary = backfill.calls.find(([name]) => name === "summary");
	assert.equal(summary[1].status, "FAILED");
	assert.match(summary[1].summary.lastError, /^Stopped while deleting existing journals/);
	assert.ok(!backfill.calls.some(([name]) => name === "job"), "nothing is posted after a stop");
	assert.throws(() => service.stopRun(config, "tenant_e", 41), { code: "not_running" }, "the run is over");
});

test("Stop reaches the posting job, which checks it before each document", async () => {
	const backfill = fakeBackfill();
	const started = await service.startRun(config, "tenant_f", { ...range, dryRun: true }, { backfill, openPool: () => fakePool() });
	await settle();
	const [, job] = backfill.calls.find(([name]) => name === "job");
	assert.equal(job.shouldStop(), false);
	service.stopRun(config, "tenant_f", started.runId);
	assert.equal(job.shouldStop(), true);
	backfill.finish();
	await settle();
});

test("schema names are checked before any SQL uses them", async () => {
	await assert.rejects(() => service.startRun(config, "bad`name", { ...range, dryRun: true }, { backfill: fakeBackfill(), openPool: fakePool }), { code: "invalid_schema" });
	await assert.rejects(() => service.readScope(config, ""), { code: "invalid_schema" });
	await assert.rejects(() => service.readRunStatus(config, "tenant", "x"), { code: "invalid_run" });
});

test("repair tasks need confirmation for live writes and check their input first", async () => {
	await assert.rejects(() => service.migrateLegacyRfcs(config, "tenant_c", { dryRun: false }), { code: "confirmation_required" });
	await assert.rejects(() => service.postBackfillRepair(config, "tenant_c", { dryRun: true }), { code: "confirmation_required" });
	await assert.rejects(() => service.assignGeneralInvoiceAccounts(config, "tenant_c", { dryRun: true }), { code: "invalid_account" });
	await assert.rejects(() => service.assignGeneralInvoiceAccounts(config, "tenant_c", { accnr: 2100, suppid: "x", dryRun: true }), { code: "invalid_supplier" });
	await assert.rejects(() => service.assignGeneralInvoiceAccounts(config, "tenant_c", { accnr: 2100 }), { code: "confirmation_required" });
	await assert.rejects(() => service.clearRunHistory(config, "tenant_c", {}), { code: "confirmation_required" });
});

test("only one backfill, repair or control fix runs per tenant at a time", async () => {
	const backfill = fakeBackfill();
	await service.startRun(config, "tenant_d", { ...range, dryRun: true }, { backfill, openPool: () => fakePool() });
	await assert.rejects(() => service.migrateLegacyRfcs(config, "tenant_d", { dryRun: true }), { code: "run_in_progress", statusCode: 409 });
	await assert.rejects(() => service.clearRunHistory(config, "tenant_d", { confirm: true }), { code: "run_in_progress" });
	await assert.rejects(() => service.applyControlFix(config, "tenant_d", "WIP", { action: "recreate", accnr: 3251 }), { code: "run_in_progress" });
	backfill.finish();
	await settle();
	await settle();
});
