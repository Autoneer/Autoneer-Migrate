/*
Manual verification checklist:
- Run the app and open Mapping UI
- Create mapping: map source CUSTOMER -> target CUSTOMERS
- In Edit Fields modal, tick OMIT for TEL_HOME and save
- In DB (mapping_json), confirm TEL_HOME object has "omit": true and "targetColumn": null
- Run a dry run; it should NOT fail with "MySQL missing columns: TEL_HOME"

This script also performs an automated check for the above behavior.
*/
// Simple test script to validate omit persistence and requiredTargets behavior
const Mapping = require('../src/migrate/models/Mapping');

function run() {
	const payload = {
		id: 'test-id',
		name: 'omit-test',
		tables: {
			CUSTOMERS: {
				targetTable: 'CUSTOMERS',
				columns: {
					TEL_HOME: {
						sourceColumn: 'TEL_HOME',
						targetColumn: null,
						omit: true
					}
				}
			}
		}
	};

	const mapping = Mapping.fromJSON(payload);
	const tableConfig = mapping.tables['CUSTOMERS'];
	if (!tableConfig) {
		console.error('FAIL: table missing');
		process.exit(1);
	}

	const col = tableConfig.columns['TEL_HOME'];
	if (!col) {
		console.error('FAIL: column missing from mapping JSON');
		process.exit(1);
	}

	if (col.omit !== true) {
		console.error('FAIL: omit not preserved (expected true)');
		process.exit(1);
	}

	if (col.targetColumn !== null) {
		console.error('FAIL: targetColumn was forced (expected null)');
		process.exit(1);
	}

	// Simulate runner requiredTargets computation
	const columnsMap = tableConfig.columns;
	const requiredTargets = Object.values(columnsMap || {})
		.filter(c => c && c.omit !== true)
		.map(c => c.targetColumn)
		.filter(Boolean);

	if (requiredTargets.length !== 0) {
		console.error('FAIL: omitted column included in requiredTargets:', requiredTargets);
		process.exit(1);
	}

	console.log('PASS: omit preserved and omitted columns excluded from requiredTargets');
}

run();
