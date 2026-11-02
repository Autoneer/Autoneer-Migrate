# General invoice repair — completed 2 November 2026

Completed on the authorized migration copy **dm_service_centre**, legacy **AUTONEER.FDB**, using targeted route B. All changes are uncommitted. No PWA files were edited. Scratch schema **glbf_test_general_invoices_20261102** was dropped after all checks passed; audit artifacts remain.

## Tenant result

- Added 479 spares_used rows, 11 work_done rows and 490 customer_invoice_lines; 290 general invoices changed DONE to POSTED with posted_at set to invoice_date. Nine labour IDs were regenerated because the legacy IDs repeat. Five display lines retain negative return quantities.
- Backfill run **3**: 290 posted, zero failed, zero skipped. New DEBTOR_INVOICE headers **98269–98558**.
- Clearing header **98559**, source MIGRATION_GENERAL_INVOICE_CLEARING / GI-2026-10-31: **2026-10-31 Dr 3200 / Cr 4900 R624,924.36**.
- Total growth: **291 journals and 2,029 journal lines**. Headers 81,629 → 81,920; lines 486,291 → 488,320. Existing journals were verified by full-row fingerprints, not only counts.
- ST-2/header 98244 and WO-2026-10-31/header 98245 remain POSTED and unchanged. Stock, stock-take records, customer caches and GL seed tables also match their original fingerprints.

## Amounts and the corrected reference

| New invoice journals | Amount (R) | Direction |
|---|---:|---|
| AR 3100 | 859,930.17 | Debit |
| Sales 1000 + 1300 + 1400 | 748,074.32 | Net credit |
| VAT 5100 | 111,855.85 | Credit |
| Inventory COS 6050 | 624,924.36 | Net debit |
| Service/sublet COS 6300 | 2,567.00 | Debit |
| Total COS | 627,491.36 | Net debit |
| Inventory 3200 before clearing | 624,924.36 | Net credit |
| Service/sublet asset 3400 | 2,567.00 | Credit |

The earlier R629,575.19 Inventory estimate omitted R4,650.83 of returns. The signed source cost R627,491.36 includes R2,567.00 of service/sublet cost; the user chose to preserve 6300/3400. Therefore Inventory correction is **629,575.19 − 4,650.83 = 627,491.36 − 2,567.00 = R624,924.36**. Header totals govern AR and VAT; legacy line/header differences are preserved.

| Account | Invoice debit (R) | Invoice credit (R) | Net debit (R) |
|---|---:|---:|---:|
| 1000 | 5 346,54 | 735 915,98 | -730 569,44 |
| 1300 | 0,00 | 8 124,90 | -8 124,90 |
| 1400 | 0,00 | 9 379,98 | -9 379,98 |
| 3100 | 859 930,17 | 0,00 | 859 930,17 |
| 3200 | 4 650,83 | 629 575,19 | -624 924,36 |
| 3400 | 0,00 | 2 567,00 | -2 567,00 |
| 5100 | 0,00 | 111 855,85 | -111 855,85 |
| 6050 | 629 575,19 | 4 650,83 | 624 924,36 |
| 6300 | 2 567,00 | 0,00 | 2 567,00 |

## Before / after balances

Debit is positive; credit is negative. After includes clearing.

| Account | 31 Oct before (R) | 31 Oct after (R) | Total before (R) | Total after (R) |
|---|---:|---:|---:|---:|
| 3100 | -437 638,20 | 422 291,97 | -423 353,49 | 436 576,68 |
| 1000 | -43 416 094,16 | -44 146 663,60 | -43 427 165,67 | -44 157 735,11 |
| 1300 | -20 392 211,50 | -20 400 336,40 | -20 393 561,50 | -20 401 686,40 |
| 1400 | -3 008 377,38 | -3 017 757,36 | -3 008 377,38 | -3 017 757,36 |
| 5100 | -9 918 441,95 | -10 030 297,80 | -9 920 305,15 | -10 032 161,00 |
| 6050 | 23 779 735,91 | 24 404 660,27 | 23 779 735,91 | 24 404 660,27 |
| 6300 | 7 533 468,53 | 7 536 035,53 | 7 534 365,95 | 7 536 932,95 |
| 3200 | 2 078 130,98 | 2 078 130,98 | 2 078 786,94 | 2 078 786,94 |
| 3400 | -276 926,12 | -279 493,12 | -276 926,12 | -279 493,12 |
| 3250 | 104 123,36 | 104 123,36 | 112 453,49 | 112 453,49 |
| 4900 | 232 324,80 | -392 599,56 | 232 324,80 | -392 599,56 |

