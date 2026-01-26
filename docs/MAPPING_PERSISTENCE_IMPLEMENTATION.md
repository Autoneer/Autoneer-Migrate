# Migration Mapping Persistence & ID Tracking - Implementation Guide

## Status: Phase 1 Complete ✅

This document tracks the implementation of deterministic, reusable, auditable migrations through mapping persistence and ID tracking.

---

## Problem Statement

**Current State:** 
- `migration_mappings` and `migration_id_map` tables are empty
- Plans cannot be reliably reused (mapping changes break old plans)
- FK resolution guesses or silently inserts NULLs
- No audit trail of what mappings were actually used
- Rerunning same plan gives different results

**Required State:**
- Every run saves immutable mapping snapshot
- ID mappings tracked for every row (INSERT/SKIP/UPDATE)
- FK resolution uses tracked IDs, never guesses
- Plans are 100% reusable regardless of profile changes
- Full audit trail of mappings and ID transformations

---

## Architecture

### Layer 1: Mapping Persistence (`src/migrate/mappingPersistence.js`)
**Purpose:** Save and load immutable per-run mapping snapshots

**Key Functions:**
- `saveRunMappings()` - Save full resolved mappings when run starts
- `loadRunMappings()` - Load mappings from `migration_run_mappings` table
- `autoGenerateMissingMappings()` - Backfill old runs
- `findRunsWithoutMappings()` - Find runs needing repair

**Database:** `migration_run_mappings`
- `run_id` - Links to migration_runs
- `table_name` - Canonical TARGET table name
- `source_table` / `target_table` - Source/target names
- `mapping_json` - Full resolved column mappings (NO placeholders)
- Created ONCE at run start, NEVER regenerated

### Layer 2: ID Map Tracking (`src/migrate/idMapTracker.js`)
**Purpose:** Track source PK → target PK mappings for FK resolution

**Key Functions:**
- `recordIdMapping()` - Record single source→target PK mapping
- `recordBatch()` - Efficiently record multiple mappings
- `lookupTargetPk()` - Find target PK for FK resolution
- `lookupBatch()` - Batch FK lookups
- `getOperationStats()` - Get INSERT/SKIP/UPDATE breakdown

**Database:** `migration_id_map`
- `run_id` - Links to migration_runs
- `table_name` - Canonical TARGET table name
- `source_pk` - Source primary key value
- `target_pk` - Target primary key value
- `operation` - 'INSERT', 'SKIP', or 'UPDATE'

---

## Phase 1: Foundation ✅ COMPLETE

### 1.1 Database Schema ✅
**File:** `data/add_mapping_persistence_tables.sql`

**Tables Created:**
- `migration_run_mappings` - Immutable mapping snapshots
- `migration_id_map` - Source→target PK mappings

**Key Indexes:**
- `idx_run_table_source` on (run_id, table_name, source_pk) for FK lookups
- `uk_run_table_source` unique constraint prevents duplicates

**Action Required:**
```sql
-- Run this SQL on your MySQL target database
source data/add_mapping_persistence_tables.sql;
```

### 1.2 Mapping Persistence Utility ✅
**File:** `src/migrate/mappingPersistence.js`

**Functions Implemented:**
- ✅ `saveRunMappings()` - Persist mappings with canonical table names
- ✅ `loadRunMappings()` - Reconstruct mapping object from DB
- ✅ `hasRunMappings()` - Check if run has saved mappings
- ✅ `autoGenerateMissingMappings()` - Backfill old runs
- ✅ `findRunsWithoutMappings()` - Find runs needing repair

**Integration Points:**
- Uses `tableNameCanonical.js` for name normalization
- Saves one row per included table
- Stores full resolved mapping JSON (no placeholders)

### 1.3 ID Map Tracking Utility ✅
**File:** `src/migrate/idMapTracker.js`

**Functions Implemented:**
- ✅ `recordIdMapping()` - Single ID mapping
- ✅ `recordBatch()` - Batch insert for efficiency
- ✅ `lookupTargetPk()` - FK resolution
- ✅ `lookupBatch()` - Batch FK resolution
- ✅ `getOperationStats()` - INSERT/SKIP/UPDATE counts
- ✅ `clearIdMappings()` - Cleanup for testing

### 1.4 Runner Integration ✅
**File:** `src/migrate/runner.js`

**Changes Made:**
- ✅ Added imports for `mappingPersistence` and `idMapTracker`
- ✅ Save run mappings immediately after `runStore.createRun()`
- ✅ Resolves tables to canonical TARGET names before saving
- ✅ Logs count of saved mappings for debugging

