# Autoneer Migration PWA - Comprehensive Audit & Refactoring Plan

## EXECUTIVE SUMMARY

Your current PWA has evolved into a complex system with overlapping concerns, confusing flows, and redundant data structures. The architecture conflates three distinct workflows (Setup → Plan → Mapping → Run → Results) into a single state object, making it difficult to manage, test, and extend.

**Core Issues:**
1. **Multi-step workflow is non-linear** - Users can navigate between Plan/Mapping/Run, causing state inconsistency
2. **Redundant data models** - Plan steps, mapping entries, and run configurations all carry overlapping information
3. **Deduplication logic is fragmented** - Spread across plan validation, runner, and mapping configuration
4. **Schema mismatch handling is ad-hoc** - Column validation happens at multiple points; missing fields cause silent failures
5. **Mapping reusability is unclear** - Profiles exist but aren't cleanly separated from session state
6. **Run state is too complex** - 2000+ lines in runner.js handling too many concerns

---

## DETAILED AUDIT FINDINGS

### 1. ARCHITECTURE ISSUES

#### 1.1 State Management (state.js)
**Current Model:**
```
{
  firebird: { host, port, database, user, password, ... }
  mysql: { host, port, user, password }
  schemaName: "autoneer"
  plan: [ { table, include, mode, keyStrategy, dedupeKeys, onDuplicate } ]
  mapping: { tables: { SOURCE: { target, columns: {...} } } }
  settings: { defaultMappingProfileId }
  ui: { runNotice, mappingNotice }
}
```

**Problems:**
- No clear ownership - plan and mapping are separate but interdependent
- `include` in plan is session-specific but mapping is reusable
- Mixing persistent (mapping) with ephemeral (UI notices) in same object
- No transaction boundaries - changes to plan don't validate against current mapping

#### 1.2 Workflow Routing (run.js, mapping.js, plan.js)
**Current Flow:** Setup → Plan (optional) → Mapping → Run

**Problems:**
- Plan validation happens AFTER mapping is built
- User can save mapping without completing plan
- Missing columns discovered at runtime, not pre-run
- No "dry" mode to validate schema compatibility before committing

#### 1.3 Mapping Model (mapping.js + mapping_default.json)
**Current Structure:**
```json
{
  "tables": {
    "SOURCE_TABLE": {
      "target": "target_table",
      "mode": "INSERT|UPSERT",
      "keyStrategy": "preserve|rekey",
      "columns": {
        "SOURCE_COL": {
          "target": "target_col",
          "transform": "trim|toNumber|...",
          "default": "...",
          "lookup": { "table": "..." }
        }
      }
    }
  }
}
```

**Problems:**
- `mode` and `keyStrategy` should be plan-level, not mapping-level (belong in run context)
- No schema validation structure - missing columns aren't surfaced until write-time
- `lookup` structure is incomplete (no field mapping)
- No field-level metadata (nullable, type, validation rules)
- Dedupe keys stored in plan, not mapping - creates validation gap

#### 1.4 Run Execution (runner.js)
**Current Size:** 2000+ lines; handles:
- Preflight checks (connections, schema validation)
- Auto-migration of old column names
- Deduplication logic (complex nested conditionals)
- Transaction management
- Integrity validation
- Error recovery
- State emission

**Problems:**
- Too many responsibilities (God Object)
- Deduplication logic is 400+ lines of nested ifs
- Schema validation at runtime instead of pre-run
- Error handling inconsistent (sometimes throws, sometimes logs)
- Integrity checks only for SPARES_USED (hardcoded)

#### 1.5 Validation (validation.js)
**Current Implementation:** Only validates clean table selection

**Missing:**
- Schema compatibility checks
- Column mapping completeness
- Type conversion safety
- Dedupe key validity
- Foreign key constraint checks

---

## ROOT CAUSE ANALYSIS

### Why Complexity Grew

1. **Feature creep without refactoring** - Each new requirement (dedupes, reruns, profiles) added code to runner.js
2. **No clear data model** - Mapping, Plan, and Run configurations evolved separately
3. **Runtime validation instead of compile-time** - Schema issues discovered during migration, not during mapping
4. **State as implicit contract** - router handlers assume `state.plan`, `state.mapping` exist and are valid
5. **Session state bleeding** - `cleanBefore`, `include` (ephemeral) stored in mapping (persistent)

---

## PROPOSED NEW ARCHITECTURE

### Phase 1: Data Model Separation

**Entities:**

1. **Schema** (Persistent, computed once)
   - Firebird schema snapshot
   - MySQL schema snapshot
   - Cached metadata (column types, constraints, PKs)

