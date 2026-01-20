/**
 * Sample unit tests for the new refactored models
 * Run with: npm test
 * 
 * To add these tests to your project:
 * 1. Install jest: npm install --save-dev jest
 * 2. Add to package.json: "scripts": { "test": "jest" }
 * 3. Create tests/ directory
 */

const Schema = require('../../src/migrate/models/Schema');
const FieldMap = require('../../src/migrate/models/FieldMap');
const Mapping = require('../../src/migrate/models/Mapping');
const Plan = require('../../src/migrate/models/Plan');
const Run = require('../../src/migrate/models/Run');

describe('Schema Model', () => {
	let schema;

	beforeEach(() => {
		schema = new Schema();
	});

	test('should create empty schema', () => {
		expect(schema.getTableNames('firebird')).toEqual([]);
		expect(schema.getTableNames('mysql')).toEqual([]);
	});

	test('should check if cached', () => {
		expect(schema.isCached()).toBe(false);
	});

	test('should store and retrieve table metadata', () => {
		schema.firebird.tables['TEST'] = {
			name: 'TEST',
			columns: {
				'ID': { name: 'ID', type: 'INTEGER', nullable: false }
			},
			primaryKey: ['ID']
		};
		schema.firebird.lastUpdated = new Date();

		expect(schema.tableExists('firebird', 'TEST')).toBe(true);
		expect(schema.tableExists('firebird', 'NOTEXIST')).toBe(false);

		const table = schema.getTable('firebird', 'test'); // Case insensitive
		expect(table.name).toBe('TEST');
	});

	test('should get column metadata', () => {
		schema.mysql.tables['USERS'] = {
			name: 'USERS',
			columns: {
				'EMAIL': { name: 'EMAIL', type: 'VARCHAR', nullable: false, length: 255 }
			},
			primaryKey: []
		};

		const column = schema.getColumn('mysql', 'users', 'email');
		expect(column.type).toBe('VARCHAR');
		expect(column.length).toBe(255);
	});

	test('should serialize and deserialize', () => {
		schema.firebird.tables['TEST'] = { name: 'TEST', columns: {}, primaryKey: [] };
		schema.firebird.lastUpdated = new Date();

		const json = schema.toJSON();
		const restored = Schema.fromJSON(json);

		expect(restored.tableExists('firebird', 'TEST')).toBe(true);
	});
});

describe('FieldMap Model', () => {
	test('should create field map', () => {
		const field = new FieldMap('OLD_NAME', 'new_name', {
			transform: 'trim',
			defaultValue: 'N/A'
		});

		expect(field.sourceColumn).toBe('OLD_NAME');
		expect(field.targetColumn).toBe('NEW_NAME');
		expect(field.transform).toBe('trim');
	});

	test('should validate type compatibility', () => {
		const field = new FieldMap('ID', 'id');

		// Same type
		let check = field.checkTypeCompatibility('INTEGER', 'INTEGER');
		expect(check.safe).toBe(true);

		// Safe conversion
		check = field.checkTypeCompatibility('SMALLINT', 'INTEGER');
		expect(check.safe).toBe(true);

		// Risky conversion
		check = field.checkTypeCompatibility('VARCHAR', 'INTEGER');
		expect(check.safe).toBe(false);
		expect(check.risk).toBe('high');
	});

	test('should validate against column metadata', () => {
		const field = new FieldMap('NAME', 'customer_name', { transform: 'trim' });

		const sourceCol = { name: 'NAME', type: 'VARCHAR', nullable: true, length: 100 };
		const targetCol = { name: 'CUSTOMER_NAME', type: 'VARCHAR', nullable: false, length: 255 };

		const validation = field.validate(sourceCol, targetCol);

		expect(validation.valid).toBe(true);
		expect(validation.warnings.length).toBeGreaterThan(0); // Nullable warning
	});

	test('should check valid transforms', () => {
		const field = new FieldMap('COL', 'col');

		expect(field.isValidTransform('trim')).toBe(true);
		expect(field.isValidTransform('toNumber')).toBe(true);
		expect(field.isValidTransform('invalidTransform')).toBe(false);
	});

	test('should serialize to JSON', () => {
		const field = new FieldMap('SRC', 'tgt', { transform: 'trim', defaultValue: 'default' });
		const json = field.toJSON();

		expect(json.sourceColumn).toBe('SRC');
		expect(json.targetColumn).toBe('TGT');
		expect(json.transform).toBe('trim');

		const restored = FieldMap.fromJSON(json);
		expect(restored.sourceColumn).toBe('SRC');
	});
});

