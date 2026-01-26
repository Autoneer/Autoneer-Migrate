# Quick Reference: Wizard Fixes

## Common Issues & Solutions

### Issue: "Reuse Plan" Shows Blank Step 3
**Debug:**
```javascript
// Check if mapping loaded
window.WizardState.get('mapping')
// Should show: { id: X, tables: {...}, mappingProfileId: X }

// Check if plan loaded
window.WizardState.get('plan')
// Should show: { id: Y, mappingProfileId: X, tables: [...] }
```

**Common Causes:**
- API returned `mappingProfile.mapping` instead of `mappingProfile.tables` ❌
- Used `new window.PlanAPI()` instead of `window.PlanAPI` ❌
- Missing `mappingProfileId` normalization ❌

**Solution:** All fixed in `wizard.js` - ensure latest code is deployed

---

### Issue: "No Mapping Found for Target Table: WORKDONE"
**Debug:**
```javascript
// Check plan tables (should be TARGET names)
window.WizardState.get('plan').tables
// ✅ Correct: ["WORK_DONE", "INVOICES"]
// ❌ Wrong: ["WORKDONE", "INVOICE"]

// Check mapping structure
window.WizardState.get('mapping').tables
// Should have: { "WORKDONE": { targetTable: "WORK_DONE", ... } }
```

**Common Causes:**
- `plan.tables` contains source names instead of target names ❌
- Plan reload reset tables to `Object.keys(mapping.tables)` ❌

**Solution:** Plan now uses target names consistently - verify:
```javascript
Object.entries(mapping.tables)
  .map(([src, cfg]) => cfg.targetTable)
  .filter(Boolean)
```

---

### Issue: Dry Run Blocked with "No Mapping Found" Modal
**This is EXPECTED behavior** - mapping is now mandatory!

**Debug:**
```javascript
// Check if mappingProfileId exists
window.WizardState.get('mappingProfileId')
window.WizardState.get('mapping')?.mappingProfileId

// Should return a number (mapping profile ID)
// If null/undefined → mapping not saved
```

**Solution:**
1. Click OK to go to Step 2
2. Save mapping profile
3. Return to Step 3
4. Dry Run will work

---

### Issue: Plan Reload Loses Table Configs
**Debug:**
```javascript
// Check tableConfigs after reload
window.WizardState.get('plan').tableConfigs
// Should show: { "WORK_DONE": { batchSize: 2000, cleanBefore: true } }
```

**Common Causes:**
- GET `/api/plans/:id` not returning `tableConfigs` field ❌
- Plan reload not setting `planFromState.tableConfigs` ❌

**Solution:** Verify API response includes:
```json
{
  "plan": {
    "tables": ["WORK_DONE"],
    "tableConfigs": { "WORK_DONE": { ... } },
    "config": { "batchSize": 1000, ... }
  }
}
```

---

## API Quick Reference

### PlanAPI (Singleton)
```javascript
// ✅ Correct
window.PlanAPI.getById(123)

// ❌ Wrong
new window.PlanAPI().getById(123)
```

### MappingAPI (Singleton)
```javascript
// ✅ Correct
window.MappingAPI.getById(456)

// ❌ Wrong
new window.MappingAPI().getById(456)
```

### GET /api/plans/:id Response
```json
{
  "success": true,
  "plan": {
    "id": 123,
    "name": "My Plan",
    "mappingProfileId": 456,
    "tables": ["WORK_DONE", "INVOICES"],  // Array
    "tableConfigs": {  // Object
      "WORK_DONE": { "batchSize": 2000, "cleanBefore": true }
    },
    "config": {  // Global
      "batchSize": 1000,
      "continueOnError": false,
      "validateData": true
    }
  }
}
```

### POST /api/runs Error Codes
- `MAPPING_REQUIRED` - Plan has no mappingProfileId
- `MAPPING_NOT_FOUND` - Mapping profile doesn't exist in DB
- `MAPPING_EMPTY` - Mapping profile has no tables

---

## State Flow Diagram

```
Migration History
    ↓ [Reuse Plan]
/wizard?reusePlanId=123&step=3
    ↓
wizard.js initialize()
    ↓
Load plan: PlanAPI.getById(123)
    ↓
Load mapping: MappingAPI.getById(plan.mappingProfileId)
    ↓
Normalize mapping: { ...mappingProfile, mappingProfileId: id, id }
    ↓
state.set('mapping', normalizedMapping)
state.set('plan', plan)
    ↓
Force: initialStep = 3
    ↓
Clean URL: /wizard
    ↓
Show Step 3 (PlanUI)
    ↓
PlanUI.initialize()
    ↓
Reload plan from DB (if plan.id exists)
    ↓
Set tableConfigs from reloaded plan
    ↓
Default tables to TARGET names:
  Object.entries(mapping.tables)
    .map(cfg => cfg.targetTable)
    ↓
Render Step 3 UI
```

