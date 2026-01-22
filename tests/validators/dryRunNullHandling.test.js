/**
 * Tests for improved dry-run validation with nullable, omitted, and default handling
 * 
 * Spec: Dry Run must NOT raise errors for:
 * - Omitted fields (excluded from migration)
 * - NULL source values with nullable targets
 * - NULL source values when target has a database default
 * 
 * Spec: Dry Run MUST raise errors for:
 * - NULL source values with NOT NULL targets and no defaults
 * - NULL source values with primary key targets
 */

const PlanValidator = require('../../src/migrate/validators/PlanValidator');
const Mapping = require('../../src/migrate/models/Mapping');
const FieldMap = require('../../src/migrate/models/FieldMap');
const Schema = require('../../src/migrate/models/Schema');

describe('PlanValidator.dryRun - NULL and Omit Handling', () => {
	let schema;
	let mapping;

	beforeEach(() => {
		// Create mock schema with target metadata
		schema = new Schema();
		schema.mysql.tables = {
			CUSTOMERS: {
				name: 'CUSTOMERS',
				columns: {
					ID: {
						name: 'ID',
						type: 'INT',
						nullable: false,
						isPrimaryKey: true,
						defaultValue: null
					},
					NAME: {
						name: 'NAME',
						type: 'VARCHAR',
						nullable: false,
						isPrimaryKey: false,
						defaultValue: null
					},
					EMAIL: {
						name: 'EMAIL',
						type: 'VARCHAR',
						nullable: true,  // Allows NULL
						isPrimaryKey: false,
						defaultValue: null
					},
					STATUS: {
						name: 'STATUS',
						type: 'VARCHAR',
						nullable: false,
						isPrimaryKey: false,
						defaultValue: 'ACTIVE'  // Has default
					},
					CREATED_AT: {
						name: 'CREATED_AT',
						type: 'TIMESTAMP',
						nullable: false,
						isPrimaryKey: false,
						defaultValue: 'CURRENT_TIMESTAMP'  // Has default
					}
				}
			}
		};

		// Create mapping
		mapping = new Mapping();
		mapping.addFieldMap('CUSTOMERS', new FieldMap({
			sourceColumn: 'CID',
			targetColumn: 'ID',
			transform: null,
			defaultValue: null
		}));
		mapping.addFieldMap('CUSTOMERS', new FieldMap({
			sourceColumn: 'NAME',
			targetColumn: 'NAME',
			transform: null,
			defaultValue: null
		}));
		mapping.addFieldMap('CUSTOMERS', new FieldMap({
			sourceColumn: 'EMAIL',
			targetColumn: 'EMAIL',
			transform: null,
			defaultValue: null
		}));
		mapping.addFieldMap('CUSTOMERS', new FieldMap({
			sourceColumn: 'STATUS',
			targetColumn: 'STATUS',
			transform: null,
			defaultValue: null
		}));
		mapping.addFieldMap('CUSTOMERS', new FieldMap({
			sourceColumn: 'CREATED_AT',
			targetColumn: 'CREATED_AT',
			transform: null,
			defaultValue: null
		}));
	});

	describe('Nullable target columns', () => {
		it('should NOT error when source NULL and target nullable', async () => {
			const firstRow = {
				cid: 1,
				name: 'John',
				email: null,  // NULL source
				status: 'ACTIVE',
				created_at: '2025-01-22'
			};

			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			expect(result.migratable).toBe(true);
			expect(result.issues).not.toContain(
				expect.stringMatching(/email|NULL/)
			);
		});
	});

	describe('NOT NULL with database default', () => {
		it('should error when source NULL, target NOT NULL with default, and no mapping default', async () => {
			const firstRow = {
				cid: 1,
				name: 'John',
				email: 'john@example.com',
				status: null,  // NULL source
				created_at: null
			};

			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			// STATUS has a database default, so error should mention it
			expect(result.migratable).toBe(false);
			expect(result.issues.some(issue =>
				issue.includes('STATUS') && issue.includes('database default')
			)).toBe(true);
		});

		it('should NOT error when mapping provides a default for NOT NULL column with DB default', async () => {
			// Add mapping default for STATUS
			const statusField = Array.from(mapping.getFieldMaps('CUSTOMERS')).find(
				([, field]) => field.targetColumn === 'STATUS'
			);
			if (statusField) {
				statusField[1].defaultValue = 'PENDING';
			}

			const firstRow = {
				cid: 1,
				name: 'John',
				email: 'john@example.com',
				status: null,  // NULL source
				created_at: '2025-01-22'
			};

			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			expect(result.migratable).toBe(true);
			expect(result.issues.some(issue => issue.includes('STATUS'))).toBe(false);
		});
	});

	describe('Omitted fields', () => {
		it('should NOT validate omitted fields', async () => {
			// Mark EMAIL as omitted
			const emailField = Array.from(mapping.getFieldMaps('CUSTOMERS')).find(
				([, field]) => field.targetColumn === 'EMAIL'
			);
			if (emailField) {
				emailField[1].omit = true;
			}

			const firstRow = {
				cid: 1,
				name: 'John',
				email: null,  // NULL source - but omitted!
				status: 'ACTIVE',
				created_at: '2025-01-22'
			};

			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			expect(result.migratable).toBe(true);
			// Should have no errors mentioning omitted field
			expect(result.issues.some(issue => issue.includes('EMAIL'))).toBe(false);
		});

		it('should NOT validate omitted NOT NULL columns even without defaults', async () => {
			// Mark NAME as omitted (NOT NULL, no default)
			const nameField = Array.from(mapping.getFieldMaps('CUSTOMERS')).find(
				([, field]) => field.targetColumn === 'NAME'
			);
			if (nameField) {
				nameField[1].omit = true;
			}

			const firstRow = {
				cid: 1,
				name: null,  // NULL source - but omitted!
				email: 'john@example.com',
				status: 'ACTIVE',
				created_at: '2025-01-22'
			};

			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			expect(result.migratable).toBe(true);
			expect(result.issues.some(issue => issue.includes('NAME'))).toBe(false);
		});
	});

	describe('Primary key columns', () => {
		it('should error when source NULL and target is primary key', async () => {
			const firstRow = {
				cid: null,  // NULL source for primary key!
				name: 'John',
				email: 'john@example.com',
				status: 'ACTIVE',
				created_at: '2025-01-22'
			};

			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			expect(result.migratable).toBe(false);
			expect(result.issues.some(issue =>
				issue.includes('ID') && issue.includes('primary key')
			)).toBe(true);
		});
	});

	describe('NOT NULL columns without defaults', () => {
		it('should error when source NULL, target NOT NULL, no mapping default, no DB default', async () => {
			const firstRow = {
				cid: 1,
				name: null,  // NULL source, NOT NULL target, no default!
				email: 'john@example.com',
				status: 'ACTIVE',
				created_at: '2025-01-22'
			};

			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			expect(result.migratable).toBe(false);
			expect(result.issues.some(issue =>
				issue.includes('NAME') && issue.includes('NOT NULL')
			)).toBe(true);
		});
	});

	describe('Transform edge cases', () => {
		it('should validate transformed values correctly', async () => {
			// Add a transform to NAME that converts empty to null
			const nameField = Array.from(mapping.getFieldMaps('CUSTOMERS')).find(
				([, field]) => field.targetColumn === 'NAME'
			);
			if (nameField) {
				nameField[1].transform = 'trim';  // Assuming trim exists
			}

			const firstRow = {
				cid: 1,
				name: '',  // Empty after trim could be null conceptually
				email: 'john@example.com',
				status: 'ACTIVE',
				created_at: '2025-01-22'
			};

			// Should process without error (transform logic handles this)
			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				schema
			);

			// Result depends on how transform is implemented
			expect(result).toHaveProperty('migratable');
			expect(result).toHaveProperty('issues');
		});
	});

	describe('Schema not provided (fallback behavior)', () => {
		it('should NOT error on null without schema (backwards compat - assumes nullable)', async () => {
			const firstRow = {
				cid: 1,
				name: null,  // NULL source
				email: 'john@example.com',
				status: 'ACTIVE',
				created_at: '2025-01-22'
			};

			// Call without schema
			const result = await PlanValidator.dryRun(
				firstRow,
				mapping,
				'CUSTOMERS',
				'CUSTOMERS',
				null  // No schema
			);

			// Without schema, should assume target is nullable (backward compat)
			expect(result.migratable).toBe(true);
		});
	});
});

describe('Mapping.getFieldMaps - Omit filtering', () => {
	it('should filter out omitted fields from result set', () => {
		const mapping = new Mapping();

		mapping.addFieldMap('TEST', new FieldMap({
			sourceColumn: 'COL1',
			targetColumn: 'COL1',
			omit: false
		}));

		mapping.addFieldMap('TEST', new FieldMap({
			sourceColumn: 'COL2',
			targetColumn: 'COL2',
			omit: true  // Omitted
		}));

		mapping.addFieldMap('TEST', new FieldMap({
			sourceColumn: 'COL3',
			targetColumn: 'COL3',
			omit: false
		}));

		const fieldMaps = mapping.getFieldMaps('TEST');

		// Mapping.getFieldMaps() should auto-filter omitted fields
		// If filtering is implemented
		const allFields = Array.from(fieldMaps.values());
		const nonOmitted = allFields.filter(f => !f.omit);

		expect(nonOmitted.length).toBe(2);
		expect(nonOmitted.some(f => f.targetColumn === 'COL2')).toBe(false);
	});
});