2. **MappingProfile** (Persistent, reusable)
   - Source table → Target table mapping
   - Column transformations & lookups
   - **Does NOT include:** mode, keyStrategy, dedupeKeys, cleanBefore

3. **MigrationPlan** (Session + Persistent option)
   - Table selection
   - Migration mode (INSERT/UPSERT/TRUNCATE+INSERT)
   - Key strategy (preserve/rekey)
   - Dedupe key configuration
   - Clean before setting
   - **References:** MappingProfile by ID
   - **Validated against:** Schema + MappingProfile before run

4. **MigrationRun** (Transient, logged)
   - Plan execution record
   - Per-table run state & logs
   - Error tracking
   - **Immutable after creation**

5. **FieldMapping** (Sub-entity of MappingProfile)
   - Source column → Target column
   - Transform function name
   - Default value
   - Lookup table reference
   - **Includes metadata:** type conversion safety, nullable handling

### Phase 2: Workflow Redesign

**New Flow:**

```
┌─────────────────────────────────────────────┐
│  STEP 1: SCHEMA DISCOVERY & VALIDATION      │
├─────────────────────────────────────────────┤
│  - Load Firebird schema (list tables)       │
│  - Load MySQL schema (column types, PKs)    │
│  - Cache both locally                       │
│  - Validate connectivity                    │
└─────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────┐
│  STEP 2: MAPPING BUILDER (Persistent)       │
├─────────────────────────────────────────────┤
│  - Select source tables                     │
│  - Auto-match or manual map to target       │
│  - Configure column transformations         │
│  - Validate field compatibility             │
│  - Save as MappingProfile (versioned)       │
└─────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────┐
│  STEP 3: PLAN BUILDER (Session)             │
├─────────────────────────────────────────────┤
│  - Load or create new MappingProfile        │
│  - Select tables to migrate                 │
│  - Configure per-table options:             │
│    * Mode (INSERT/UPSERT/TRUNCATE)          │
│    * Key strategy (preserve/rekey)          │
│    * Dedupe keys (if UPSERT)                │
│    * Clean before (delete old data)         │
│  - Validate: schema + mapping               │
│  - PRE-RUN CHECK: simulate row 1            │
└─────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────┐
│  STEP 4: EXECUTE MIGRATION                  │
├─────────────────────────────────────────────┤
│  - Load Plan                                │
│  - Per table:                               │
│    * Pre-check schema                       │
│    * Handle missing fields (abort/skip)     │
│    * Migrate in transaction                 │
│    * Validate checksums                     │
│    * Record success/failure                 │
│  - Post-run: rollback or commit             │
└─────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────┐
│  STEP 5: RESULTS & AUDIT                    │
├─────────────────────────────────────────────┤
│  - View run history                         │
│  - Inspect errors                           │
│  - Rerun with corrections                   │
└─────────────────────────────────────────────┘
```

### Phase 3: File Structure Reorganization

**New Directory Layout:**

```
routes/
├── schema.js          # GET /api/schemas (discover + cache)
├── mapping.js         # GET|POST|PUT /api/mappings/{id}
├── plan.js            # GET|POST /api/plans
├── run.js             # POST /api/runs, GET /api/runs/{id}
├── status.js          # GET /api/health, /api/runs/{id}/status

migrate/
├── models/
│   ├── Schema.js      # Schema discovery & caching
│   ├── Mapping.js     # MappingProfile CRUD
│   ├── Plan.js        # MigrationPlan validation
│   ├── Run.js         # MigrationRun execution
│   └── FieldMap.js    # Column-level mapping logic
│
├── validators/
│   ├── SchemaValidator.js     # Check connectivity, list tables
│   ├── MappingValidator.js    # Validate mapping completeness
│   ├── PlanValidator.js       # Validate plan against schema+mapping
│   └── FieldValidator.js      # Type safety, nullable checks
│
├── executors/
│   ├── PreflightExecutor.js   # Connectivity, schema checks
│   ├── TableExecutor.js       # Single-table migration logic
│   └── TransactionExecutor.js # Transaction wrapper
│
├── mappers/
│   ├── transforms.js          # Transform functions (trim, toNumber, etc)
│   ├── fieldMapper.js         # Apply column mappings to rows
│   └── dedupeMapper.js        # Dedupe key extraction & matching
│
├── loggers/
│   ├── runLogger.js           # Event logging
│   └── auditLogger.js         # Persistence logging
│
└── runners/
    └── migrationRunner.js     # Orchestrator (instead of current runner.js)

config/
├── state.js                   # Session state (ephemeral)
├── settings.js                # Persistent settings
└── schemaCache.js             # Cached schema metadata

db/
├── firebird.js
├── mysql.js
└── index.js                   # Connection pooling

views/
├── layouts/
├── schema.hbs         # Step 1: Schema discovery
├── mapping.hbs        # Step 2: Mapping builder
├── plan.hbs           # Step 3: Plan builder
├── run.hbs            # Step 4: Execution monitor
└── results.hbs        # Step 5: Results review

public/
├── js/
│   ├── schema-ui.js      # Step 1 UI logic
│   ├── mapping-ui.js     # Step 2 UI logic
│   ├── plan-ui.js        # Step 3 UI logic
│   ├── run-ui.js         # Step 4 UI logic
│   └── components/
│       ├── modal.js
│       ├── fieldEditor.js
│       └── tableSelector.js
│
└── css/
    └── app.css
```

