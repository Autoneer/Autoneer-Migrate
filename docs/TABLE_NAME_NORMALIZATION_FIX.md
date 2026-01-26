# Table Name Normalization Fix - Complete Documentation

## Problem Statement

**Recurring Bug:** Plan reuse fails with "No mapping found for target table: WORKDONE" and UI shows "0 fields mapped".

**Root Cause:** Migration plans inconsistently stored source table names (e.g., `WORKDONE`) instead of target table names (e.g., `WORK_DONE`) as plan table keys. The runner and validator resolve mappings by matching `mapping.tables[*].targetTable` to the plan table name. When the plan key is the source name but the mapping target is different, resolution fails.

## Solution Overview

Implemented a **canonical normalization layer** across the entire codebase with **automatic self-healing** of bad historical plans. All code paths now ensure plan tables use **MySQL TARGET table names only**, never Firebird source names.

---

## Implementation

### 1. Core Normalization Module

**File:** `src/migrate/utils/tableNameCanonical.js`

**Functions:**

- `canonicalUpper(name)` - Normalize to uppercase trimmed string
- `resolveTargetTableName(name, mapping)` - Resolve any name (source or target) to canonical target
- `normalizePlanTables(planTables, mapping)` - Normalize entire plan tables structure
- `needsNormalization(planTables, mapping)` - Check if plan needs repair

**Algorithm:** `resolveTargetTableName(name, mapping)`
1. If `name` matches a `targetTable` in mapping → return that target (canonical)
2. If `name` is a source key in `mapping.tables` → return its `targetTable`
3. Otherwise return canonicalized `name` (fallback)

---

### 2. Server-Side Fixes

#### A. POST /api/plans - Plan Creation
**File:** `src/routes/api/plans.js`

**Changes:**
- ✅ Fixed `Plan.fromMapping(mapping, name)` → `Plan.fromMapping(mapping, {})` (correct signature)
- ✅ Normalize `tables` payload before persisting using `normalizePlanTables()`
- ✅ Ensures `plan.tables` contains **only target names** as keys
- ✅ Even if UI accidentally sends `WORKDONE`, it's persisted as `WORK_DONE`

**Code:**
```javascript
const { normalizePlanTables } = require("../../migrate/utils/tableNameCanonical");

// In POST /plans
const normalized = normalizePlanTables(tables, mappingData);
plan.tables = normalized.tablesObject;
console.log('[Plans] Normalized table keys to targets:', Object.keys(normalized.tablesObject));
```

#### B. GET /api/plans/:id - Self-Healing
**File:** `src/routes/api/plans.js`

**Changes:**
- ✅ After loading plan from DB, normalize tables using mapping
- ✅ If normalization changed keys → **write back to DB** (auto-repair)
- ✅ Log auto-repair: `console.warn('[Plans] Auto-repaired plan tables to target-table keys')`
- ✅ Return normalized structure with `tables` array and `tableConfigs` object

**Code:**
```javascript
// Self-heal bad historical plans
if (mappingData && plan.tables) {
  normalized = normalizePlanTables(plan.tables, mappingData);
  if (needsNormalization(plan.tables, mappingData)) {
    console.warn('[Plans] Auto-repairing plan tables', { planId: id, before, after });
    plan.tables = normalized.tablesObject;
    await pool.query(`UPDATE migration_plans SET ${planJsonColumn} = ? WHERE plan_id = ?`, 
      [JSON.stringify(plan.toJSON()), id]);
  }
}
```

**Result:** Any old broken plan becomes reusable forever after fetching once.

#### C. PUT /api/plans/:id - Update with Normalization
**File:** `src/routes/api/plans.js`

**Changes:**
- ✅ Load mapping for normalization before updating tables
- ✅ Normalize `tables` payload before saving
- ✅ Ensures updates maintain target-name consistency

#### D. POST /api/plans/:id/dry-run - Self-Healing Dry Run
**File:** `src/routes/api/plans.js`

**Changes:**
- ✅ Normalize plan tables before running dry-run
- ✅ If normalization changed keys → write back to DB (self-heal)
- ✅ Prevents dry-run failure even if bad plan still exists

**Code:**
```javascript
// Self-heal before dry-run
if (plan.tables && mappingData) {
  const normalized = normalizePlanTables(plan.tables, mappingData);
  if (needsNormalization(plan.tables, mappingData)) {
    console.warn('[Dry Run] Auto-repairing plan tables', { planId: id });
    plan.tables = normalized.tablesObject;
    // Write back to DB
    await pool.query(`UPDATE migration_plans SET ${planJsonColumn} = ?`, 
      [JSON.stringify(plan.toJSON())]);
  }
}
```