**Code Location:** `startMigration()` function, lines ~1964-1995

---

## Phase 2: Runner ID Tracking 🚧 IN PROGRESS

### 2.1 Insert Operation Tracking
**Goal:** Record every INSERT with source PK → target PK

**Current State:**
- ✅ `runStore.storeIdMap()` exists but only used for `rekey` strategy
- ✅ Only tracks insertId, not all operations
- ❌ Doesn't track SKIP (duplicate) operations
- ❌ Doesn't track UPDATE operations
- ❌ Uses old schema (`source_id`/`target_id` instead of `source_pk`/`target_pk`)

**Implementation Needed:**

```javascript
// In runner.js, after successful INSERT (line ~1620-1650)
// For EACH inserted row:
const idMappings = [];
for (let i = 0; i < rowsToInsert.length; i++) {
  const row = rowsToInsert[i];
  const result = insertResults[i]; // or result.insertId for auto-increment
  
  if (row.sourcePk && result.insertId) {
    idMappings.push({
      sourcePk: row.sourcePk,
      targetPk: result.insertId,
      operation: 'INSERT'
    });
  }
}

// Batch record after insert block
if (idMappings.length > 0) {
  await idMapTracker.recordBatch(pool, {
    runId,
    tableName,
    mappings: idMappings
  });
}
```

**Locations to Update:**
- Line 1620-1650: Rekey strategy single-row inserts
- Line 1652-1680: Batch inserts with rollback handling
- Line 1690-1730: Fallback single-row error handling

### 2.2 SKIP Operation Tracking
**Goal:** Record source PK → existing target PK when duplicate found

**Current State:**
- ❌ No tracking of skipped duplicates
- Duplicate handling at lines 1638-1644, 1695-1703

**Implementation Needed:**

```javascript
// When duplicate detected (ignoreDuplicates=true, affectedRows=0):
if (ignoreDuplicatesForInsert && result.affectedRows === 0) {
  rowsSkippedDuplicates += 1;
  
  // Look up existing target PK
  const existingPk = await lookupExistingPk(pool, tableName, row.dedupeKeyValues);
  
  if (existingPk && row.sourcePk) {
    await idMapTracker.recordIdMapping(pool, {
      runId,
      tableName,
      sourcePk: row.sourcePk,
      targetPk: existingPk,
      operation: 'SKIP'
    });
  }
}
```

**Helper Function Needed:**

```javascript
async function lookupExistingPk(pool, tableName, dedupeKeyValues) {
  const mapping = resolveMappingForTarget(tableName, mapping);
  const pkColumn = mapping.primaryKey || 'id';
  
  // Build WHERE clause from dedupe keys
  const whereClauses = Object.keys(dedupeKeyValues).map(k => `${k} = ?`);
  const sql = `SELECT ${pkColumn} FROM ${tableName} WHERE ${whereClauses.join(' AND ')} LIMIT 1`;
  
  const [rows] = await pool.query(sql, Object.values(dedupeKeyValues));
  return rows[0]?.[pkColumn] || null;
}
```

### 2.3 UPDATE Operation Tracking
**Goal:** Record source PK → target PK for UPSERT mode updates

**Current State:**
- UPSERT mode supported (step.mode === "UPSERT")
- Update detection at lines 1662-1670
- ❌ No ID tracking for updates

**Implementation Needed:**

```javascript
// For UPSERT mode, after detecting updates:
if (step.mode === "UPSERT" && affected > totalRows) {
  const updatedCount = affected - totalRows;
  rowsUpdated += updatedCount;
  
  // Track updated IDs
  // (This is complex - may need to re-query to get target PKs)
  // For now, track what we can from the batch
}
```

**Complexity:** UPSERT doesn't return which rows were updated vs inserted. May need:
- Query target table before batch to get existing PKs
- Match source PKs to existing target PKs
- Record as 'UPDATE' operation

---

## Phase 3: FK Resolution 📋 PENDING

### 3.1 FK Lookup Before Insert
**Goal:** Replace FK guessing with migration_id_map lookups

**Current Behavior:**
- FK resolution happens during row transformation
- Likely in `applyTransform()` or mapping resolvers
- May silently insert NULL or guess based on value matching

**Required Behavior:**

```javascript
// When processing FK column:
async function resolveForeignKey(runId, parentTable, sourceFkValue) {
  if (!sourceFkValue) return null;
  
  const targetPk = await idMapTracker.lookupTargetPk(pool, {
    runId,
    parentTable: resolveTargetTableName(parentTable, mapping),
    sourcePk: sourceFkValue
  });
  
  if (!targetPk) {
    throw new Error(
      `FK resolution failed: No target PK found for ${parentTable}.${sourceFkValue} in run ${runId}. ` +
      `Parent table may not have been migrated yet or source FK value is invalid.`
    );
  }
  
  return targetPk;
}
```

