# Autoneer Firebird → MySQL Migration PWA

This project provides a step-by-step migration wizard to move data from a Firebird database into the exact MySQL schema defined in data/database_schema.md.

## 🎉 NEW: Migration Wizard (Phase 3)

**A modern, guided 5-step wizard for streamlined migrations!**

Access the new wizard at **http://localhost:3000/wizard** or click "🧙 Wizard (New)" in the sidebar.

### Why Use the Wizard?

- **📊 Visual Progress Tracking** - See exactly where you are in the migration process
- **✅ Real-time Validation** - Catch errors before they happen with inline validation
- **💾 State Persistence** - Your progress is saved automatically (localStorage)
- **📱 Mobile Responsive** - Works on desktop, tablet, and mobile devices
- **♿ Accessible** - WCAG 2.1 AA compliant with keyboard navigation
- **🔄 Real-time Updates** - Watch migration progress in real-time with 2-second polling

### Wizard Steps

1. **Schema Discovery** - Automatically discover tables and columns from both databases
2. **Build Mapping** - Map source tables to target tables with field-level control
3. **Create Plan** - Order tables, configure batch size, and run dry-run validation
4. **Execute Migration** - Start migration with live progress tracking
5. **View Results** - Review statistics, errors, and export reports

📖 **Documentation:**
- [Phase 3 Complete Guide](docs/PHASE_3_COMPLETE.md) - Full implementation details
- [Integration Guide](docs/WIZARD_INTEGRATION_COMPLETE.md) - Testing and troubleshooting

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

### Option 1: New Wizard (Recommended)
Open http://localhost:3000/wizard and follow the guided 5-step process.

### Option 2: Classic Flow
Open http://localhost:3000/setup and follow the wizard:

1. Configure Firebird connection, test connection.
2. Configure MySQL connection, test connection.
3. Select target schema. If it does not exist, create it using the exact DDL from data/database_schema.md.
4. Build a migration plan, edit mappings, then run.
5. View results and download logs.

## Features

### 🧙 Migration Wizard (Phase 3 - NEW!)
- **5-Step Guided Process** - Linear workflow from schema discovery to results
- **State Management** - localStorage persistence + in-memory event system
- **Real-time Progress** - 2-second polling with auto-stop on completion
- **Responsive Design** - Mobile-first with breakpoints for tablet/desktop
- **Accessibility** - WCAG 2.1 AA with focus indicators, keyboard nav, screen reader support
- **Dark Mode** - Automatic dark mode based on system preferences
- **Error Recovery** - Retry failed migrations, stop mid-process, inline validation

### Run Page Enhancements (Classic Flow)

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

## Architecture Refactoring (Phases 1 & 2 Complete! 🎉)

The codebase has been refactored to implement clean separation of concerns with a comprehensive REST API layer.

### 🏗️ New Architecture
- **Model Layer**: Schema, FieldMap, Mapping, Plan, Run
- **Validator Layer**: Schema, Mapping, and Plan validators
- **Executor Layer**: Preflight checks and table migration executors
- **API Layer**: 28 RESTful endpoints for programmatic access

### 📚 Documentation
- **[API Quick Reference](API_QUICK_REFERENCE.md)** - Fast lookup for all API endpoints
- **[Refactoring README](REFACTORING_README.md)** - Architecture overview and usage examples
- **[Phase 2 Complete](PHASE_2_COMPLETE.md)** - API implementation details
- **[Complete Summary](COMPLETE_REFACTORING_SUMMARY.md)** - Full project overview
- **[Quick Start Guide](QUICK_START_REFACTORING.md)** - Developer onboarding

### 🔌 Key Features
- **28 REST API Endpoints** for all operations
- **Full CRUD** for mappings, plans, and runs
- **Real-time Progress Tracking** via API
- **Pre-run Validation** and dry-run simulation
- **100% Backward Compatible** - existing UI still works
- **Legacy Format Support** - convert old mappings automatically

### 🚀 Quick API Examples

```bash
# Refresh database schemas
curl -X POST http://localhost:3000/api/schemas/refresh

# Create a mapping profile
curl -X POST http://localhost:3000/api/mappings \
  -H "Content-Type: application/json" \
  -d '{"name":"My Mapping","tables":{...}}'

# Create a migration plan
curl -X POST http://localhost:3000/api/plans \
  -H "Content-Type: application/json" \
  -d '{"mappingId":"abc-123","name":"My Plan"}'

# Track run progress
curl http://localhost:3000/api/runs/20250120_140530/progress
```

### 🧪 Testing
```bash
# Run automated API tests
node scripts/test_phase2_api.js

# Run unit tests
npm test tests/models/refactored-models.test.js
```

## Notes

- The migration is data-only.
- Credentials are never logged or returned to the browser.
- The schema creation uses the DDL in data/database_schema.md verbatim.
- All new API endpoints are documented in [API_QUICK_REFERENCE.md](API_QUICK_REFERENCE.md).
