# DM Trucks invoice conflicts — run 10

Read-only diagnosis on 6 October 2026. No database rows or schema were changed.

All 32 invoice errors have the same cause: an older target invoice with status `REDO` still occupies `uq_invoices_active_job` for a real job. The rejected invoice has a different original invoice number.

The generated key tests split/void/credit criteria and excludes job zero, but it does not test invoice status. Every blocking REDO row has `is_split_invoice = 0`, `voided_at = NULL`, and `credit_for_invoice_nr = NULL`, so it is counted as active.

Source preflight currently deletes invoices with status REDO. These 32 target blockers no longer exist in the source. Each affected source job has exactly one remaining invoice, and every job's `INVNR` references the rejected replacement invoice. All rejected invoices have no positive legacy SPLITNR; this is not a missing split flag. The rejected and blocking invoices share the same customer in every case. 29 blocking invoices have paid amount zero. 3 REDO blockers have nonzero paid amounts, so retaining their audit/payment history matters. 30 rejected invoices are marked PAID in the source.

The existing-record skip correctly does not skip these invoices: the rejected invoice numbers have not been imported. Doing so would lose the valid replacement headers.

To resolve these conflicts while retaining the old headers, the application-owned active-job key needs to exclude REDO status in addition to its existing rules. A condition such as `COALESCE(status, '') <> 'REDO'` must be applied so NULL statuses continue to retain their existing behavior. Keep the unique rule for ordinary active real-job invoices and preserve invoice numbers/job links. Review application status handling alongside that schema change. Merely setting a historical flag will not help because the current key ignores it.

No blanket historical classification, invented void date, split flag, duplicate skip, or target deletion was performed.

| Job | Target REDO blocker | Rejected replacement | Source job INVNR | Replacement paystatus |
| --- | --- | --- | --- | --- |
| 9199 | 11043 | 11082 | 11082 | PAID |
| 7839 | 9703 | 9705 | 9705 | UNPAID |
| 9027 | 10832 | 10833 | 10833 | PAID |
| 11242 | 13030 | 13031 | 13031 | PAID |
| 11325 | 13266 | 13351 | 13351 | PAID |
| 12496 | 14288 | 14295 | 14295 | PAID |
| 11261 | 13385 | 13386 | 13386 | PAID |
| 10526 | 12394 | 12397 | 12397 | PAID |
| 11663 | 13484 | 13494 | 13494 | PAID |
| 8480 | 10287 | 10288 | 10288 | PAID |
| 12218 | 14112 | 14125 | 14125 | PAID |
| 9257 | 11047 | 11048 | 11048 | PAID |
| 12636 | 14410 | 14426 | 14426 | PAID |
| 8290 | 10119 | 10123 | 10123 | PAID |
| 10397 | 12210 | 12212 | 12212 | PAID |
| 9631 | 11427 | 11428 | 11428 | PAID |
| 9073 | 10857 | 10858 | 10858 | PAID |
| 8298 | 10131 | 10132 | 10132 | PAID |
| 7861 | 9715 | 9717 | 9717 | PAID |
| 10471 | 12291 | 12293 | 12293 | PAID |
| 9451 | 11267 | 11275 | 11275 | PAID |
| 10878 | 12855 | 12856 | 12856 | UNPAID |
| 12970 | 14773 | 14782 | 14782 | PAID |
| 8932 | 10755 | 10775 | 10775 | PAID |
| 11167 | 13140 | 13141 | 13141 | PAID |
| 10326 | 12197 | 12232 | 12232 | PAID |
| 8137 | 10064 | 10085 | 10085 | PAID |
| 8200 | 10028 | 10029 | 10029 | PAID |
| 10590 | 12433 | 12434 | 12434 | PAID |
| 10802 | 12684 | 12745 | 12745 | PAID |
| 9321 | 11134 | 11135 | 11135 | PAID |
| 11265 | 13065 | 13067 | 13067 | PAID |

Evidence: [JSON details](dm-trucks-invoice-conflicts-run-10.json), Firebird INVOICES/JOB_INFORMATION, dm_trucks.invoices/migration_row_errors, and the live generated-column definition.