## Verification

- Full tests folder: **310 tests; 286 passed, 19 known failures, 5 skipped**. All added tests passed. The 19 are the accepted 17 opening-stock/WIP UI failures plus unchanged syntax failures in tests/models/refactored-models.test.js and tests/validators/dryRunNullHandling.test.js. Neither file was edited. See [general-invoice-full-tests.tap](C:/Projects/Autoneer-Migrate/logs/general-invoice-full-tests.tap).
- Scratch: full write, no-op rerun, clearing undo, GL undo, lines/status undo, verification of all 30 starting table fingerprints, then complete write again. Auto-increment counters may advance; all data returned exactly. See [general-invoice-scratch-full-undo-verified.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-scratch-full-undo-verified.json) and [general-invoice-scratch-checks.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-scratch-checks.json).
- Tenant before snapshot matched scratch baseline exactly. Line dry run matched counts, totals, row hashes and the reviewed replay differences; GL dry run matched every invoice journal, account and amount.
- No RUNNING migration/backfill rows at gates. No FAILED or SKIPPED targeted invoices. Every new journal balances; every invoice AR/VAT reconciles to its header; no new 3250 lines.
- Counts/max IDs grew only for 290 DEBTOR_INVOICE journals and one clearing. Every original header and line retained its fingerprint. Inventory at cutover and in total returned exactly to baseline; WIP is unchanged at cutover and in total.
- Validate GL and GAAP both passed before and after, using the same backend checks as the UI; no manual UI step was needed.
- Tenant rerun: lines reported Nothing to add; posting and clearing reported exact journals already present. Final snapshot unchanged.
- [general-invoice-dm-before.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-dm-before.json), [general-invoice-dm-after.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-dm-after.json), [general-invoice-dm-checks.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-dm-checks.json), [general-invoice-dm-rerun-verified.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-dm-rerun-verified.json).
- Scratch deletion confirmed in [general-invoice-scratch-cleanup.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-scratch-cleanup.json).

## Files changed

| Files | Change |
|---|---|
| src/migrate/dataQuality/rules.js; src/migrate/dataQuality/engine.js | Accept general-invoice line identity via a positive invoice number. |
| src/migrate/runner.js | Remove invalid job_number/lnr natural-key deduplication in spares rekey mode. |
| src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill.js | Post job-0 invoice lines; preserve signed sales/cost returns and mapped service accounts; fail on line-read errors; no general-invoice WIP relief. |
| scripts/backfill_general_invoice_lines.js | Atomic line/display/status repair and undo backups; signed display quantities; exact replay/reference checks. |
| scripts/general_invoice_scratch.js | Read-only-source scratch copy, resumable fingerprint verification, generated columns and legacy zero dates handled. |
| scripts/preview_general_invoice_gl.js | Real mirror targeted preview inside a rolled-back transaction, journal/account reconciliation. |
| scripts/general_invoice_route_b.js | Targeted posting, one clearing, strict preservation checks, backups, undo and no-op reruns. |
| scripts/general_invoice_audit.js | Idle gates, fingerprints, balances, journal-source snapshots and UI-equivalent validation. |
| tests/dataQuality.test.js; tests/glBackfillGeneralInvoices.test.js | General invoice acceptance, posting, signed returns and source-read failures. |
| tests/generalInvoiceDisplayLines.test.js; tests/generalInvoiceGlPreview.test.js; tests/generalInvoiceRouteB.test.js; tests/generalInvoiceScratch.test.js | Display returns, journal checks, reference and validation gates, copy modes/fingerprints. |

