# Autoneer Firebird → MySQL Migration PWA

This project provides a step-by-step migration wizard to move data from a Firebird database into the exact MySQL schema defined in data/database_schema.md.

## Requirements

- Node.js LTS
- Firebird client libraries installed on the machine running the app
  - Windows: install Firebird Client (fbclient.dll)
  - The Firebird driver uses the local client library
- MySQL server

## Setup

1. Install dependencies:
   - npm install
2. Copy .env.example to .env and adjust defaults if desired.
3. Start:
   - npm run dev (nodemon)
   - npm run start

## Usage

Open http://localhost:3000/setup and follow the wizard:

1. Configure Firebird connection, test connection.
2. Configure MySQL connection, test connection.
3. Select target schema. If it does not exist, create it using the exact DDL from data/database_schema.md.
4. Build a migration plan, edit mappings, then run.
5. View results and download logs.

## Features

### Run Page Enhancements (NEW! 🎉)

Two powerful features that dramatically improve the migration workflow:

#### 1. Pre-Migration Summary
- **See what will happen before you run** - View source→target table mappings
- **Verify configuration at a glance** - Mode, key strategy, and dedupe keys displayed
- **Catch issues early** - Review all migrations before execution

#### 2. Inline Plan Editor
- **Fix errors without navigation** - Edit plan options directly when validation errors occur
- **Save time** - No more clicking Back and navigating through multiple pages
- **Streamlined workflow** - Update dedupe keys, mode, or key strategy instantly

📖 **Documentation:**
- [Complete Guide](docs/run-page-enhancements.md) - Full feature documentation
- [Quick Reference](docs/run-page-quick-reference.md) - Fast lookup and decision trees
- [Before/After Comparison](docs/run-page-before-after.md) - Visual guide showing improvements

**Example Scenario:**
```
Error: "Table spares_used: Re-key IDs requires dedupe keys"
Before: Navigate back to Plan page → Find table → Edit → Navigate back (9 steps)
After: Enter dedupe keys inline → Click Update Plan (2 steps) ✅
```

### Custom Table Mapping with Dropdown Selection

Migrate data from any source table to any target table with full control over field selection, custom field names, transformations, and default values. Now featuring **dropdown selectors** for easy table and field selection!

**Example:** Migrate `spares_used` to `customer_invoice_lines` with selected fields only.

📖 **Documentation:**
- [Enhanced Guide](docs/enhanced-table-mapping-guide.md) - Dropdown selection and field mapping
- [Complete Guide](docs/custom-table-mapping-guide.md) - Comprehensive instructions and examples
- [Quick Start](docs/custom-table-mapping-quickstart.md) - Fast reference for common tasks

**Key Capabilities:**
- **Dropdown target table selection** - Choose from available MySQL tables
- **Dropdown field mapping** - Select target fields with data type display
- **Primary key indicators** - See which fields are primary keys (🔑)
- **Data type information** - View field types to choose correct transforms
- **Refresh button** - Reload target table schema if it changes
- **Custom table/field support** - Still supports manual entry when needed
- Apply transformations (trim, toNumber, toDate, etc.)
- Set default values for fields
- Save as reusable migration profiles
- Load and manage saved profiles

## Logs and run results

Run records and logs are stored in the selected MySQL schema in these internal tables:

- migration_runs
- migration_table_runs
- migration_row_errors
- migration_mapping_profiles
- migration_id_map (optional, when re-keying IDs)

## Notes

- The migration is data-only.
- Credentials are never logged or returned to the browser.
- The schema creation uses the DDL in data/database_schema.md verbatim.
