# Autoneer Firebird → MySQL Migration PWA

This project provides a step-by-step migration wizard to move data from a Firebird database into a MySQL schema defined in data/database_schema.md.

## Migration Wizard

A guided 5-step wizard is available at **http://localhost:3000/wizard**.

### Wizard Steps
1. **Schema Discovery** — discover tables and columns from both databases
2. **Build Mapping** — map source tables to target tables with field-level control
3. **Create Plan** — order tables, configure batch size, and run dry-run validation
4. **Execute Migration** — start migration with live progress tracking
5. **View Results** — review statistics and errors

### Wizard Highlights (verified)
- **State Persistence** — progress is saved in localStorage
- **Responsive UI** — layout includes mobile and tablet breakpoints
- **Real-time Progress** — run progress polls every 2 seconds and auto-stops when complete
- **Error Recovery** — retry failed migrations and stop active runs

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

### Option 1: Wizard (Recommended)
Open http://localhost:3000/wizard and follow the guided 5-step process.

### Option 2: Classic Flow
Open http://localhost:3000/setup and follow the wizard:

1. Configure Firebird connection, test connection.
2. Configure MySQL connection, test connection.
3. Select target schema. If it does not exist, create it using the exact DDL from data/database_schema.md.
4. Build a migration plan, edit mappings, then run.
5. View results and download logs.

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