Memory notes updated: general-invoice-lines.md, opening-stock-migration.md, wip-residual-at-cutover.md, gl-backfill-migrate-owned.md, scratch-tenant-copies.md and MEMORY.md. The existing untracked CLAUDE.md was not edited.

## Current tenant backups and undo order

Run from C:/Projects/Autoneer-Migrate, **only if rollback is intended**. These backups belong to the current restored copy. Undo clearing first, GL second, lines/statuses last. The journal undo refuses altered headers or lines. No rollback was performed on dm_service_centre.

1. [general-invoice-clearing-dm_service_centre-2026-11-02T19-19-14-263Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-clearing-dm_service_centre-2026-11-02T19-19-14-263Z.json)

```powershell
node scripts/general_invoice_route_b.js --schema dm_service_centre --action undo --backup "C:/Projects/Autoneer-Migrate/logs/general-invoice-clearing-dm_service_centre-2026-11-02T19-19-14-263Z.json"
```

2. [general-invoice-gl-dm_service_centre-2026-11-02T19-18-11-701Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-gl-dm_service_centre-2026-11-02T19-18-11-701Z.json)

```powershell
node scripts/general_invoice_route_b.js --schema dm_service_centre --action undo --backup "C:/Projects/Autoneer-Migrate/logs/general-invoice-gl-dm_service_centre-2026-11-02T19-18-11-701Z.json"
```

3. [general-invoice-lines-dm_service_centre-2026-11-02T19-17-31-387Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-dm_service_centre-2026-11-02T19-17-31-387Z.json)

```powershell
node scripts/backfill_general_invoice_lines.js --schema dm_service_centre --undo "C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-dm_service_centre-2026-11-02T19-17-31-387Z.json"
```

## Historical and scratch backup inventory

These files are retained audit history, **not additional rollback steps for dm_service_centre**. The scratch schema is gone. The two morning tenant backups predate its restore and must not be used on this tenant. The following commands document their original undo targets only.

- [general-invoice-clearing-glbf_test_general_invoices_20261102-2026-11-02T19-04-06-575Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-clearing-glbf_test_general_invoices_20261102-2026-11-02T19-04-06-575Z.json) — Already undone during rehearsal.

```powershell
node scripts/general_invoice_route_b.js --schema glbf_test_general_invoices_20261102 --action undo --backup "C:/Projects/Autoneer-Migrate/logs/general-invoice-clearing-glbf_test_general_invoices_20261102-2026-11-02T19-04-06-575Z.json"
```

- [general-invoice-clearing-glbf_test_general_invoices_20261102-2026-11-02T19-14-41-983Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-clearing-glbf_test_general_invoices_20261102-2026-11-02T19-14-41-983Z.json) — Final scratch cycle; schema subsequently dropped.

```powershell
node scripts/general_invoice_route_b.js --schema glbf_test_general_invoices_20261102 --action undo --backup "C:/Projects/Autoneer-Migrate/logs/general-invoice-clearing-glbf_test_general_invoices_20261102-2026-11-02T19-14-41-983Z.json"
```

- [general-invoice-gl-glbf_test_general_invoices_20261102-2026-11-02T19-03-08-625Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-gl-glbf_test_general_invoices_20261102-2026-11-02T19-03-08-625Z.json) — Already undone during rehearsal.

```powershell
node scripts/general_invoice_route_b.js --schema glbf_test_general_invoices_20261102 --action undo --backup "C:/Projects/Autoneer-Migrate/logs/general-invoice-gl-glbf_test_general_invoices_20261102-2026-11-02T19-03-08-625Z.json"
```

- [general-invoice-gl-glbf_test_general_invoices_20261102-2026-11-02T19-13-57-040Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-gl-glbf_test_general_invoices_20261102-2026-11-02T19-13-57-040Z.json) — Final scratch cycle; schema subsequently dropped.

