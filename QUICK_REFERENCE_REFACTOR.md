# Quick Reference: UI + Mapping Refactor Implementation

## What Changed - At a Glance

### 🎯 User-Facing Changes
1. **Modal Editor** - Field mappings now edit in a modal (not scroll-based)
2. **Per-Row Auto-Map** - Each table row has 🪄 Auto-Map Fields button
3. **Omit Fields** - Checkbox to exclude columns from migration
4. **Smart Defaults** - NULL handling pre-fills with type-correct defaults
5. **Real Row Counts** - Dry-run shows actual counts, not placeholders

---

## Key APIs

### Frontend: Modal.custom()
```javascript
await Modal.custom({
  title: 'Edit Field Mappings',
  contentHTML: '<table>...</table>',
  type: 'info',
  size: 'xl',
  confirmText: 'Save',
  cancelText: 'Cancel',
  onMount: (modalEl) => {
    // Attach listeners after DOM insertion
    modalEl.querySelectorAll('input').forEach(el => {
      el.addEventListener('change', handler);
    });
  },
  onConfirm: () => {
    // Save action
  },
  onCancel: () => {
    // Discard action
  }
});
```

### Backend: Mapping.getFieldMaps()
```javascript
// Now automatically filters omitted fields
const fieldMaps = mapping.getFieldMaps('FIREBIRD_TABLE');
// fieldMaps.size only includes non-omitted fields
```

### Backend: Firebird Row Counting
```javascript
// Single attach, reuse
const db = await firebird.attachWithRetry(config);

// Count multiple tables efficiently
const count1 = await firebird.countRowsWithDb(db, 'TABLE_1');
const count2 = await firebird.countRowsWithDb(db, 'TABLE_2');

db.detach();
```

---

## Field Mapping JSON Structure

### New Format (with omit)
```json
{
  "FIREBIRD_TABLE": {
    "targetTable": "mysql_table",
    "columns": {
      "SOURCE_COL": {
        "sourceColumn": "SOURCE_COL",
        "targetColumn": "MYSQL_COL",
        "transform": null,
        "defaultValue": "0",
        "omit": true
      }
    }
  }
}
```

### Important: Omit Flag Behavior
- **`omit: true`**: Column NOT migrated
  - Skipped in `transformRow()`
  - Skipped in `dryRun()` validation
  - Filtered by `Mapping.getFieldMaps()`
  
- **`omit: false` or missing**: Column migrated normally
  - Backward compatible (old mappings work)

---

## Type-Safe Defaults

### Automatic Prefill Rules
When target column is **NOT NULL** and **no default set**:

| Type | Prefill | Example |
|------|---------|---------|
| INT, BIGINT, DECIMAL | `0` | Numeric counters |
| BOOLEAN | `0` | False value |
| DATE | `1970-01-01` | Unix epoch |
| DATETIME | `1970-01-01 00:00:00` | Unix epoch |
| TIME | `00:00:00` | Midnight |
| VARCHAR, TEXT | `` (empty) | Text fields |
| JSON | `{}` | Empty object |

### Important Rules
1. Only applied when value is **empty** (not when existing value present)
2. Only applied when target column is **NOT NULL**
3. Can be overridden by user
4. Applied via `getTypeSafeDefault(mysqlType)` helper

---

## Auto-Map Behavior

### From Table Row
```javascript
// User clicks 🪄 Auto-Map button on table row
autoMapFieldsForTable('USERS', silent=false)
// → Runs auto-mapping
// → Opens modal automatically
// → No warning shown
// → User can review & save
```

### From Modal
```javascript
// User clicks 🪄 Auto-Map Fields inside modal
autoMapFieldsForTable('USERS', silent=true)
// → Runs auto-mapping
// → Updates table silently
// → No modal open/close
// → User continues editing
```

---

## Omit Field Workflow

### Setting Omit
```javascript
// In modal field editor
checkbox.addEventListener('change', (e) => {
  setFieldMapping(tableName, srcCol, 'omit', e.target.checked);
  
  // Visual feedback
  if (e.target.checked) {
    row.classList.add('omitted');
    row.querySelectorAll('input, select').forEach(el => {
      el.disabled = true;
    });
  }
});
```

### During Migration
```javascript
// TableExecutor.transformRow()
for (const [sourceCol, fieldMap] of fieldMaps) {
  if (fieldMap.omit) {
    continue;  // Skip entirely
  }
  // ... normal transform logic
}
```

### In Validation
```javascript
// PlanValidator.dryRun()
for (const [srcCol, field] of fieldMaps) {
  if (field.omit) {
    continue;  // Skip validation
  }
  // ... normal validation logic
}
```

---

