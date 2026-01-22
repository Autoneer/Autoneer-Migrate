# Quick Reference: Dry-Run NULL Handling

## TL;DR

✅ **Omitted fields are never validated or migrated**  
✅ **NULL source values are OK if target is nullable**  
✅ **NOT NULL targets need mapping default OR must be omitted**  
✅ **Errors are now actionable, not confusing**

---

## Error Messages & Fixes

### ❌ "Target column X is NOT NULL but source value is NULL"

**Root Cause**: No way to provide a value for a required column

**Fixes**:
1. Provide a mapping default (e.g., 0, '', 1970-01-01)
2. Mark column as "Omit"
3. Fix the source data

---

### ⚠️ "Target column X is NOT NULL with a database default, but source value is NULL and no mapping default provided"

**Root Cause**: DB default can apply, but needs clarification

**Fixes**:
1. Let it be (migration will succeed, DB default will apply)
2. OR provide mapping default for consistency
3. OR mark as "Omit" and let DB handle all rows

---

### ❌ "Target primary key column X would receive NULL"

**Root Cause**: Primary keys cannot be NULL

**Fixes**:
1. Mark column as "Omit" (let DB auto-increment)
2. Provide mapping default (e.g., UUID generator)
3. Fix source data

---

### ✅ No error for nullable fields

**Behavior**: NULL source values are fine if target allows NULL

**Example**:
```
Source: EMAIL = NULL
Target: email VARCHAR(255) NULL  ← Allows NULL
Result: ✅ OK - NULL will be migrated
```

---

## Validation Rules (Logic Table)

| Source | Transform | Mapping Default | Target Nullable | Target Has DB Default | Target PK | Result |
|--------|-----------|-----------------|-----------------|----------------------|-----------|--------|
| NULL | - | - | YES | Any | Any | ✅ OK |
| NULL | - | YES | NO | Any | Any | ✅ OK |
| NULL | - | NO | NO | YES | NO | ⚠️ Suggest default |
| NULL | - | NO | NO | NO | NO | ❌ ERROR |
| NULL | - | NO | NO | Any | YES | ❌ ERROR |
| - | Returns NULL | NO | YES | Any | Any | ✅ OK |
| - | Returns NULL | YES | NO | Any | Any | ✅ OK |
| - | Returns NULL | NO | NO | Any | Any | ❌ ERROR |

---

## Code Examples

### Validation with Schema (Proper)

```javascript
const PlanValidator = require('./validators/PlanValidator');

const result = await PlanValidator.dryRun(
  sampleRow,        // First row from Firebird
  mapping,          // Mapping profile
  'CUSTOMERS',      // Source table
  'customers',      // Target table  ← NEW
  schema            // Schema with metadata ← NEW
);

if (!result.migratable) {
  result.issues.forEach(err => console.log(err));
}
```

### Payload Generation (Correct)

```javascript
// Omitted fields are excluded
const targetColumns = Array.from(fieldMaps.values())
  .filter(fm => !fm.omit)      // ← Excludes omitted
  .map(fm => fm.targetColumn);

const query = `INSERT INTO table (${targetColumns.join(',')}) VALUES ...`;
```

### Field with Omit Flag

```javascript
const field = new FieldMap({
  sourceColumn: 'TEL_HOME',
  targetColumn: 'tel_home',
  defaultValue: null,
  omit: true  // ← Will be skipped in validation & migration
});
```

---

## Common Scenarios

### Scenario 1: Nullable Column with NULL Source

```
User Action: Maps PHONE (NULL) to phone_number (VARCHAR, NULL)
Result: ✅ No error, NULL will be migrated
```

### Scenario 2: NOT NULL Column with NULL Source

```
User Action: Maps NAME (NULL) to name (VARCHAR, NOT NULL, no default)
Result: ❌ ERROR - must provide default or omit
User Fix: 
  - Type default value: '' or 'Unknown'
  - OR click "Omit" checkbox
```

### Scenario 3: NOT NULL Column with DB Default and NULL Source

