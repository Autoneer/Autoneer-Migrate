# VISUAL ARCHITECTURE SUMMARY

## Current vs New Architecture

### CURRENT (Problematic)
```
┌─────────────────────────────────────────────────────────┐
│                    Single State Object                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ firebird { config }                               │  │
│  │ mysql { config }                                  │  │
│  │ plan { include, mode, keyStrategy, dedupeKeys }   │  │
│  │ mapping { tables { SOURCE: { target, columns }}} │  │
│  │ ui { runNotice, mappingNotice }                  │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  ↓ Everything flows through 5 confusing routes ↓        │
│                                                          │
│  /setup  →  /plan  →  /mapping  →  /run  →  /results   │
│  (optional)  (skip?) (complex) (error-prone) (unwind)   │
│                                                          │
│  ↓ At runtime, discover problems ↓                      │
│                                                          │
│  runner.js (2000+ lines, too many concerns)             │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### NEW (Clean & Logical)
```
┌───────────────────────────────────────────────────────────────┐
│                 Clear Data Models & Separation                │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  PERSISTENT (Reusable)          SESSION (Ephemeral)         │
│  ─────────────────────         ─────────────────────         │
│                                                               │
│  • Schema                        • Plan                       │
│    ├─ Firebird tables              ├─ Selected tables        │
│    └─ MySQL tables                 ├─ Per-table modes        │
│                                    └─ Clean before flags     │
│  • MappingProfile                                            │
│    ├─ ID                        • Run                        │
│    ├─ Source → Target tables       ├─ Execution state        │
│    └─ Column mappings              ├─ Per-table progress     │
│                                    └─ Error tracking         │
│
├───────────────────────────────────────────────────────────────┤
│                    Linear 4-Step Wizard                       │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  Step 1 ──→ Step 2 ──→ Step 3 ──→ Step 4 ──→ Results       │
│  Discover   Build     Create    Execute                      │
│  Schemas    Mapping   Plan      Migration                    │
│                                                               │
│  ✓ Each step validates before proceeding                     │
│  ✓ Can save and resume later                                │
│  ✓ Clear error recovery ("Skip / Fix / Abort")               │
│  ✓ Real-time progress tracking                              │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                  Focused Components                           │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  Validators                    Executors                     │
│  ├─ SchemaValidator            ├─ PreflightExecutor         │
│  ├─ MappingValidator           ├─ TableExecutor             │
│  └─ PlanValidator              └─ TransactionExecutor        │
│                                                               │
│  ✓ Pre-run checks catch issues early                        │
│  ✓ Each executor handles one thing well                     │
│  ✓ Easy to test independently                              │
│  ✓ Easy to extend                                           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Old vs New

### OLD FLOW (Confusing)
```
User fills setup form
        ↓
Goes to /plan (optional detour)
        ↓
Goes to /mapping (complex, can navigate back)
        ↓
Goes to /run (oops, discover schema missing!)
        ↓
Back to /mapping (user frustrated)
        ↓
Back to /run (try again)
        ↓
Migration fails mid-table
        ↓
User confused about what happened
```

### NEW FLOW (Linear & Safe)
```
Step 1: Discover Schemas
  • Connect to Firebird & MySQL
  • Cache metadata
  → Automatically proceed

Step 2: Build Mapping Profile
  • Select source tables
  • Map columns to targets
  • Validate completeness
  → Proceed when valid

Step 3: Create Migration Plan
  • Select which tables to migrate
  • Choose mode (INSERT/UPSERT/TRUNCATE)
  • Set dedupe keys if needed
  → Validate against schema before proceeding

Step 4: Execute Migration
  • Pre-run: Verify all schema exists
  • Execute table-by-table
  • If error: User chooses (Skip / Fix / Abort)
  • Track progress in real-time

Results:
  • Summary statistics
  • Per-table details
  • Error report
  • Audit trail
```

---

## Component Relationships

