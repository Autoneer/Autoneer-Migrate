# Test Plan: Critical Wizard & Mapping Fixes

## Overview
This document outlines the comprehensive test plan for validating all critical fixes to the migration wizard, focusing on plan reuse, mapping persistence, and dry-run functionality.

## Fixes Implemented

### Issue 1: Reuse Plan from Migration History
**Problem:** Clicking "Reuse plan" from Migration History failed silently due to incorrect API usage and property checks.

**Root Causes Fixed:**
- ✅ Changed `new window.PlanAPI()` → `window.PlanAPI` (singleton, not constructor)
- ✅ Changed `new window.MappingAPI()` → `window.MappingAPI` (singleton, not constructor)
- ✅ Fixed `mappingProfile?.mapping` → `mappingProfile?.tables` (correct API response shape)
- ✅ Normalized mapping object with `mappingProfileId` field
- ✅ Force `initialStep = 3` when `reusePlanId` exists (ignore localStorage)

### Issue 2: Dry Run Loses Mapping
**Problem:** Running Dry Run multiple times caused "No mapping found for target table" errors because plan used source table names instead of target names.

**Root Causes Fixed:**
- ✅ Changed `this.plan.tables = Object.keys(this.mapping.tables)` to extract target table names
- ✅ Fixed `renderPlanTables()` to find source table by matching targetTable in mapping
- ✅ Updated GET `/api/plans/:id` to return `tables` as array and `tableConfigs` as object
- ✅ Plan reload now sets `tableConfigs` from API response
- ✅ Added strict mappingProfileId validation before dry-run (client-side gate)
- ✅ Added server-side mapping validation (defense-in-depth)

### Issue 3: Mapping Mandatory for Dry Run
**Problem:** Dry Run could attempt to run without a saved mapping, causing silent failures.

**Enforcement Added:**
- ✅ Client-side: Block dry-run if no mappingProfileId, show modal to go to Step 2
- ✅ Client-side: Validate mapping has tables before allowing dry-run
- ✅ Server-side: Return 400 MAPPING_REQUIRED if no mappingProfileId
- ✅ Server-side: Return 400 MAPPING_EMPTY if mapping has no tables
- ✅ mapping-ui.js stores mappingProfileId in state after save

---

## Test Scenarios

### Test 1: Reuse Plan from Migration History
**Objective:** Verify "Reuse Plan" opens wizard on Step 3 with plan and mapping loaded

**Steps:**
1. Complete a full migration (Steps 1-4) with a saved plan
2. Navigate to Migration History page
3. Find the completed run
4. Click "Reuse Plan" button

**Expected Results:**
- ✅ Browser navigates to `/wizard` (not `/mapping` 404 error)
- ✅ Wizard opens directly on **Step 3** (Plan Creator)
- ✅ Plan name is populated
- ✅ Mapping profile name shows in "Mapping Profile" field
- ✅ Table list shows correct tables with Source → Target display
- ✅ No console errors about "PlanAPI is not a constructor"
- ✅ No errors about "mapping.mapping is undefined"

**Validation Commands:**
```javascript
// Open browser console on Step 3
window.WizardState.get('mapping')
// Should show: { id: X, name: "...", tables: {...}, mappingProfileId: X }

window.WizardState.get('plan')
// Should show: { id: Y, name: "...", tables: [...], mappingProfileId: X }
```

---

### Test 2: Dry Run Works Repeatedly
**Objective:** Verify Dry Run can be executed multiple times without mapping errors

**Steps:**
1. Complete Step 1 (Schema Discovery)
2. Complete Step 2 (Build Mapping) and save mapping profile
3. Go to Step 3 (Plan Creator)
4. Click "Run Dry Run" button
5. Wait for dry-run to complete successfully
6. Click "Run Dry Run" button again (without leaving Step 3)

**Expected Results:**
- ✅ First dry-run completes successfully
- ✅ Second dry-run completes successfully (no "No mapping found for target table" error)
- ✅ Both dry-runs show same table mappings
- ✅ No table name mismatches (WORKDONE vs WORK_DONE)
- ✅ Dry-run results show correct source → target mappings

**Common Errors to Watch For (should NOT occur):**
- ❌ "No mapping found for target table: WORKDONE"
- ❌ "Mapping profile not found"
- ❌ Tables switching from target names to source names

---

### Test 3: Dry Run Blocked Without Mapping
**Objective:** Verify dry-run is blocked if no mapping profile exists

**Steps:**
1. Clear browser localStorage: `localStorage.clear()`
2. Refresh wizard
3. Manually navigate to Step 3 (if possible)
4. Attempt to click "Run Dry Run"