**Locations to Update:**
- FK resolution in `applyTransform()` (src/migrate/mappers/*)
- Table dependency ordering (ensure parents migrate before children)

### 3.2 Dependency-Aware Table Ordering
**Goal:** Ensure parent tables migrate before children

**Current State:**
- Table order determined by plan step order
- No automatic dependency resolution

**Enhancement Needed:**
- Parse FK definitions from mapping or schema
- Topologically sort tables (parents first)
- Validate no circular dependencies
- Override plan order if needed for FK safety

---

## Phase 4: Plan Reuse from migration_run_mappings 📋 PENDING

### 4.1 GET /api/plans/:id Reuse Logic
**Goal:** Load mappings from migration_run_mappings instead of profile

**File:** `src/routes/api/plans.js`

**Current Behavior:**
- Loads plan from `migration_plans` table
- Loads mapping from `mapping_profile_id` (mutable)
- Changes to profile break old plans

**Required Behavior:**

```javascript
// GET /api/plans/:id
router.get('/api/plans/:id', async (req, res) => {
  const planId = req.params.id;
  const { from_run_id } = req.query; // Optional: reuse from specific run
  
  // Load plan
  const plan = await loadPlan(pool, planId);
  
  // Determine mapping source
  let mapping, mappingSource;
  
  if (from_run_id) {
    // REUSE: Load immutable snapshot from run
    mapping = await mappingPersistence.loadRunMappings(pool, from_run_id);
    if (!mapping) {
      // Auto-generate if missing (backward compatibility)
      await mappingPersistence.autoGenerateMissingMappings(pool, {
        runId: from_run_id,
        mapping: await loadMappingFromProfile(pool, plan.mapping_profile_id),
        plan
      });
      mapping = await mappingPersistence.loadRunMappings(pool, from_run_id);
    }
    mappingSource = 'run_snapshot';
  } else {
    // NEW: Load current profile
    mapping = await loadMappingFromProfile(pool, plan.mapping_profile_id);
    mappingSource = 'profile';
  }
  
  res.json({
    plan,
    mapping,
    mappingSource, // Tell UI whether this is immutable or mutable
    ...
  });
});
```

**UI Changes:**
- Show badge: "Using saved mapping from Run #123" vs "Using current profile"
- Warn if profile has changed since plan was created
- Offer option: "Reuse exact mapping from previous run"

### 4.2 Dry-Run with Immutable Mappings
**Goal:** Dry-run uses same mappings that will be used in real run

**File:** `src/routes/api/plans.js`

**Enhancement:**

```javascript
// POST /api/plans/:id/dry-run
router.post('/api/plans/:id/dry-run', async (req, res) => {
  const planId = req.params.id;
  const { reuse_run_id } = req.body; // Optional
  
  let mapping;
  if (reuse_run_id) {
    mapping = await mappingPersistence.loadRunMappings(pool, reuse_run_id);
  } else {
    mapping = await loadMappingFromProfile(pool, plan.mapping_profile_id);
  }
  
  // Run dry-run with resolved mapping
  const result = await runDryRun(plan, mapping);
  res.json(result);
});
```

---

## Phase 5: Self-Healing & Testing 📋 PENDING

### 5.1 Backfill Script
**File:** `scripts/heal-migration-mappings.js`

**Purpose:** Populate migration_run_mappings for old runs

```javascript
const mysql = require('../src/db/mysql');
const mappingPersistence = require('../src/migrate/mappingPersistence');

async function healAllRuns() {
  const pool = await mysql.connectToSchema(config, schemaName);
  
  // Find runs without mappings
  const runs = await mappingPersistence.findRunsWithoutMappings(pool, 1000);
  
  console.log(`Found ${runs.length} runs without mappings`);
  
  for (const run of runs) {
    try {
      // Load plan and profile
      const plan = await loadPlan(pool, run.plan_id);
      const mapping = await loadMappingFromProfile(pool, plan.mapping_profile_id);
      
      // Generate mappings
      await mappingPersistence.autoGenerateMissingMappings(pool, {
        runId: run.run_id,
        mapping,
        plan,
        planId: run.plan_id
      });
      
      console.log(`✅ Healed run ${run.run_id}`);
    } catch (err) {
      console.error(`❌ Failed to heal run ${run.run_id}:`, err.message);
    }
  }
  
  await pool.end();
}

healAllRuns();
```

### 5.2 Startup Self-Heal
**File:** `src/app.js`

**Enhancement:**

```javascript
// In app.js startup
const ENABLE_AUTO_HEAL = process.env.AUTO_HEAL_MAPPINGS !== 'false';

if (ENABLE_AUTO_HEAL) {
  const runs = await mappingPersistence.findRunsWithoutMappings(pool, 10);
  if (runs.length > 0) {
    console.log(`[Startup] Found ${runs.length} runs without mappings, auto-healing...`);
    for (const run of runs) {
      await mappingPersistence.autoGenerateMissingMappings(...);
    }
  }
}
```

### 5.3 Acceptance Tests
**File:** `scripts/test-mapping-persistence.js`

**Test Cases:**
1. ✅ Run creates mapping snapshot
2. ✅ ID mappings recorded for INSERT
3. ✅ ID mappings recorded for SKIP
4. ✅ ID mappings recorded for UPDATE
5. ✅ FK resolution finds correct target PK
6. ✅ FK resolution fails when parent not migrated
7. ✅ Plan reuse loads from migration_run_mappings
8. ✅ Profile changes don't affect reused plans
9. ✅ Dry-run uses immutable mappings
10. ✅ Self-healing backfills old runs

---

## Implementation Checklist

### Database
- [x] Create `migration_run_mappings` table
- [x] Create `migration_id_map` table
- [ ] Run SQL migration on target database
- [ ] Verify indexes created

### Code - Mapping Persistence
- [x] Create `mappingPersistence.js` module
- [x] Implement `saveRunMappings()`
- [x] Implement `loadRunMappings()`
- [x] Implement `autoGenerateMissingMappings()`
- [x] Integrate into `runner.js` startup

### Code - ID Tracking
- [x] Create `idMapTracker.js` module
- [x] Implement `recordIdMapping()`
- [x] Implement `recordBatch()`
- [x] Implement `lookupTargetPk()`
- [ ] Integrate INSERT tracking in runner
- [ ] Integrate SKIP tracking in runner
- [ ] Integrate UPDATE tracking in runner
- [ ] Add `lookupExistingPk()` helper

### Code - FK Resolution
- [ ] Find FK resolution code path
- [ ] Replace with `idMapTracker.lookupTargetPk()`
- [ ] Add error handling for missing parent
- [ ] Test FK resolution accuracy

### Code - Plan Reuse
- [ ] Update GET /api/plans/:id
- [ ] Add `from_run_id` query parameter
- [ ] Load from migration_run_mappings
- [ ] Update POST /api/plans/:id/dry-run
- [ ] Add UI indicators for mapping source

### Scripts & Testing
- [ ] Create heal-migration-mappings.js
- [ ] Create test-mapping-persistence.js
- [ ] Add startup self-heal in app.js
- [ ] Run acceptance tests
- [ ] Document test results

---

## Success Criteria

When complete, the system must:

✅ **Deterministic:** Same plan + same source = same result
✅ **Reusable:** Old plans work regardless of profile changes
✅ **Auditable:** Full trace of mappings and ID transformations
✅ **FK-Safe:** Never guess or insert NULL FKs
✅ **Self-Healing:** Auto-backfills old runs on demand

---

## Next Steps

1. **RUN SQL MIGRATION:**
   ```bash
   mysql -u root -p autoneer < data/add_mapping_persistence_tables.sql
   ```

2. **COMPLETE PHASE 2:** Update runner.js to track all ID operations
   - Focus on lines 1600-1750 (insert/update logic)
   - Add batch ID tracking after each successful operation
   - Handle SKIP/duplicate cases

3. **TEST PHASE 1:** Verify mapping persistence works
   ```bash
   node scripts/test-mapping-persistence.js
   ```

4. **IMPLEMENT PHASE 3:** FK resolution via migration_id_map

5. **IMPLEMENT PHASE 4:** Plan reuse from migration_run_mappings

6. **RUN BACKFILL:** Heal existing runs
   ```bash
   node scripts/heal-migration-mappings.js
   ```

---

## Documentation

See also:
- [TABLE_NAME_NORMALIZATION_FIX.md](./TABLE_NAME_NORMALIZATION_FIX.md) - Canonical table name handling
- [CRITICAL_FIXES_SUMMARY.md](./CRITICAL_FIXES_SUMMARY.md) - Initial wizard fixes
- Database schema: `data/database_schema.md`

---

**Last Updated:** 2026-01-26
**Phase:** 1 Complete, 2 In Progress
**Next Review:** After Phase 2 completion
