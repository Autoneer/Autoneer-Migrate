# Autoneer Migration Refactoring - Phase 1 Implementation

## Overview

This refactoring implements a clean separation of concerns between **schema discovery**, **persistent mapping profiles**, **session-specific migration plans**, and **execution**. This reduces complexity, improves testability, and enables better error handling.

## New Architecture

### Core Components

```
src/migrate/
├── models/           # Data models
│   ├── Schema.js     # Database schema representation
│   ├── FieldMap.js   # Column transformation definition
│   ├── Mapping.js    # Persistent mapping profile
│   ├── Plan.js       # Session-specific migration plan
│   ├── Run.js        # Execution state tracking
│   └── index.js      # Central export
├── validators/       # Validation logic
│   ├── SchemaValidator.js    # Schema compatibility checks
│   ├── MappingValidator.js   # Mapping validation
│   ├── PlanValidator.js      # Pre-run validation
│   └── index.js
├── executors/        # Execution logic
│   ├── PreflightExecutor.js  # Pre-run checks
│   ├── TableExecutor.js      # Single-table migration
│   └── index.js
```

### API Routes

```
src/routes/
├── schema.js         # Schema discovery and caching
└── (existing routes to be updated)
```

## Data Flow

```
1. Schema Discovery
   └─> Schema.js (cached)

2. Mapping Creation
   └─> Mapping.js (persistent, reusable)
       └─> FieldMap.js (per-column config)

3. Plan Creation
   └─> Plan.js (session-specific)
       └─> Uses Mapping + adds run config

4. Validation
   └─> PlanValidator validates against Schema

5. Execution
   └─> PreflightExecutor (checks)
   └─> TableExecutor (per-table migration)
   └─> Run.js (tracks progress)
```

## Key Features

### 1. Schema Model (`Schema.js`)
- Discovers Firebird and MySQL schemas
- Caches metadata for performance
- Provides query methods for tables and columns
- Normalizes type information

**Usage:**
```javascript
const Schema = require('./models/Schema');

const schema = new Schema();
await schema.discoverFirebird(firebirdConfig);
await schema.discoverMySQL(mysqlConfig, schemaName);

// Cache for later use
await schema.saveCache('./data/schema_cache.json');

// Query
const table = schema.getTable('mysql', 'customers');
const column = schema.getColumn('firebird', 'CUSTOMERS', 'CID');
```

### 2. FieldMap Model (`FieldMap.js`)
- Defines how one column maps to another
- Includes transforms, defaults, and lookups
- Validates type compatibility

**Usage:**
```javascript
const FieldMap = require('./models/FieldMap');

const field = new FieldMap('OLD_NAME', 'new_name', {
  transform: 'trim',
  defaultValue: 'N/A'
});

const validation = field.validate(sourceColumnMeta, targetColumnMeta);
```

### 3. Mapping Model (`Mapping.js`)
- Persistent, reusable mapping profile
- Maps source tables → target tables
- Contains all FieldMaps
- Validates against Schema

**Usage:**
```javascript
const Mapping = require('./models/Mapping');
const FieldMap = require('./models/FieldMap');

const mapping = new Mapping(uuid(), 'Production Mapping');

const fieldMaps = new Map();
fieldMaps.set('CID', new FieldMap('CID', 'customer_id'));
fieldMaps.set('NAME', new FieldMap('NAME', 'customer_name', { transform: 'trim' }));

mapping.addTable('CUSTOMERS', 'customers', fieldMaps);

// Validate against schema
const validation = mapping.validate(schema);
```