```
┌────────────────────────────────────────────────────────────┐
│                     API Routes (REST)                      │
├────────────────────────────────────────────────────────────┤
│  GET  /api/schemas                                         │
│  POST /api/schemas/refresh                                │
│  GET  /api/mappings                                       │
│  POST /api/mappings                                       │
│  PUT  /api/mappings/:id                                   │
│  POST /api/plans                                          │
│  POST /api/plans/:id/validate                             │
│  POST /api/runs                                           │
│  GET  /api/runs/:id/events (SSE)                          │
└────────────────────────────────────────────────────────────┘
           ↑
           │ Called by
           │
┌────────────────────────────────────────────────────────────┐
│                Frontend (Wizard UI)                        │
├────────────────────────────────────────────────────────────┤
│  WizardManager (orchestrator)                              │
│    ├─ SchemaUI (Step 1)                                    │
│    ├─ MappingUI (Step 2)                                   │
│    ├─ PlanUI (Step 3)                                      │
│    ├─ RunUI (Step 4)                                       │
│    └─ ResultsUI (Step 5)                                   │
│                                                             │
│  Utilities:                                                │
│  ├─ State management (localStorage)                        │
│  ├─ Form validation                                        │
│  ├─ API client wrapper                                     │
│  └─ Event handling                                         │
└────────────────────────────────────────────────────────────┘
           ↑
           │ REST calls via
           │
┌────────────────────────────────────────────────────────────┐
│              Backend (Node.js/Express)                     │
├────────────────────────────────────────────────────────────┤
│  Executors:                    Validators:                 │
│  ├─ PreflightExecutor          ├─ SchemaValidator         │
│  ├─ TableExecutor              ├─ MappingValidator        │
│  └─ TransactionExecutor        └─ PlanValidator           │
│                                                             │
│  Models:                                                   │
│  ├─ Schema (discovery + caching)                           │
│  ├─ Mapping (persistent profiles)                          │
│  ├─ Plan (session-specific config)                        │
│  ├─ Run (execution tracking)                               │
│  └─ FieldMap (column mappings)                             │
│                                                             │
│  Database:                                                 │
│  ├─ migration_runs (run history)                           │
│  ├─ migration_plans (plan definitions)                    │
│  ├─ migration_schemas (schema cache)                      │
│  ├─ migration_mapping_profiles (reusable mappings)        │
│  └─ migration_row_errors (error tracking)                 │
└────────────────────────────────────────────────────────────┘
           ↓
         Connects to
           ↓
┌────────────────────────────────────────────────────────────┐
│              External Databases                            │
├────────────────────────────────────────────────────────────┤
│  Firebird              MySQL                               │
│  ├─ RDB$ tables        ├─ information_schema               │
│  ├─ User tables        ├─ Target schema                    │
│  └─ Data to migrate    └─ Data destination                 │
└────────────────────────────────────────────────────────────┘
```

---

## State Management Pattern

```
┌─────────────────────────────────────────┐
│     In-Memory State (WizardState)        │
│  ┌─────────────────────────────────────┐ │
│  │ schema: { firebird, mysql }         │ │
│  │ mapping: { id, name, tables }       │ │
│  │ plan: { mappingId, selectedTables } │ │
│  │ run: { id, status, progress }       │ │
│  │ currentStep: 1-5                    │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
           ↓ Syncs to ↓
┌─────────────────────────────────────────┐
│  localStorage (for persistence)          │
│  ┌─────────────────────────────────────┐ │
│  │ autoneer_wizard_state: {JSON}       │ │
│  │ autoneer_wizard_step_1: {JSON}      │ │
│  │ autoneer_wizard_step_2: {JSON}      │ │
│  │ ... etc                             │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
           ↑ Loaded from ↑
  On page reload or resume
```

---

## Error Handling Flow

### CURRENT (Implicit Failure)
```
Row fails during migration
         ↓
Log to database
         ↓
Migration continues or stops (user doesn't know)
         ↓
User sees "failed" but doesn't know what to do
```

### NEW (Explicit User Choice)
```
Missing column detected during pre-run validation
         ↓
Pause migration, show error modal
         ↓
User sees options:
  1. Skip this table (continue with next)
  2. Fix mapping and retry (go back to Step 2)
  3. Stop migration (abort entirely)
         ↓
User makes choice
         ↓
Migration continues based on choice
         ↓
Clear audit trail shows what happened
```

---

## Validation Layers