## Dry-Run Changes

### Before (Placeholder)
```javascript
const estimatedRows = result.sampleRow ? 1000 : 0;
```

### After (Actual)
```javascript
const sourceTable = mapping.getSourceTable(table);
if (sourceTable) {
  estimatedRows = await firebird.countRowsWithDb(db, sourceTable);
}
```

### Performance Optimization
```javascript
// Connect once, reuse for all tables
let fbDb = await firebird.attachWithRetry(state.firebird);
try {
  for (const table of tables) {
    // Reuse fbDb for countRowsWithDb
  }
} finally {
  fbDb.detach();  // Clean up
}
```

---

## Testing Checklist

### ✅ Modal Editor
- [ ] Click Edit Fields → modal opens
- [ ] Modal doesn't scroll page
- [ ] Cancel discards changes
- [ ] Save persists changes
- [ ] ESC key cancels

### ✅ Auto-Map
- [ ] Per-row Auto-Map button works
- [ ] Auto-map from modal works
- [ ] No warning banner shown
- [ ] Fields matched correctly

### ✅ Omit Checkbox
- [ ] Can check/uncheck
- [ ] Row grays out when omitted
- [ ] Controls disabled when omitted
- [ ] Persists in mapping JSON

### ✅ Default Values
- [ ] Numeric fields: `0`
- [ ] Date fields: `1970-01-01`
- [ ] Text fields: empty
- [ ] NOT NULL respected

### ✅ Dry-Run
- [ ] Row counts are actual (not 1000)
- [ ] Per-table counts sum correctly
- [ ] Omitted fields not in output

---

## File Map

### Frontend
| File | Purpose |
|------|---------|
| `src/public/js/utils/modal.js` | Modal.custom() API |
| `src/public/js/steps/mapping-ui.js` | Field editor, auto-map, omit UI |
| `src/public/css/wizard.css` | Modal + table styling |

### Backend Models
| File | Purpose |
|------|---------|
| `src/migrate/models/FieldMap.js` | Omit property |
| `src/migrate/models/Mapping.js` | Filter omitted fields |

### Backend Logic
| File | Purpose |
|------|---------|
| `src/migrate/executors/TableExecutor.js` | Skip omitted in transform |
| `src/migrate/validators/PlanValidator.js` | Skip omitted in validation |
| `src/routes/api/plans.js` | Real row count dry-run |

---

## Common Edits

### Add New Type-Safe Default
```javascript
// In mapping-ui.js getTypeSafeDefault()
if (['CUSTOM_TYPE'].includes(type)) {
  return 'custom_default_value';
}
```

### Adjust Modal Size
```javascript
// Make modal smaller
Modal.custom({
  size: 'lg',  // Changed from 'xl'
  // ...
});
```

### Change Omit Visual Indicator
```css
/* In wizard.css */
.field-row.omitted {
  opacity: 0.4;  /* More/less visible */
  background: #fee;  /* Different color */
}
```

### Disable Auto-Map Warning Permanently
Already done! No code changes needed.

---

## Debugging Tips

### Check if Field is Omitted
```javascript
const fieldMap = mapping.getFieldMaps(sourceTable).get('COL');
console.log('Omitted:', fieldMap?.omit);  // true/false
```

### Verify Modal Opening
```javascript
// Check browser DevTools
// Should see: Modal.custom({ ... }) → Promise
// Should see: modal overlay in DOM
```

### Test Dry-Run Counts
```javascript
// Call dry-run API
POST /plans/:id/dry-run
// Response should have actual counts, not 1000
```

---

## Gotchas & Notes

⚠️ **Mapping.getFieldMaps() filters omitted fields**
- If you need ALL fields (including omitted), don't use this method
- The filtering happens here intentionally

⚠️ **Modal.custom() promises require await**
- Don't forget `await` or `.then()`
- Modal returns Promise<boolean>

⚠️ **Firebird connection pooling**
- Single attach per dry-run is optimized
- Don't attach multiple times per table

⚠️ **Default values are strings**
- `0` for numbers (will be parsed by DB)
- `1970-01-01` for dates (will be parsed)
- Not type-converted yet

---

## Future Roadmap

- [ ] Bulk field selection (select all, select none)
- [ ] Field mapping templates
- [ ] Conditional field mapping
- [ ] Visual dependency graph
- [ ] Import/export mapping profiles
- [ ] Field remapping history

---

**Quick Start**: Open modal in mapping-ui.js → call Modal.custom() → attach listeners in onMount → save via confirmText button

**Testing**: Run wizard, select table + target, click Edit Fields, verify modal appears and functionality works

**Deployment**: No database migrations required; fully backward compatible with existing mappings