### Phase 4: API Changes

**Current Pattern (RPC-style):**
```
POST /plan/save
POST /mapping/customize
POST /mapping/resolve
POST /run/start
```

**New Pattern (REST):**
```
GET    /api/schemas                          # Load cached schemas
GET    /api/schemas/refresh                  # Refresh from DBs

GET    /api/mappings                         # List profiles
POST   /api/mappings                         # Create new
GET    /api/mappings/:id                     # Get one
PUT    /api/mappings/:id                     # Update
DELETE /api/mappings/:id                     # Delete
POST   /api/mappings/:id/validate            # Pre-validate

GET    /api/plans                            # List recent
POST   /api/plans                            # Create (from mapping + selections)
POST   /api/plans/:id/validate               # Pre-run validation
GET    /api/plans/:id/dry-run                # Simulate row 1

GET    /api/runs                             # List runs
POST   /api/runs                             # Start (from plan)
GET    /api/runs/:id                         # Get run status
GET    /api/runs/:id/events (SSE)            # Stream progress
POST   /api/runs/:id/abort                   # Cancel

GET    /api/runs/:id/tables                  # Per-table results
GET    /api/runs/:id/tables/:name/errors     # Errors for table
POST   /api/runs/:id/tables/:name/skip       # Skip failed table (next run)

GET    /api/health                           # Connection status
```

---

## IMPLEMENTATION ROADMAP

### Stage 1: Foundation (Week 1)
- [ ] Create data models (Schema, Mapping, Plan, Run, FieldMap)
- [ ] Build validators
- [ ] Create database schema changes (if needed)

### Stage 2: Routing (Week 2)
- [ ] Implement new API routes
- [ ] Migrate old handlers to new endpoints
- [ ] Add backward compatibility layer

### Stage 3: UI Redesign (Week 3)
- [ ] Create Step 1: Schema Discovery UI
- [ ] Create Step 2: Mapping Builder UI
- [ ] Create Step 3: Plan Builder UI

### Stage 4: Execution (Week 4)
- [ ] Refactor runner.js into TableExecutor + TransactionExecutor
- [ ] Implement pre-run validation
- [ ] Add on-the-fly error correction (skip table, fix fields)

### Stage 5: Testing & Polish (Week 5)
- [ ] Unit tests for validators
- [ ] Integration tests for runners
- [ ] E2E tests for full workflow

---

## KEY IMPROVEMENTS

### 1. Schema Validation Before Run
**Current:** Runtime errors when columns missing
**New:** Pre-run check discovers schema mismatches
```javascript
// NEW: Pre-run validator
const issues = await PlanValidator.checkSchema(plan, schemas);
if (issues.missing.length > 0) {
  // Show user: "Column X missing in MySQL. Skip table or add column?"
  const action = await user.selectAction(issues);
  // EITHER: Skip table, OR: Update mapping, OR: Update schema
}
```

### 2. On-the-Fly Error Handling
**Current:** One column missing = entire table fails
**New:** User chooses action mid-run
```javascript
// NEW: During execution
if (schema mismatch detected) {
  // Pause table, offer options:
  // 1. Skip this table
  // 2. Add missing column to MySQL
  // 3. Remove unmapped columns from selection
  const action = await user.chooseAction();
  // Continue or skip based on choice
}
```

### 3. Mapping Reusability
**Current:** Profiles exist but contain run-config
**New:** Clean separation
```javascript
// Mapping stays the same across runs
const mapping = await Mapping.get(id); // Just column mappings

// Plan varies per run
const plan = new Plan({
  mapping_id: id,
  tables: ['CUSTOMER', 'INVOICES'],
  perTable: {
    CUSTOMER: { mode: 'UPSERT', keyStrategy: 'preserve' }
    INVOICES: { mode: 'INSERT', keyStrategy: 'rekey' }
  }
});
```