---

## Debugging Commands

### Inspect Wizard State
```javascript
window.__wizardDebug()
```

### Check Current Step
```javascript
window.wizard.currentStep
```

### Reload Plan from DB
```javascript
const plan = await window.PlanAPI.getById(123)
console.log(plan)
```

### Reload Mapping from DB
```javascript
const mapping = await window.MappingAPI.getById(456)
console.log(mapping)
```

### Verify Table Names
```javascript
// Plan tables (should be TARGET names)
const planTables = window.WizardState.get('plan').tables
console.log('Plan tables:', planTables)

// Mapping tables (SOURCE → TARGET)
const mappingTables = window.WizardState.get('mapping').tables
Object.entries(mappingTables).forEach(([src, cfg]) => {
  console.log(`${src} → ${cfg.targetTable}`)
})
```

### Force Dry Run (Bypass UI)
```javascript
// Get plan ID
const planId = window.WizardState.get('plan').id

// Call API directly
const response = await fetch('/api/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ planId, dryRun: true })
})

const result = await response.json()
console.log(result)
```

### Clear State (Nuclear Option)
```javascript
localStorage.clear()
location.reload()
```

---

## Common Error Messages

### "PlanAPI is not a constructor"
**Cause:** Using `new window.PlanAPI()` instead of `window.PlanAPI`  
**Fix:** Remove `new` keyword

### "Cannot read property 'mapping' of undefined"
**Cause:** Checking `mappingProfile?.mapping` instead of `mappingProfile?.tables`  
**Fix:** API returns `tables`, not `mapping`

### "No mapping found for target table: WORKDONE"
**Cause:** Plan uses source names instead of target names  
**Fix:** Ensure `plan.tables` contains target names from `cfg.targetTable`

### "Mapping profile not found"
**Cause:** mappingProfileId is null or invalid  
**Fix:** Save mapping in Step 2 before creating plan

### "Mapping profile exists but contains no table mappings"
**Cause:** Mapping JSON has empty `tables` object  
**Fix:** Rebuild mapping in Step 2 with at least one table

---

## File Quick Reference

| File | Purpose |
|------|---------|
| `src/public/js/wizard.js` | Main wizard orchestrator, reuse plan logic |
| `src/public/js/steps/plan-ui.js` | Step 3 UI, dry-run gate, table name handling |
| `src/public/js/steps/mapping-ui.js` | Step 2 UI, mapping save |
| `src/routes/api/plans.js` | Plan CRUD, GET/:id response format |
| `src/routes/api/runs.js` | Run execution, dry-run validation |
| `src/public/js/api/plan-api.js` | Plan API client (singleton) |
| `src/public/js/api/mapping-api.js` | Mapping API client (singleton) |

---

## Testing Quick Commands

### Test Reuse Plan
1. Complete migration with plan ID 123
2. Navigate to Migration History
3. Click "Reuse Plan"
4. Verify opens on Step 3
5. Console: `window.WizardState.get('plan').id === 123`

### Test Dry Run Repeat
1. Go to Step 3
2. Run Dry Run
3. Wait for success
4. Run Dry Run again
5. Verify no "mapping not found" errors

### Test Mapping Required
1. Clear localStorage
2. Refresh wizard
3. Try to run Dry Run
4. Verify modal blocks execution

---

## Performance Tips

1. **Avoid Excessive Plan Reloads:**
   - Plan is reloaded on Step 3 initialize if `plan.id` exists
   - Only happens once per step entry
   - Cached in `this.plan`

2. **Minimize API Calls:**
   - Mapping loaded once in wizard.js (reuse plan)
   - Plan loaded once in plan-ui.js (initialize)
   - No polling or repeated fetches

3. **Use State Management:**
   - `WizardState` is in-memory cache
   - `WizardStorage` syncs to localStorage
   - Prefer state.get() over API calls when possible

---

## Migration Checklist

When migrating to these fixes:

- [ ] Deploy code changes
- [ ] Test reuse plan with existing plans
- [ ] Test dry run with existing mappings
- [ ] Verify backward compatibility with old plan JSON
- [ ] Check server logs for new error codes
- [ ] Monitor dry-run success rate
- [ ] User communication: Recommend clearing localStorage

---

## Support Contacts

- **Issue Tracking:** GitHub Issues
- **Documentation:** `docs/` folder
- **Detailed Tests:** `docs/CRITICAL_FIXES_TEST_PLAN.md`
- **Summary:** `docs/CRITICAL_FIXES_SUMMARY.md`