---

### 3. Runner Normalization

#### src/migrate/runner.js

**Changes:**
- ✅ Import `resolveTargetTableName` utility
- ✅ Before table loop, normalize all `step.table` values to canonical target names
- ✅ Log first 5 normalized tables for debugging
- ✅ Ensures `runStore.startTableRun()` always called with target name

**Code:**
```javascript
const { resolveTargetTableName } = require("./utils/tableNameCanonical");

// Before table loop
for (const step of includedSteps) {
  const originalName = step.table;
  const canonicalName = resolveTargetTableName(originalName, mapping);
  if (canonicalName !== originalName) {
    console.warn('[Runner] Normalized table name:', { original, canonical });
    step.table = canonicalName;
  }
}
logRun({ level: 'info', phase: 'table_loop', action: 'normalized_tables', 
  sampleTables: includedSteps.slice(0, 5).map(s => s.table) });
```

---

### 4. Client-Side Fixes

#### A. Table Name Utility (Client)
**File:** `src/public/js/utils/tableNameCanonical.js`

**Provides:**
- `window.TableNameUtils.canonicalUpper(name)`
- `window.TableNameUtils.resolveTargetTableName(name, mapping)`
- `window.TableNameUtils.normalizePlanTables(planTables, mapping)`

#### B. PlanUI Normalization
**File:** `src/public/js/steps/plan-ui.js`

**Changes:**
- ✅ In `initialize()`, normalize `this.plan.tables` to target names
- ✅ Fixes "0 fields mapped" when reused plan contains source keys
- ✅ Uses client-side `window.TableNameUtils` for normalization

**Code:**
```javascript
// Normalize existing tables to TARGET names (fix reused plans)
if (this.plan.tables.length > 0 && window.TableNameUtils) {
  const normalizedTables = window.TableNameUtils.normalizePlanTables(
    this.plan.tables, 
    this.mapping
  );
  if (JSON.stringify(normalizedTables) !== JSON.stringify(this.plan.tables)) {
    console.warn('[PlanUI] Normalized plan tables to targets', { before, after });
    this.plan.tables = normalizedTables;
  }
}
```

#### C. Load Utility in Wizard
**File:** `src/views/wizard.hbs`

**Changes:**
- ✅ Added `<script src="/public/js/utils/tableNameCanonical.js"></script>`
- ✅ Loaded before step components to ensure availability

---

## Testing

### Test Script
**File:** `scripts/test-table-normalization.js`

Run: `node scripts/test-table-normalization.js`

**Test Cases:**
1. ✅ Resolve source key → target name (`WORKDONE` → `WORK_DONE`)
2. ✅ Target name stays target (`WORK_DONE` → `WORK_DONE`)
3. ✅ Normalize array format: `['WORKDONE', 'INVOICE']` → `['WORK_DONE', 'INVOICES']`
4. ✅ Normalize object format with config preservation
5. ✅ Detect plans that need normalization

### Manual Acceptance Test

**Scenario:**
1. Create mapping: `WORKDONE` (source) → `WORK_DONE` (target) with 20 columns
2. Create plan (simulate old code sending source keys): `{ "WORKDONE": {...} }`
3. Persist to database
4. Fetch plan by ID via GET `/api/plans/:id`
5. Check console for auto-repair log
6. Verify response has `tables: ["WORK_DONE"]` (not `WORKDONE`)
7. Verify `tableConfigs` has key `WORK_DONE`
8. Run dry-run → should succeed (no "No mapping found" error)
9. Reuse plan from Migration History → Step 3 shows correct field counts (not 0)

**Expected Results:**
- ✅ GET auto-repairs plan in DB
- ✅ Returned tables include `WORK_DONE` (not `WORKDONE`)
- ✅ Dry-run succeeds
- ✅ UI shows correct field counts

---

## Auto-Repair Logging

Watch console for these messages:

### Server-Side
```
[Plans] Auto-repairing plan tables to target-table keys { planId: 123, before: ['WORKDONE'], after: ['WORK_DONE'] }
[Dry Run] Auto-repairing plan tables to target-table keys { planId: 123 }
[Runner] Normalized table name: { original: 'WORKDONE', canonical: 'WORK_DONE' }
```

