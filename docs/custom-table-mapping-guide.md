# Custom Table Mapping Guide

## Overview

The custom table mapping feature allows you to migrate data from one table to a completely different table name with full control over which fields to include, custom field mappings, transformations, and default values. This is saved as a migration profile that can be reused for future migrations.

## Use Case Example

**Scenario:** You want to migrate data from `spares_used` table to `customer_invoice_lines` table, selecting only specific fields and applying custom transformations.

---

## Step-by-Step Instructions

### Step 1: Navigate to the Mapping Page

1. Start the migration application
2. Complete the **Setup** step (configure Firebird and MySQL connections)
3. Complete the **Plan** step (select which tables to migrate)
4. Navigate to the **Mapping** page

### Step 2: Enable Advanced Options

1. On the Mapping page, check the box labeled **"Show advanced options"**
2. This will reveal several advanced sections including **"Advanced: Custom Table Mapping"**

### Step 3: Configure Custom Table Mapping

The Custom Table Mapping section shows all your source tables with options to customize each one.

#### 3.1 Change Target Table Name

For each source table you want to customize:

1. Locate the row for your source table (e.g., `SPARES_USED`)
2. In the **Target Table** column, enter the desired target table name
   - Example: Change `spares_used` to `customer_invoice_lines`

#### 3.2 Configure Fields

1. Click the **"Configure Fields"** button for the table you're customizing
2. A field configuration panel will expand showing all available fields

In the field configuration panel:

- **Checkbox Column**: Check/uncheck to include/exclude each field from migration
  - Use the checkbox in the header row to select/deselect all fields at once
- **Source Field**: Shows the original field name (read-only)
- **Target Field**: Customize the destination field name
  - Example: Map `SPARE` to `line_description`
- **Transform**: Select data transformation to apply:
  - `trim` - Remove whitespace from strings
  - `toNumber` - Convert to numeric value
  - `toDate` - Convert to date format
  - `toUpperCase` - Convert string to uppercase
  - `toLowerCase` - Convert string to lowercase
- **Default Value**: Set a default value for the field if source is empty
  - Example: Set default to `0` for price fields or `'N/A'` for text fields

#### 3.3 Example Configuration

**Migrating SPARES_USED to customer_invoice_lines:**

| Include | Source Field | Target Field | Transform | Default Value |
|---------|-------------|--------------|-----------|---------------|
| ✓ | SPARES_ID | line_id | - | - |
| ✓ | JOB_NR | invoice_number | - | - |
| ✓ | SPARE | line_description | trim | - |
| ✓ | QUANTITY | quantity | toNumber | 1 |
| ✓ | COST_PRICE | unit_cost | toNumber | 0 |
| ✓ | SALES_PRICE | unit_price | toNumber | 0 |
| ✓ | DATE_USED | line_date | toDate | - |
| ✗ | STATUS | - | - | - |
| ✗ | MARKUP | - | - | - |

In this example:
- Only selected fields (with ✓) will be migrated
- Field names are customized for the target table
- Appropriate transformations ensure data is in the correct format
- Default values prevent null/empty issues

### Step 4: Apply Custom Mapping

1. After configuring all fields, click **"Done"** to close the field selector
2. Repeat for any other tables you want to customize
3. Click the **"Apply Custom Mapping"** button at the bottom of the section
4. You'll see a success message confirming the changes were applied

### Step 5: Save as a Profile

To save your custom mapping configuration for future use:

1. Scroll to the **"Current profile"** section
2. Enter a descriptive profile name in the text field
   - Example: `"Spares to Invoice Lines Migration"`
3. If this is a new configuration, ensure **"Create a new profile"** is checked
4. Click **"Save profile & continue to Run"**

Your custom mapping is now saved as a reusable profile!

### Step 6: Load a Saved Profile

To reuse a saved custom mapping profile:

1. Navigate to the Mapping page
2. Enable "Show advanced options"
3. Scroll to the **"Advanced: Profiles"** section
4. Find your saved profile in the list
5. Click **"Load"** next to the profile name
6. The custom table mappings and field configurations will be loaded
7. You can now proceed to run the migration or make additional changes

### Step 7: Set Default Profile (Optional)

To make a profile load automatically next time:

1. In the Profiles section, find your desired profile
2. Click **"Set Default"** next to the profile name
3. This profile will now load automatically when you open the Mapping page

---

## Advanced Tips

### Duplicating Table Mappings

If you want to migrate the same source table to multiple target tables:

1. Use the **"Duplicate"** button (currently prompts for manual JSON editing)
2. Alternatively, export your mapping as JSON, manually duplicate the table entry with a different target name, and import it back

### JSON Export/Import

For complex customizations:

