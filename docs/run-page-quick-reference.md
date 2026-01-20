# Run Page Quick Reference

## Pre-Migration Summary

**Location:** Run page, above the "Run Migration" button

**What You See:**
```
Migration Plan Summary
┌─────────────┬───┬────────────────────────┬────────┬──────────────┬─────────────┐
│ Source      │ → │ Target                 │ Mode   │ Key Strategy │ Dedupe Keys │
├─────────────┼───┼────────────────────────┼────────┼──────────────┼─────────────┤
│ spares_used │ → │ customer_invoice_lines │ UPSERT │ rekey        │ code, name  │
│ customers   │ → │ customers              │ INSERT │ preserve     │ none        │
└─────────────┴───┴────────────────────────┴────────┴──────────────┴─────────────┘
```

**Use This To:**
- ✓ Verify table mappings before migration
- ✓ Review mode and key strategy settings
- ✓ Check dedupe keys configuration

---

## Fixing Validation Errors

### Step 1: Click "Run Migration"

### Step 2: If Errors Occur

You'll see:
```
⚠️ Fix Plan Configuration

Validation errors detected:
• Table spares_used: Re-key IDs requires dedupe keys or a unique index on natural keys.
```

### Step 3: Edit Configuration

A table appears with editable fields:
- **Mode**: Dropdown (INSERT/UPSERT)
- **Key Strategy**: Dropdown (preserve/rekey)
- **Dedupe Keys**: Text input (e.g., `code, name`)
- **On Duplicate**: Dropdown (error/skip/replace)

### Step 4: Update Plan

Click "Update Plan" button

### Step 5: Run Again

Click "Run Migration" again - errors should be resolved!

---

## Common Fixes

### Error: "Re-key IDs requires dedupe keys"
**Fix:** Enter dedupe keys like `code, name` OR change key strategy to `preserve`

### Error: "UPSERT requires primary key or dedupe keys"
**Fix:** Enter dedupe keys OR change mode to `INSERT`

### Error: "INSERT requires dedupe keys or unique index"
**Fix:** Enter dedupe keys OR change mode to `UPSERT`

### Error: "Dedupe keys not mapped: invoice_id"
**Fix:** Go to Mapping page and map the field OR remove from dedupe keys

---

## Dedupe Keys Format

**Single Key:**
```
code
```

**Multiple Keys (comma-separated):**
```
code, name
```

**Multiple Keys (with spaces):**
```
customer_code, invoice_date, reference_number
```

**DO NOT use:**
- ❌ `code;name` (wrong separator)
- ❌ `"code", "name"` (no quotes needed)
- ❌ `code name` (missing comma)

---

## Quick Decision Guide

### Should I Use INSERT or UPSERT?

```
First migration?
├─ Yes → INSERT
└─ No (re-running) → UPSERT

Target table empty?
├─ Yes → INSERT
└─ No → UPSERT

Source has duplicates vs dedupe keys?
├─ Yes → UPSERT
└─ No → INSERT
```

### Should I Use preserve or rekey?

```
Need same IDs as source?
├─ Yes → preserve
└─ No → rekey

External systems reference these IDs?
├─ Yes → preserve
└─ No → rekey

Target table has auto-increment ID?
├─ Yes → rekey
└─ No → preserve
```

### What Dedupe Keys Should I Use?

```
Does table have natural business key?
├─ Yes (e.g., customer_code) → Use that
└─ No → Look for composite key

Examples:
- customers: email, customer_code
- products: sku, product_code
- invoices: invoice_number, invoice_date
- transactions: date, reference, account
```

---

## Keyboard Shortcuts

- **Tab**: Move between fields in plan editor
- **Enter**: Submit form (Update Plan or Run Migration)
- **Esc**: (Future: Close plan editor)

---

## Status Messages

### Success Messages

**Green Alert:**
```
✓ Plan updated successfully
Migration options have been updated. You can now run the migration.
```

### Warning Messages

**Yellow Alert:**
```
⚠ Potential issues detected
Table spares_used: Dedupe keys (code, name) may cause skipped duplicates...
```

### Error Messages

**Red Alert:**
```
❌ Validation errors detected
• Table spares_used: Re-key IDs requires dedupe keys or a unique index on natural keys.
```

---

## Tips

💡 **Tip 1:** Review the Migration Plan Summary before every run to catch issues early

💡 **Tip 2:** Use the inline editor for quick fixes, but go to Plan page for complex changes

💡 **Tip 3:** Keep dedupe keys consistent across re-runs to avoid duplicates

💡 **Tip 4:** Test with dry run first to validate configuration

💡 **Tip 5:** Save your plan as a profile after getting it working

---

## Need More Help?

- Full Guide: [Run Page Enhancements](./run-page-enhancements.md)
- Table Mapping: [Enhanced Table Mapping Guide](./enhanced-table-mapping-guide.md)
- Troubleshooting: [Migration Troubleshooting](./migration-troubleshooting.md)
