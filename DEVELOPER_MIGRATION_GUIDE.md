# Developer Migration Guide

This guide helps developers transition from the old system to the new refactored architecture.

## Quick Start

### What Changed?

**Before (Old System):**
- Single large `runner.js` file (~2000 lines)
- Mixing of concerns (schema, mapping, execution)
- State-based plan management
- No formal validation layer
- Limited API access

**After (New System):**
- Separated concerns (models, validators, executors)
- Clean REST API (28 endpoints)
- Model-based state management
- Comprehensive validation
- Full programmatic access

### Migration Strategy

You have two options:

#### Option 1: Use New APIs Exclusively
Start using new API endpoints for all new features. Existing UI continues to work.

#### Option 2: Gradual Migration
Use new APIs for new features while maintaining existing code.

## For Frontend Developers

### Using the New APIs

#### 1. Replace Direct State Access

**Before:**
```javascript
// Direct state manipulation
state.mapping = { ... };
state.plan = [ ... ];
```

**After:**
```javascript
// Use API endpoints
const response = await fetch('/api/mappings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'My Mapping', tables: { ... } })
});
const { mapping } = await response.json();
```

#### 2. Replace Page Navigation with API Calls

**Before:**
```javascript
// Navigate to validation page
window.location.href = '/plan';
```

**After:**
```javascript
// Validate via API
const response = await fetch(`/api/plans/${planId}/validate`, {
  method: 'POST'
});
const { validation } = await response.json();
// Display results inline
```

#### 3. Real-time Progress Tracking

**Before:**
```javascript
// Poll status endpoint
setInterval(async () => {
  const response = await fetch(`/migrate/run/${runId}/status`);
  const status = await response.json();
}, 5000);
```

**After:**
```javascript
// Use dedicated progress endpoint
setInterval(async () => {
  const response = await fetch(`/api/runs/${runId}/progress`);
  const { progress, estimatedSecondsRemaining } = await response.json();
  updateProgressBar(progress);
  updateETA(estimatedSecondsRemaining);
}, 2000);
```

### Common Patterns

#### Pattern: Create Mapping Profile

```javascript
async function createMappingProfile(name, tables) {
  const response = await fetch('/api/mappings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, tables })
  });
  
  if (!response.ok) {
    const { error } = await response.json();
    throw new Error(error);
  }
  
  const { mapping } = await response.json();
  return mapping.id;
}
```

#### Pattern: Validate and Fix Plan

```javascript
async function validateAndFixPlan(planId) {
  // Validate
  const validateResponse = await fetch(`/api/plans/${planId}/validate`, {
    method: 'POST'
  });
  const { validation } = await validateResponse.json();
  
  if (!validation.canProceed) {
    // Show errors to user
    displayErrors(validation.errors);
    
    // Allow user to fix configuration
    const fixes = await getUserFixes(validation.errors);
    
    // Update plan
    const updateResponse = await fetch(`/api/plans/${planId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tables: fixes })
    });
    
    // Re-validate
    return await validateAndFixPlan(planId);
  }
  
  return true;
}
```

#### Pattern: Monitor Run Progress

```javascript
async function monitorRun(runId, onProgress, onComplete) {
  const intervalId = setInterval(async () => {
    const response = await fetch(`/api/runs/${runId}/progress`);
    const { status, progress, tablesCompleted, tablesTotal } = await response.json();
    
    onProgress(progress, tablesCompleted, tablesTotal);
    
    if (status === 'COMPLETED' || status === 'FAILED') {
      clearInterval(intervalId);
      
      // Get final summary
      const summaryResponse = await fetch(`/api/runs/${runId}/summary`);
      const { summary } = await summaryResponse.json();
      
      onComplete(status, summary);
    }
  }, 2000);
}
```

## For Backend Developers

### Using the New Models

#### 1. Replace Direct Schema Access

**Before:**
```javascript
const firebird = require('./db/firebird');
const tables = await firebird.listTables(config);
```

**After:**
```javascript
const { Schema } = require('./migrate/models');

const schema = new Schema();
await schema.discoverFirebird(config);
await schema.saveCache('./data/schema_cache.json');

const table = schema.getTable('firebird', 'CUSTOMERS');
```

#### 2. Replace Mapping Logic

**Before:**
```javascript
const mapping = JSON.parse(fs.readFileSync('mapping.default.json'));
```

**After:**
```javascript
const { Mapping } = require('./migrate/models');

// Load from database
const pool = await mysql.connectToSchema(config.mysql, schemaName);
const profile = await runStore.getMappingProfile(pool, mappingId);
const mapping = Mapping.fromJSON(JSON.parse(profile.mapping_json));

