"use strict";
require("dotenv").config();
const mysql = require("mysql2/promise");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const { state } = require("../src/config/state");
const { runAllChecks } = require("../src/migrate/gl/glValidation");
const { runAllGAAPChecks } = require("../src/migrate/gl/glReconciliation");
const CUTOVER = "2026-10-31";
const ACCOUNTS = [3100,1000,1300,1400,5100,6050,6300,3200,3400,3250,4900];
const PROTECTED = ["gl_journal_headers","gl_journal_lines","stock","stock_take","stock_takes","customers","gl_account_types","gl_accounts","gl_control_accounts","gl_periods","tax_codes"];
function schemaName(schema) {
	if (!/^(dm_service_centre|glbf_test_[A-Za-z0-9_]+)$/.test(schema)) throw new Error("Unsupported migration schema");
	return schema;
}
function ident(name) { if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Invalid identifier"); return `\`${name}\``; }
function cents(value) { const n=Number(value||0); assert.ok(Number.isFinite(n)); return Math.round(n*100); }
async function fingerprint(conn, table, where = "", params = []) {
	const [meta] = await conn.query(`SHOW COLUMNS FROM ${ident(table)}`);
	const columns = meta.filter(row => !/VIRTUAL GENERATED|STORED GENERATED/i.test(row.Extra)).map(row=>row.Field);
	const sum=Buffer.alloc(32); let count=0;
	const stream=conn.connection.query(`SELECT ${columns.map(ident).join(",")} FROM ${ident(table)} ${where}`,params).stream({highWaterMark:500});
	for await(const row of stream) {
		const digest=createHash("sha256").update(JSON.stringify(columns.map(col=>row[col]))).digest(); let carry=0;
		for(let i=31;i>=0;i--){const n=sum[i]+digest[i]+carry;sum[i]=n&255;carry=n>>>8;} count++;
	}
	return {count,checksum:sum.toString("hex")};
}
async function assertIdle(conn) {
	const [[{ n }]]=await conn.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='migration_runs'");
	assert.equal(Number(n),1,"migration_runs is required for the idle check");
	for(const table of ["gl_backfill_runs","migration_runs"]) {
		const [rows]=await conn.query(`SELECT * FROM ${table} WHERE UPPER(status)='RUNNING'`);
		assert.equal(rows.length,0,`${table} has a RUNNING row`);
	}
}
async function validation(conn) {
	return {gl:await runAllChecks(conn),gaap:await runAllGAAPChecks(conn)};
}
async function balances(conn) {
	const result={};
	for(const [scope,filter] of [["cutover","AND h.trxdate <= ?"],["total",""]]) {
		const [rows]=await conn.query(`SELECT l.accnr,CAST(SUM(l.debit-l.credit) AS DECIMAL(18,2)) balance FROM gl_journal_headers h JOIN gl_journal_lines l ON l.header_id=h.id WHERE h.status='POSTED' ${filter} AND l.accnr IN (?) GROUP BY l.accnr`,scope==="cutover"?[CUTOVER,ACCOUNTS]:[ACCOUNTS]);
		result[scope]=Object.fromEntries(ACCOUNTS.map(acc=>[acc,rows.find(row=>Number(row.accnr)===acc)?.balance||"0.00"]));
	}
	return result;
}
async function snapshot(conn) {
	await assertIdle(conn);
	const [[db]]=await conn.query("SELECT DATABASE() schema_name,NOW() server_now");
	const [sources]=await conn.query("SELECT source,COUNT(*) count,MAX(id) max_id FROM gl_journal_headers GROUP BY source ORDER BY source");
	const [[maxima]]=await conn.query("SELECT (SELECT COALESCE(MAX(id),0) FROM gl_journal_headers) header_id,(SELECT COALESCE(MAX(id),0) FROM gl_journal_lines) line_id");
	const hashes={}; for(const table of PROTECTED) hashes[table]=await fingerprint(conn,table);
	return {...db,sources,maxima,hashes,balances:await balances(conn),validation:await validation(conn)};
}
async function assertExistingUnchanged(conn, before) {
	for(const table of PROTECTED) {
		const max=table==="gl_journal_headers"?before.maxima.header_id:table==="gl_journal_lines"?before.maxima.line_id:null;
		assert.deepEqual(await fingerprint(conn,table,max==null?"":"WHERE id<=?",max==null?[]:[max]),before.hashes[table],`${table}: existing data changed`);
	}
}
function assertNoNewValidationFailures(before, after) {
	for(const key of ["gl","gaap"]) for(const check of after[key].checks) {
		if(check.passed)continue;
		const previous=before[key].checks.find(item=>item.check===check.check);
		assert.ok(previous&&!previous.passed,`New Validate GL failure: ${check.check} ${check.name}`);
		assert.deepEqual(check.errors,previous.errors,`Changed Validate GL errors: ${check.check}`);
	}
}
async function connect(schema) { return mysql.createConnection({...state.mysql,database:schemaName(schema),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true}); }
async function main() {
	const args=process.argv.slice(2);const schema=args[args.indexOf("--schema")+1];const file=args[args.indexOf("--out")+1];
	if(!args.includes("--schema")||!args.includes("--out"))throw new Error("Usage: --schema <name> --out <snapshot.json>");
	const conn=await connect(schema);try{await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");const report=await snapshot(conn);fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({file,sources:report.sources.length,balances:report.balances,validateGL:report.validation.gl.allPassed,gaap:report.validation.gaap.allPassed}));await conn.rollback();}finally{await conn.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={schemaName,ident,cents,connect,fingerprint,assertIdle,validation,balances,snapshot,assertExistingUnchanged,assertNoNewValidationFailures,CUTOVER};