```powershell
node scripts/general_invoice_route_b.js --schema glbf_test_general_invoices_20261102 --action undo --backup "C:/Projects/Autoneer-Migrate/logs/general-invoice-gl-glbf_test_general_invoices_20261102-2026-11-02T19-13-57-040Z.json"
```

- [general-invoice-lines-dm_service_centre-2026-11-02T08-00-25-554Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-dm_service_centre-2026-11-02T08-00-25-554Z.json) — Obsolete: predates restore.

```powershell
node scripts/backfill_general_invoice_lines.js --schema dm_service_centre --undo "C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-dm_service_centre-2026-11-02T08-00-25-554Z.json"
```

- [general-invoice-lines-dm_service_centre-2026-11-02T08-24-37-244Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-dm_service_centre-2026-11-02T08-24-37-244Z.json) — Obsolete: predates restore.

```powershell
node scripts/backfill_general_invoice_lines.js --schema dm_service_centre --undo "C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-dm_service_centre-2026-11-02T08-24-37-244Z.json"
```

- [general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T18-22-50-569Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T18-22-50-569Z.json) — Already undone during rehearsal.

```powershell
node scripts/backfill_general_invoice_lines.js --schema glbf_test_general_invoices_20261102 --undo "C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T18-22-50-569Z.json"
```

- [general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T18-31-21-848Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T18-31-21-848Z.json) — Already undone during rehearsal.

```powershell
node scripts/backfill_general_invoice_lines.js --schema glbf_test_general_invoices_20261102 --undo "C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T18-31-21-848Z.json"
```

- [general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T19-02-23-235Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T19-02-23-235Z.json) — Already undone during rehearsal.

```powershell
node scripts/backfill_general_invoice_lines.js --schema glbf_test_general_invoices_20261102 --undo "C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T19-02-23-235Z.json"
```

- [general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T19-13-14-686Z.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T19-13-14-686Z.json) — Final scratch cycle; schema subsequently dropped.

```powershell
node scripts/backfill_general_invoice_lines.js --schema glbf_test_general_invoices_20261102 --undo "C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-glbf_test_general_invoices_20261102-2026-11-02T19-13-14-686Z.json"
```

For any complete historical cycle, the required order remains clearing → GL → lines/statuses; these commands are not a request to recreate or undo the dropped scratch schema. The copy manifest [glbf_test_general_invoices_20261102-copy.json](C:/Projects/Autoneer-Migrate/logs/glbf_test_general_invoices_20261102-copy.json) is verification metadata, not a row backup.

## Remaining loose ends

- **17 DONE general invoices without source lines, R11,432.13**, left unposted: 10666, 11348, 11959, 11996, 12003, 12096, 13479, 14935, 15038, 15353, 16592, 17896, 18715, 19856, 21633, 24941, 25647. Invoice 24941 has a zero header.
- **Invoice 18321** is DELETED, header total R0.00, paid R86,250.00. Payment 29621 remains posted as journal 51381; no adjustment was made.
- **Invoice 15888 is absent**: legacy spares IDs 45007 and 45008 remain excluded.
- **19 repaired invoices have line/header ex-VAT differences of at least R1**. Display retains legacy lines; journals reconcile to header totals. Details: [general-invoice-lines-scratch-reference.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-lines-scratch-reference.json).
- Existing replay differences remain unchanged: 270 field differences on 210 positive-job rows, none overlapping repaired job-0 lines. Evidence covers 250 VAT normalization fields, four saved LABOURLOST account fixes and 16 post-import changes. Exact list: [general-invoice-replay-audit.json](C:/Projects/Autoneer-Migrate/logs/general-invoice-replay-audit.json).
- Customer **1332** has cached balance **R0.00**, calculated balance **R118.85**. Cache was preserved; DONE→POSTED does not change the balance calculator’s inclusion rule.
- The accepted 19 pre-existing test failures remain. The PWA ex-VAT stock-take patch noted in opening-stock-migration.md remains outside this repair.
