# Enhanced Custom Table Mapping - Quick Guide

## 🎉 New Feature: Dropdown Selection for Target Tables & Fields

The custom table mapping feature has been enhanced with dropdown selectors that show available target tables and their fields, making it much easier to configure your migrations!

---

## What's New

### ✅ Target Table Dropdown
- **Before**: Type table names manually
- **Now**: Select from a dropdown of all available MySQL tables

### ✅ Target Field Dropdowns
- **Before**: Type field names manually
- **Now**: Select from dropdowns showing actual fields in the target table
- Fields show data type and primary key indicators

### ✅ Dynamic Field Loading
- Automatically loads target table fields when you select a table
- Shows field data types (e.g., `varchar`, `int`, `decimal`)
- Indicates primary keys with 🔑 icon
- Refresh button to reload fields if schema changes

### ✅ Custom Table/Field Option
- Still supports custom names if your table doesn't exist yet
- Select "✏️ Custom table name..." or "✏️ Custom field name..." from dropdowns

---

## Step-by-Step Guide

### Step 1: Navigate to Custom Table Mapping
1. Go to the **Mapping** page
2. Check **"Show advanced options"**
3. Scroll to **"Advanced: Custom Table Mapping"**

### Step 2: Select Target Table

**Example: Migrate SPARES_USED to customer_invoice_lines**

1. Find the **SPARES_USED** row
2. Click the **Target Table** dropdown
3. Select `customer_invoice_lines` from the list
   - All available MySQL tables are shown alphabetically
   - Or select "✏️ Custom table name..." to enter your own

**Target table dropdown shows:**
```
— Select target table —
accounts
customers
customer_invoice_lines    ← Select this
invoices
spares_used
suppliers
✏️ Custom table name...
```

### Step 3: Configure Field Mapping

1. Click **"Configure Fields"** button
2. The field mapping panel opens showing:
   - **Title**: "Map fields: SPARES_USED → customer_invoice_lines"
   - All source fields with checkboxes
   - Target field dropdowns (automatically populated!)

**Field mapping interface:**
```
☑ | Source Field    →  Target Field (dropdown)              | Transform  | Default
--------------------------------------------------------------------------------
☑ | SPARES_ID       →  [line_id 🔑 (int)]                   | None       |
☑ | SPARE           →  [line_description (varchar)]         | trim       |
☑ | QUANTITY        →  [quantity (decimal)]                 | toNumber   | 1
☑ | COST_PRICE      →  [unit_cost (decimal)]                | toNumber   | 0
☑ | SALES_PRICE     →  [unit_price (decimal)]               | toNumber   | 0
☐ | STATUS          →  [— Select target field —]            |            |
☐ | MARKUP          →  [— Select target field —]            |            |
```

### Step 4: Map Each Field

For each source field:

1. **Check/Uncheck** to include/exclude
2. **Select target field** from dropdown:
   - Dropdown shows all fields in the selected target table
   - Shows data type in parentheses
   - Primary keys marked with 🔑
3. **Choose transform** (trim, toNumber, toDate, etc.)
4. **Set default value** if needed

**Example Target Field Dropdown:**
```
Target Field dropdown for QUANTITY:
— Select target field —
invoice_number (int)
line_id 🔑 (int)
line_description (varchar)
quantity (decimal)         ← Select this
unit_cost (decimal)
unit_price (decimal)
line_date (date)
✏️ Custom field name...
```

### Step 5: Apply and Save

1. Click **"Done"** to close field mapping
2. Click **"Apply Custom Mapping"**
3. Enter profile name: "Spares to Invoice Lines"
4. Check "Create a new profile"
5. Click **"Save profile & continue to Run"**

---

## Key Features

### 🔄 Refresh Target Fields Button

If you modify your MySQL schema while working:

1. Click **"🔄 Refresh Target Fields"** button
2. Reloads the target table's current schema
3. Updates all field dropdowns with latest columns

### 🔑 Primary Key Indicator

Target fields that are primary keys show a 🔑 icon:
- `line_id 🔑 (int)` ← Primary key
- `quantity (decimal)` ← Regular field

### 📊 Data Type Display

Each field shows its MySQL data type:
- `line_description (varchar)`
- `quantity (decimal)`
- `line_date (date)`
- `is_active (tinyint)`

This helps you:
- Choose appropriate transforms
- Ensure data type compatibility
- Set correct default values

---

## Complete Example

**Goal**: Migrate SPARES_USED to customer_invoice_lines

**Step-by-Step:**

