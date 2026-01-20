# Run Page Enhancements

## Overview

The Run page has been enhanced with two critical features to improve the migration workflow:

1. **Pre-Migration Summary**: View which tables will be migrated and their configuration before running
2. **Inline Plan Editor**: Fix validation errors directly on the run page without navigating back

## Features

### 1. Migration Plan Summary

Before running the migration, you'll see a comprehensive table showing:

- **Source Table**: The table from Firebird being migrated
- **Target Table**: The destination table in MySQL
- **Mode**: INSERT or UPSERT
- **Key Strategy**: preserve or rekey
- **Dedupe Keys**: The fields used for deduplication (if any)

**Example:**
```
Source Table    →  Target Table              Mode      Key Strategy  Dedupe Keys
spares_used     →  customer_invoice_lines    UPSERT    rekey        code, name
customers       →  customers                 INSERT    preserve     none
```

This summary helps you:
- Verify the migration configuration before execution
- Understand the relationship between source and target tables
- Review key strategies and deduplication settings at a glance

### 2. Inline Plan Editor

When validation errors occur (e.g., "Re-key IDs requires dedupe keys"), the page will display:

1. **Error List**: All validation errors clearly listed
2. **Editable Plan Table**: Modify migration options directly
3. **Quick Actions**: Update plan or go to full plan editor

**Editable Fields:**
- **Mode**: Switch between INSERT and UPSERT
- **Key Strategy**: Toggle between preserve and rekey
- **Dedupe Keys**: Enter comma-separated field names (e.g., `code, name`)
- **On Duplicate**: Choose error, skip, or replace behavior

### How It Works

#### Validation Error Scenario

1. User clicks "Run Migration"
2. System validates the migration plan
3. If errors are detected:
   - The page reloads with error details
   - The plan editor becomes visible
   - All table configurations are editable
4. User makes corrections
5. Click "Update Plan" to save changes
6. Run the migration again

#### Example Workflow

**Problem:**
```
❌ Table spares_used: Re-key IDs requires dedupe keys or a unique index on natural keys.
```

**Solution:**
1. Locate `spares_used` in the plan editor table
2. Enter dedupe keys: `code, name`
3. Click "Update Plan"
4. Success message appears: "Plan updated successfully"
5. Click "Run Migration" again

## Benefits

### Before These Enhancements
- No visibility into source→target table mappings
- Validation errors required navigating back through multiple pages
- Had to reconfigure everything when fixing errors
- Time-consuming and frustrating workflow

### After These Enhancements
- ✅ Clear overview of all table mappings before migration
- ✅ Fix validation errors instantly without navigation
- ✅ Preserve all other configurations when making corrections
- ✅ Streamlined, efficient workflow

## Technical Details

### Backend Changes

#### `src/routes/run.js`

**New Functionality:**
1. `tableMappings` array construction in GET `/run`
   - Maps target tables back to source tables using `resolveMappingForTarget()`
   - Includes mode, keyStrategy, dedupeKeys for each table
   
2. Error handling enhancement in POST `/run/start`
   - Passes `validationErrors` array to template
   - Sets `showPlanEditor: true` when errors occur
   - Builds `tableMappings` even on error for context

3. New route: POST `/run/update-plan`
   - Processes form submission with updated plan options
   - Updates `state.plan` with new configuration
   - Redirects back to `/run` with success message

**Helper Function:**
```javascript
function resolveMappingForTarget(targetTable, mapping) {
  // Returns mapping entry for a given target table
  // Used to find the source table name
}
```

#### `src/views/run.hbs`

**New UI Components:**

1. **Success/Warning Notices**
   ```handlebars
   {{#if ui.runNotice}}
     <div class="alert {{ui.runNotice.type}}">
       <strong>{{ui.runNotice.message}}</strong>
     </div>
   {{/if}}
   ```

2. **Table Mappings Summary**
   ```handlebars
   {{#if tableMappings}}
     <div class="card nested" id="table-mappings-summary">
       <table class="data-table">
         <!-- Shows source → target with mode/keyStrategy/dedupeKeys -->
       </table>
     </div>
   {{/if}}
   ```

3. **Plan Editor**
   ```handlebars
   {{#if showPlanEditor}}
     <div class="card nested" id="plan-editor">
       <div class="alert error">
         <!-- Lists validation errors -->
       </div>
       <form method="post" action="/run/update-plan">
         <table class="data-table">
           <!-- Editable plan configuration -->
         </table>
       </form>
     </div>
   {{/if}}
   ```

### Form Field Naming Convention

The plan editor uses prefixed field names to identify which table each setting applies to:

