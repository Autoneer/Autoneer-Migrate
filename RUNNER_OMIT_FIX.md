# Fix: Runner Respects Omit Field Selections

**Issue**: Migration failing with "MySQL missing columns: TEL_HOME" even though TEL_HOME was marked as "omit" in field mapping.

**Root Cause**: The migration runner's preflight validation was checking ALL columns from the mapping, including omitted ones.

**Fix Location**: `src/migrate/runner.js` (lines 1035-1040)

## Before
```javascript
const firebirdColumns = Object.keys(columnsMap || {});
const targetColumns = Object.values(columnsMap || {}).map((c) => c.target);
```

This included ALL columns, even ones marked with `omit: true`.

## After
```javascript
// Filter out omitted columns from validation
const firebirdColumns = Object.keys(columnsMap || {}).filter(srcCol => {
  const colConfig = columnsMap[srcCol];
  return !colConfig.omit; // Exclude omitted columns
});
const targetColumns = Object.values(columnsMap || {})
  .filter(c => !c.omit) // Exclude omitted columns
  .map((c) => c.target);
```

Now omitted columns are excluded from:
1. Firebird column existence check
2. MySQL column existence check  
3. Column validation in preflight

## Testing
1. Mark a field as "omit" in Step 2 (Build Mapping)
2. Save the mapping
3. Create a plan and run migration
4. ✅ Should NOT error about missing MySQL columns for omitted fields

## Impact
- ✅ Omitted fields are now fully respected in migration runner
- ✅ No breaking changes
- ✅ Works with existing omit implementation

## Related Files
- This completes the omit functionality alongside:
  - `src/migrate/validators/PlanValidator.js` - Dry-run omit handling
  - `src/migrate/executors/TableExecutor.js` - Payload generation omit filtering
  - `src/routes/api/plans.js` - API omit handling
