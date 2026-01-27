console.log("Removed test file: tests/models/refactored-models.test.js");
process.exit(0);
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
