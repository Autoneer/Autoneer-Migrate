# Autoneer-Migrate — Imported job part lines must arrive with correct VAT state

## Background (already diagnosed in Autoneer-PWA)

A full Firebird ? MySQL import into the local tenant `dm_trucks` (run 1, plan 18,
mapping profile 15, 2026-10-06) produced open WIP jobs showing wrong VAT. Two
importer behaviours caused it:

1. **Empty invoice numbers become 0, not NULL.**
   - Mapping profile 15 for `SPARES_USED` sets `INVNR` to `defaultValue: ""`.
   - `TableExecutor.transformRow` (src/migrate/executors/TableExecutor.js ~L300-305)
     replaces a NULL source value with that `""`. MySQL stores it in the INT
     column `spares_used.invoice_nr` as 0. `work_done.invoice_nr` shows the same
     result.
   - AUTONEER itself writes NULL for "not invoiced". Its open-line VAT
     normalisation previously only matched `invoice_nr IS NULL`, so it skipped
     every imported line. (AUTONEER-PWA now also treats 0 as open, but imports
     should match native data.)
   - The same default logic exists in src/routes/api/plans.js (~L891) and
     src/migrate/validators/PlanValidator.js (~L230).
   - mapping.default.json maps INVNR with `toNumber` and no default, which
     correctly yields NULL. The stored profile did not.

2. **No VAT rate snapshot.** `spares_used.vat_rate` has no source column, so every
   imported line has `vat_rate = NULL`.
   - AUTONEER then derives each line's rate as `vat / sales_price`.
   - Legacy rows often carry a `VAT` amount left over from an earlier selling
     price. `SALES_PRICEINCVAT` was correct; `VAT` was not.
   - Example: BRAKE DISC FRONT, sales 1,477.80, legacy VAT 277.09 (15% of an old
     price 1,847.25). Expected 221.67.
   - New-epoch tenants never run AUTONEER legacy migration 158, which did this
     cleanup for older tenants.

AUTONEER-PWA now contains the authoritative open-line rule and a repair script:
- `src/services/finalise/openJobPartVat.service.js` (`planOpenPartVatLine`,
  `resolveOpenPartVatRate`, `normalizeOpenJobPartVat`)
- `scripts/audit/repair_open_job_part_vat.js --schema <tenant> [--job N] [--apply]`
  (dry run by default; snapshots before writing)

Do not modify the AUTONEER-PWA repository from this task.

## Required changes

### A. Keep "no invoice" as NULL
- A NULL source value written to a **numeric** target column must stay NULL when
  the configured default is an empty string. Never let `""` reach a numeric
  column where MySQL silently coerces it to 0.
- Required outcome: `spares_used.invoice_nr` and `work_done.invoice_nr` are NULL
  for uninvoiced legacy lines.
- Apply the rule consistently in every place defaults are applied (executor, plan
  preview, validator). Use the target column metadata the importer already reads
  (Schema.js) rather than hard-coding column names, if that is reliable.
- Explicit numeric defaults such as `"0"` must keep working unchanged.
- Before changing behaviour, list every numeric target column whose stored
  mapping default is `""` across the existing profiles. Report the list. Do not
  change columns other than the two above without the user's approval. Be
  careful with `job_information.invoice_nr`: confirm how AUTONEER-PWA reads it
  before proposing a change.

### B. Leave open part lines with a correct VAT snapshot
- After a run that imported `SPARES_USED` (with `STOCK` and `COMPANY_PREFFERENCES`
  present in the target), open part lines must end up with `vat_rate` set and
  `vat` / `sales_priceincvat` restated.
- "Open" means the line's invoice number is NULL/0, the job has no non-void row
  in `invoices`, and the line is not excluded from the quote
  (`is_excluded_from_quote = 0`).
- Preferred: keep AUTONEER-PWA as the single source of truth. Add a post-import
  step that runs the PWA repair script against the target schema (dry run,
  report, then `--apply`), with the PWA checkout path configurable. If the PWA
  checkout is not available, fail the step with a clear message. Do not silently
  skip it.
- Only if the user rejects that approach: implement the rule natively, mirroring
  `resolveOpenPartVatRate` exactly:
  1. an existing `vat_rate` wins;
  2. a linked stock row with `vat = 'YES'` ? tenant `taxpercent / 100`, and
     `vat = 'NO'` ? 0;
  3. GENERIC/GEN-/SUNDRY/SUNDRY- lines, and lines with no linked stock row
     (`stock_id` 0/NULL), keep the implied rate `vat / sales_price`;
  4. otherwise 0.
  VAT is `ROUND(sales_price × rate, 2)` and inc-VAT is `sales_price + vat`. In
  that case, add a parity test against the PWA rule's behaviour.
- **Never touch lines attached to an invoice** (posted history). Their stored
  amounts are accounting records.

### C. Post-import verification
- Add a check to the run summary that reports, for the target schema:
  - open part lines still having `vat_rate IS NULL`;
  - lines with `invoice_nr = 0` in `spares_used` / `work_done`.
- Mark the run with a warning if either count is non-zero.

## Constraints
- Do not run imports or repairs against production, or against any tenant other
  than a local scratch target, without explicit approval.
- Do not alter already-imported tenants (`dm_trucks` was repaired separately).
- Keep changes minimal and match existing code style. Add only strictly necessary
  tests and flag any new test file.

## Report back
1. Root cause confirmed in this repo (files and lines).
2. The list of numeric columns with `""` defaults (section A) and what you
   changed.
3. How section B is wired (PWA script call or native rule), with the dry-run
   output from a local test import.
4. Verification actually performed, and anything left unverified.

Stop after implementation. Do not commit or push without approval.