// Or convert legacy
const mapping = Mapping.fromLegacyFormat(oldMapping);
```

#### 3. Replace Plan Management

**Before:**
```javascript
state.plan = [
  { table: 'customers', mode: 'UPSERT', include: true }
];
```

**After:**
```javascript
const { Plan } = require('./migrate/models');

const plan = Plan.fromMapping(mapping);
plan.updateTable('customers', {
  mode: 'UPSERT',
  keyStrategy: 'rekey',
  dedupeKeys: ['email']
});
```

#### 4. Replace Validation Logic

**Before:**
```javascript
// Custom validation in runner
if (!mapping.tables['CUSTOMERS']) {
  throw new Error('Missing table');
}
```

**After:**
```javascript
const { MappingValidator, PlanValidator } = require('./migrate/validators');

// Validate mapping
const mappingValidation = MappingValidator.validateMapping(mapping, schema);
if (!mappingValidation.valid) {
  return { errors: mappingValidation.errors };
}

// Validate plan
const planValidation = await PlanValidator.validate(plan, mapping, schema);
if (!planValidation.canProceed) {
  return { errors: planValidation.errors };
}
```

#### 5. Replace Execution Tracking

**Before:**
```javascript
// Direct state updates
runState.tables.push({
  name: tableName,
  status: 'COMPLETED',
  migrated: 1000
});
```

**After:**
```javascript
const { Run } = require('./migrate/models');

const run = new Run(runId, plan);
run.recordTableSuccess(tableName, {
  rowsMigrated: 1000,
  rowsInserted: 800,
  rowsUpdated: 200,
  durationMs: 5000
});

console.log(`Progress: ${run.getProgress()}%`);
console.log(`ETA: ${run.getEstimatedSecondsRemaining()}s`);
```

### Common Patterns

#### Pattern: Complete Migration Workflow

```javascript
const { Schema, Mapping, Plan, Run } = require('./migrate/models');
const { PlanValidator } = require('./migrate/validators');
const { PreflightExecutor, TableExecutor } = require('./migrate/executors');

async function executeMigration(mappingId, config) {
  // 1. Load or create schema
  const schema = new Schema();
  if (await schema.isCached('./data/schema_cache.json')) {
    await schema.loadCache('./data/schema_cache.json');
  } else {
    await schema.discoverFirebird(config.firebird);
    await schema.discoverMySQL(config.mysql.pool, config.schemaName);
    await schema.saveCache('./data/schema_cache.json');
  }
  
  // 2. Load mapping
  const profile = await runStore.getMappingProfile(pool, mappingId);
  const mapping = Mapping.fromJSON(JSON.parse(profile.mapping_json));
  
  // 3. Create and validate plan
  const plan = Plan.fromMapping(mapping);
  const validation = await PlanValidator.validate(plan, mapping, schema);
  
  if (!validation.canProceed) {
    throw new Error(`Plan validation failed: ${validation.errors.join(', ')}`);
  }
  
  // 4. Preflight checks
  const preflight = new PreflightExecutor(
    config.firebird,
    config.mysql,
    config.schemaName,
    logger
  );
  const preflightResult = await preflight.execute(plan, mapping, schema);
  
  if (!preflightResult.pass) {
    throw new Error(`Preflight failed: ${preflightResult.errors.join(', ')}`);
  }
  
  // 5. Execute migration
  const runId = generateRunId();
  const run = new Run(runId, plan);
  
  for (const tableName of plan.getIncludedTables()) {
    const tableConfig = plan.getTableConfig(tableName);
    const sourceTable = mapping.getSourceTable(tableName);
    
    const executor = new TableExecutor(
      tableConfig,
      sourceTable,
      tableName,
      mapping,
      schema,
      { firebird: config.firebird, mysql: config.mysql.pool },
      logger
    );
    
    try {
      const stats = await executor.execute({ batchSize: 500 });
      run.recordTableSuccess(tableName, stats);
    } catch (err) {
      run.recordTableFailure(tableName, err.message, 'Check logs');
    }
  }
  
  run.finish(run.getFailedTables().length > 0 ? 'PARTIAL' : 'SUCCESS');
  
  return run.toJSON();
}
```

## Converting Existing Code

### Step-by-Step Conversion

#### Step 1: Identify State Usage

Find all places using:
- `state.mapping`
- `state.plan`
- `state.schema`

#### Step 2: Replace with Models

```javascript
// Before
const mapping = state.mapping;

// After
const { Mapping } = require('./migrate/models');
const mapping = await loadMappingFromDB(mappingId);
```

#### Step 3: Add Validation

```javascript
// Before
// No validation

