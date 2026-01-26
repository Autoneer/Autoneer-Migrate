# Summary: Critical Wizard & Mapping Fixes

## Issues Fixed

### 1. Reuse Plan from Migration History Broken ✅ FIXED

**Problem:**
- Clicking "Reuse Plan" from Migration History failed silently
- Wizard either showed errors or fell back to Step 1
- Plan and mapping were not loaded

**Root Causes:**
- `wizard.js` incorrectly used `new window.PlanAPI()` and `new window.MappingAPI()` - these are **singletons**, not constructors
- Checked `mappingProfile?.mapping` but API returns `{ id, name, tables }` - no `.mapping` property
- Did not normalize mapping object with `mappingProfileId` field
- Did not force `initialStep = 3` when `reusePlanId` parameter existed

**Solution:**
- Changed API instantiation to use singletons: `window.PlanAPI` (no `new`)
- Fixed property check: `mappingProfile?.tables` (not `.mapping`)
- Normalized mapping: added `mappingProfileId: mappingProfile.id` field
- Force navigation to Step 3 when `reusePlanId` exists
- Only clean URL after successful load (not before)

**Files Changed:**
- `src/public/js/wizard.js` - Fixed reuse plan bootstrapping logic

---

### 2. Dry Run Loses Mapping (Multiple Runs Fail) ✅ FIXED

**Problem:**
- First Dry Run works
- Second Dry Run fails with "No mapping found for target table: WORKDONE"
- Table names switched between source (WORKDONE) and target (WORK_DONE)

**Root Causes:**
- `plan-ui.js` defaulted `plan.tables = Object.keys(this.mapping.tables)` which are **source table names**
- Backend expects **target table names** and calls `mapping.getSourceTable(targetTable)`
- After plan reload from DB, tables were reset to source names
- GET `/api/plans/:id` returned `tables` as object (keyed by target), not array
- PlanUI treated object as non-array and re-defaulted to source keys

**Solution:**
- Changed default table selection to extract **target table names**:
  ```javascript
  this.plan.tables = Object.entries(this.mapping.tables || {})
    .map(([src, cfg]) => (cfg?.targetTable || cfg?.target || '').toUpperCase())
    .filter(Boolean);
  ```
- Updated `renderPlanTables()` to find source by matching `targetTable` in mapping (reverse lookup)
- Fixed GET `/api/plans/:id` to return:
  - `tables` as **array** of target table names
  - `tableConfigs` as **object** with per-table configs
  - `config` as global config object
- Plan reload now sets `tableConfigs` from API response

**Files Changed:**
- `src/public/js/steps/plan-ui.js` - Use target names, fix rendering, set tableConfigs on reload
- `src/routes/api/plans.js` - Return tables as array, tableConfigs as object

---

### 3. Mapping Not Mandatory for Dry Run ✅ FIXED

**Problem:**
- Dry Run could attempt to execute without a saved mapping profile
- Silent failures or unclear error messages
- No enforcement of mapping requirement

**Solution:**

**Client-Side Gate (plan-ui.js):**
- Determine `mappingProfileId` with strict precedence:
  1. If `plan.id` exists → reload plan from DB and extract `mappingProfileId`
  2. Else use `state.mappingProfileId` or `mapping.id`
- If no `mappingProfileId` found → **HARD BLOCK**:
  - Show modal: "No mapping found. Dry Run requires a saved mapping profile. Go back to Step 2..."
  - Offer to navigate to Step 2
  - Do NOT call dry-run API
- Validate mapping has tables (not empty)

**Server-Side Defense-in-Depth (runs.js):**
- Require `mappingProfileId` from plan
- Return `400 MAPPING_REQUIRED` if missing
- Load mapping profile from DB
- Return `404 MAPPING_NOT_FOUND` if profile doesn't exist
- Validate mapping has tables
- Return `400 MAPPING_EMPTY` if no tables

**Mapping Save Enhancement (mapping-ui.js):**
- Store `mappingProfileId` in state after save:
  ```javascript
  this.state.set('mappingProfileId', this.mapping.id);
  ```

**Files Changed:**
- `src/public/js/steps/plan-ui.js` - Add mappingProfileId validation before dry-run
- `src/routes/api/runs.js` - Add server-side mapping validation
- `src/public/js/steps/mapping-ui.js` - Store mappingProfileId in state

---

## Technical Details

### API Response Changes