- `mode_<tableName>`: Mode selection (INSERT/UPSERT)
- `keyStrategy_<tableName>`: Key strategy (preserve/rekey)
- `dedupeKeys_<tableName>`: Comma-separated dedupe keys
- `onDuplicate_<tableName>`: Duplicate handling (error/skip/replace)

**Example:**
```html
<input name="mode_spares_used" value="UPSERT" />
<input name="dedupeKeys_spares_used" value="code,name" />
```

### CSS Styling

#### New Classes

**`.badge`** - Used for mode and key strategy display:
```css
.badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  background: var(--panel);
  border: 1px solid var(--border);
}
```

**`.form-control`** - Used for inline form inputs:
```css
.form-control {
  width: 100%;
  font-size: 13px;
}
```

## Common Validation Errors

### Re-key IDs Requires Dedupe Keys

**Error:**
```
Table spares_used: Re-key IDs requires dedupe keys or a unique index on natural keys.
```

**Cause:** Using `keyStrategy: rekey` without specifying dedupe keys or having a unique index.

**Solution:**
1. Add dedupe keys (e.g., `code, name`)
2. OR change key strategy to `preserve`
3. OR ensure target table has a unique index on natural keys

### UPSERT Requires Primary Key or Dedupe Keys

**Error:**
```
Table customers: UPSERT requires a primary key or dedupe keys.
```

**Cause:** Using `mode: UPSERT` on a table without a primary key and no dedupe keys defined.

**Solution:**
1. Add dedupe keys that uniquely identify records
2. OR change mode to `INSERT`
3. OR ensure target table has a primary key

### INSERT Requires Unique Index

**Error:**
```
Table products: INSERT requires dedupe keys or a unique index to prevent duplicates.
```

**Cause:** Using `mode: INSERT` without unique constraints to prevent duplicate insertions.

**Solution:**
1. Add dedupe keys for duplicate detection
2. OR change mode to `UPSERT`
3. OR ensure target table has a unique index

### Dedupe Keys Not Mapped

**Error:**
```
Table spares_used: Dedupe keys not mapped from source fields: invoice_id.
```

**Cause:** Dedupe key specified doesn't exist in the field mapping.

**Solution:**
1. Go to Mapping page and map the missing field
2. OR remove the dedupe key from configuration
3. OR use different dedupe keys that are mapped

## Best Practices

### Choosing Dedupe Keys

**Good Dedupe Keys:**
- Natural identifiers (e.g., `code`, `email`, `sku`)
- Business keys (e.g., `customer_code`, `product_id`)
- Composite keys when single field isn't unique (e.g., `date, reference_number`)

**Avoid:**
- Fields that can be null
- Fields that change frequently
- Auto-increment IDs from source (when rekeying)

### Mode Selection

**Use INSERT when:**
- Migrating fresh data to empty tables
- Source data is guaranteed unique
- Target has unique constraints

**Use UPSERT when:**
- Re-running migrations
- Updating existing records
- Source may contain duplicates relative to dedupe keys

### Key Strategy

**Use preserve when:**
- IDs should remain the same (e.g., customer IDs shown on invoices)
- Foreign key relationships must be maintained
- External systems reference these IDs

**Use rekey when:**
- IDs will conflict with existing data
- Migrating to table with auto-increment ID
- No external references to these IDs

## Troubleshooting

### Plan Editor Not Appearing

**Symptoms:** Validation errors show but no edit form appears

**Check:**
1. Are there actually errors? (Check browser console)
2. Is `showPlanEditor` being passed to template?
3. Are all tables marked as `include: true` in the plan?

### Update Plan Doesn't Persist

**Symptoms:** Changes don't save or revert after update

**Check:**
1. Form method is POST
2. Action URL is `/run/update-plan`
3. Field names follow naming convention (`mode_<tableName>`)
4. Browser console for JavaScript errors

### Table Mappings Not Showing

**Symptoms:** Summary section doesn't appear

**Check:**
1. Is there a valid plan with included tables?
2. Is mapping configuration complete?
3. Are tables properly included in the plan?

## Related Documentation

- [Enhanced Table Mapping Guide](./enhanced-table-mapping-guide.md)
- [Custom Table Mapping Guide](./custom-table-mapping-guide.md)
- [Migration Troubleshooting](./migration-troubleshooting.md)

## Future Enhancements

Potential improvements for future versions:

1. **Inline Field Mapping Editor**: Edit field mappings directly from run page
2. **Validation Warnings**: Show non-blocking warnings with recommendations
3. **Auto-Suggest Dedupe Keys**: Suggest dedupe keys based on unique indexes
4. **Batch Plan Updates**: Update multiple tables at once
5. **Plan Templates**: Save/load plan configurations as templates