describe('Mapping Model', () => {
	test('should create mapping', () => {
		const mapping = new Mapping('123', 'Test Mapping');

		expect(mapping.id).toBe('123');
		expect(mapping.name).toBe('Test Mapping');
		expect(mapping.getSourceTables()).toEqual([]);
	});

	test('should add table with field maps', () => {
		const mapping = new Mapping('123', 'Test Mapping');

		const fieldMaps = new Map();
		fieldMaps.set('ID', new FieldMap('ID', 'customer_id'));
		fieldMaps.set('NAME', new FieldMap('NAME', 'customer_name'));

		mapping.addTable('CUSTOMERS', 'customers', fieldMaps);

		expect(mapping.getSourceTables()).toContain('CUSTOMERS');
		expect(mapping.getTargetTable('CUSTOMERS')).toBe('CUSTOMERS');

		const retrievedMaps = mapping.getFieldMaps('CUSTOMERS');
		expect(retrievedMaps.size).toBe(2);
	});

	test('should get source table by target table', () => {
		const mapping = new Mapping('123', 'Test Mapping');
		mapping.addTable('OLD_TABLE', 'new_table', new Map());

		expect(mapping.getSourceTable('new_table')).toBe('OLD_TABLE');
		expect(mapping.getSourceTable('nonexistent')).toBeNull();
	});

	test('should serialize and deserialize', () => {
		const mapping = new Mapping('123', 'Test Mapping');
		mapping.addTable('TEST', 'test', new Map([
			['COL1', new FieldMap('COL1', 'col1')]
		]));

		const json = mapping.toJSON();
		const restored = Mapping.fromJSON(json);

		expect(restored.id).toBe('123');
		expect(restored.getSourceTables()).toContain('TEST');
	});
});

describe('Plan Model', () => {
	test('should create plan', () => {
		const plan = new Plan('mapping-123', 'Test Mapping');

		expect(plan.mappingId).toBe('mapping-123');
		expect(plan.mappingName).toBe('Test Mapping');
		expect(plan.isValidated).toBe(false);
	});

	test('should add table configuration', () => {
		const plan = new Plan('mapping-123', 'Test Mapping');

		plan.addTable('customers', {
			mode: 'UPSERT',
			keyStrategy: 'rekey',
			dedupeKeys: ['email'],
			onDuplicate: 'UPDATE'
		});

		const config = plan.getTableConfig('customers');
		expect(config.mode).toBe('UPSERT');
		expect(config.dedupeKeys).toContain('email');
	});

	test('should track validation state', () => {
		const plan = new Plan('mapping-123', 'Test Mapping');

		expect(plan.isReady()).toBe(false);

		plan.recordValidation([], ['warning1']);
		expect(plan.isReady()).toBe(true);

		plan.recordValidation(['error1'], []);
		expect(plan.isReady()).toBe(false);
	});

	test('should get summary', () => {
		const plan = new Plan('mapping-123', 'Test Mapping');
		plan.addTable('table1', { mode: 'INSERT' });
		plan.addTable('table2', { mode: 'UPSERT' });

		const summary = plan.getSummary();
		expect(summary.tableCount).toBe(2);
		expect(summary.modes.INSERT).toBe(1);
		expect(summary.modes.UPSERT).toBe(1);
	});

	test('should create plan from mapping', () => {
		const mapping = new Mapping('123', 'Test Mapping');
		mapping.addTable('SRC1', 'tgt1', new Map());
		mapping.addTable('SRC2', 'tgt2', new Map());

		const plan = Plan.fromMapping(mapping, { mode: 'INSERT' });

		expect(plan.getIncludedTables()).toContain('TGT1');
		expect(plan.getIncludedTables()).toContain('TGT2');
		expect(plan.getTableConfig('tgt1').mode).toBe('INSERT');
	});
});

