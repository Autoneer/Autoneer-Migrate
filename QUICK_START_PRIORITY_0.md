# Quick Start Guide - Priority 0 Bug Fixes

## For Developers Using the Migration System

### What Changed?

Four critical bug fixes were implemented to prevent data loss and ensure migration integrity:

1. **NOT NULL Validation** - Blocks migration if columns can't satisfy NOT NULL constraints
2. **Data Type Validation** - Warns about risky type conversions
3. **Transaction Safety** - Guarantees FK_CHECKS restoration
4. **Zero-Loss Detection** - Replaces 50-row tolerance with strict validation

---

## Quick Examples

### 1. Using New Transform Functions

#### Decimal/Numeric Fields (with precision validation)
```json
{
  "COST_PRICE": {
    "target": "cost_price",
    "transform": { "name": "toDecimal", "args": [18, 2] },
    "default": 0
  }
}
```

#### Firebird Timestamps (auto-format detection)
```json
{
  "CREATED_AT": {
    "target": "created_at",
    "transform": "toFirebirdTimestamp"
  }
}
```

#### Boolean Fields (with strict validation)
```json
{
  "IS_ACTIVE": {
    "target": "is_active",
    "transform": "cloneBoolean",
    "default": 0
  }
}
```

#### BLOB Data
```json
{
  "PHOTO": {
    "target": "photo_base64",
    "transform": { "name": "handleBlobData", "args": ["base64"] }
  }
}
```

### 2. Avoiding NOT NULL Errors

**Problem**: Column is NOT NULL but transform can return NULL

**Before** (will fail):
```json
{
  "PRICE": {
    "target": "price",
    "transform": "toNumber"
  }
}
```

**After** (will pass):
```json
{
  "PRICE": {
    "target": "price",
    "transform": "toNumber",
    "default": 0
  }
}
```

### 3. Adding Checksum Validation for Your Tables

Edit `src/migrate/runner.js`, function `identifyNumericColumns()`:

```javascript
function identifyNumericColumns(tableName) {
  const numericTables = {
    'SPARES_USED': ['quantity', 'cost_price', 'sales_price'],
    'INVOICES': ['inv_totalexlvat', 'inv_totalinclvat'],
    // Add your table here:
    'YOUR_TABLE': ['amount_field', 'price_field'],
  };
  return numericTables[tableName.toUpperCase()] || [];
}
```

---

## Common Error Messages and Fixes

### Error: "Column NOT NULL constraint violations detected"

**Example**:
```
Column 'cost_price' is NOT NULL but uses transform 'toNumber' 
which can return NULL, and no default is set.
```

**Fix**: Add a default value to the mapping:
```json
{
  "COST_PRICE": {
    "target": "cost_price",
    "transform": "toNumber",
    "default": 0
  }
}
```

---

### Error: "Data loss detected in table_name"

**Example**:
```
Data loss detected in spares_used: Read 443 rows but only 
accounted for 230. Lost 213 rows.
```

**Cause**: Incorrect dedupe key configuration causing row collapse

**Fix**: Review dedupe key configuration:
- For **preserve** mode: use primary key (e.g., `spares_id`)
- For **rekey** mode: use natural composite key (e.g., `job_number`, `lnr`)

---

### Error: "Checksum mismatch in table.column"

**Example**:
```
Checksum mismatch in spares_used.cost_price: 
Firebird sum=125450.50, MySQL sum=98320.25, variance=21.61%.
```

**Causes**:
1. Transform returning NULL instead of preserving values
2. Missing columns in mapping
3. Incorrect default values

**Fix**: 
- Ensure transform preserves numeric values (use `toNumber` or `toDecimal`)
- Check all source columns are mapped
- Verify defaults match expected values

---

### Warning: "Precision loss: value exceeds DECIMAL(precision, scale)"

**Example**:
```
Precision loss: 123456789.99 exceeds DECIMAL(10,2). 
Whole part has 9 digits but max is 8.
```

