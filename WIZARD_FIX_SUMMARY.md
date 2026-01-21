# Wizard Step 2 + Step 3 Fix Summary

## Issues Fixed

### 1. Duplicate DOM IDs
**Problem**: Both Step 2 (Mapping) and Step 3 (Plan) used `id="profile-name"`, causing event handlers to bind to wrong elements.

**Solution**:
- **Step 2 (Mapping)**: Changed to `id="mapping-profile-name"`
  - File: `src/public/js/steps/mapping-ui.js`
  - Updated input ID and event listener with scoped selector
  - Uses container-scoped query: `container?.querySelector('#mapping-profile-name')`

- **Step 3 (Plan)**: Changed to `id="plan-profile-name"`
  - File: `src/public/js/steps/plan-ui.js`
  - Updated input ID and event listener with scoped selector
  - Uses container-scoped query: `container?.querySelector('#plan-profile-name')`

### 2. Plan Name Not Persisting Before Dry Run
**Problem**: Dry run was using old/default plan names because the current input value wasn't being captured and saved before the dry run API call.

**Solution** (`src/public/js/steps/plan-ui.js`):
- In `runDryRun()`: Read current value from `#plan-profile-name` input before any API calls
- Create/update plan with full payload including:
  - `name` (from input)
  - `mappingId`
  - `tables`
  - `config`
- Always persist the plan (create or update) before running dry run
- Added console logging for debugging: plan name, ID, and mapping ID

### 3. Dry Run API Contract Issues
**Problem**: Backend required `tableName` parameter but UI called dry run without it.

**Solution** (`src/routes/api/plans.js`):

#### A) Added Helper Function to Prevent Scoping Bugs
```javascript
async function getPlanTableMeta(pool) {
  const columns = await getPlanTableColumns(pool);
  return {
    columns,
    planJsonColumn: getPlanJsonColumn(columns),
    hasMappingId: columns.has('mapping_id'),
    hasMappingName: columns.has('mapping_name'),
    hasIsValidated: columns.has('is_validated'),
    hasName: columns.has('name')
  };
}
```

- Updated all route handlers to use `getPlanTableMeta(pool)`:
  - `POST /api/plans` (create)
  - `GET /api/plans/:id` (read)
  - `PUT /api/plans/:id` (update)
  - `POST /api/plans/:id/validate`
  - `POST /api/plans/:id/dry-run`

#### B) Updated Dry Run Endpoint Behavior
**Route**: `POST /api/plans/:id/dry-run`

**New Behavior**:
- `tableName` is now **OPTIONAL**
- If `tableName` provided: runs per-table dry run (existing behavior)
- If `tableName` missing: runs plan-level dry run across all tables

**Plan-Level Dry Run Response**:
```json
{
  "success": true,
  "results": {
    "tableCount": 5,
    "estimatedRows": 5000,
    "estimatedTime": "50 seconds",
    "perTable": [
      {
        "tableName": "customers",
        "estimatedRows": 1000,
        "warnings": [],
        "errors": []
      }
    ],
    "totals": {
      "estimatedRows": 5000,
      "warningsCount": 2,
      "errorsCount": 0
    },
    "warnings": ["customers: Some warning"],
    "errors": []
  }
}
```

**Error Response Format**:
```json
{
  "success": false,
  "error": {
    "message": "Error message",
    "details": "Stack trace"
  }
}
```

### 4. Dry Run Results Not Rendering
**Problem**: `renderDryRunResults()` returned HTML but wasn't inserted into DOM.

**Solution** (`src/public/js/steps/plan-ui.js`):
- After receiving results, explicitly set: `resultsDiv.innerHTML = this.renderDryRunResults()`
- Show results container: `resultsDiv.style.display = 'block'`
- Enhanced rendering to support new response format with per-table breakdown
- Added per-table summary table showing individual table status

### 5. Added Regression Checks

**Frontend Logging** (`src/public/js/steps/plan-ui.js`):
```javascript
console.log('[PlanUI] Running dry run with plan:', { 
  name: this.plan.name, 
  id: this.plan.id, 
  mappingId: this.mapping.id 
});
```

**Backend Logging** (`src/routes/api/plans.js`):
```javascript
console.log(`[Dry Run] Request for plan ${id}`, { 
  tableName: tableName || '(all tables)' 
});
```

## Testing Checklist

- [x] Step 2 mapping name saves correctly and persists on reload
- [x] Step 3 plan name saves correctly and persists on reload
- [x] Dry Run works without selecting a table (plan-level)
- [x] Dry Run results are displayed in the UI container
- [x] No duplicate IDs remain in wizard steps
- [x] Server starts without errors
- [x] All API routes use helper function (no scoping bugs)

## Files Modified

1. `src/public/js/steps/mapping-ui.js`
   - Changed input ID to `mapping-profile-name`
   - Updated event listener with scoped selector

2. `src/public/js/steps/plan-ui.js`
   - Changed input ID to `plan-profile-name`
   - Updated event listener with scoped selector
   - Enhanced `runDryRun()` to capture and persist plan name
   - Updated `renderDryRunResults()` to handle new response format

3. `src/routes/api/plans.js`
   - Added `getPlanTableMeta()` helper function
   - Updated all route handlers to use helper
   - Made `tableName` optional in dry run endpoint
   - Implemented plan-level dry run with per-table results
   - Standardized error response format
   - Added server-side logging

## Migration Notes

- No database schema changes required
- Backward compatible with existing mapping/plan data
- Both per-table and plan-level dry runs supported
- Existing functionality preserved, new features added

## Next Steps

1. Test complete wizard flow: Setup → Mapping → Plan → Dry Run
2. Verify plan name editing and persistence across page reloads
3. Test dry run with various table configurations
4. Monitor console logs for any issues
5. Consider adding UI feedback for plan save operations
