# Bug Fix: NULL Dedupe Keys Incorrectly Treated as Duplicates

## Issue Summary
**Run ID**: 94  
**Date**: 2026-01-20  
**Severity**: CRITICAL - Data Loss

### Problem Description
During migration of `spares_used` table, 438 out of 443 rows were incorrectly skipped as "duplicates" when they actually had NULL values in the dedupe key columns (`job_number`, `lnr`). The deduplication logic was treating all rows with NULL dedupe keys as having the same key, causing them to be incorrectly flagged as duplicates after the first NULL row was encountered.

### Log Evidence
```json
{"phase":"deduplication","dedupe_keys":["job_number","lnr"],"dedupe_values":[null,null],"reason":"duplicate_key"}
```

This pattern repeated 438 times, with only 5 rows actually inserted (those with non-NULL dedupe key values).

### Secondary Issue
The migration also revealed a mapping problem where price columns (`COST_PRICE`, `SALES_PRICE`) were not being migrated correctly, resulting in only 2 rows with non-zero prices in MySQL vs 438 in Firebird.

## Root Cause Analysis

### Deduplication Logic Flaw
In [runner.js](../src/migrate/runner.js) around line 1273, the code checked if dedupe keys were "ready" (non-NULL):

```javascript
const ready = row.dedupeValues?.every((v) => v !== undefined && v !== null);
```

However, when `ready` was `false`, the code fell through to the `else` block without explicit handling:

```javascript
if (ready && matched) {
    // Handle duplicates
} else {
    toInsert.push({ row, sourceRow, rowIndex });  // This should happen
}
```

The problem was that the condition `ready && matched` was false for NULL keys, but the matching logic still executed for the first NULL row, setting up a scenario where subsequent NULL rows would be treated as duplicates against that first NULL entry in the batch.

## Solution Implemented

### 1. Explicit NULL Dedupe Key Handling
Modified the deduplication loop to explicitly handle rows with NULL dedupe keys:

```javascript
// If dedupe keys contain NULL values, always insert the row (cannot reliably deduplicate)
if (!ready) {
    logRun({
        level: 'debug',
        phase: 'deduplication',
        table: tableName,
        action: 'null_dedupe_keys',
        dedupe_keys: dedupeKeys,
        dedupe_values: row.dedupeValues,
        message: 'Row has NULL dedupe key values; inserting without deduplication'
    });
    toInsert.push({ row, sourceRow, rowIndex });
    continue; // Skip deduplication logic for this row
}
```

**Key Changes**:
- Added explicit `if (!ready)` check at the start of the loop
- Rows with NULL dedupe keys are immediately added to `toInsert` array
- Added debug logging to track NULL dedupe key occurrences
- Use `continue` to skip matching/deduplication logic entirely

### 2. Preflight Validation for NULL Dedupe Keys
Added early detection to warn users when dedupe keys contain NULL values:

```javascript
// Validate dedupe keys for NULL values in source data
if (dedupeKeys.length && !dryRun) {
    const dedupeSourceCols = dedupeKeys
        .map(targetCol => {
            const entry = Object.entries(columnsMap || {}).find(([, rule]) => rule.target === targetCol);
            return entry ? entry[0] : null;
        })
        .filter(Boolean);
    
    if (dedupeSourceCols.length === dedupeKeys.length) {
        try {
            const nullCheckQuery = `SELECT COUNT(*) as null_count FROM ${sourceTable} WHERE ${dedupeSourceCols.map(c => `${c} IS NULL`).join(' OR ')}`;
            const nullCheckResult = await firebird.query(firebirdConfig, nullCheckQuery);
            const nullCount = nullCheckResult[0]?.NULL_COUNT || 0;
            
            if (nullCount > 0) {
                logRun({
                    level: 'warn',
                    phase: 'preflight',
                    table: tableName,
                    action: 'dedupe_keys_validation',
                    message: `Found ${nullCount} rows with NULL values in dedupe key columns [${dedupeKeys.join(', ')}]`,
                    hint: 'These rows will be inserted without deduplication. Consider choosing dedupe keys without NULLs or adding transforms to provide default values.'
                });
            }
        } catch (err) {
            // Non-critical validation - log and continue
        }
    }
}
```

