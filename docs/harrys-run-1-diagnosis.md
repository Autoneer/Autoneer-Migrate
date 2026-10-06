# Harrys migration run 1 — 6 October 2026

Run 1 failed because the target invoice schema rejects multiple active invoices for the same job. This is a source/target business-rule mismatch, not the Firebird login warning: the invoice source read and subsequent connectivity checks succeeded.

Evidence was checked read-only against `harrys.migration_runs`, `migration_table_runs`, `migration_row_errors`, `invoices`, `SHOW CREATE TABLE invoices`, and `logs/migrate/1.log`.

## Outcome

- Run: 09:31:43–09:33:33 SAST (1 minute 50 seconds).
- 21 selected tables: 4 succeeded, invoices failed, 16 were not attempted.
- 55,903 valid source invoices: 55,539 inserted, 364 rejected.
- 103,515 rows were written across the attempted tables. The failed run did not undo those writes.
- Every rejected invoice hit `invoices.uq_invoices_active_job`.
- 358 rejected invoices have job number 0. Invoice 7319 already occupies that active-job value. Example rejected invoice numbers: 6968, 5887, 6514, 6638, 6589.
- The other 6 conflicts are:

| Job | Invoice already imported | Rejected source invoice |
| --- | --- | --- |
| 5617 | 4904 | 4903 |
| 5264 | 4811 | 4672 |
| 5215 | 4810 | 4769 |
| 1448 | 1387 | 1345 |
| 32502 | 26292 | 26305 |
| 43961 | 31075 | 31080 |

The old error UI displayed account number 3993200 as the source record ID because mapping target names were compared case-sensitively. The new diagnostics recover the actual invoice number from saved source rows, and new migrations resolve the mapped primary key case-insensitively.

## Why the schema rejects these records

`uq_invoices_active_job` is unique on the generated `job_number_active` column. Its current expression returns `job_number` when `is_split_invoice` is 0, `voided_at` is NULL, and `credit_for_invoice_nr` is NULL. It includes job number 0 and does not check `is_historical_import`.

All 55,539 currently imported invoices have `is_historical_import = 0`. Consequently legacy sales invoices with job 0 and historical invoices sharing real jobs are treated as competing active invoices. Merely setting `is_historical_import = 1` would still leave the current generated-key conflict in place.

The migration intentionally forces invoices to preserve `invoice_nr`, use INSERT, and reject duplicate keys. The console's unexplained `plan_migrate` warning was that policy overriding the saved SKIP choice. Skipping these errors would silently lose 364 invoices; re-keying would break original invoice identities and references.

## Repair options

For a historical import, the recommended design is to explicitly classify the imported historical invoices and exclude those records from the generated active-job key. Preserve their original `invoice_nr` and `job_number`, while retaining the unique rule for ordinary active invoices. Coordinate this change with the application that owns the invoice schema and its historical-invoice/payment behavior. The migration mapping/import path must actually supply the historical flag; its current default is 0.

If some imported invoices must remain active, review the six real-job pairs individually to identify legitimate split, replacement, voided, or credited invoices. Apply only classifications supported by the source data. Separately agree how a legacy job number of 0 represents “no job”; the active-job key can exclude that sentinel without rewriting the preserved source job number. Do not mark records split or void merely to make the import pass.

Before retrying, reconcile the 55,539 already-written invoices. A full invoice INSERT rerun currently also collides on their preserved primary keys. Either restore a known pre-import target snapshot and rerun the corrected plan, or prepare a targeted recovery that inserts only the 364 missing invoice numbers after checking existing invoice identities and values. Do not truncate unrelated target data or globally disable the unique rule. After all invoices reconcile, run the 16 previously unattempted tables, then rebuild GL accounts and convert account numbers.

No invoice data, active-job constraint, or historical classification was changed during this investigation, and no migration was rerun.

## Application changes

- Failure Results precedes Step 5 whenever execution fails or stops. Conversion is gated on a successful run, including navigation through a direct link or restored wizard state.
- Results group repeated causes, explain why they failed, show sample source invoice numbers and technical detail, and provide plan/mapping amendment and retry actions.
- Retry selects failed and unattempted tables and retains the saved plan's configuration and mapping profile. It does not repair database conflicts automatically.
- Amending a plan clears the completed run from the wizard while retaining the saved plan and mapping, so it can actually be executed again. The original run remains in history.
- Totals distinguish successful, failed, and unattempted tables; show row error counts; and use stored completion times.
- New logs include representative row errors, grouped counts, and meaningful invoice-policy warnings. New run snapshots retain the full selected table list.
