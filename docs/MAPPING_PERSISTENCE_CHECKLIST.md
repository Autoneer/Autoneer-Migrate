# Mapping Persistence - Implementation Checklist

Use this checklist to track progress on the remaining implementation phases.

---

## Phase 1: Foundation ✅ COMPLETE

- [x] Create `migration_run_mappings` table schema
- [x] Create `migration_id_map` table schema  
- [x] Add indexes for FK lookups
- [x] Create `src/migrate/mappingPersistence.js` module
- [x] Create `src/migrate/idMapTracker.js` module
- [x] Integrate mapping save into `runner.js` startup
- [x] Test mapping save on run creation
- [x] Document implementation in comprehensive guides

**Verification:**
```bash
# Check tables exist
mysql -u root -p autoneer -e "SHOW TABLES LIKE 'migration_%'"

# Check mapping saved after run
mysql -u root -p autoneer -e "SELECT COUNT(*) FROM migration_run_mappings"
```

---

## Phase 2: ID Tracking Integration ⚠️ TODO

### 2.1 INSERT Operation Tracking
- [ ] Locate INSERT success handling in runner.js (lines ~1620-1650)
- [ ] Extract source PK from batch rows before insert
- [ ] Extract target PK from insert result (insertId or batch result)
- [ ] Build array of `{sourcePk, targetPk, operation: 'INSERT'}` objects
- [ ] Call `idMapTracker.recordBatch()` after successful batch
- [ ] Test with small table (e.g., 10 rows)
- [ ] Verify `migration_id_map` populated with INSERT operations

**Code Template:**
```javascript
// After successful INSERT
const idMappings = [];
for (let i = 0; i < rowsToInsert.length; i++) {
  const row = rowsToInsert[i];
  const targetPk = row.targetPk || result.insertId + i; // Adjust based on strategy
  
  if (row.sourcePk) {
    idMappings.push({
      sourcePk: String(row.sourcePk),
      targetPk: String(targetPk),
      operation: 'INSERT'
    });
  }
}

if (idMappings.length > 0) {
  await idMapTracker.recordBatch(pool, {
    runId,
    tableName,
    mappings: idMappings
  });
}
```

### 2.2 SKIP Operation Tracking  
- [ ] Locate duplicate handling code (lines ~1638-1644, 1695-1703)
- [ ] Create `lookupExistingPk()` helper function
- [ ] Query target table to find existing PK using dedupe keys
- [ ] Record source PK → existing target PK with operation: 'SKIP'
- [ ] Test with table that has duplicates
- [ ] Verify SKIP operations recorded