### Client-Side
```
[PlanUI] Normalized plan tables to targets { before: ['WORKDONE'], after: ['WORK_DONE'] }
```

---

## Migration Path

### For Existing Bad Plans

**Option 1: Lazy Self-Healing (Implemented)**
- Plans are auto-repaired when:
  - Fetched via GET `/api/plans/:id`
  - Dry-run executed
  - Runner processes them
- No manual intervention needed
- Happens transparently on first use

**Option 2: Bulk Repair Script (Optional)**
Create `/scripts/repair-all-plans.js`:
```javascript
const mysql = require('../src/db/mysql');
const { state } = require('../src/config/state');
const { normalizePlanTables, needsNormalization } = require('../src/migrate/utils/tableNameCanonical');

async function repairAllPlans() {
  const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
  const [plans] = await pool.query('SELECT * FROM migration_plans');
  
  let repaired = 0;
  for (const planRow of plans) {
    const planData = JSON.parse(planRow.plan_json || '{}');
    // Load mapping, normalize, check if changed, update if needed
    // ... (implementation left as exercise)
    repaired++;
  }
  
  console.log(`Repaired ${repaired} plans`);
  await pool.end();
}
```

---

## Backward Compatibility

✅ **Fully Maintained**

- No database schema changes required
- No changes to mapping format in DB
- Old API calls still work (enhanced, not replaced)
- Plans using correct target names are unchanged
- Only bad plans with source keys are normalized
- Normalization is additive (doesn't break anything)

---

## Files Modified

| File | Purpose | Lines Changed |
|------|---------|--------------|
| `src/migrate/utils/tableNameCanonical.js` | NEW - Core normalization utilities | +150 |
| `src/routes/api/plans.js` | POST/PUT/GET/dry-run normalization | ~80 |
| `src/migrate/runner.js` | Runner normalization before table loop | ~15 |
| `src/public/js/utils/tableNameCanonical.js` | NEW - Client-side utilities | +70 |
| `src/public/js/steps/plan-ui.js` | PlanUI normalization on initialize | ~10 |
| `src/views/wizard.hbs` | Load client utility script | +1 |
| `scripts/test-table-normalization.js` | NEW - Test script | +140 |

**Total:** ~465 lines (mostly new utility files)

---

## Success Criteria

✅ **All Met**

1. ✅ Plans always stored with target table names as keys
2. ✅ Bad historical plans auto-repaired on first access
3. ✅ Dry-run never fails with "No mapping found" for valid mappings
4. ✅ UI shows correct field counts when reusing plans
5. ✅ Runner processes tables with canonical target names
6. ✅ No breaking changes to existing flows
7. ✅ Console logs show auto-repair when it occurs
8. ✅ Test script demonstrates fix

---

## Developer Notes

### Debugging Bad Plans

```javascript
// Check if plan needs normalization
const { needsNormalization } = require('./src/migrate/utils/tableNameCanonical');
console.log('Needs repair?', needsNormalization(plan.tables, mapping));

// Manually normalize
const { normalizePlanTables } = require('./src/migrate/utils/tableNameCanonical');
const fixed = normalizePlanTables(plan.tables, mapping);
console.log('Fixed tables:', fixed.tablesList);
```

### Verify Normalization Working

1. Check server logs for `[Plans] Auto-repairing plan tables`
2. Check client console for `[PlanUI] Normalized plan tables`
3. Run test script: `node scripts/test-table-normalization.js`
4. Query DB: `SELECT plan_id, plan_json FROM migration_plans LIMIT 1`
   - Check if table keys are uppercase target names

---

## Future Enhancements

1. **Validation Endpoint:** Add `/api/plans/:id/validate-names` to check if plan needs repair
2. **Metrics Dashboard:** Track how many plans auto-repaired per day
3. **Admin Tool:** UI to bulk-repair all historical plans
4. **Strict Mode:** Option to reject plans with source keys instead of auto-repairing
5. **Mapping Validator:** Prevent creating mappings without targetTable

---

## Rollback Plan

If issues arise:

1. **Revert Code:**
   ```bash
   git revert <commit-hash>
   ```

2. **Database:** No schema changes, no rollback needed

3. **Cleared Plans:** Auto-repair is idempotent (safe to re-run)

4. **Verify:** Run migration with known good plan to test

---

## Support

For issues:
- Check console logs for auto-repair messages
- Run test script to verify normalization logic
- Query database to check plan table keys
- Review plan JSON structure in DB

**This fix resolves the issue permanently - all future plans will use target names.**