### 4. Cleaner Run Execution
**Current:** 2000+ line monolith
**New:** Focused components
```javascript
// Pseudo-code
const run = new MigrationRun(plan);

for (const tableConfig of plan.tables) {
  const executor = new TableExecutor(tableConfig, schemas, mapping);
  
  try {
    await executor.preCheck();  // Schema validation
    const result = await executor.execute(batchSize);
    run.recordSuccess(tableConfig.table, result);
  } catch (err) {
    if (err.recoverable) {
      const action = await user.chooseAction(err);
      if (action === 'RETRY') continue;
      if (action === 'SKIP') run.recordSkipped(tableConfig.table);
    } else {
      run.recordFailure(tableConfig.table, err);
      break; // Stop remaining tables
    }
  }
}
```

### 5. Better Audit Trail
**Current:** Logs buried in JSON lines
**New:** Structured events
```javascript
// NEW: Audit table
{
  event_id: UUID,
  run_id: INTEGER,
  timestamp: DATETIME,
  event_type: 'PREFLIGHT_FAIL' | 'SCHEMA_MISMATCH' | 'ROW_ERROR' | 'TABLE_SUCCESS',
  level: 'ERROR' | 'WARN' | 'INFO',
  table_name: VARCHAR,
  message: TEXT,
  context: JSON,  // Extra details
  recovery_action: VARCHAR  // What user did (if interactive)
}
```

---

## MIGRATION PATH (No Breaking Changes)

### Week 1-2: Build in Parallel
- New models & validators coexist with old code
- Old routes still work via adapter layer
- New routes available for new UI

### Week 3-4: Gradual Cutover
- New UI added to setup pages
- Old UI still available (feature flag)
- New execution path tested in staging

### Week 5: Full Switch
- Old routes deprecated
- Old UI removed
- New models become primary

---

## TESTING STRATEGY

### Unit Tests
```javascript
// validators/*.test.js
describe('PlanValidator', () => {
  test('detects missing columns', async () => {
    const plan = { ... };
    const schema = { mysql: { ... } };
    const result = await PlanValidator.validateSchema(plan, schema);
    expect(result.issues).toContainEqual({
      table: 'INVOICES',
      missing: ['invoice_date'],
      severity: 'ERROR'
    });
  });
});
```

### Integration Tests
```javascript
// migrate/tests/integration/table-executor.test.js
describe('TableExecutor', () => {
  test('migrates with deduplication', async () => {
    const mapping = { ... };
    const config = { mode: 'UPSERT', dedupeKeys: ['cid'] };
    const executor = new TableExecutor(config, schemas, mapping);
    
    const result = await executor.execute(batchSize);
    expect(result.inserted + result.updated).toBe(100);
    expect(result.skipped).toBe(5); // Duplicates
  });
});
```

### E2E Tests
```javascript
// tests/e2e/full-migration.test.js
describe('Full Migration Workflow', () => {
  test('complete migration with error recovery', async () => {
    // Step 1: Discover schemas
    await page.goto('/schema');
    // Step 2: Build mapping
    await page.goto('/mapping');
    // Step 3: Create plan
    await page.goto('/plan');
    // Step 4: Run migration
    await page.goto('/run');
    // Expect success
  });
});
```

---

## RISK MITIGATION

### Risk: Incompatibility with existing mappings
**Mitigation:** Migration script converts old format
```javascript
// migrate-old-mapping.js
const old = JSON.parse(fs.readFileSync('mapping.json'));
const newMapping = {
  id: uuid(),
  name: 'migrated_' + Date.now(),
  created_at: new Date(),
  tables: {}
};

for (const [source, def] of Object.entries(old.tables)) {
  newMapping.tables[source] = {
    target_table: def.target,
    columns: def.columns // Keep as-is
    // mode, keyStrategy moved to Plan, not here
  };
}
```

### Risk: Breaking existing runs
**Mitigation:** Keep old schema, add views
```sql
-- Keep migration_runs, migration_table_runs
-- Add new migration_plans table
-- Runs link to Plans, not directly to config
```

### Risk: User confusion with new steps
**Mitigation:** Guided tour + inline help
- Schema step: "We're discovering what tables exist"
- Mapping step: "Configure which Firebird columns map to MySQL"
- Plan step: "Choose tables and migration strategy"

---

## DETAILED IMPLEMENTATION CHECKLIST

See next section for agent prompt...