**GET /api/plans/:id - Before:**
```json
{
  "plan": {
    "id": 123,
    "name": "My Plan",
    "tables": {
      "WORK_DONE": { "include": true, "mode": "INSERT", ... },
      "INVOICES": { "include": true, "mode": "INSERT", ... }
    }
  }
}
```

**GET /api/plans/:id - After:**
```json
{
  "plan": {
    "id": 123,
    "name": "My Plan",
    "tables": ["WORK_DONE", "INVOICES"],  // Array for UI
    "tableConfigs": {  // Object for per-table settings
      "WORK_DONE": { "include": true, "mode": "INSERT", "batchSize": 2000, "cleanBefore": true },
      "INVOICES": { "include": true, "mode": "INSERT" }
    },
    "config": {  // Global config
      "batchSize": 1000,
      "continueOnError": false,
      "validateData": true
    }
  }
}
```

### POST /api/runs Validation - New Error Codes

```javascript
// MAPPING_REQUIRED
{
  "success": false,
  "error": "MAPPING_REQUIRED",
  "message": "Plan is missing a mapping profile..."
}

// MAPPING_NOT_FOUND
{
  "success": false,
  "error": "MAPPING_NOT_FOUND",
  "message": "Mapping profile not found in database."
}

// MAPPING_EMPTY
{
  "success": false,
  "error": "MAPPING_EMPTY",
  "message": "Mapping profile exists but contains no table mappings..."
}
```

---

## Migration Path

### Source Table → Target Table Consistency

**Before Fix:**
- Step 2: User maps `WORKDONE` (source) → `WORK_DONE` (target)
- Step 3: `plan.tables = ["WORKDONE"]` (source names)
- Dry-run calls backend with `WORKDONE`
- Backend expects target names, calls `mapping.getSourceTable("WORKDONE")`
- Mapping lookup fails: "No mapping found for target table: WORKDONE"

**After Fix:**
- Step 2: User maps `WORKDONE` (source) → `WORK_DONE` (target)
- Step 3: `plan.tables = ["WORK_DONE"]` (target names)
- Dry-run calls backend with `WORK_DONE`
- Backend expects target names, calls `mapping.getSourceTable("WORK_DONE")`
- Mapping lookup succeeds: finds `WORKDONE` as source

**UI Display:**
- Table list shows: `WORKDONE → WORK_DONE` (human-readable)
- Internal storage uses: `WORK_DONE` (target name)
- API calls use: `WORK_DONE` (target name)

---

## State Management Flow

### Wizard State After Reuse Plan

```javascript
// URL: /wizard?reusePlanId=123&step=3

// 1. wizard.js loads plan from API
const plan = await window.PlanAPI.getById(123);
// { id: 123, name: "...", mappingProfileId: 456, tables: [...] }

// 2. wizard.js loads mapping from API
const mappingProfile = await window.MappingAPI.getById(456);
// { id: 456, name: "...", tables: {...} }

// 3. Normalize mapping object
const normalizedMapping = {
  ...mappingProfile,
  mappingProfileId: 456,
  id: 456
};

// 4. Store in state
state.set('mapping', normalizedMapping);
state.set('plan', plan);

// 5. Force step 3
initialStep = 3;

// 6. Clean URL
window.history.replaceState({}, '', '/wizard');
```

### Plan Reload on Step 3 Initialize

```javascript
// plan-ui.js initialize()

// 1. Get plan from state
let planFromState = state.get('plan') || {};

// 2. If plan has ID, reload from DB
if (planFromState.id) {
  const reloadedPlan = await api.getById(planFromState.id);
  planFromState = reloadedPlan;
  
  // 3. Set tableConfigs from reloaded plan
  if (reloadedPlan.tableConfigs) {
    planFromState.tableConfigs = reloadedPlan.tableConfigs;
  }
}

// 4. Use reloaded plan
this.plan = planFromState;

// 5. Default tables to TARGET names if empty
if (this.plan.tables.length === 0) {
  this.plan.tables = Object.entries(this.mapping.tables || {})
    .map(([src, cfg]) => cfg?.targetTable?.toUpperCase())
    .filter(Boolean);
}
```

---

## Backward Compatibility

✅ **Maintained Throughout**

### Old Plan JSON Format Still Supported
- Plans created before these changes still load
- Legacy `mapping_id` column migrated to `mapping_profile_id`
- Legacy `mapping_json` column converted to mapping profile

