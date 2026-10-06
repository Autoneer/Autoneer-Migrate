# General invoices with job number zero

Legacy job number `0` means a valid general invoice without a job. The invoice
keeps its original invoice number, job number, customer, and active/historical
classification. Only its generated `job_number_active` value becomes NULL.
`uq_invoices_active_job` continues to enforce one active invoice per real job.

`src/db/invoiceActiveJobSchema.js` wraps the target's current generated expression:

```sql
CASE WHEN job_number = 0 THEN NULL ELSE (existing_expression) END
```

This preserves all existing rules for real jobs, including split, void, credit,
and any historical criteria already defined by the application. The repair keeps
the column's integer type, stored/virtual mode, comment, visibility, and unique
index. Repeated checks do not alter the column again. Older target schemas without
the generated column or named index remain unchanged; unsupported definitions
fail explicitly before an ALTER.

The migration runner checks this during preflight when invoices are included,
before source cleanup or invoice copying. A dry run reports a pending correction
without changing the target. ALTER failures stop the run even if table-level
continue-on-error is enabled. No new duplicate skipping, re-keying, or historical
classification policy is introduced.

## Applied target correction — 6 October 2026

The configured `dm_trucks` target matched the reported run: run 4 had 301 invoice
errors with `Duplicate entry '0' for key 'invoices.uq_invoices_active_job'`.
The correction was applied to `dm_trucks.invoices` and verified:

- All 16,320 existing invoices remain present.
- SHA-256 comparisons of every invoice's base column values before/after match.
- Every real job's generated key remains unchanged.
- The existing job-zero invoice now has a NULL active-job key.
- `uq_invoices_active_job` remains a unique index on `job_number_active`.
- A repeat repair returns `unchanged`.

No import was rerun, and existing run/error records retain their audit history.
The target contains a partial import. The Retry Failed / Unattempted Tables action
now skips matching existing headers and inserts missing ones. Errors for different
invoices sharing an active real job remain errors and need their own review.

## Retrying partial imports

Retries carry the prior run ID to the runner and preserve existing target rows:
target cleanup is disabled. Records with preserved IDs are checked by their full
primary key. Re-keyed records use the prior run's ID map or configured natural
keys, with target existence verified. Each matched record counts as skipped,
appears in detailed logs as `already_migrated`, and gets a SKIP mapping in the new
run so linked rows can resolve it. Missing records continue through the import.
Retries also reuse prior mappings for foreign keys to completed tables.

Existing invoices are skipped only when their original invoice number and mapped
job/customer identities match. A header with conflicting ownership, or a different
invoice colliding with the active-job key, remains an error. No existing invoice is
updated, re-numbered, or reclassified by the retry. Duplicate errors arising after
the existence check are checked again during row fallback. Dry runs report the
same skips without writing records or mappings. Fresh runs retain their existing
collision policy.

## Verification

Unit tests cover repeat repair, metadata preservation, dry runs, older schemas,
unexpected definitions, and failed ALTERs. Runner tests cover preflight ordering
and stopping on repair failure. Opt-in MySQL tests use temporary tables to verify
both STORED and VIRTUAL generated columns: the example invoice numbers 23421,
13158, 25915, 24597, and 18196 coexist with job zero and unchanged classification;
duplicate invoice numbers and duplicate active real jobs are rejected. Existing
split, void, and credit exceptions continue to work.

```powershell
node --test tests/invoiceActiveJobSchema.test.js tests/invoiceMigrationSafety.test.js tests/runnerProgress.test.js
$env:MIGRATION_MYSQL_TEST = '1'
node --test tests/invoiceActiveJobMysql.test.js
```

Future target application schema migrations should encode the same sentinel rule
so their generated column definition matches this repair.
