const test = require("node:test");
const assert = require("node:assert/strict");

const service = require("../src/migrate/gl/glBackfill");
const { query } = require("../src/migrate/gl/glBackfill/mirror/database/database");

const config = { host: "localhost", port: 3306, user: "u", password: "" };
const range = { fromDate: "2020-01-01", toDate: "2020-12-31", types: ["DEBTOR_INVOICE", "CREDITOR_INVOICE"] };

// Answers the PWA route's guard queries; `running` and `lastLiveAge` (seconds) drive them.
function fakePool({ running = 0, lastLiveAge = null } = {}) {
	const pool = { sql: [], ended: 0 };
	pool.query = async (sql) => {
		pool.sql.push(sql);
		if (/COUNT\(\*\) AS cnt/.test(sql)) return [[{ cnt: running }]];
		if (/AS age_seconds/.test(sql)) return [lastLiveAge == null ? [] : [{ age_seconds: lastLiveAge }]];
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
	assert.deepEqual(started, { runId: 41, cleared: null, dryRun: true, types: ["CREDITOR_INVOICE", "DEBTOR_INVOICE"] });
	assert.equal(pool.sql.length, 0, "dry runs skip the live-run guards");
	await settle();
	const job = backfill.calls.find(([kind]) => kind === "job")[1];
	assert.deepEqual(job, { companyDb: "tenant_a", schema: "tenant_a", runId: 41, fromDate: range.fromDate, toDate: range.toDate, types: ["CREDITOR_INVOICE", "DEBTOR_INVOICE"], dryRun: true, staffId: 0 });
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
	assert.deepEqual(started.cleared, { deleted: 3 });
	const [clear, create] = backfill.calls;
	assert.deepEqual(clear, ["clear", { companyDb: "tenant_b", schema: "tenant_b", fromDate: range.fromDate, toDate: range.toDate, types: ["CREDITOR_INVOICE", "DEBTOR_INVOICE"] }]);
	assert.equal(create[1].dryRun, false);
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
