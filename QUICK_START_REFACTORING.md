# Phase 1 Refactoring - Quick Start Guide

## What Has Been Implemented

### ✅ Core Models (Complete)
- `Schema.js` - Database schema discovery and caching
- `FieldMap.js` - Column-level transformation definitions
- `Mapping.js` - Reusable mapping profiles
- `Plan.js` - Session-specific migration plans
- `Run.js` - Execution state tracking

### ✅ Validators (Complete)
- `SchemaValidator.js` - Table/column existence checks
- `MappingValidator.js` - Mapping completeness and correctness
- `PlanValidator.js` - Pre-run validation and dry-run simulation

### ✅ Executors (Complete)
- `PreflightExecutor.js` - Pre-migration checks
- `TableExecutor.js` - Single-table migration execution

### ✅ API Routes (Partial)
- `routes/schema.js` - Schema discovery and caching endpoints

### ✅ Database Migration
- `data/add_refactoring_tables.sql` - Creates new tables

## Getting Started

### 1. Apply Database Migrations

Run the SQL migration script on your MySQL database:

```bash
mysql -u your_user -p your_database < data/add_refactoring_tables.sql
```

Or using a MySQL client:
```sql
SOURCE data/add_refactoring_tables.sql;
```

### 2. Test Schema Discovery

Start your application and test the schema API:

```bash
# Refresh schemas
curl -X POST http://localhost:3000/api/schemas/refresh

# Get cached schemas
curl http://localhost:3000/api/schemas

# Get Firebird tables
curl http://localhost:3000/api/schemas/firebird

# Get specific table metadata
curl http://localhost:3000/api/schemas/table/mysql/customers
```

### 3. Use New Models in Code

```javascript
// Example: Create a mapping programmatically
const { Mapping, FieldMap } = require('./src/migrate/models');
const { v4: uuidv4 } = require('uuid');

// Create a new mapping
const mapping = new Mapping(uuidv4(), 'Production Mapping');

// Add a table mapping
const fieldMaps = new Map();
fieldMaps.set('CID', new FieldMap('CID', 'customer_id', { transform: 'toNumber' }));
fieldMaps.set('NAME', new FieldMap('NAME', 'customer_name', { transform: 'trim' }));
fieldMaps.set('EMAIL', new FieldMap('EMAIL', 'email', { transform: 'toLowerCase' }));

mapping.addTable('CUSTOMERS', 'customers', fieldMaps);

// Save to file
const fs = require('fs').promises;
await fs.writeFile('./my-mapping.json', JSON.stringify(mapping.toJSON(), null, 2));
```

### 4. Validate a Mapping

```javascript
const { Schema } = require('./src/migrate/models');
const { MappingValidator } = require('./src/migrate/validators');

// Load schema
const schema = new Schema();
await schema.loadCache('./data/schema_cache.json');

// Validate mapping
const validation = MappingValidator.validateMapping(mapping, schema);

if (!validation.valid) {
  console.log('Mapping errors:', validation.errors);
} else {
  console.log('Mapping is valid!');
}
```

### 5. Create and Validate a Plan

```javascript
const { Plan } = require('./src/migrate/models');
const { PlanValidator } = require('./src/migrate/validators');

// Create plan from mapping
const plan = Plan.fromMapping(mapping, {
  mode: 'INSERT',
  keyStrategy: 'preserve',
  batchSize: 500
});

// Customize per-table config
plan.updateTable('customers', {
  mode: 'UPSERT',
  dedupeKeys: ['email'],
  onDuplicate: 'UPDATE'
});

// Validate plan
const planValidation = await PlanValidator.validate(plan, mapping, schema);

if (!planValidation.canProceed) {
  console.log('Plan blockers:', planValidation.blockers);
} else {
  console.log('Plan is ready to execute!');
}
```

## Testing the New Components

### Unit Test Example

Create `tests/models/Schema.test.js`:

```javascript
const Schema = require('../../src/migrate/models/Schema');

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

  test('should get table metadata', () => {
    // Add mock table
    schema.firebird.tables['TEST'] = {
      name: 'TEST',
      columns: {},
      primaryKey: []
    };

    expect(schema.tableExists('firebird', 'TEST')).toBe(true);
    expect(schema.tableExists('firebird', 'NOTEXIST')).toBe(false);
  });
});
```

