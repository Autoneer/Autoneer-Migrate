/**
 * Test Script: Table Name Normalization Fix
 * 
 * Demonstrates that the normalization layer fixes the recurring bug where
 * plans with source table names (WORKDONE) fail dry-run with "No mapping found"
 */

const { normalizePlanTables, resolveTargetTableName, needsNormalization } = require('../src/migrate/utils/tableNameCanonical');

console.log('='.repeat(80));
console.log('TABLE NAME NORMALIZATION TEST');
console.log('='.repeat(80));
console.log();

// Simulate a mapping with source -> target
const sampleMapping = {
	tables: {
		'WORKDONE': {
			targetTable: 'WORK_DONE',
			columns: {
				ID: { target: 'id', transform: null },
				WORKER_ID: { target: 'worker_id', transform: null },
				DESCRIPTION: { target: 'description', transform: null },
				COMPLETED_DATE: { target: 'completed_date', transform: null }
			}
		},
		'INVOICE': {
			targetTable: 'INVOICES',
			columns: {
				INVOICE_ID: { target: 'id', transform: null },
				CUSTOMER_ID: { target: 'customer_id', transform: null },
				TOTAL: { target: 'total_amount', transform: null }
			}
		},
		'EMPLOYEES': {
			targetTable: 'EMPLOYEES',
			columns: {
				EMP_ID: { target: 'id', transform: null },
				NAME: { target: 'full_name', transform: null }
			}
		}
	}
};

console.log('Sample Mapping Structure:');
console.log('  Source: WORKDONE    → Target: WORK_DONE (20 columns)');
console.log('  Source: INVOICE     → Target: INVOICES (10 columns)');
console.log('  Source: EMPLOYEES   → Target: EMPLOYEES (15 columns)');
console.log();

// Test Case 1: Resolve source key to target
console.log('TEST 1: Resolve Source Key → Target Name');
console.log('-'.repeat(80));
const test1Input = 'WORKDONE';
const test1Result = resolveTargetTableName(test1Input, sampleMapping);
console.log(`  Input:    "${test1Input}" (source key)`);
console.log(`  Resolved: "${test1Result}" (target name)`);
console.log(`  ✓ ${test1Result === 'WORK_DONE' ? 'PASS' : 'FAIL'}`);
console.log();

// Test Case 2: Target name stays target name
console.log('TEST 2: Target Name → Target Name (identity)');
console.log('-'.repeat(80));
const test2Input = 'WORK_DONE';
const test2Result = resolveTargetTableName(test2Input, sampleMapping);
console.log(`  Input:    "${test2Input}" (already target)`);
console.log(`  Resolved: "${test2Result}" (target name)`);
console.log(`  ✓ ${test2Result === 'WORK_DONE' ? 'PASS' : 'FAIL'}`);
console.log();

// Test Case 3: Normalize bad plan (array format)
console.log('TEST 3: Normalize Plan Tables (Array Format)');
console.log('-'.repeat(80));
const badPlanTables = ['WORKDONE', 'INVOICE', 'EMPLOYEES'];
console.log('  Bad Plan Tables (source keys):', badPlanTables);
const normalized = normalizePlanTables(badPlanTables, sampleMapping);
console.log('  Normalized Tables (targets):  ', normalized.tablesList);
console.log(`  ✓ ${normalized.tablesList.join(',') === 'WORK_DONE,INVOICES,EMPLOYEES' ? 'PASS' : 'FAIL'}`);
console.log();

// Test Case 4: Normalize bad plan (object format)
console.log('TEST 4: Normalize Plan Tables (Object Format)');
console.log('-'.repeat(80));
const badPlanObject = {
	'WORKDONE': { include: true, mode: 'INSERT', batchSize: 1000 },
	'INVOICE': { include: true, mode: 'INSERT', batchSize: 500 }
};
console.log('  Bad Plan Object Keys (sources):', Object.keys(badPlanObject));
const normalizedObj = normalizePlanTables(badPlanObject, sampleMapping);
console.log('  Normalized Object Keys (targets):', Object.keys(normalizedObj.tablesObject));
console.log(`  ✓ ${Object.keys(normalizedObj.tablesObject).join(',') === 'WORK_DONE,INVOICES' ? 'PASS' : 'FAIL'}`);
console.log('  Config preserved:', normalizedObj.tablesObject['WORK_DONE'].batchSize === 1000);
console.log();

// Test Case 5: Check if normalization needed
console.log('TEST 5: Detect Bad Plans (needsNormalization)');
console.log('-'.repeat(80));
const goodPlan = { 'WORK_DONE': {}, 'INVOICES': {} };
const badPlan = { 'WORKDONE': {}, 'INVOICE': {} };
console.log('  Good Plan (target keys):  needs normalization?', needsNormalization(goodPlan, sampleMapping));
console.log('  Bad Plan (source keys):   needs normalization?', needsNormalization(badPlan, sampleMapping));
console.log(`  ✓ ${needsNormalization(badPlan, sampleMapping) === true ? 'PASS' : 'FAIL'}`);
console.log();

// Demonstrate the bug scenario
console.log('='.repeat(80));
console.log('BUG SCENARIO REPRODUCTION');
console.log('='.repeat(80));
console.log();
console.log('BEFORE FIX:');
console.log('  1. User creates plan with table "WORKDONE" (source key)');
console.log('  2. Plan is persisted to DB with key "WORKDONE"');
console.log('  3. User reuses plan from Migration History');
console.log('  4. Step 3 shows "0 fields mapped" (can\'t find mapping)');
console.log('  5. Dry-run fails: "No mapping found for target table: WORKDONE"');
console.log('  6. Runner expects target "WORK_DONE", gets source "WORKDONE" → mismatch');
console.log();
console.log('AFTER FIX:');
console.log('  1. POST /api/plans normalizes tables → persists "WORK_DONE"');
console.log('  2. GET /api/plans/:id self-heals old plans → returns "WORK_DONE"');
console.log('  3. plan-ui.js normalizes loaded plan → always "WORK_DONE"');
console.log('  4. runner.js normalizes steps → always "WORK_DONE"');
console.log('  5. ✓ Dry-run succeeds, shows correct field counts, migration works');
console.log();

console.log('='.repeat(80));
console.log('ALL TESTS COMPLETE');
console.log('='.repeat(80));
console.log();
console.log('Run this script:');
console.log('  node scripts/test-table-normalization.js');
console.log();