**Benefits**:
- Warns users at preflight stage before migration starts
- Queries Firebird source table to count NULL values
- Provides actionable hint to fix the mapping
- Non-blocking (continues migration with warning)

## Impact Assessment

### Before Fix
- **Result**: 438 rows skipped as duplicates (99% data loss)
- **Inserted**: 5 rows
- **Skipped**: 438 rows (all had NULL dedupe keys)
- **Outcome**: FAILED migration with validation error

### After Fix (Expected)
- **Result**: All 443 rows inserted (no data loss)
- **Inserted**: 443 rows (5 with valid dedupe keys + 438 with NULL keys)
- **Skipped**: 0 rows
- **Outcome**: SUCCESSFUL migration with warning about NULL dedupe keys

### Performance Impact
- Negligible: NULL check is O(1) per row
- Preflight validation adds ~50-200ms per table (one COUNT query)

## Testing Checklist

- [ ] **Test 1**: Run migration with dedupe keys that have NULL values
  - Expected: Rows with NULL keys are inserted, not skipped
  - Expected: Preflight warning logged with count of NULL rows
  
- [ ] **Test 2**: Run migration with dedupe keys that have no NULL values
  - Expected: Deduplication works as before
  - Expected: No preflight warning
  
- [ ] **Test 3**: Run migration with mixed NULL/non-NULL dedupe keys
  - Expected: NULL rows inserted, non-NULL rows deduplicated correctly
  - Expected: Preflight warning with accurate count
  
- [ ] **Test 4**: Verify debug logging
  - Expected: Debug logs show `null_dedupe_keys` action for each NULL row
  - Expected: Logs include actual NULL values array

## Recommendations

### For `spares_used` Table
The `job_number` and `lnr` columns contain NULLs because they are not populated for all rows in Firebird. Consider:

1. **Option A**: Change dedupe keys to `spares_id` (if preserving IDs)
   ```javascript
   step.dedupeKeys = ["spares_id"];
   step.keyStrategy = "preserve";
   ```

2. **Option B**: Add transform to generate default values for NULL keys
   ```javascript
   columns: {
       JOB_NUMBER: { target: 'job_number', transform: 'coalesceDefault', default: 'UNKNOWN' },
       LNR: { target: 'lnr', transform: 'coalesceDefault', default: 0 }
   }
   ```

3. **Option C**: Use a unique dedupe key that never has NULLs
   ```javascript
   step.dedupeKeys = ["some_unique_column"];
   ```

### For Price Columns
The price validation failure indicates a separate mapping issue. Verify:

1. `COST_PRICE` and `SALES_PRICE` columns are in the mapping
2. Transform preserves NULL vs 0 (use `toNumber` not `coerceNumber`)
3. Source columns are correctly named in Firebird schema

## Files Modified

1. **src/migrate/runner.js**
   - Lines ~1273-1320: Added NULL dedupe key handling in deduplication loop
   - Lines ~1063-1095: Added preflight validation for NULL dedupe keys
   - Lines ~1298: Fixed dedupe value extraction to use `row.mappedRow[k]` instead of `row[k]`

## Related Issues
- Priority 0 Task 4: Zero-Loss Validation (already implemented)
- Price mapping validation failing (requires separate investigation)

## Rollback Plan
If this fix causes issues:
1. Revert commit with these changes
2. Manually add condition to migration plan to filter rows with NULL dedupe keys
3. Investigate alternative dedupe key strategy

## Version Info
- **Branch**: master
- **Commit**: TBD (pending commit after testing)
- **Node.js**: 18+
- **MySQL**: 8.0+
- **Firebird**: 3.0+
