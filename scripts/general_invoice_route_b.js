"use strict";
// Targeted journal posting/clearing/undo. Every write uses one transaction;
// immutable before-state fingerprints and on-disk backups precede commit.
require("dotenv").config();
const fs=require("node:fs");
const path=require("node:path");
const assert=require("node:assert/strict");
const audit=require("./general_invoice_audit");
const {inspectJournal}=require("./preview_general_invoice_gl");
const SOURCE="MIGRATION_GENERAL_INVOICE_CLEARING";
const SOURCE_ID="GI-2026-10-31";
const logs=path.join(__dirname,"..","logs");
const cents=audit.cents;
const money=value=>(value/100).toFixed(2);
const read=file=>JSON.parse(fs.readFileSync(file,"utf8"));
const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data,null,2));
const newBackup=(kind,schema)=>path.join(logs,`general-invoice-${kind}-${schema}-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);

function journalSignature(lines) {
	return lines.map(l=>[Number(l.accnr),cents(l.debit),cents(l.credit),Number(l.invoice_nr||0),Number(l.cid||0),Number(l.job_number||0),l.ref1||null,l.ref2||null]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function assertSamePreview(a,b) {
	assert.equal(a.ready,true);assert.equal(b.ready,true);
	assert.deepEqual(a.targetIds,b.targetIds,"Target invoice IDs changed");
	assert.deepEqual(a.accounts,b.accounts,"Account totals changed");
	assert.equal(a.proposedClearing.amount,b.proposedClearing.amount);
	assert.deepEqual(a.journals.map(j=>[Number(j.invoice_nr),j.date,journalSignature(j.lines)]),b.journals.map(j=>[Number(j.invoice_nr),j.date,journalSignature(j.lines)]),"Built journals differ from reference");
}
async function readJournals(conn,ids) {
	const [headers]=await conn.query("SELECT * FROM gl_journal_headers WHERE source='DEBTOR_INVOICE' AND source_id IN (?) ORDER BY id",[ids.map(String)]);
	const result=[];
	for(const header of headers){const [lines]=await conn.query("SELECT * FROM gl_journal_lines WHERE header_id=? ORDER BY line_no,id",[header.id]);result.push({header,lines});}
	return result;
}
async function verifyJournals(conn,preview) {
	const journals=await readJournals(conn,preview.targetIds);
	assert.equal(journals.length,290,"Expected one journal for each target invoice");
	assert.equal(new Set(journals.map(j=>String(j.header.source_id))).size,290);
	for(const journal of journals){
		const expected=preview.journals.find(j=>Number(j.invoice_nr)===Number(journal.header.source_id));
		assert.ok(expected);assert.equal(journal.header.status,"POSTED");assert.equal(journal.header.trxdate,expected.date);
		assert.deepEqual(journalSignature(journal.lines),journalSignature(expected.lines),`Journal differs: ${expected.invoice_nr}`);
		const [[invoice]]=await conn.query("SELECT * FROM invoices WHERE invoice_nr=?",[expected.invoice_nr]);
		assert.deepEqual(inspectJournal({...invoice,parts_cost:expected.signedPartsCost,sublet_cost:expected.subletCost},journal.lines),[],`Invoice ${expected.invoice_nr} fails financial checks`);
	}
	return journals;
}
async function verifySourceGrowth(conn,before,source,added) {
	const [rows]=await conn.query("SELECT source,COUNT(*) count,MAX(id) max_id FROM gl_journal_headers GROUP BY source ORDER BY source");
	for(const row of rows){const old=before.sources.find(x=>x.source===row.source);if(row.source===source){assert.equal(Number(row.count),Number(old?.count||0)+added);if(added)assert.ok(Number(row.max_id)>Number(old?.max_id||0));}else assert.deepEqual(row,old,`Existing journal source changed: ${row.source}`);}
	for(const old of before.sources)assert.ok(rows.some(row=>row.source===old.source));
}
async function assertWipUnchanged(conn,before) {
	const balances=await audit.balances(conn);
	for(const scope of ["cutover","total"])assert.equal(balances[scope][3250],before.balances[scope][3250],"WIP changed");
}
async function postInvoices(conn,schema,preview,file) {
	assert.equal(preview.schema,schema);assert.equal(preview.ready,true);assert.equal(preview.targetIds.length,290);
	await audit.assertIdle(conn);
	const existing=await readJournals(conn,preview.targetIds);
	if(existing.length){assert.equal(existing.length,290,"Partial target posting exists");await verifyJournals(conn,preview);console.log("NOTHING TO POST: all 290 journals match the preview.");return;}
	const before=await audit.snapshot(conn);
	const expected=new Map(preview.journals.map(j=>[Number(j.invoice_nr),j]));
	const db=require("../src/migrate/gl/glBackfill/mirror/database/database");
	const engine=require("../src/migrate/gl/glBackfill/mirror/lib/finance/postingEngine");
	const original={validateLines:engine.validateLines,postJournal:engine.postJournal,deleteGlJournalBySource:engine.deleteGlJournalBySource};
	const captured=new Set();
	const bound={query:(sql,params=[])=>{
		if(!/^\s*(SELECT|SHOW|INSERT|UPDATE)\b/i.test(sql))throw Error(`Posting refused SQL: ${sql.slice(0,120)}`);
		if(!/^\s*(SELECT|SHOW)\b/i.test(sql)){
			const match=sql.match(/^\s*(?:INSERT(?:\s+IGNORE)?\s+INTO|UPDATE)\s+`?([\w]+)`?\.`?([\w]+)`?(?=\s|\()/i);
			assert.ok(match&&match[1]===schema&&["gl_account_types","gl_accounts","gl_control_accounts","tax_codes","gl_periods","gl_backfill_runs","gl_backfill_run_items","gl_journal_headers","gl_journal_lines","invoices","customers"].includes(match[2]),"Unexpected mutation scope");
		}
		return conn.query(sql,params);
	},getConnection:async()=>{throw Error("Unexpected nested financial transaction");}};
	const query=async(sql,params=[]) => (await bound.query(sql,params))[0];
	engine.validateLines=(lines,...rest)=>{const nr=Number(lines[0]?.invoice_nr);assert.ok(expected.has(nr));assert.ok(!captured.has(nr));captured.add(nr);assert.deepEqual(journalSignature(lines),journalSignature(expected.get(nr).lines),`Built journal changed: ${nr}`);return original.validateLines(lines,...rest);};
	engine.postJournal=options=>original.postJournal({...options,queryFn:query});
	engine.deleteGlJournalBySource=async()=>{throw Error("Existing journals may never be replaced by this repair");};
	const customerBalances=require("../src/migrate/gl/glBackfill/mirror/utils/customerBalance");
	const originalResync=customerBalances.recalculateCustomerBalance;
	const cacheDifferences=[];
	// Journal reconstruction changes neither invoice amounts nor payments.
	// Preserve existing customer caches instead of repairing unrelated drift.
	customerBalances.recalculateCustomerBalance=async(company,cid)=>{
		const value=await customerBalances.getCustomerBalance(company,cid,{queryFn:query,resolveControlAccountsFn:(s,keys)=>engine.resolveControlAccounts(s,keys,{queryFn:query})});
		const [row]=await query(`SELECT balance FROM ${schema}.customers WHERE cid=?`,[cid]);
		if(cents(row.balance)!==cents(value))cacheDifferences.push({cid,stored:row.balance,recalculated:money(cents(value)),action:"PRESERVED"});
		return value;
	};
	const mirror=require("../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill");
	const backup={kind:"GL",schema,status:"PREPARED",preview:path.resolve(file),before};
	const backupFile=newBackup("gl",schema);
	try{
		await conn.beginTransaction();
		await db.withPool(bound,async()=>{
			await audit.assertIdle(conn);
			const dates=preview.journals.map(j=>j.date).sort();
			const options={companyDb:schema,schema,staffId:0,fromDate:dates[0],toDate:dates.at(-1),types:["DEBTOR_INVOICE"],dryRun:false};
			backup.runId=await mirror.createRun(options);
			await mirror.runBackfillJob({...options,runId:backup.runId,targetedSourceIds:{DEBTOR_INVOICE:preview.targetIds}});
			const [[run]]=await conn.query("SELECT * FROM gl_backfill_runs WHERE id=?",[backup.runId]);
			const summary=typeof run.summary_json==="string"?JSON.parse(run.summary_json):run.summary_json;
			assert.equal(run.status,"DONE");assert.equal(summary.failed,0);assert.equal(summary.skipped,0);assert.equal(summary.posted,290);assert.equal(captured.size,290);
			backup.journals=await verifyJournals(conn,preview);
			// The operation is journal-only. Customer balance caches must already
			// agree; an unexpected change aborts the entire transaction.
			await audit.assertExistingUnchanged(conn,before);
			await verifySourceGrowth(conn,before,"DEBTOR_INVOICE",290);
			await assertWipUnchanged(conn,before);
			audit.assertNoNewValidationFailures(before.validation,await audit.validation(conn));
			backup.run=run;backup.summary=summary;backup.preservedCacheDifferences=cacheDifferences;
			save(backupFile,backup);
			await conn.commit();backup.status="COMMITTED";save(backupFile,backup);
		});
		console.log(JSON.stringify({posted:290,runId:backup.runId,backup:backupFile,summary:backup.summary}));
	}catch(error){await conn.rollback();throw error;}finally{Object.assign(engine,original);customerBalances.recalculateCustomerBalance=originalResync;}
}

async function clearInventory(conn,schema,glBackup,write) {
	assert.equal(glBackup.kind,"GL");assert.equal(glBackup.schema,schema);assert.equal(glBackup.status,"COMMITTED");
	await audit.assertIdle(conn);
	const preview=read(glBackup.preview);
	const journals=await verifyJournals(conn,preview);
	const movement=journals.flatMap(j=>j.lines).filter(l=>Number(l.accnr)===3200).reduce((sum,l)=>sum+cents(l.credit)-cents(l.debit),0);
	assert.equal(money(movement),preview.proposedClearing.amount);assert.ok(movement>0);
	const [existing]=await conn.query("SELECT * FROM gl_journal_headers WHERE source=? AND source_id=?",[SOURCE,SOURCE_ID]);
	if(existing.length){const [lines]=await conn.query("SELECT * FROM gl_journal_lines WHERE header_id=?",[existing[0].id]);assert.equal(existing[0].trxdate,audit.CUTOVER);assert.deepEqual(lines.map(l=>[Number(l.accnr),cents(l.debit),cents(l.credit)]).sort((a,b)=>a[0]-b[0]),[[3200,movement,0],[4900,0,movement]]);console.log("NOTHING TO CLEAR: the exact clearing journal already exists.");return;}
	console.log(`Clearing preview: ${audit.CUTOVER} Dr 3200 / Cr 4900 ${money(movement)}`);
	if(!write)return;
	const before=await audit.snapshot(conn);
	const engine=require("../src/migrate/gl/glBackfill/mirror/lib/finance/postingEngine");
	const query=async(sql,params=[])=>(await conn.query(sql,params))[0];
	const backup={kind:"CLEARING",schema,status:"PREPARED",source:SOURCE,sourceId:SOURCE_ID,amount:money(movement),before};
	const backupFile=newBackup("clearing",schema);
	try{
		await conn.beginTransaction();
		const result=await engine.postJournal({schema,source:SOURCE,sourceId:SOURCE_ID,trxdate:audit.CUTOVER,description:"General invoice migration: preserve opening Inventory",lines:[{accnr:3200,debit:money(movement),credit:"0.00"},{accnr:4900,debit:"0.00",credit:money(movement)}],exactAmounts:true,userId:0,queryFn:query});
		assert.equal(result.status,"posted");backup.headerId=result.id;
		await audit.assertExistingUnchanged(conn,before);await verifySourceGrowth(conn,before,SOURCE,1);await assertWipUnchanged(conn,before);
		const balances=await audit.balances(conn);
		assert.equal(cents(balances.cutover[3200]),cents(glBackup.before.balances.cutover[3200]),"Inventory cut-over did not return to its baseline");
		audit.assertNoNewValidationFailures(glBackup.before.validation,await audit.validation(conn));
		const [[header]]=await conn.query("SELECT * FROM gl_journal_headers WHERE id=?",[backup.headerId]);const [lines]=await conn.query("SELECT * FROM gl_journal_lines WHERE header_id=?",[backup.headerId]);backup.journals=[{header,lines}];
		save(backupFile,backup);await conn.commit();backup.status="COMMITTED";save(backupFile,backup);
		console.log(JSON.stringify({posted:1,headerId:backup.headerId,amount:backup.amount,backup:backupFile}));
	}catch(error){await conn.rollback();throw error;}
}

async function undo(conn,schema,backup,write) {
	assert.equal(backup.schema,schema);assert.ok(["GL","CLEARING"].includes(backup.kind));assert.ok(["COMMITTED","PREPARED"].includes(backup.status));await audit.assertIdle(conn);
	const engine=require("../src/migrate/gl/glBackfill/mirror/lib/finance/postingEngine");const query=async(sql,params=[])=>(await conn.query(sql,params))[0];
	if(backup.kind==="GL")assert.equal((await query("SELECT id FROM gl_journal_headers WHERE source=? AND source_id=?",[SOURCE,SOURCE_ID])).length,0,"Undo the clearing first");
	const present=[];
	for(const saved of backup.journals){const [header]=await query("SELECT * FROM gl_journal_headers WHERE source=? AND source_id=?",[saved.header.source,saved.header.source_id]);if(!header)continue;assert.deepEqual(header,saved.header,"Journal header changed since backup");const lines=await query("SELECT * FROM gl_journal_lines WHERE header_id=? ORDER BY line_no,id",[header.id]);assert.deepEqual(lines,saved.lines,"Journal lines changed since backup");present.push(saved);}
	assert.ok(present.length===0||present.length===backup.journals.length,"Partial undo state");
	console.log(`Undo preview: ${present.length} ${backup.kind} journal(s), by exact backed-up source and ID.`);
	if(!write||!present.length)return;
	try{
		await conn.beginTransaction();
		for(const saved of present)assert.equal((await engine.deleteGlJournalBySource(schema,saved.header.source,saved.header.source_id,query)).deleted,true);
		if(backup.kind==="GL"){
			await conn.query("DELETE FROM gl_backfill_run_items WHERE run_id=?",[backup.runId]);
			await conn.query("DELETE FROM gl_backfill_runs WHERE id=?",[backup.runId]);
		}
		await audit.assertExistingUnchanged(conn,backup.before);
		assert.deepEqual(await audit.balances(conn),backup.before.balances,"Undo balances differ from baseline");
		audit.assertNoNewValidationFailures(backup.before.validation,await audit.validation(conn));
		await conn.commit();console.log(`UNDONE: ${present.length} journals.`);
	}catch(error){await conn.rollback();throw error;}
}
async function main(){
	const args=process.argv.slice(2);const get=name=>args[args.indexOf(name)+1];
	assert.ok(args.includes("--schema")&&args.includes("--action"));const schema=audit.schemaName(get("--schema"));const action=get("--action");
	const conn=await audit.connect(schema);
	try{
		if(action==="post"){
			assert.ok(args.includes("--preview")&&args.includes("--reference"));const p=read(get("--preview"));assertSamePreview(read(get("--reference")),p);await postInvoices(conn,schema,p,get("--preview"));
		}else if(action==="clear"||action==="clear-preview")await clearInventory(conn,schema,read(get("--backup")),action==="clear");
		else if(action==="undo"||action==="undo-preview")await undo(conn,schema,read(get("--backup")),action==="undo");
		else throw Error("Actions: post, clear-preview, clear, undo-preview, undo");
	}finally{await conn.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={journalSignature,assertSamePreview};