### 4. Plan Model (`Plan.js`)
- Session-specific migration configuration
- References a Mapping (doesn't copy it)
- Adds per-table run config: mode, keyStrategy, dedupeKeys
- Tracks validation state

**Usage:**
```javascript
const Plan = require('./models/Plan');

const plan = new Plan(mapping.id, mapping.name);

plan.addTable('customers', {
  mode: 'UPSERT',
  keyStrategy: 'rekey',
  dedupeKeys: ['email'],
  onDuplicate: 'UPDATE',
  cleanBefore: false
});

// Or create from mapping with defaults
const plan = Plan.fromMapping(mapping, { mode: 'INSERT' });
```

### 5. Run Model (`Run.js`)
- Tracks execution state
- Per-table progress and results
- Totals and statistics
- Error tracking

**Usage:**
```javascript
const Run = require('./models/Run');

const run = new Run(runId, plan, { dryRun: false, batchSize: 500 });

run.startTable('customers');
// ... migration happens ...
run.recordTableSuccess('customers', { inserted: 1000, updated: 50 });
```

## Validators

### SchemaValidator
- Validates table and column existence
- Checks primary key compatibility
- Validates field mappings

### MappingValidator
- Full mapping validation against schema
- Completeness checks
- Type compatibility warnings

### PlanValidator
- Pre-run validation
- Mode/strategy validation
- Dedupe key validation
- Dry-run simulation

## Executors

### PreflightExecutor
- Connectivity checks
- Schema validation
- Foreign key state
- Configuration validation

### TableExecutor
- Single-table migration
- Batch processing
- Transform application
- Progress tracking

## API Endpoints

### Schema Routes

```
GET  /api/schemas              - Get cached schemas
POST /api/schemas/refresh      - Force re-discovery
GET  /api/schemas/firebird     - Get Firebird schema only
GET  /api/schemas/mysql        - Get MySQL schema only
GET  /api/schemas/table/:db/:tableName - Get table metadata
```

### Mapping Routes (Phase 2)

```
GET    /api/mappings                    - List all mapping profiles
POST   /api/mappings                    - Create new mapping profile
GET    /api/mappings/:id                - Get specific mapping
PUT    /api/mappings/:id                - Update mapping profile
DELETE /api/mappings/:id                - Delete mapping profile
POST   /api/mappings/:id/validate       - Validate mapping against schemas
POST   /api/mappings/convert-legacy     - Convert old mapping.default.json
```

**Example - Create Mapping:**
```bash
curl -X POST http://localhost:3000/api/mappings \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Mapping",
    "tables": {
      "CUSTOMERS": {
        "target": "customers",
        "columns": {
          "CID": { "target": "customer_id" },
          "NAME": { "target": "customer_name", "transform": "trim" }
        }
      }
    }
  }'
```

**Example - Validate Mapping:**
```bash
curl -X POST http://localhost:3000/api/mappings/abc-123/validate
```

### Plan Routes (Phase 2)

```
GET    /api/plans                       - List all plans
POST   /api/plans                       - Create plan from mapping
GET    /api/plans/:id                   - Get specific plan
PUT    /api/plans/:id                   - Update plan configuration
DELETE /api/plans/:id                   - Delete plan
POST   /api/plans/:id/validate          - Validate plan
POST   /api/plans/:id/dry-run           - Simulate migration for one table
```

**Example - Create Plan:**
```bash
curl -X POST http://localhost:3000/api/plans \
  -H "Content-Type: application/json" \
  -d '{
    "mappingId": "abc-123",
    "name": "Evening Migration"
  }'
```

**Example - Update Plan Table Config:**
```bash
curl -X PUT http://localhost:3000/api/plans/5 \
  -H "Content-Type: application/json" \
  -d '{
    "tables": {
      "customers": {
        "mode": "UPSERT",
        "keyStrategy": "rekey",
        "dedupeKeys": ["email"],
        "onDuplicate": "UPDATE"
      }
    }
  }'
```

**Example - Dry Run:**
```bash
curl -X POST http://localhost:3000/api/plans/5/dry-run \
  -H "Content-Type: application/json" \
  -d '{ "tableName": "customers" }'
```

### Run Routes (Phase 2)

```
GET    /api/runs                        - List all runs
GET    /api/runs/:runId                 - Get detailed run information
GET    /api/runs/:runId/progress        - Get real-time progress
GET    /api/runs/:runId/tables          - Get table-level results
GET    /api/runs/:runId/summary         - Get summary statistics
DELETE /api/runs/:runId                 - Delete run record
```

**Example - Get Run Progress:**
```bash
curl http://localhost:3000/api/runs/20250120_140530/progress
```

**Response:**
```json
{
  "success": true,
  "runId": "20250120_140530",
  "status": "RUNNING",
  "progress": 65,
  "estimatedSecondsRemaining": 45,
  "tablesCompleted": 13,
  "tablesTotal": 20,
  "tablesFailed": 0
}
```

**Example - Get Run Summary:**
```bash
curl http://localhost:3000/api/runs/20250120_140530/summary
```

**Response:**
```json
{
  "success": true,
  "summary": {
    "runId": "20250120_140530",
    "status": "COMPLETED",
    "dryRun": false,
    "startedAt": "2025-01-20T14:05:30Z",
    "completedAt": "2025-01-20T14:12:45Z",
    "durationMs": 435000,
    "tables": {
      "total": 20,
      "completed": 20,
      "failed": 0,
      "pending": 0
    },
    "rows": {
      "migrated": 150000,
      "inserted": 120000,
      "updated": 30000,
      "skipped": 500,
      "errors": 0
    }
  }
}
```

## Database Schema

New tables created by `data/add_refactoring_tables.sql`:

1. **migration_mappings** - Stores reusable mapping profiles
2. **migration_plans** - Stores session-specific plans
3. **migration_schemas** - Caches discovered schemas
4. **migration_settings** - Application settings

Updated table:
- **migration_runs** - Now links to plans and mappings

## Migration Guide

### Converting Old Mappings

```javascript
const Mapping = require('./models/Mapping');

// Load old mapping.default.json
const oldMapping = JSON.parse(fs.readFileSync('mapping.default.json'));

// Convert to new format
const newMapping = Mapping.fromLegacyFormat(oldMapping);

// Save to database or file
await saveMappingToDB(newMapping.toJSON());
```

### Using the New System

```javascript
// 1. Discover schemas (once, or when schema changes)
const schema = new Schema();
await schema.discoverFirebird(config.firebird);
await schema.discoverMySQL(config.mysql, config.schemaName);
await schema.saveCache('./data/schema_cache.json');

// 2. Create or load mapping
const mapping = new Mapping(uuid(), 'My Mapping');
// ... add tables and field maps ...

// 3. Validate mapping
const validation = mapping.validate(schema);
if (!validation.valid) {
  console.log('Mapping issues:', validation.issues);
}

// 4. Create plan for this run
const plan = Plan.fromMapping(mapping);
plan.updateTable('customers', { mode: 'UPSERT', dedupeKeys: ['email'] });

// 5. Validate plan
const planValidation = await PlanValidator.validate(plan, mapping, schema);
if (!planValidation.canProceed) {
  console.log('Plan blockers:', planValidation.blockers);
  return;
}

// 6. Execute
const run = new Run(runId, plan);
// ... execute migration ...
```

## Testing

### Unit Tests
Run tests for individual models:
```bash
npm test -- models/Schema.test.js
npm test -- models/Mapping.test.js
npm test -- validators/PlanValidator.test.js
```

### Integration Tests
Test full migration flow:
```bash
npm test -- integration/full-migration.test.js
```

## Benefits

### Before Refactoring
- ❌ 2000+ line `runner.js` with too many responsibilities
- ❌ Overlapping data in plan, mapping, and state
- ❌ Schema validation at runtime
- ❌ Hard to test and maintain
- ❌ Confusing error messages

### After Refactoring
- ✅ Focused, single-responsibility classes
- ✅ Clear separation: Schema → Mapping → Plan → Run
- ✅ Schema validation before run
- ✅ Testable components
- ✅ Clear error messages with hints
- ✅ Reusable mapping profiles
- ✅ Better caching and performance

## Next Steps (Phase 3+)

**Phase 2 is now complete!** ✅

All core API routes have been implemented:
- ✅ Mapping CRUD endpoints
- ✅ Plan management endpoints  
- ✅ Run tracking endpoints
- ✅ Validation and dry-run capabilities

### Future Enhancements (Phase 3)

1. Update existing UI to consume new API endpoints
2. Create dedicated mapping management page
3. Add real-time WebSocket updates for run progress
4. Implement webhooks for run notifications
5. Add scheduled migrations
6. Enhanced reporting and analytics dashboard
7. Export/import mapping profiles
8. Template library for common migrations

## Compatibility

### Backward Compatibility
- Old `mapping.default.json` format is supported via `Mapping.fromLegacyFormat()`
- Existing `migration_runs` table is preserved
- Existing routes continue to work

### Migration Path
1. Run `data/add_refactoring_tables.sql` to create new tables
2. Convert existing mappings using `Mapping.fromLegacyFormat()`
3. Gradually migrate routes to use new models
4. Update UI to use new API endpoints

## Support

For questions or issues:
1. Check this README
2. Review code comments in model files
3. Check `AUDIT_AND_REFACTORING_PLAN.md` for design decisions

## License

Same as parent project