**Helper Function:**
```javascript
async function lookupExistingPk(pool, tableName, dedupeKeyValues, primaryKey) {
  const whereClauses = Object.keys(dedupeKeyValues).map(k => `\`${k}\` = ?`);
  const sql = `SELECT \`${primaryKey}\` FROM \`${tableName}\` WHERE ${whereClauses.join(' AND ')} LIMIT 1`;
  
  const [rows] = await pool.query(sql, Object.values(dedupeKeyValues));
  return rows[0]?.[primaryKey] || null;
}
```

### 2.3 UPDATE Operation Tracking
- [ ] Locate UPSERT mode handling (step.mode === "UPSERT")
- [ ] Determine which rows were updated vs inserted
- [ ] Extract target PKs for updated rows
- [ ] Record with operation: 'UPDATE'
- [ ] Test with UPSERT mode table
- [ ] Verify UPDATE operations recorded

### 2.4 Verification
- [ ] Run migration with INSERT, SKIP, UPDATE scenarios
- [ ] Check operation breakdown:
```sql
SELECT run_id, table_name, operation, COUNT(*) as count
FROM migration_id_map
WHERE run_id = ?
GROUP BY run_id, table_name, operation;
```
- [ ] Verify counts match expected (inserted + skipped + updated = total rows)

---

## Phase 3: FK Resolution ⚠️ TODO

### 3.1 Locate FK Resolution Code
- [ ] Search for FK handling in `src/migrate/mappers/`
- [ ] Search for FK handling in `applyTransform()`
- [ ] Search for FK handling in column transformation code
- [ ] Document current FK resolution strategy
- [ ] Identify all tables with FK dependencies

### 3.2 Replace with ID Map Lookup
- [ ] Import `idMapTracker` into FK resolution module
- [ ] Replace FK resolution with `lookupTargetPk()`
- [ ] Add error handling for missing parent PK
- [ ] Log FK resolution for debugging
- [ ] Remove any FK guessing logic

**Code Template:**
```javascript
// In FK column transformation
async function resolveForeignKey(runId, parentTable, sourceFkValue, mapping) {
  if (!sourceFkValue) return null;
  
  const canonicalParentTable = resolveTargetTableName(parentTable, mapping);
  
  const targetPk = await idMapTracker.lookupTargetPk(pool, {
    runId,
    parentTable: canonicalParentTable,
    sourcePk: String(sourceFkValue)
  });
  
  if (!targetPk) {
    throw new Error(
      `FK resolution failed for ${parentTable}.${sourceFkValue}: ` +
      `Parent record not found in migration_id_map for run ${runId}. ` +
      `Ensure ${parentTable} is migrated before this table.`
    );
  }
  
  console.log(`[FK] Resolved ${parentTable}.${sourceFkValue} → ${targetPk}`);
  return targetPk;
}
```

### 3.3 Table Dependency Ordering
- [ ] Parse FK definitions from mapping or schema
- [ ] Build dependency graph (parent → children)
- [ ] Implement topological sort
- [ ] Detect circular dependencies
- [ ] Reorder plan tables if needed
- [ ] Log reordering decisions

### 3.4 Verification
- [ ] Migrate table with FK dependencies (e.g., order_items → orders)
- [ ] Verify no "FK resolution failed" errors
- [ ] Check child table has correct parent IDs:
```sql
-- Example: verify invoice_items.invoice_id matches invoices.id
SELECT COUNT(*) as orphaned_rows
FROM invoice_items ii
LEFT JOIN invoices i ON ii.invoice_id = i.id
WHERE i.id IS NULL;
-- Should be 0
```
- [ ] Test with parent table NOT migrated (should fail gracefully)

---

## Phase 4: Plan Reuse from Snapshots ⚠️ TODO

### 4.1 Update GET /plans/:id
- [ ] Add `from_run_id` query parameter to route signature
- [ ] Load plan from `migration_plans` table
- [ ] If `from_run_id` provided:
  - [ ] Call `mappingPersistence.loadRunMappings(pool, from_run_id)`
  - [ ] If null, call `autoGenerateMissingMappings()` for backward compatibility
  - [ ] Set `mappingSource = 'run_snapshot'`
- [ ] If NOT provided:
  - [ ] Load from mapping profile (current behavior)
  - [ ] Set `mappingSource = 'profile'`
- [ ] Add `mappingSource` to response JSON
- [ ] Test with query string: `GET /api/plans/123?from_run_id=456`

**Code Location:** `src/routes/api/plans.js` line ~308

**Response Schema:**
```json
{
  "success": true,
  "plan": { ... },
  "mapping": { ... },
  "mappingSource": "run_snapshot",
  "fromRunId": 456
}
```

### 4.2 Update POST /plans/:id/dry-run
- [ ] Add `reuse_run_id` to request body schema
- [ ] If provided, load from `migration_run_mappings`
- [ ] Use immutable mapping for validation
- [ ] Return mapping source in response
- [ ] Test dry-run with reused mapping
- [ ] Verify deterministic results

**Code Location:** `src/routes/api/plans.js` dry-run endpoint

### 4.3 UI Integration
- [ ] Add "Reuse from Run" dropdown in wizard Step 3
- [ ] Show badge: "Using saved mapping from Run #123"
- [ ] Show warning if profile has changed since plan created
- [ ] Disable mapping edit when reusing from run (immutable)
- [ ] Test UI flow with reused plan

### 4.4 Verification
- [ ] Change mapping profile (e.g., add/remove column)
- [ ] Reuse old plan with `from_run_id`
- [ ] Verify OLD mapping used (not new profile)
- [ ] Check field counts match original run
- [ ] Run dry-run → should show same validation as original

---

## Phase 5: Self-Healing & Testing ⚠️ TODO

### 5.1 Create Backfill Script
- [ ] Create `scripts/heal-migration-mappings.js`
- [ ] Import `mappingPersistence` module
- [ ] Call `findRunsWithoutMappings(pool, 1000)`
- [ ] For each run:
  - [ ] Load plan and mapping profile
  - [ ] Call `autoGenerateMissingMappings()`
  - [ ] Log success/failure
- [ ] Add CLI options (dry-run, limit, run-id filter)
- [ ] Test on development database

**Script Template:**
```javascript
const mysql = require('../src/db/mysql');
const { state } = require('../src/config/state');
const mappingPersistence = require('../src/migrate/mappingPersistence');