**Expected Results:**
- ✅ Modal appears: "No mapping found. Dry Run requires a saved mapping profile. Go back to Step 2..."
- ✅ Clicking OK navigates to Step 2
- ✅ Clicking Cancel stays on Step 3
- ✅ Dry-run does NOT execute

**Server-Side Validation (if modal bypassed):**
1. Use browser console to force API call:
```javascript
await fetch('/api/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ planId: 123, dryRun: true })
})
```

**Expected Server Response:**
- ✅ HTTP 400 Bad Request
- ✅ Error code: `MAPPING_REQUIRED`
- ✅ Message: "Plan is missing a mapping profile..."

---

### Test 4: Plan Reload After Failed Migration
**Objective:** Verify returning to Step 3 after a failed migration keeps correct mapping

**Steps:**
1. Complete Steps 1-2 with valid mapping
2. Go to Step 3, create plan
3. Go to Step 4, start migration
4. Let migration fail (or cancel it)
5. Navigate back to Step 3

**Expected Results:**
- ✅ Plan is reloaded from database
- ✅ Mapping profile is still associated
- ✅ Table selection shows correct tables
- ✅ Dry-run still works
- ✅ No "Mapping lost" error

---

### Test 5: Refresh Browser on Step 3 with Reused Plan
**Objective:** Verify reused plan URL parameter survives browser refresh

**Steps:**
1. Use "Reuse Plan" from Migration History
2. Wizard opens on Step 3
3. Press F5 to refresh browser

**Expected Results:**
- ✅ URL is `/wizard` (cleaned up, no `?reusePlanId=X&step=3`)
- ✅ Step 3 still loads correctly from localStorage/database
- ✅ Plan and mapping are still present
- ✅ Dry-run works

**Note:** After successful reuse load, URL is cleaned with `history.replaceState()`. On refresh, wizard relies on localStorage to restore state, not query params.

---

### Test 6: Target Table Names Consistent
**Objective:** Verify plan uses target table names throughout (not source names)

**Steps:**
1. Create mapping with source table `WORKDONE` → target `WORK_DONE`
2. Go to Step 3
3. Inspect plan state in console:
```javascript
window.WizardState.get('plan').tables
```

**Expected Results:**
- ✅ `plan.tables` array contains: `["WORK_DONE"]` (target name)
- ✅ NOT: `["WORKDONE"]` (source name)
- ✅ Table list UI shows: "WORKDONE → WORK_DONE"
- ✅ Dry-run uses `WORK_DONE` when calling backend

**Validation in Network Tab:**
1. Run dry-run
2. Check POST `/api/runs` request body
3. `tables` array should contain target names

---

### Test 7: Per-Table Options Persist
**Objective:** Verify per-table configurations (batchSize, cleanBefore) persist through reload

**Steps:**
1. Go to Step 3 with a plan
2. Click "⚙ Options" on a table (e.g., WORK_DONE)
3. Set batch size override: 3000
4. Check "Clean target table before migrate"
5. Save options
6. Run dry-run
7. Return to Step 3 (navigate away and back)
8. Click "⚙ Options" on same table

**Expected Results:**
- ✅ Batch size shows 3000 (not default 1000)
- ✅ Clean before checkbox is checked
- ✅ Settings persist in `plan.tableConfigs`
- ✅ Reload from DB preserves these settings

**Validation:**
```javascript
window.WizardState.get('plan').tableConfigs
// Should show: { "WORK_DONE": { batchSize: 3000, cleanBefore: true } }
```

---

### Test 8: Mapping Has Tables Validation (Server-Side)
**Objective:** Verify server rejects dry-run if mapping exists but has no tables

**Scenario:** Corrupt mapping profile in database with empty tables object

**Manual DB Test:**
```sql
-- Create mapping with no tables
INSERT INTO migration_mapping_profiles (name, mapping_json)
VALUES ('Empty Mapping', '{"name":"Empty","tables":{}}');

-- Create plan using this mapping
INSERT INTO migration_plans (name, mapping_profile_id, plan_json)
VALUES ('Test Plan', LAST_INSERT_ID(), '{"name":"Test","tables":{}}');
```

**API Test:**
```javascript
// Attempt dry-run with plan that has empty mapping
await fetch('/api/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ planId: <plan_id>, dryRun: true })
})
```

**Expected Server Response:**
- ✅ HTTP 400 Bad Request
- ✅ Error code: `MAPPING_EMPTY`
- ✅ Message: "Mapping profile exists but contains no table mappings..."

---

## Regression Tests

### Regression 1: Existing Wizard Flow Still Works
**Objective:** Verify normal wizard flow (no plan reuse) is not broken