```
┌─────────────────────────────────────────────────────┐
│        Step 1: Schema Discovery                     │
│  ✓ Firebird connectivity check                     │
│  ✓ MySQL connectivity check                        │
│  ✓ Table enumeration from both DBs                 │
│  ✓ Column type mapping                             │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│        Step 2: Mapping Validation                   │
│  ✓ All selected tables have target tables          │
│  ✓ All selected source columns exist               │
│  ✓ All target columns exist                        │
│  ✓ Type compatibility checks                       │
│  ✓ NULL constraint validation                      │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│        Step 3: Plan Validation                      │
│  ✓ Selected tables are in mapping                  │
│  ✓ Mode + strategy combinations valid              │
│  ✓ Dedupe keys exist (if UPSERT)                   │
│  ✓ Schema still matches                            │
│  ✓ Dry-run test (simulate row 1)                   │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│        Step 4: Preflight Checks                     │
│  ✓ Final connectivity verification                 │
│  ✓ Schema hasn't changed                           │
│  ✓ Foreign key state                               │
│  ✓ Sufficient disk space                           │
│  ✓ User permissions verified                       │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│        During Migration: Per-Table Checks           │
│  ✓ Table still exists                              │
│  ✓ Columns still match mapping                     │
│  ✓ Can read from source                            │
│  ✓ Can write to target                             │
│  ✓ Constraints don't block inserts                 │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│        Post-Migration: Integrity Validation         │
│  ✓ Row count matches (no data loss)                │
│  ✓ Checksum validation (numeric fields)            │
│  ✓ Foreign key orphan check                        │
│  ✓ All errors logged                               │
└─────────────────────────────────────────────────────┘
```

---

## UI Evolution

### STEP 1: Schema Discovery
```
┌────────────────────────────┐
│  Firebird: ● Connected     │
│  MySQL:    ● Connected     │
│                            │
│  ✓ 12 tables discovered    │
│  ✓ Schema cached           │
│                            │
│  [Next →]                  │
└────────────────────────────┘
```

### STEP 2: Build Mapping
```
┌────────────────────────────┐
│  CUSTOMER    → customers    │ ✓ Complete
│  INVOICES    → invoices     │ ⚠ Missing fields
│  SPARES_USED → spares_used  │ ○ Not started
│                            │
│  Field Mapping: CUSTOMER   │
│  ┌──────────────────────┐  │
│  │ CID    → cid         │  │
│  │ NAME   → name (trim) │  │
│  │ ...                  │  │
│  └──────────────────────┘  │
│                            │
│  [← Back] [Save & Next →] │
└────────────────────────────┘
```

### STEP 3: Create Plan
```
┌────────────────────────────┐
│ ☑ CUSTOMER                 │
│ ☑ INVOICES                 │
│ ☑ SPARES_USED              │
│                            │
│ CUSTOMER Config:           │
│ Mode: [UPSERT ▼]           │
│ Strategy: [Preserve ▼]     │
│ Clean Before: ☐            │
│                            │
│ Validation: ✓ All OK      │
│                            │
│ [← Back] [Run →]          │
└────────────────────────────┘
```

### STEP 4: Execute
```
┌────────────────────────────┐
│ Overall: ████░░░░ 50%      │
│                            │
│ ✓ CUSTOMER   ████████      │
│ ✓ STOCK      ████████      │
│ ⏳ INVOICES    ████░░░░     │
│ ○ SPARES_USED ░░░░░░░░    │
│                            │
│ Logs:                      │
│ [Info] Table completed     │
│ [Info] Batch 5: 50 rows    │
│                            │
│ [Stop]                     │
└────────────────────────────┘
```

### STEP 5: Results
```
┌────────────────────────────┐
│ ✓ Success!                 │
│                            │
│ Summary:                   │
│ Total rows: 940            │
│ Inserted: 930              │
│ Updated: 5                 │
│ Skipped: 5                 │
│ Errors: 0                  │
│                            │
│ [View Audit] [New Run]    │
└────────────────────────────┘
```

---

## Test Coverage Target