async function main() {
  const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
  const runs = await mappingPersistence.findRunsWithoutMappings(pool, 100);
  
  console.log(`Found ${runs.length} runs without mappings`);
  
  let healed = 0;
  let failed = 0;
  
  for (const run of runs) {
    try {
      // Load plan, profile, auto-generate
      await mappingPersistence.autoGenerateMissingMappings(pool, {
        runId: run.run_id,
        ...
      });
      console.log(`✅ Healed run ${run.run_id}`);
      healed++;
    } catch (err) {
      console.error(`❌ Failed run ${run.run_id}:`, err.message);
      failed++;
    }
  }
  
  console.log(`\nSummary: ${healed} healed, ${failed} failed`);
  await pool.end();
}

main();
```

### 5.2 Add Startup Auto-Heal
- [ ] Open `src/app.js`
- [ ] Add auto-heal check after DB connection
- [ ] Read `AUTO_HEAL_MAPPINGS` env var (default: true)
- [ ] Call `findRunsWithoutMappings(pool, 10)` (limit to recent runs)
- [ ] Auto-heal if found
- [ ] Log repair count at startup
- [ ] Test startup behavior

**Code Location:** `src/app.js` after database initialization

### 5.3 Create Acceptance Test Script
- [ ] Create `scripts/test-mapping-persistence.js`
- [ ] Test Case 1: Mapping snapshot created on run start
- [ ] Test Case 2: ID mappings track INSERT operations
- [ ] Test Case 3: ID mappings track SKIP operations
- [ ] Test Case 4: ID mappings track UPDATE operations
- [ ] Test Case 5: FK resolution finds correct target PK
- [ ] Test Case 6: FK resolution fails when parent missing
- [ ] Test Case 7: Plan reuse loads from snapshot
- [ ] Test Case 8: Profile changes don't affect reused plans
- [ ] Test Case 9: Dry-run uses immutable mappings
- [ ] Test Case 10: Self-healing backfills old runs

**Test Template:**
```javascript
async function testMappingSnapshot() {
  console.log('Test 1: Mapping snapshot created on run start');
  
  // Start migration
  const runId = await startMigration(...);
  
  // Check migration_run_mappings
  const [rows] = await pool.query(
    'SELECT COUNT(*) as count FROM migration_run_mappings WHERE run_id = ?',
    [runId]
  );
  
  assert(rows[0].count > 0, 'Expected mappings to be saved');
  console.log('✅ PASS');
}
```

### 5.4 Documentation Updates
- [ ] Update README.md with mapping persistence feature
- [ ] Add migration guide for upgrading existing instances
- [ ] Document SQL migration steps
- [ ] Add troubleshooting section
- [ ] Document ENV variables (AUTO_HEAL_MAPPINGS)
- [ ] Add API documentation for `from_run_id` parameter

### 5.5 Final Verification
- [ ] Run all acceptance tests → all pass
- [ ] Run backfill script on production copy → success
- [ ] Test plan reuse with 3+ runs → deterministic
- [ ] Test FK migration with dependencies → correct references
- [ ] Review console logs for errors → none
- [ ] Check migration_run_mappings table → populated
- [ ] Check migration_id_map table → populated
- [ ] Verify backward compatibility → old code still works

---

## Deployment Checklist

### Pre-Deployment
- [ ] All phases complete and tested
- [ ] SQL migration script reviewed
- [ ] Backup production database
- [ ] Test on staging environment
- [ ] Review breaking changes (should be none)
- [ ] Update version number

### Deployment
- [ ] Run SQL migration on production: `mysql < add_mapping_persistence_tables.sql`
- [ ] Verify tables created: `SHOW TABLES LIKE 'migration_%'`
- [ ] Deploy updated code
- [ ] Restart application
- [ ] Check startup logs for auto-heal activity
- [ ] Monitor first migration run

### Post-Deployment
- [ ] Run backfill script: `node scripts/heal-migration-mappings.js`
- [ ] Verify old runs now have mappings
- [ ] Test plan reuse from migration history
- [ ] Monitor FK resolution logs (should see "FK resolved" messages)
- [ ] Check for any errors in production logs
- [ ] Update documentation with production notes

---

## Progress Tracking

**Phase 1:** ✅ COMPLETE (2026-01-26)
**Phase 2:** ⚠️ TODO (Est. 3-4 hours)
**Phase 3:** ⚠️ TODO (Est. 2-3 hours)
**Phase 4:** ⚠️ TODO (Est. 2-3 hours)
**Phase 5:** ⚠️ TODO (Est. 3-4 hours)

**Total Remaining:** ~10-14 hours of development + testing

---

**Use this checklist to track your progress. Check off items as you complete them!**