```
1. Target Table Selection:
   SPARES_USED → [customer_invoice_lines ▼]

2. Click "Configure Fields"

3. Field Mapping:
   ☑ SPARES_ID      → [line_id 🔑 (int) ▼]           | None       |
   ☑ JOB_NR         → [invoice_number (int) ▼]       | None       |
   ☑ SPARE          → [line_description (varchar) ▼] | trim       |
   ☑ QUANTITY       → [quantity (decimal) ▼]         | toNumber   | 1
   ☑ COST_PRICE     → [unit_cost (decimal) ▼]        | toNumber   | 0
   ☑ SALES_PRICE    → [unit_price (decimal) ▼]       | toNumber   | 0
   ☑ DATE_USED      → [line_date (date) ▼]           | toDate     |
   ☐ STATUS         (unchecked - not migrated)
   ☐ MARKUP         (unchecked - not migrated)

4. Click "Done"

5. Click "Apply Custom Mapping"

6. Save as profile: "Spares to Invoice Lines"

7. Done! Ready to run migration.
```

---

## Benefits

### ✅ No More Typos
- Select from actual table/field names
- No more spelling mistakes
- Autocomplete-style selection

### ✅ See What Exists
- View all available target tables
- See actual field names and types
- Know what you're mapping to

### ✅ Type Safety
- See field data types before mapping
- Choose appropriate transforms based on type
- Avoid data type mismatches

### ✅ Easy Field Discovery
- Browse target table structure
- Identify primary keys
- Understand schema without SQL queries

### ✅ Still Flexible
- Custom table/field names still supported
- Mix dropdown selection with custom entries
- Full backwards compatibility

---

## Tips & Tricks

### 1. Quick Field Matching
When target field names match source fields:
- Dropdowns auto-select matching names when available
- Just verify and adjust as needed

### 2. Data Type Hints
Use data types to choose transforms:
- `varchar` → use `trim`
- `int`, `decimal` → use `toNumber`
- `date`, `datetime` → use `toDate`

### 3. Primary Key Mapping
Look for 🔑 icon to identify primary keys:
- Usually map ID fields to primary keys
- Helps with database integrity

### 4. Schema Changes
If you add columns to MySQL:
- Click "🔄 Refresh Target Fields"
- New columns appear in dropdowns
- No need to reload the page

### 5. Custom Names Still Work
For tables/fields that don't exist yet:
- Select "✏️ Custom table name..."
- Enter the name you'll create later
- Migration creates mapping, you create schema

---

## Comparison: Before vs. After

### Before (Manual Entry)
```
Target Table: [____________] ← Type "customer_invoice_lines"
Target Field: [____________] ← Type "line_description"
```
**Issues**: Typos, unknown fields, no validation

### After (Dropdown Selection)
```
Target Table: [customer_invoice_lines ▼] ← Select from list
Target Field: [line_description (varchar) ▼] ← Select with type info
```
**Benefits**: Accurate, visible options, type information

---

## Troubleshooting

### Dropdown Shows No Tables
**Issue**: Target table dropdown is empty
**Solution**: 
- Ensure MySQL connection is active
- Check you've selected a schema in Setup
- Verify MySQL user has permissions to read schema

### Target Fields Not Loading
**Issue**: Field dropdown shows "— Select target field —" only
**Solution**:
1. Ensure target table is selected first
2. Click "🔄 Refresh Target Fields"
3. Check MySQL table exists and has columns

### Can't Find My Table
**Issue**: Table not in dropdown list
**Solution**:
- Select "✏️ Custom table name..."
- Enter your table name manually
- You can create the table in MySQL later

### Field Dropdowns Don't Update
**Issue**: Selected target table but fields didn't load
**Solution**:
1. Check browser console for errors
2. Try selecting a different table first
3. Click "🔄 Refresh Target Fields"
4. Reload the mapping page

---

## API Endpoint (For Advanced Users)

The feature includes a new API endpoint:

```
GET /mapping/api/target-table-fields/:tableName
```

**Returns:**
```json
{
  "ok": true,
  "tableName": "customer_invoice_lines",
  "columns": [
    {
      "name": "line_id",
      "dataType": "int",
      "isPrimary": true
    },
    {
      "name": "line_description",
      "dataType": "varchar",
      "isPrimary": false
    }
  ]
}
```

You can use this for custom integrations or scripts.

---

## Summary

The enhanced custom table mapping feature makes it **significantly easier** to:
- Select target tables from available MySQL tables
- Map fields accurately using dropdowns
- See data types and primary keys
- Avoid typos and errors
- Understand your target schema

**No more guessing** - see exactly what tables and fields are available!

**Still flexible** - custom names supported when needed.

**Better experience** - faster, more accurate, less error-prone.

---

## Next Steps

1. **Try It Out**
   - Navigate to Mapping → Advanced → Custom Table Mapping
   - Select a target table from the dropdown
   - See how field dropdowns populate automatically

2. **Create Your First Mapping**
   - Follow the example: SPARES_USED → customer_invoice_lines
   - Use dropdowns to select target fields
   - Save as a profile for reuse

3. **Explore Your Schema**
   - Browse available target tables
   - Check out field types and primary keys
   - Plan your migrations with confidence

Happy migrating! 🚀