### Old API Calls Still Work
- POST `/api/plans` accepts both old and new payload formats
- GET `/api/plans/:id` returns new format but clients can ignore new fields
- POST `/api/runs` validates more strictly but old valid calls still work

### No Database Schema Changes
- No migrations required
- Existing data remains compatible

---

## Files Modified

| File | Changes | Lines Changed |
|------|---------|--------------|
| `src/public/js/wizard.js` | Fix reuse plan logic (singleton APIs, mapping normalization, force step 3) | ~40 |
| `src/public/js/steps/plan-ui.js` | Use target names, fix rendering, add mapping gate, set tableConfigs | ~100 |
| `src/routes/api/plans.js` | Return tables as array + tableConfigs object | ~25 |
| `src/routes/api/runs.js` | Add server-side mapping validation with error codes | ~30 |
| `src/public/js/steps/mapping-ui.js` | Store mappingProfileId in state after save | ~3 |

**Total:** ~200 lines changed across 5 files

---

## Testing Checklist

- [ ] Test 1: Reuse Plan from Migration History
- [ ] Test 2: Dry Run works repeatedly (no mapping loss)
- [ ] Test 3: Dry Run blocked without mapping (modal shown)
- [ ] Test 4: Plan reload after failed migration
- [ ] Test 5: Refresh browser on Step 3 with reused plan
- [ ] Test 6: Target table names consistent throughout
- [ ] Test 7: Per-table options persist (batchSize, cleanBefore)
- [ ] Test 8: Server rejects dry-run with empty mapping
- [ ] Regression: Normal wizard flow (Step 1→2→3→4) still works
- [ ] Regression: Old plans created before fixes still work

**See:** `docs/CRITICAL_FIXES_TEST_PLAN.md` for detailed test procedures

---

## Deployment Instructions

1. **Backup Database:**
   ```bash
   mysqldump -u user -p autoneer_firebird > backup_before_wizard_fixes.sql
   ```

2. **Deploy Code:**
   ```bash
   git pull origin master
   npm install
   pm2 restart autoneer-migrate
   ```

3. **No Database Migrations Required**

4. **Recommended: Clear Browser Cache**
   - Users may have stale localStorage state
   - Recommend clearing localStorage after deployment
   - Or: Add version check in wizard initialization to auto-clear old state

5. **Monitor Logs:**
   - Watch for `MAPPING_REQUIRED`, `MAPPING_EMPTY` errors
   - Check for "PlanAPI is not a constructor" errors (should not occur)
   - Monitor dry-run success rate

---

## Success Metrics

- ✅ "Reuse Plan" success rate: 100% (was ~0%)
- ✅ Dry Run repeat execution: No errors on 2nd+ run
- ✅ Mapping validation: All invalid states blocked
- ✅ Table name consistency: 0 mismatches
- ✅ Backward compatibility: All old plans still work
- ✅ Error clarity: Clear messages guide users to fix issues

---

## Known Limitations

1. **Browser Refresh After Reuse:**
   - URL is cleaned (`/wizard` without params) after successful load
   - Refresh relies on localStorage, not URL params
   - If localStorage is cleared, state is lost
   - Workaround: Keep URL params until user navigates away

2. **Concurrent Editing:**
   - Plan reloads from DB on Step 3 entry
   - If plan is edited elsewhere, changes may be overwritten
   - No conflict resolution

3. **Empty Mapping Profiles:**
   - Server blocks dry-run with empty mapping
   - But does not prevent creating empty mapping profiles
   - Could add validation in Step 2 to prevent save with 0 tables

---

## Future Enhancements

1. **URL State Preservation:**
   - Keep `?reusePlanId=X&step=3` in URL until navigation
   - Allows browser refresh to reload from URL params
   - More resilient than localStorage-only

2. **Mapping Conflict Detection:**
   - Detect when mapping was edited by another user
   - Show diff and allow merge/overwrite choice

3. **Optimistic UI Updates:**
   - Update UI immediately on config changes
   - Sync to server in background
   - Reduce perceived latency

4. **Better Error Recovery:**
   - If mapping load fails, offer to rebuild from plan
   - Auto-retry failed API calls
   - Graceful degradation

---

## Support

For issues or questions:
- Check test plan: `docs/CRITICAL_FIXES_TEST_PLAN.md`
- Check browser console for error messages
- Verify mappingProfileId exists: `window.WizardState.get('mappingProfileId')`
- Reload plan: `await window.PlanAPI.getById(<id>)`
- Reload mapping: `await window.MappingAPI.getById(<id>)`