1. Use **"Export JSON"** to download your mapping configuration
2. Edit the JSON file manually with any text editor
3. Use **"Import"** to load your modified configuration

Example JSON structure:
```json
{
  "tables": {
    "SPARES_USED": {
      "target": "customer_invoice_lines",
      "mode": "INSERT",
      "keyStrategy": "rekey",
      "columns": {
        "SPARES_ID": {
          "target": "line_id"
        },
        "SPARE": {
          "target": "line_description",
          "transform": "trim"
        },
        "QUANTITY": {
          "target": "quantity",
          "transform": "toNumber",
          "default": 1
        }
      }
    }
  }
}
```

### Field Selection Strategies

**Include All Approach:**
- Start with all fields checked
- Uncheck only the fields you don't want

**Include Specific Approach:**
- Uncheck all fields using the header checkbox
- Check only the specific fields you need

### Transform Guidelines

- **Use `trim`** on all string/text fields to remove whitespace
- **Use `toNumber`** on numeric fields (prices, quantities, IDs)
- **Use `toDate`** on date fields to ensure proper date formatting
- **Use case transforms** only when target database requires specific casing

### Default Value Best Practices

- Set default values for NOT NULL fields in your target database
- Use `0` for required numeric fields
- Use appropriate defaults for business logic (e.g., `1` for quantity)
- Leave empty if the field allows NULL values

---

## Troubleshooting

### Issue: Changes Not Saving

**Solution:** Make sure to:
1. Click "Apply Custom Mapping" after configuring fields
2. Save the mapping as a profile (give it a name and click "Save profile")

### Issue: Fields Not Appearing in Target Table

**Solution:** Verify:
1. The field is checked (included) in the field configuration
2. The target field name matches your target database schema
3. The target table exists in your MySQL database

### Issue: Data Type Mismatches

**Solution:**
1. Ensure you're using the correct transform (toNumber, toDate, etc.)
2. Check that default values match the target field's data type
3. Review migration logs for specific error messages

### Issue: Profile Not Loading

**Solution:**
1. Verify the profile was saved successfully
2. Check if there are any error messages
3. Try exporting and re-importing the profile JSON

---

## Complete Workflow Example

**Goal:** Migrate SPARES_USED to customer_invoice_lines with selected fields

1. ✅ Navigate to Mapping page
2. ✅ Enable "Show advanced options"
3. ✅ In Custom Table Mapping section, find SPARES_USED row
4. ✅ Change target from `spares_used` to `customer_invoice_lines`
5. ✅ Click "Configure Fields" button
6. ✅ Select only needed fields (uncheck unwanted fields)
7. ✅ Customize target field names as needed
8. ✅ Set appropriate transforms (toNumber for prices, trim for text)
9. ✅ Set default values where needed (0 for prices, 1 for quantity)
10. ✅ Click "Done" to close field selector
11. ✅ Click "Apply Custom Mapping"
12. ✅ Enter profile name: "Spares to Invoice Lines"
13. ✅ Check "Create a new profile"
14. ✅ Click "Save profile & continue to Run"
15. ✅ Your custom mapping is saved and ready to use!

To run the migration:
- Proceed to the Run page
- Configure migration settings (dry run, batch size, etc.)
- Click "Start Migration"
- Monitor progress and review results

---

## Profile Management

### Viewing Saved Profiles

In the "Advanced: Profiles" section, you can see:
- Profile name
- Creation date
- Status badges (Default, Loaded)

### Profile Actions

- **Load**: Apply this profile's configuration
- **Set Default**: Make this profile load automatically
- **Delete**: Remove the profile (requires confirmation)

### Best Practices

1. **Naming Convention**: Use descriptive names that indicate the purpose
   - Good: "Spares to Invoice Lines - Production"
   - Bad: "Profile 1", "Test"

2. **Version Control**: Include version or date in profile names for tracking
   - Example: "Spares Migration v2.0"
   - Example: "Invoice Lines 2026-01"

3. **Documentation**: Keep notes about what each profile does
   - Export profiles as JSON and save with README files
   - Document any special business logic or transformations

4. **Testing**: Always test custom mappings with a dry run first
   - Enable dry run mode on the Run page
   - Verify data appears correctly before committing

---

## Summary

The custom table mapping feature provides complete flexibility in how you migrate data between databases. By allowing you to:

- Map any source table to any target table name
- Select specific fields to include/exclude
- Customize field names and transformations
- Set default values
- Save configurations as reusable profiles

You can handle complex migration scenarios that go beyond simple table-to-table copies. This is especially useful for:

- Database schema restructuring
- Consolidating data from multiple source tables
- Migrating to a different database design
- Selective data migration based on business requirements

Remember to always test your migrations with a dry run before committing changes to production data!
