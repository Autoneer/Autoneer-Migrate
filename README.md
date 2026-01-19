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
