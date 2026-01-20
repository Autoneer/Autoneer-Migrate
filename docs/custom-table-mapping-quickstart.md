# Quick Start: Custom Table Mapping

## Overview
Migrate from any source table to any target table with custom field selection and transformations.

## Quick Example: SPARES_USED → customer_invoice_lines

### Step 1: Open Mapping Page & Enable Advanced Options
- Navigate: Setup → Plan → **Mapping**
- ✅ Check "Show advanced options"

### Step 2: Configure Custom Mapping
1. Scroll to **"Advanced: Custom Table Mapping"** section
2. Find the **SPARES_USED** row
3. Change target table name: `spares_used` → `customer_invoice_lines`
4. Click **"Configure Fields"** button

### Step 3: Select & Map Fields

**Example Configuration:**

```
✓ SPARES_ID      → line_id           (no transform)
✓ JOB_NR         → invoice_number    (no transform)
✓ SPARE          → line_description  (transform: trim)
✓ QUANTITY       → quantity          (transform: toNumber, default: 1)
✓ COST_PRICE     → unit_cost         (transform: toNumber, default: 0)
✓ SALES_PRICE    → unit_price        (transform: toNumber, default: 0)
✓ DATE_USED      → line_date         (transform: toDate)
✗ STATUS         (unchecked - not migrated)
✗ MARKUP         (unchecked - not migrated)
```

**Field Configuration Tips:**
- ✓ = Include field (checked)
- ✗ = Exclude field (unchecked)
- **Transform**: Apply data conversion (trim, toNumber, toDate, toUpperCase, toLowerCase)
- **Default Value**: Value to use if source field is empty/null

### Step 4: Apply & Save
1. Click **"Done"** (closes field selector)
2. Click **"Apply Custom Mapping"**
3. Enter profile name: `"Spares to Invoice Lines"`
4. ✅ Check "Create a new profile"
5. Click **"Save profile & continue to Run"**

### Step 5: Run Migration
- Go to Run page
- Enable "Dry run" for testing
- Click "Start Migration"
- Review results

---

## Key Features

### ✅ What You Can Do
- Map any source table to any target table name
- Select specific fields to migrate (include/exclude)
- Rename fields for the target database
- Apply data transformations (trim, toNumber, toDate, etc.)
- Set default values for fields
- Save as reusable profile
- Load saved profiles for future migrations

### 📋 Common Transformations

| Transform | Use For | Example |
|-----------|---------|---------|
| `trim` | Text fields with whitespace | "  Name  " → "Name" |
| `toNumber` | Numeric fields | "123.45" → 123.45 |
| `toDate` | Date fields | "2024-01-20" → Date object |
| `toUpperCase` | Uppercase text | "product" → "PRODUCT" |
| `toLowerCase` | Lowercase text | "PRODUCT" → "product" |

### 💡 Default Value Examples

| Field Type | Example Default |
|------------|-----------------|
| Quantity | `1` |
| Price | `0` |
| Status | `'ACTIVE'` |
| Description | `'N/A'` |

---

## Profile Management

### Save Profile
```
Profile Name: "Spares to Invoice Lines"
☑ Create a new profile
[Save profile & continue to Run]
```

### Load Profile
1. Go to Mapping page
2. Enable "Show advanced options"
3. Scroll to "Advanced: Profiles"
4. Click "Load" next to your profile

### Set Default Profile
Click "Set Default" to auto-load the profile next time

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Changes not saving | Click "Apply Custom Mapping" then "Save profile" |
| Fields missing | Check field is included (✓) in configuration |
| Data type errors | Verify correct transform is selected |
| Profile not loading | Try export → re-import JSON |

---

## JSON Example

For manual editing or complex scenarios:

```json
{
  "tables": {
    "SPARES_USED": {
      "target": "customer_invoice_lines",
      "mode": "INSERT",
      "keyStrategy": "rekey",
      "columns": {
        "SPARES_ID": { "target": "line_id" },
        "SPARE": { "target": "line_description", "transform": "trim" },
        "QUANTITY": { "target": "quantity", "transform": "toNumber", "default": 1 },
        "COST_PRICE": { "target": "unit_cost", "transform": "toNumber", "default": 0 },
        "SALES_PRICE": { "target": "unit_price", "transform": "toNumber", "default": 0 }
      }
    }
  }
}
```

Export/Import via "Advanced: Import / Export" section.

---

## Workflow Summary

```
1. Setup (DB Connections)
   ↓
2. Plan (Select Tables)
   ↓
3. Mapping (Custom Table Mapping)
   ├─ Change target table name
   ├─ Configure fields
   ├─ Apply mapping
   └─ Save as profile
   ↓
4. Run (Execute Migration)
   └─ Test with dry run first!
```

---

## Need Help?

See full documentation: [docs/custom-table-mapping-guide.md](./custom-table-mapping-guide.md)