**Steps:**
1. Start fresh wizard session
2. Complete Step 1 (Schema Discovery)
3. Complete Step 2 (Build Mapping)
4. Complete Step 3 (Create Plan)
5. Run Dry Run
6. Complete Step 4 (Execute Migration)

**Expected Results:**
- ✅ All steps complete without errors
- ✅ Navigation between steps works
- ✅ Save/load from localStorage works
- ✅ Migration executes successfully

---

### Regression 2: Backward Compatibility with Old Plans
**Objective:** Verify existing plans created before these fixes still work

**Steps:**
1. Load a plan created before these changes
2. Open in wizard via Reuse Plan
3. Run dry-run

**Expected Results:**
- ✅ Plan loads successfully
- ✅ Mapping profile is resolved (via migration logic)
- ✅ Dry-run works

---

## Known Issues / Edge Cases

### Edge Case 1: Plan Without Mapping Profile ID
**Scenario:** Very old plan created before `mapping_profile_id` column existed

**Expected Behavior:** 
- `resolvePlanMappingProfileId()` migrates legacy `mapping_id` or `mapping_json` to new format
- Plan becomes usable after migration
- If migration fails, user is prompted to rebuild mapping

### Edge Case 2: Deleted Mapping Profile
**Scenario:** Plan references a mapping profile that was deleted from database

**Expected Behavior:**
- Dry-run returns 404 MAPPING_NOT_FOUND
- User is prompted to rebuild mapping in Step 2
- No silent failures

### Edge Case 3: Multiple Tables with Same Target
**Scenario:** Two source tables map to same target (invalid mapping)

**Expected Behavior:**
- Mapping validation in Step 2 should prevent this
- If it occurs, migration will fail with clear error message
- Not a wizard flow issue (data validation issue)

---

## Success Criteria

✅ All 8 test scenarios pass  
✅ Both regression tests pass  
✅ No console errors during normal operation  
✅ "Reuse Plan" opens wizard on Step 3 100% of time  
✅ Dry-run works on first attempt and all subsequent attempts  
✅ Mapping persistence confirmed across browser refreshes  
✅ Server-side validation prevents invalid dry-runs  
✅ Target table names used consistently (not source names)  

---

## Test Execution Checklist

- [ ] Test 1: Reuse Plan from Migration History
- [ ] Test 2: Dry Run Works Repeatedly
- [ ] Test 3: Dry Run Blocked Without Mapping
- [ ] Test 4: Plan Reload After Failed Migration
- [ ] Test 5: Refresh Browser on Step 3
- [ ] Test 6: Target Table Names Consistent
- [ ] Test 7: Per-Table Options Persist
- [ ] Test 8: Mapping Has Tables Validation
- [ ] Regression 1: Existing Wizard Flow
- [ ] Regression 2: Backward Compatibility

---

## Browser Console Debug Commands

```javascript
// Check wizard state
window.__wizardDebug()

// Check current mapping
window.WizardState.get('mapping')

// Check current plan
window.WizardState.get('plan')

// Check plan tables (should be target names)
window.WizardState.get('plan').tables

// Check table configs
window.WizardState.get('plan').tableConfigs

// Check mappingProfileId
window.WizardState.get('mappingProfileId')
window.WizardState.get('mapping').mappingProfileId

// Force reload plan from DB
await window.PlanAPI.getById(<plan_id>)

// Force reload mapping from DB
await window.MappingAPI.getById(<mapping_id>)
```

---

## Deployment Notes

1. **Database Migration:** No schema changes required
2. **Browser Cache:** Recommend users clear localStorage after deployment to avoid stale state conflicts
3. **API Changes:** 
   - GET `/api/plans/:id` response shape changed (added `tableConfigs`, `config` fields)
   - POST `/api/runs` now validates mapping more strictly
4. **Backward Compatibility:** Maintained - old plans auto-migrate, old API calls still work

---

## Rollback Plan

If critical issues found after deployment:

1. **Revert Commits:** All changes in single atomic commit - easy to revert
2. **Clear User State:** Users may need to clear localStorage
3. **Database:** No schema changes, no migration needed
4. **APIs:** All endpoints maintain backward compatibility - old clients still work

---

## Post-Deployment Monitoring

Watch for these error patterns in logs:

- `MAPPING_REQUIRED` - indicates users trying dry-run without mapping
- `MAPPING_EMPTY` - indicates corrupt mapping profiles in DB
- `PlanAPI is not a constructor` - indicates reuse plan fix didn't apply
- `No mapping found for target table` - indicates table name mismatch still occurring

If any of these appear frequently, investigate root cause and file bug report.
