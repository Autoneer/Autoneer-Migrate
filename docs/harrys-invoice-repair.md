# Harrys invoice repair — 6 October 2026 follow-up

The console warning and invoice failures are independent. This follow-up uses read-only checks against the configured MySQL `harrys` schema and the Firebird source. During this check `harrys.invoices`, `migration_runs`, `migration_row_errors`, and `migration_id_map` were empty. The older run report describes the earlier partial import, not the current target contents. Verify the wizard points to the same server/schema before applying anything.

The user confirmed some imported invoices must remain active and asked to leave the final two non-split conflicts for review. No blanket historical flag, automatic void, invented split, renumbering, or duplicate-skipping policy has been added.

## ID-map warning

`src/db/mysql.js` created `source_id` / `target_id`, whereas both ID-map writers use `source_pk` / `target_pk`, `operation`, and `created_at`. The live table had the old layout and no mappings.

The runtime DDL now creates the correct columns and unique run/table/source key. Initialization also upgrades old tables by renaming the existing columns and adding the missing audit fields and key. Existing mappings are preserved; ambiguous columns or duplicate mappings cause an actionable error before the upgrade rather than silent deletion. Unknown legacy operation/timestamp values remain NULL. This runs through the existing migration-table initialization on application/schema setup and before a migration.

A final read-only check confirmed that the permanent `harrys.migration_id_map` now has `source_pk`, `target_pk`, `operation`, and `created_at`. The permanent invoice table was still empty and its generated active-job expression was unchanged.

Bulk preserved-ID recording now uses each row's actual target primary key, including sparse/out-of-order IDs and insert results where `insertId` is zero. It no longer invents a contiguous range from `insertId`. Batches containing ignored rows are not mapped by position because that cannot reliably identify which insert succeeded. Failed tracking in the earlier run cannot be reconstructed merely by repairing the table definition.

## The 364 invoice errors

| Cause | Failed rows | Repair |
| --- | ---: | --- |
| Job 0 treated as one real job | 358 | Exclude the no-job sentinel from the generated active-job key. The source contains 359 valid invoices with job 0 and no job_information row numbered 0. |
| Missing modern split flag | 4 | Derive `is_split_invoice = 1` from a positive legacy `SPLITNR` while retaining the original split number, invoice number, job number, and active/historical status. Implemented in the importer. |
| Non-split invoices sharing real jobs | 2 | Left for review as requested. |

Split flags are derived only when the target has `is_split_invoice`, the mapping retains a source field mapped to `splitnr`, and there is no explicit mapping to the modern flag. Other target versions and explicit mappings retain their existing behavior.

### Source-confirmed split invoices

| Job | Source invoices | Legacy SPLITNR |
| --- | --- | --- |
| 1448 | 1345, 1387 | 1, 2 |
| 5215 | 4769, 4810 | 1, NULL |
| 5264 | 4672, 4811 | 1, 2 |
| 5617 | 4903, 4904 | 1, 2 |

The old application's split workflow writes `SPLITNR` to the invoice and job records. It was already mapped into the new invoice's legacy `splitnr` column, but the generated key tests the separate `is_split_invoice` flag, which had defaulted to zero.

### Cases deliberately left for review

| Job | Invoice referenced by the source job | Extra invoice | Source facts |
| --- | --- | --- | --- |
| 32502 | 26305 | 26292 | Extra invoice total/paid are 0/0, marked PRINTED and UNPAID. Referenced invoice is 1808.04 and PAID. Neither has SPLITNR. |
| 43961 | 31080 | 31075 | Both totals/paid are 0/0 and UNPAID. Neither has SPLITNR. |

The job references suggest which invoice is current, but do not establish a valid void date, credit relationship, or historical classification for the extras. Merely setting `is_historical_import = 1` would not resolve these conflicts because the current generated key does not test that flag. A later decision to retain them as historical would need a coordinated key and classification change, with the application's historical-invoice behavior taken into account.

## Applying the remaining schema correction

`docs/harrys-invoice-job-zero.sql` contains the proposed `ALTER TABLE` for the observed STORED generated column. It preserves `uq_invoices_active_job`, leaves every invoice's job number intact, and excludes only job number 0 from that key. It preserves the existing split/void/credit tests and makes no historical classification changes. **It has not been applied to the permanent `harrys.invoices` table.** This belongs in the application-owned schema migration as well if it should apply to other tenant schemas.

After this SQL and the importer update, the source evidence predicts that 362 of the original 364 rejections are resolved. The other two still prevent a completely successful invoice migration. Keep them visible until reviewed; do not silently omit them to report success.

If the selected target still contains the earlier 55,539 imported invoice headers, reconcile that partial import before retrying: a full INSERT rerun would collide on their invoice numbers. If the selected target is the currently observed empty `harrys`, a fresh corrected import is appropriate once the two remaining cases are decided. A completed migration and final reconciliation should precede account conversion.

## Verification

Regression checks cover old-schema upgrades, repeat initialization, preservation of old mappings, refusal to delete ambiguous mappings, actual sparse IDs, successful rows in failed-batch fallback, split derivation, and the runner's generated INSERT values. Opt-in MySQL tests use only connection-local temporary tables to verify the real ALTER, ID-map writes/upserts/lookups, and the proposed job-zero key: multiple no-job and split invoices succeed, while two normal active invoices for a real job still fail. No migration was rerun and the two review cases were not changed.

The root-level test suite passes. Two older test files outside that suite, `tests/models/refactored-models.test.js` and `tests/validators/dryRunNullHandling.test.js`, already have syntax errors in HEAD (stray closing braces and top-level await in CommonJS respectively). They were not modified as part of this repair.