Run tests:
```bash
npm test
```

## Integration with Existing Code

### Option 1: Gradual Migration (Recommended)

Keep existing routes working while adding new ones:

1. Existing routes continue using old flow
2. New API routes use new models
3. Gradually update existing routes to use new models
4. Eventually deprecate old code

### Option 2: Convert Existing Mappings

```javascript
const { Mapping } = require('./src/migrate/models');
const fs = require('fs').promises;

// Load old mapping
const oldMapping = JSON.parse(
  await fs.readFile('./src/migrate/mapping.default.json', 'utf8')
);

// Convert to new format
const newMapping = Mapping.fromLegacyFormat(oldMapping);

// Save
await fs.writeFile(
  './mappings/converted-mapping.json',
  JSON.stringify(newMapping.toJSON(), null, 2)
);
```

## Next Development Tasks

### High Priority
1. ✅ Core models and validators (DONE)
2. ✅ Basic API routes for schema (DONE)
3. 🔄 Create mapping management UI
4. 🔄 Update existing migration routes to use new models
5. 🔄 Add comprehensive error handling

### Medium Priority
6. 🔄 Create unit tests for all models
7. 🔄 Create integration tests
8. 🔄 Add API documentation (Swagger/OpenAPI)
9. 🔄 Implement mapping CRUD endpoints
10. 🔄 Create plan management endpoints

### Low Priority
11. 🔄 Add more transform functions
12. 🔄 Implement webhooks for notifications
13. 🔄 Add scheduled migrations
14. 🔄 Enhanced reporting dashboard

## Common Issues and Solutions

### Issue: "Schema cache is stale"
**Solution:** Call `POST /api/schemas/refresh` to rediscover schemas

### Issue: "Mapping validation fails"
**Solution:** Check validation errors and fix field mappings or ensure tables exist

### Issue: "Transform function not found"
**Solution:** Ensure transform name matches one in `FieldMap.isValidTransform()` list

### Issue: "Primary key mismatch"
**Solution:** Check that both source and target tables have compatible primary keys

## Code Organization

```
src/migrate/
├── models/           # ✅ DONE - Data models
├── validators/       # ✅ DONE - Validation logic
├── executors/        # ✅ DONE - Execution logic
├── mappers/          # Existing - Transform functions
│   ├── index.js
│   └── transforms.js
└── (old files)       # Keep for now, gradually deprecate
    ├── runner.js     # 2000+ lines - will be replaced by executors
    ├── migrationPlan.js
    └── mapping.default.json
```

## Key Concepts

### Separation of Concerns

1. **Schema** = What exists in databases (discovered)
2. **Mapping** = How to transform data (persistent, reusable)
3. **Plan** = What to migrate in this session (ephemeral)
4. **Run** = Execution state (tracking)

### Validation Layers

1. **Schema Level** - Do tables/columns exist?
2. **Mapping Level** - Are transforms valid? Types compatible?
3. **Plan Level** - Is configuration correct? Can we proceed?
4. **Preflight** - Can we connect? Are prerequisites met?

### Data Flow

```
Setup (existing)
  ↓
Schema Discovery (new API)
  ↓
Mapping Creation (new models)
  ↓
Plan Configuration (new models)
  ↓
Validation (new validators)
  ↓
Execution (new executors)
  ↓
Results (existing, can be enhanced)
```

## Support and Documentation

- **Full Documentation**: See [REFACTORING_README.md](REFACTORING_README.md)
- **Architecture Details**: See [AUDIT_AND_REFACTORING_PLAN.md](AUDIT_AND_REFACTORING_PLAN.md)
- **Code Examples**: Check comments in model files
- **API Docs**: Coming soon

## Contributing

When adding new features:

1. Follow the model → validator → executor pattern
2. Add unit tests for new models
3. Update this guide with usage examples
4. Document new API endpoints
5. Maintain backward compatibility

## Questions?

Check the code comments - every model, validator, and executor has detailed JSDoc comments explaining usage and parameters.