**Fix**: Increase precision in MySQL schema or mapping:
```json
{
  "LARGE_AMOUNT": {
    "target": "large_amount",
    "transform": { "name": "toDecimal", "args": [18, 2] }
  }
}
```

---

## Testing Your Changes

### 1. Test NOT NULL Validation
```bash
# Temporarily remove a required column from mapping
# Run migration - should fail with clear error
```

### 2. Test Zero-Loss Detection
```bash
# Set wrong dedupe key (e.g., use composite key in preserve mode)
# Run migration - should fail with "Data loss detected"
```

### 3. Test Checksum Validation
```bash
# Add numeric table to identifyNumericColumns()
# Run migration - should validate checksums automatically
```

---

## Migration Workflow

### Before (Old System)
1. ❌ Silent data loss up to 50 rows
2. ❌ Runtime errors for NOT NULL violations
3. ❌ FK_CHECKS might not restore
4. ❌ No checksum validation

### After (New System)
1. ✅ Preflight: NOT NULL validation blocks invalid mappings
2. ✅ Preflight: Data type warnings for risky conversions
3. ✅ Migration: Zero-loss detection catches all missing rows
4. ✅ Post-migration: Checksum validation verifies numeric fields
5. ✅ Cleanup: FK_CHECKS restoration guaranteed

---

## Performance Notes

- Preflight validation: +50-200ms per table (one-time)
- Checksum validation: +500-2000ms per table (one-time)
- Individual row logging: +5-10% (only at debug level)
- **Total impact**: < 10% slower

To disable individual row logging (production):
```javascript
// In logger configuration, set level to 'info' instead of 'debug'
```

---

## Troubleshooting

### "Failed to validate nullability for table_name"
- Non-critical warning, migration continues
- Usually means information_schema query failed
- Check MySQL permissions for information_schema access

### "Failed to validate data types for table_name"
- Non-critical warning, migration continues
- Usually means Firebird system table query failed
- Check Firebird permissions for RDB$ tables

### "Failed to restore FOREIGN_KEY_CHECKS=1"
- **CRITICAL ERROR** - migration stops
- Database may be in inconsistent state
- Manually run: `SET FOREIGN_KEY_CHECKS=1;`
- Check MySQL permissions and connection

---

## Best Practices

### 1. Always Add Defaults for NOT NULL + Transforms
```json
{
  "NULLABLE_SOURCE": {
    "target": "not_null_target",
    "transform": "toNumber",
    "default": 0  // ✅ Required!
  }
}
```

### 2. Use Specific Transforms for Data Types
```json
{
  "DECIMAL_FIELD": {
    "target": "decimal_field",
    "transform": { "name": "toDecimal", "args": [18, 2] }  // ✅ Validates precision
  }
}
```

### 3. Configure Checksum Validation for Financial Data
- Add all tables with monetary amounts to `identifyNumericColumns()`
- Ensures no rounding errors or data loss in critical fields

### 4. Test with Sample Data First
- Run migration on small test database
- Verify all validations pass
- Check warnings in logs
- Only then migrate production data

---

## Need Help?

1. Check `PRIORITY_0_IMPLEMENTATION_SUMMARY.md` for full documentation
2. Review `docs/migration-troubleshooting.md` for common issues
3. Enable debug logging to see individual row skips
4. Check migration logs in `logs/migrate/` directory

---

## Rollback Plan

If issues arise after deployment:

1. **NOT NULL errors blocking migration**: 
   - Add defaults to mapping
   - Or set column to NULL in MySQL schema temporarily

2. **False positive data loss errors**:
   - Review dedupe key configuration
   - Check for duplicate source data

3. **Checksum validation failing**:
   - Verify transforms are correct
   - Check 1% tolerance is appropriate
   - Temporarily remove table from `identifyNumericColumns()` if needed

4. **Critical FK_CHECKS restoration failure**:
   - Manually run: `SET FOREIGN_KEY_CHECKS=1;`
   - Verify foreign key constraints
   - Re-run migration with fkChecks disabled

---

**Last Updated**: January 20, 2026  
**Migration System Version**: 2.0 (with Priority 0 fixes)