// After
const { MappingValidator } = require('./migrate/validators');
const validation = MappingValidator.validateMapping(mapping, schema);
if (!validation.valid) {
  return res.status(400).json({ errors: validation.errors });
}
```

#### Step 4: Use Executors

```javascript
// Before
// Custom migration code

// After
const { TableExecutor } = require('./migrate/executors');
const executor = new TableExecutor(config, ...);
const stats = await executor.execute();
```

## Testing Your Changes

### Unit Tests

```javascript
const { Mapping, FieldMap } = require('../src/migrate/models');

describe('Mapping', () => {
  test('should create mapping', () => {
    const mapping = new Mapping('test-id', 'Test Mapping');
    expect(mapping.name).toBe('Test Mapping');
  });
  
  test('should add table', () => {
    const mapping = new Mapping('test-id', 'Test');
    const fieldMaps = new Map();
    fieldMaps.set('CID', new FieldMap('CID', 'customer_id'));
    
    mapping.addTable('CUSTOMERS', 'customers', fieldMaps);
    
    expect(mapping.getTables()).toContain('customers');
  });
});
```

### API Tests

```bash
# Use the provided test script
node scripts/test_phase2_api.js

# Or test manually
curl http://localhost:3000/api/mappings
curl -X POST http://localhost:3000/api/mappings -d '{"name":"Test"}'
```

## Common Issues and Solutions

### Issue: "Cannot find module './migrate/models'"

**Solution:** Check your require path. Use absolute or relative paths correctly.

```javascript
// Correct
const { Mapping } = require('./src/migrate/models');

// Or if in src/
const { Mapping } = require('./migrate/models');
```

### Issue: "Mapping validation fails but no errors shown"

**Solution:** Check the validation result structure:

```javascript
const validation = MappingValidator.validateMapping(mapping, schema);
console.log('Valid:', validation.valid);
console.log('Errors:', validation.errors);
console.log('Warnings:', validation.warnings);
```

### Issue: "Run progress always shows 0%"

**Solution:** Ensure you're recording table results:

```javascript
// Must record success/failure for each table
run.recordTableSuccess(tableName, stats);
// Then check progress
console.log(run.getProgress());
```

## Best Practices

### 1. Always Validate Before Execution

```javascript
const validation = await PlanValidator.validate(plan, mapping, schema);
if (!validation.canProceed) {
  // Handle errors
  return;
}
// Proceed with execution
```

### 2. Use Schema Caching

```javascript
// Check if cached and fresh
if (await schema.isCached(cacheFile)) {
  await schema.loadCache(cacheFile);
} else {
  await schema.discoverFirebird(config);
  await schema.discoverMySQL(pool, schemaName);
  await schema.saveCache(cacheFile);
}
```

### 3. Track Progress Properly

```javascript
const run = new Run(runId, plan);

// Record each table
for (const table of tables) {
  try {
    const stats = await migrateTable(table);
    run.recordTableSuccess(table, stats);
  } catch (err) {
    run.recordTableFailure(table, err.message, 'Check logs');
  }
}

// Finish run
run.finish(run.hasFailures() ? 'FAILED' : 'SUCCESS');
```

### 4. Handle Errors Gracefully

```javascript
try {
  const validation = await PlanValidator.validate(plan, mapping, schema);
  // ...
} catch (err) {
  logger.error('Validation failed:', err);
  return {
    success: false,
    error: err.message,
    hint: 'Check schema connections'
  };
}
```

## Resources

- **API Documentation**: [API_QUICK_REFERENCE.md](API_QUICK_REFERENCE.md)
- **Architecture Guide**: [REFACTORING_README.md](REFACTORING_README.md)
- **Quick Start**: [QUICK_START_REFACTORING.md](QUICK_START_REFACTORING.md)
- **Phase 2 Details**: [PHASE_2_COMPLETE.md](PHASE_2_COMPLETE.md)
- **Test Examples**: [tests/models/refactored-models.test.js](tests/models/refactored-models.test.js)

## Getting Help

1. Check inline code documentation (JSDoc comments)
2. Review examples in documentation files
3. Run test script to verify setup: `node scripts/test_phase2_api.js`
4. Check existing usage in route files

## Summary

**Key Changes:**
- Use models instead of direct state
- Use validators before execution
- Use executors for migration logic
- Use APIs for all operations
- Track progress with Run model

**Benefits:**
- Cleaner code organization
- Better error handling
- Easier testing
- More flexible
- Better documented

**Next Steps:**
1. Read [API_QUICK_REFERENCE.md](API_QUICK_REFERENCE.md)
2. Try example API calls
3. Convert one feature at a time
4. Test thoroughly
5. Deploy with confidence!
