"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {journalSignature,assertSamePreview}=require("../scripts/general_invoice_route_b");
const {schemaName,assertNoNewValidationFailures}=require("../scripts/general_invoice_audit");

test("journal comparison treats SQL decimal strings/null job as equal but detects changed amounts and references",()=>{
	const original=[{accnr:3200,debit:0,credit:12.34,invoice_nr:10,cid:24,job_number:0}];
	assert.deepEqual(journalSignature(original),journalSignature([{...original[0],accnr:"3200",debit:"0.00",credit:"12.34",job_number:null}]));
	assert.notDeepEqual(journalSignature(original),journalSignature([{...original[0],credit:12.35}]));
	assert.notDeepEqual(journalSignature(original),journalSignature([{...original[0],invoice_nr:11}]));
});
test("cross-schema preview references must agree on every built journal",()=>{
	const p={ready:true,targetIds:[10],accounts:[{accnr:3200,credit:"12.34"}],proposedClearing:{amount:"12.34"},journals:[{invoice_nr:10,date:"2026-10-30",lines:[{accnr:3200,credit:12.34}]}]};
	assert.doesNotThrow(()=>assertSamePreview(p,{...p,schema:"dm_service_centre"}));
	const changed=JSON.parse(JSON.stringify(p));changed.journals[0].lines[0].credit=12.35;
	assert.throws(()=>assertSamePreview(p,changed));
	assert.throws(()=>schemaName("production"));
});
test("validation comparison refuses a newly failing check or new errors in an existing failure",()=>{
	const before={gl:{checks:[{check:"A",passed:false,errors:["old"]}]},gaap:{checks:[{check:"B",passed:true,errors:[]}]}};
	assert.doesNotThrow(()=>assertNoNewValidationFailures(before,JSON.parse(JSON.stringify(before))));
	const after=JSON.parse(JSON.stringify(before));after.gaap.checks[0]={check:"B",passed:false,errors:["new"]};
	assert.throws(()=>assertNoNewValidationFailures(before,after));
	after.gaap=before.gaap;after.gl.checks[0].errors.push("new");assert.throws(()=>assertNoNewValidationFailures(before,after));
});