```
Backend:
├─ Models: 100% coverage
│  ├─ Schema.js ✓
│  ├─ FieldMap.js ✓
│  ├─ Mapping.js ✓
│  ├─ Plan.js ✓
│  └─ Run.js ✓
├─ Validators: 100% coverage
│  ├─ SchemaValidator ✓
│  ├─ MappingValidator ✓
│  └─ PlanValidator ✓
├─ Executors: 90%+ coverage
│  ├─ PreflightExecutor ✓
│  ├─ TableExecutor ✓
│  └─ TransactionExecutor ✓
└─ Routes: 80%+ coverage
   └─ API endpoints ✓

Frontend:
├─ Utilities: 100% coverage
│  ├─ storage.js ✓
│  ├─ state.js ✓
│  ├─ validator.js ✓
│  └─ api client ✓
├─ Steps: 80%+ coverage
│  ├─ Schema UI ✓
│  ├─ Mapping UI ✓
│  ├─ Plan UI ✓
│  ├─ Run UI ✓
│  └─ Results UI ✓
└─ E2E: Full workflow ✓

Overall Target: 85%+ code coverage
```

---

## Performance Targets

```
Metric                    Current    Target      Method
────────────────────────  ────────   ────────    ──────────────
Page Load                 3-4s       <2s         Lazy load steps
Step Transition           500-800ms  <300ms      Preload next step
API Response (schemas)    2-3s       <1s         Cache metadata
API Response (run start)  1-2s       <500ms      Async background
Progress Update (SSE)     Every 1s   Every 100ms Batch updates
Memory Usage              50+ MB     <30 MB      Cleanup on destroy
Database Query Time       Varies     <200ms      Index optimization
```

---

## Success Criteria

```
Technical:
✓ All acceptance criteria met
✓ 85%+ code coverage
✓ All tests passing
✓ No console errors in production
✓ API response times < 1s
✓ Page load time < 2s

User Experience:
✓ Users can complete flow in < 10 min (was 30+ min)
✓ Error messages are actionable
✓ No confusion about next step
✓ Can recover from errors
✓ Can save and resume session

Operational:
✓ Clear audit trail
✓ Error logs are searchable
✓ Performance monitoring in place
✓ Backup/recovery plan documented
✓ Rollback plan documented
```

---

## Timeline

```
Week 1:
┌────────────────────────────────────────┐
│ Backend Models & Database              │ 
│ [████████████░░░░░░░░░░░░░░░░░░░░░]   │
│ ✓ Schema, Mapping, Plan, Run, FieldMap│
└────────────────────────────────────────┘

Week 2:
┌────────────────────────────────────────┐
│ Backend Validators & Executors         │
│ [████████░░░░░░░░░░░░░░░░░░░░░░░░░░░] │
│ ✓ Validators & Executors               │
└────────────────────────────────────────┘

│ Frontend Utilities & Wizard            │
│ [████████░░░░░░░░░░░░░░░░░░░░░░░░░░░] │
│ ✓ State, storage, API clients          │
└────────────────────────────────────────┘

Week 3:
┌────────────────────────────────────────┐
│ Backend Routes & Tests                 │
│ [████████████████░░░░░░░░░░░░░░░░░░░░] │
│ ✓ REST endpoints, 90%+ coverage        │
└────────────────────────────────────────┘

│ Frontend Steps & Styling               │
│ [████████████░░░░░░░░░░░░░░░░░░░░░░░░] │
│ ✓ All 4 step UIs, CSS, responsive     │
└────────────────────────────────────────┘

Week 4+:
┌────────────────────────────────────────┐
│ Integration Testing & Polish           │
│ [████████████████████░░░░░░░░░░░░░░░░] │
│ ✓ E2E tests, accessibility, perf tuning│
└────────────────────────────────────────┘
```

---

## Risk Mitigation

```
Risk                          Mitigation
─────────────────────────     ─────────────────────────────
Breaking old mappings         Migration script to convert
Existing runs fail             Keep old schema, add views
User confusion with new UI     Guided tour + inline help
Performance regression         Benchmarking & optimization
Data loss during migration     Checksums + row count validation
Incomplete rollback            Backup strategy + dry-run mode
```

---

## Summary Stats

```
Documents Provided:    4 files (~80 KB)
Code Examples:         2000+ lines
Acceptance Criteria:   100+ items
Tasks Defined:         15+ detailed tasks
Estimated Effort:      3-4 weeks (full team)
Success Metrics:       10+ key indicators
Test Cases Outlined:   30+ test scenarios
```

**Good to Go! 🚀**