```
User Action: Maps STATUS (NULL) to status (VARCHAR, NOT NULL, DEFAULT 'ACTIVE')
Result: ⚠️ Warning about DB default
User Action: Can proceed (DB will set 'ACTIVE') or click "Omit"
Both work.
```

### Scenario 4: Omitted NOT NULL Column

```
User Action: Maps EMAIL (anything) to email, checks "Omit"
Firebird: EMAIL = NULL
Target: email VARCHAR(255) NOT NULL
Result: ✅ No error, field won't be in INSERT
Behavior: DB will either use its default or fail with "Missing column"
  (This is user's responsibility; column must have a default)
```

---

## UI Interaction

### Field Editor Modal

```
[Edit Fields: CUSTOMERS → customers]

| Source     | Target     | Default | Omit □ |
|------------|------------|---------|--------|
| CID        | id         | -       | ☑️     |  ← Primary key, omitted (auto-increment)
| NAME       | name       | -       | ☐     |  ← Required, no default needed
| EMAIL      | email      | -       | ☐     |  ← Nullable, NULL is OK
| STATUS     | status     | ACTIVE  | ☐     |  ← Required, default provided
| CREATED_AT | created_at | -       | ☐     |  ← Has DB default, NULL is OK
```

### Dry Run Results

```
✅ Dry Run Successful (1 row processed)

Table: CUSTOMERS
Sample Row: {cid: 1, name: 'John', email: NULL, status: 'ACTIVE', ...}
Transformed: {id: 1, name: 'John', email: NULL, status: 'ACTIVE', ...}
  (Note: created_at omitted, will use DB default)
  (Note: cid not in INSERT, id will auto-increment)

Warnings: None
Issues: None
```

---

## Migration Execution (What Happens)

### INSERT Statement Generated

```sql
INSERT INTO customers (id, name, email, status)
VALUES (?, ?, ?, ?)
-- Note: created_at is NOT included (omitted from INSERT)
--       MySQL will apply its DEFAULT 'CURRENT_TIMESTAMP'

-- Note: cid NOT included (if marked omitted)
--       MySQL will auto-increment id
```

### Result

```
✅ Row inserted with:
  - id: Auto-generated or from mapping default
  - name: 'John'
  - email: NULL (OK, column is nullable)
  - status: 'ACTIVE' (from mapping default)
  - created_at: CURRENT_TIMESTAMP (DB default)
```

---

## Testing Your Changes

### Manual Test

1. Go to Step 2: Build Mapping
2. Select CUSTOMERS → customers
3. Check a nullable field (EMAIL)
4. Click "Run Dry Run"
5. ✅ Should succeed (no error for NULL EMAIL)

### Manual Test: Omit Field

1. Same setup
2. Click "Omit" checkbox for TEL_HOME
3. Click "Run Dry Run"
4. ✅ Should succeed (no validation for omitted)

### Manual Test: NOT NULL + NULL

1. Same setup
2. Uncheck "Omit" for STATUS
3. Mark source STATUS as NULL (edit first row)
4. Click "Run Dry Run"
5. ⚠️ Should show suggestion about DB default

---

## Files to Know

| File | Purpose |
|------|---------|
| `PlanValidator.js` | Validation logic (dryRun method) |
| `TableExecutor.js` | Payload builder (insertBatch method) |
| `Schema.js` | Target metadata source (getColumn) |
| `plans.js` | API endpoint calling dryRun() |
| `dryRunNullHandling.test.js` | Test suite (NEW) |

---

## Troubleshooting

### "Dry run still errors for NULL field"

✅ Check: Is the field marked as "Omit"? If so, no error should appear.  
✅ Check: Is the target column nullable in MySQL schema?  
✅ Check: Did you provide a mapping default?

### "Dry run passes but migration fails"

✅ Likely: NOT NULL column with NULL value not caught by new validator.  
✅ Fix: Check error message from migration.  
✅ Verify: Target schema reflects actual MySQL constraints.

### "Omitted field still appears in results"

✅ Expected: Dry run transformedRow should exclude omitted fields.  
✅ Check: Transformations are filtered correctly in plans.js.

---

**More info**: See `DRY_RUN_NULL_FIX_COMPLETE.md`