describe('Run Model', () => {
	let plan;

	beforeEach(() => {
		plan = new Plan('mapping-123', 'Test Mapping');
		plan.addTable('customers', { mode: 'INSERT' });
		plan.addTable('orders', { mode: 'INSERT' });
	});

	test('should create run', () => {
		const run = new Run(1, plan, { dryRun: false, batchSize: 500 });

		expect(run.id).toBe(1);
		expect(run.status).toBe('RUNNING');
		expect(run.isActive()).toBe(true);
	});

	test('should track table progress', () => {
		const run = new Run(1, plan);

		run.startTable('customers');
		expect(run.currentTable).toBe('customers');

		run.recordTableSuccess('customers', { inserted: 100, updated: 0, skipped: 5 });

		expect(run.totals.inserted).toBe(100);
		expect(run.totals.skipped).toBe(5);
	});

	test('should calculate progress', () => {
		const run = new Run(1, plan);

		expect(run.getProgress()).toBe(0);

		run.recordTableSuccess('customers', { inserted: 100 });
		expect(run.getProgress()).toBe(50); // 1 of 2 tables

		run.recordTableSuccess('orders', { inserted: 200 });
		expect(run.getProgress()).toBe(100); // 2 of 2 tables
	});

	test('should track failures', () => {
		const run = new Run(1, plan);

		run.recordTableFailure('customers', 'Connection failed', 'Check database settings');

		expect(run.status).toBe('FAILED');
		expect(run.lastError.message).toBe('Connection failed');
		expect(run.getFailedTables()).toContain('CUSTOMERS');
	});

	test('should finish run', () => {
		const run = new Run(1, plan);

		run.finish('SUCCESS');

		expect(run.status).toBe('SUCCESS');
		expect(run.isComplete()).toBe(true);
		expect(run.isActive()).toBe(false);
	});

	test('should serialize to JSON', () => {
		const run = new Run(1, plan);
		run.recordTableSuccess('customers', { inserted: 100 });

		const json = run.toJSON();

		expect(json.id).toBe(1);
		expect(json.status).toBe('RUNNING');
		expect(json.totals.inserted).toBe(100);
	});
});

describe('Integration: Full Workflow', () => {
	test('should complete full workflow', () => {
		// 1. Create schema
		const schema = new Schema();
		schema.firebird.tables['CUSTOMERS'] = {
			name: 'CUSTOMERS',
			columns: {
				'CID': { name: 'CID', type: 'INTEGER', nullable: false },
				'NAME': { name: 'NAME', type: 'VARCHAR', nullable: true, length: 100 }
			},
			primaryKey: ['CID']
		};
		schema.mysql.tables['CUSTOMERS'] = {
			name: 'CUSTOMERS',
			columns: {
				'CUSTOMER_ID': { name: 'CUSTOMER_ID', type: 'INT', nullable: false },
				'CUSTOMER_NAME': { name: 'CUSTOMER_NAME', type: 'VARCHAR', nullable: true, length: 255 }
			},
			primaryKey: ['CUSTOMER_ID']
		};

		// 2. Create mapping
		const mapping = new Mapping('123', 'Production Mapping');
		const fieldMaps = new Map();
		fieldMaps.set('CID', new FieldMap('CID', 'customer_id'));
		fieldMaps.set('NAME', new FieldMap('NAME', 'customer_name', { transform: 'trim' }));
		mapping.addTable('CUSTOMERS', 'customers', fieldMaps);

		// 3. Validate mapping
		const validation = mapping.validate(schema);
		expect(validation.valid).toBe(true);

		// 4. Create plan
		const plan = Plan.fromMapping(mapping);
		plan.updateTable('customers', { mode: 'INSERT', batchSize: 500 });

		expect(plan.getIncludedTables()).toContain('CUSTOMERS');

		// 5. Create run
		const run = new Run(1, plan);
		expect(run.isActive()).toBe(true);

		// 6. Simulate execution
		run.startTable('customers');
		run.recordTableSuccess('customers', { inserted: 1000, updated: 0, skipped: 0 });
		run.finish('SUCCESS');

		expect(run.isComplete()).toBe(true);
		expect(run.totals.inserted).toBe(1000);
	});
});
