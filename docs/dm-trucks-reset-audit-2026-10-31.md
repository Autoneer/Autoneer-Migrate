# DM Trucks reset audit — 31 October 2026

**Verdict: not yet an empty, clean target for a full legacy re-import.**

Read-only inspection of local localhost:3306/dm_trucks on 31 October 2026 at 08:13 SAST. All 359 base tables were counted using a consistent, read-only transaction. No database rows, schema, settings, or source Firebird data were changed. No migration or application runner was started. Counts establish current emptiness; they do not establish whether an empty table was cleared using TRUNCATE or DELETE.

## Verified empty

- 319 of 359 tables contain zero rows.
- Customers, suppliers, stock, jobs, job reports, customer/supplier invoices, invoice items, work done, spares used, payments and credit notes are empty.
- GL journal headers/lines and the stock movement ledger are empty.
- migration_id_map, both migration-run tables, table-run records, run mappings and migration error records are empty. Saved plans and mapping profiles remain.
- 248 of the 249 present tables classified CLEAR by the current Fresh Start registry are empty.

## Remaining issues

1. **customer_document_print_snapshots: 16 rows.** These comprise 11 job-quote snapshots and 5 job-invoice snapshots, issued 9–14 October. All 16 currently have no matching customer; jobs and invoices are also empty. The application reads these snapshots by document type, number and variant. Re-importing the same numbers can associate retained issued evidence with new/imported records or trigger identity checks. Resolve this retained evidence before reusing the tenant for a clean import.
2. **accounts.startbalance: 27 nonzero opening balances.** There are 133 account definitions. All eight other checked running/comparative fields are zero and none of the nine fields contain NULL. Opening balances still survive despite empty journals; they need an explicit preserve/replace decision.
3. **Eight targets in saved plan 18 (FULL DB 06/10/2026) are populated.** All are configured INSERT, preserved IDs, duplicate policy SKIP, and cleanBefore: false. Matching source keys can be skipped rather than refreshing retained data.

| Target table | Existing rows |
| --- | ---: |
| banks | 2 |
| staff | 19 |
| accounts | 133 |
| location | 27 |
| acc_class | 7 |
| wip_status | 33 |
| acc_department | 20 |
| labour_pricing | 7 764 |

4. **The saved FULL DB plan does not include job_information.** It contains 21 targets, of which 13 are empty. Jobs are in separate plan 19. Ensure the actual next migration includes jobs in the required dependency order; the saved plan alone is not a full workshop migration.

Staff needs special treatment: the current migration runner removes non-SUPER USER staff on a new live run and preserves SUPER USER rows. The tenant currently has 17 non-SUPER USER rows and 2 SUPER USER rows. Do not infer that blanket staff truncation is required.

## Why a reset can leave these rows

- The manual tenant-data reset explicitly protects issued print snapshots and the retained configuration/master tables above (C:/Projects/autoneer-pwa/src/services/tenantDataReset.service.js). Its running-total reset omits accounts.startbalance.
- The separate Fresh Start registry classifies print snapshots as CLEAR and includes opening balances among account reset fields (C:/Projects/autoneer-pwa/src/services/tenantReset/freshStartRegistry.js, version 2026-10-30.1).
- These are different reset paths. This audit did not read the central reset audit history, so it does not assert which mode was executed.
- Nine present tables are not in the current Fresh Start registry. All nine are empty, so they contain no residual data; the registry mismatch would nevertheless need attention before using the Fresh Start engine again.

## Next migration preparation

Resolve the retained snapshots and opening balances, choose whether to preserve or refresh the populated import targets, and ensure the selected plan includes jobs. Keep company/access configuration, schema-migration ledgers and saved mapping definitions as appropriate. No cleanup or import has been executed by this audit.

The source Firebird database and source-to-target key overlaps were not inspected. This is a target reset audit, not an end-to-end migration validation.

## Complete table inventory

Classification is from the current Fresh Start registry, not a claim that the user selected that reset mode.

| Table | Rows | Classification |
| --- | ---: | --- |
| acc_class | 7 | KEEP |
| acc_department | 20 | KEEP |
| acc_range | 0 | KEEP |
| account_links | 0 | KEEP |
| accounts | 133 | KEEP_RESET |
| adjust_stock | 0 | CLEAR |
| ai_diagnostic_sessions | 0 | CLEAR |
| ai_knowledge_chunks | 0 | KEEP |
| ai_knowledge_sources | 0 | KEEP |
| bank_opening_balances | 0 | CLEAR |
| bank_recon | 0 | CLEAR |
| bank_recon_customer_allocations | 0 | CLEAR |
| bank_recon_matches | 0 | CLEAR |
| bank_statement_imports | 0 | CLEAR |
| bank_statements | 0 | CLEAR |
| banks | 2 | KEEP |
| book_logon_detail | 0 | KEEP |
| book_sync | 0 | CLEAR |
| booking_calendar_audit_log | 0 | KEEP |
| booking_calendar_closures | 0 | KEEP |
| booking_calendar_days | 7 | KEEP |
| booking_calendar_settings | 1 | KEEP |
| booking_reminder_log | 0 | CLEAR |
| booking_reminder_runs | 0 | CLEAR |
| booking_reminder_settings | 1 | KEEP |
| bookings | 0 | CLEAR |
| cash_customer | 0 | CLEAR |
| categories | 0 | KEEP |
| company | 1 | KEEP |
| company_prefferences | 1 | KEEP |
| credit_notes | 0 | CLEAR |
| credit_notes_supplier | 0 | CLEAR |
| creditors | 0 | CLEAR |
| crm_activity_timeline | 0 | CLEAR |
| crm_followups | 0 | CLEAR |
| crm_interactions | 0 | CLEAR |
| crm_opportunities | 0 | CLEAR |
| crm_service_reminders | 0 | CLEAR |
| customer_credit_allocations | 0 | CLEAR |
| customer_credit_scope_releases | 0 | CLEAR |
| customer_credits | 0 | CLEAR |
| customer_display_devices | 0 | KEEP |
| customer_document_links | 0 | CLEAR |
| customer_document_print_snapshots | 16 | CLEAR |
| customer_invoice_lines | 0 | CLEAR |
| customer_notes | 0 | CLEAR |
| customer_payment_batch_allocations | 0 | CLEAR |
| customer_payment_batch_audit | 0 | CLEAR |
| customer_payment_batches | 0 | CLEAR |
| customer_portal_access_links | 0 | CLEAR |
| customer_portal_inbound_events | 0 | CLEAR |
| customer_portal_legal_content | 0 | KEEP |
| customer_portal_outbox | 0 | CLEAR |
| customer_portal_outbox_attempts | 0 | CLEAR |
| customer_portal_settings | 22 | KEEP |
| customer_refund_credit_allocations | 0 | CLEAR |
| customer_refund_lines | 0 | CLEAR |
| customer_refunds | 0 | CLEAR |
| customer_request_messages | 0 | CLEAR |
| customer_requests | 0 | CLEAR |
| customers | 0 | KEEP_RESET |
| dealer_accounting_postings | 0 | CLEAR |
| dealer_audit_log | 0 | CLEAR |
| dealer_deal_corrections | 0 | CLEAR |
| dealer_deal_payments | 0 | CLEAR |
| dealer_delivery_checklist_items | 0 | CLEAR |
| dealer_delivery_checklists | 0 | CLEAR |
| dealer_finance_applications | 0 | CLEAR |
| dealer_finance_providers | 0 | KEEP |
| dealer_floorplan_accounts | 0 | CLEAR |
| dealer_floorplan_interest | 0 | CLEAR |
| dealer_floorplan_providers | 0 | KEEP |
| dealer_fni_commissions | 0 | CLEAR |
| dealer_fni_items | 0 | CLEAR |
| dealer_insurance_products | 0 | KEEP |
| dealer_reconditioning_jobs | 0 | CLEAR |
| dealer_sales_activities | 0 | CLEAR |
| dealer_sales_commissions | 0 | CLEAR |
| dealer_sales_leads | 0 | CLEAR |
| dealer_service_plans | 0 | KEEP |
| dealer_tradein_appraisals | 0 | CLEAR |
| dealer_tradein_photos | 0 | CLEAR |
| dealer_vehicle_costs | 0 | CLEAR |
| dealer_vehicle_deal_items | 0 | CLEAR |
| dealer_vehicle_deals | 0 | CLEAR |
| dealer_vehicle_documents | 0 | CLEAR |
| dealer_vehicle_images | 0 | CLEAR |
| dealer_vehicle_quote_items | 0 | CLEAR |
| dealer_vehicle_quotes | 0 | CLEAR |
| dealer_vehicle_reservations | 0 | CLEAR |
| dealer_vehicle_stock | 0 | CLEAR |
| dealer_warranty_products | 0 | KEEP |
| debtor_groups | 0 | KEEP |
| debtors | 0 | CLEAR |
| equipment_checkin | 7 | KEEP |
| fin_cat | 0 | KEEP |
| free_quotes | 0 | CLEAR |
| full_upgrade_setup_state | 0 | KEEP |
| general_links | 0 | KEEP |
| generic_warranty_claim_pack_artifact | 0 | CLEAR |
| generic_warranty_claim_pack_share | 0 | CLEAR |
| generic_warranty_claim_pack_staged_object | 0 | CLEAR |
| gl_account_types | 6 | KEEP |
| gl_accounts | 124 | KEEP |
| gl_backfill_run_items | 0 | CLEAR |
| gl_backfill_runs | 0 | CLEAR |
| gl_control_accounts | 31 | KEEP |
| gl_journal_headers | 0 | CLEAR |
| gl_journal_lines | 0 | CLEAR |
| gl_periods | 12 | KEEP |
| inspection | 0 | CLEAR |
| invoice_adjustments | 0 | CLEAR |
| invoice_general | 0 | CLEAR |
| invoice_items | 0 | CLEAR |
| invoice_split_groups | 0 | CLEAR |
| invoice_split_lines | 0 | CLEAR |
| invoices | 0 | CLEAR |
| invoices_supplier | 0 | CLEAR |
| job_ai_repair_time | 0 | CLEAR |
| job_ai_suggested_parts | 0 | CLEAR |
| job_ai_suggested_parts_actions | 0 | CLEAR |
| job_audit_log | 0 | CLEAR |
| job_checkin | 0 | CLEAR |
| job_checkin_photo_draft | 0 | CLEAR |
| job_checklist | 0 | CLEAR |
| job_document | 0 | CLEAR |
| job_edit_sessions | 0 | CLEAR |
| job_information | 0 | CLEAR |
| job_messages | 0 | CLEAR |
| job_parts_request | 0 | CLEAR |
| job_parts_request_supplier_attempts | 0 | CLEAR |
| job_quality_control | 0 | CLEAR |
| job_quote_evidence | 0 | CLEAR |
| job_report | 0 | CLEAR |
| job_report_templates | 0 | KEEP |
| job_service_checklist_items | 0 | CLEAR |
| job_service_checklists | 0 | CLEAR |
| job_workflow_milestone | 0 | CLEAR |
| journal | 0 | CLEAR |
| journal_entry | 0 | CLEAR |
| journal_temp | 0 | CLEAR |
| labour_links | 0 | KEEP |
| labour_pricing | 7764 | KEEP |
| ledger | 0 | CLEAR |
| license_disc | 0 | KEEP |
| link_accounts | 0 | KEEP |
| location | 27 | KEEP |
| loyalty_accounts | 0 | KEEP_RESET |
| loyalty_redemptions | 0 | CLEAR |
| loyalty_settings | 0 | KEEP |
| loyalty_transactions | 0 | CLEAR |
| makes | 531 | KEEP |
| manual_journal_headers | 0 | CLEAR |
| manual_journal_lines | 0 | CLEAR |
| marketing_campaign_recipients | 0 | CLEAR |
| marketing_campaign_runs | 0 | CLEAR |
| marketing_campaign_segments | 0 | CLEAR |
| marketing_campaigns | 0 | CLEAR |
| marketing_contact_preferences | 0 | KEEP |
| marketing_opt_out_events | 0 | CLEAR |
| markup | 0 | KEEP |
| message_log | 0 | CLEAR |
| message_status_webhook_log | 0 | CLEAR |
| message_templates | 16 | KEEP |
| messages | 3 | KEEP |
| migration_baseline | 0 | KEEP |
| migration_id_map | 0 | KEEP |
| migration_mapping_profiles | 4 | KEEP |
| migration_plans | 4 | KEEP |
| migration_presets | 3 | KEEP |
| migration_profiles | 3 | KEEP |
| migration_row_errors | 0 | KEEP |
| migration_run_errors | 0 | KEEP |
| migration_run_mappings | 0 | KEEP |
| migration_runs | 0 | KEEP |
| migration_runs_legacy | 0 | KEEP |
| migration_table_runs | 0 | KEEP |
| migrations | 60 | KEEP |
| onboarding_state | 1 | KEEP |
| online_payment_transactions | 0 | CLEAR |
| orders | 0 | CLEAR |
| payments | 0 | CLEAR |
| payments_suppliers | 0 | CLEAR |
| paymethods | 5 | KEEP |
| payroll_cycle_settings | 0 | KEEP |
| payroll_cycle_settings_details | 0 | KEEP |
| payroll_employee_profile_details | 0 | KEEP |
| payroll_employee_recurring_items | 0 | KEEP |
| payroll_employees | 0 | KEEP |
| payroll_events | 0 | CLEAR |
| payroll_leave_balances | 0 | CLEAR |
| payroll_leave_categories | 0 | KEEP |
| payroll_leave_entries | 0 | CLEAR |
| payroll_leave_legacy_imports | 0 | CLEAR |
| payroll_payslip_artifacts | 0 | CLEAR |
| payroll_payslip_documents | 0 | CLEAR |
| payroll_payslip_lines | 0 | CLEAR |
| payroll_payslip_links | 0 | CLEAR |
| payroll_payslip_pdf_content | 0 | CLEAR |
| payroll_payslips | 0 | CLEAR |
| payroll_replacement_attempts | 0 | CLEAR |
| payroll_run_details | 0 | CLEAR |
| payroll_runs | 0 | CLEAR |
| payroll_salary_payments | 0 | UNCLASSIFIED |
| payroll_settings | 0 | KEEP |
| payroll_staff_loan_details | 0 | CLEAR |
| payroll_staff_loan_transaction_details | 0 | CLEAR |
| payroll_staff_loan_transactions | 0 | CLEAR |
| payroll_staff_loans | 0 | CLEAR |
| pb_account_clearance_events | 0 | CLEAR |
| pb_customer_evidence_decisions | 0 | CLEAR |
| pb_customer_evidence_photos | 0 | CLEAR |
| pb_customer_evidence_publications | 0 | CLEAR |
| pb_customer_progress_events | 0 | CLEAR |
| pb_financial_operations | 0 | CLEAR |
| pb_insurance_assessment_evidence | 0 | CLEAR |
| pb_insurance_assessments | 0 | CLEAR |
| pb_insurance_authorisation_evidence | 0 | CLEAR |
| pb_insurance_authorisation_lines | 0 | CLEAR |
| pb_insurance_authorisation_scopes | 0 | CLEAR |
| pb_insurance_authorisations | 0 | CLEAR |
| pb_insurance_billing_evidence | 0 | CLEAR |
| pb_insurance_billing_lines | 0 | CLEAR |
| pb_insurance_billing_plans | 0 | CLEAR |
| pb_insurance_billing_seals | 0 | CLEAR |
| pb_insurance_claim_pack_events | 0 | UNCLASSIFIED |
| pb_insurance_claim_pack_items | 0 | UNCLASSIFIED |
| pb_insurance_claim_pack_shares | 0 | UNCLASSIFIED |
| pb_insurance_claim_packs | 0 | UNCLASSIFIED |
| pb_insurance_claims | 0 | CLEAR |
| pb_insurance_customer_acceptance_refs | 0 | UNCLASSIFIED |
| pb_insurance_events | 0 | CLEAR |
| pb_insurance_evidence | 0 | CLEAR |
| pb_insurance_handover_invoices | 0 | CLEAR |
| pb_insurance_handover_sets | 0 | CLEAR |
| pb_insurance_handovers | 0 | CLEAR |
| pb_insurance_invoice_issues | 0 | CLEAR |
| pb_insurance_invoice_members | 0 | CLEAR |
| pb_insurance_invoice_sets | 0 | CLEAR |
| pb_insurance_issued_invoices | 0 | CLEAR |
| pb_insurance_receipts | 0 | CLEAR |
| pb_insurance_remittances | 0 | CLEAR |
| pb_insurance_supplement_evidence | 0 | CLEAR |
| pb_insurance_supplement_job_lines | 0 | CLEAR |
| pb_insurance_supplement_sections | 0 | CLEAR |
| pb_insurance_supplement_submissions | 0 | CLEAR |
| pb_insurance_supplements | 0 | CLEAR |
| pb_insurers | 0 | KEEP |
| pb_job_production | 0 | CLEAR |
| pb_job_station_movements | 0 | CLEAR |
| pb_job_variation_lines | 0 | UNCLASSIFIED |
| pb_job_variations | 0 | UNCLASSIFIED |
| pb_production_stations | 7 | KEEP |
| pb_production_update_photos | 0 | CLEAR |
| pb_production_updates | 0 | CLEAR |
| pb_quote_assessments | 0 | CLEAR |
| pb_quote_bookings | 0 | CLEAR |
| pb_quote_job_lines | 0 | CLEAR |
| pb_quote_jobs | 0 | CLEAR |
| pb_quote_photos | 0 | CLEAR |
| pb_quote_revision_photos | 0 | CLEAR |
| pb_quote_sections | 0 | CLEAR |
| pb_quote_staff_acceptances | 0 | CLEAR |
| pb_vehicle_handovers | 0 | CLEAR |
| phonebook | 0 | KEEP |
| print_options | 2 | KEEP |
| purchases | 0 | CLEAR |
| push_subscriptions | 0 | KEEP |
| quick_quote_conversions | 0 | CLEAR |
| quick_quote_decision_attestations | 0 | UNCLASSIFIED |
| quick_quote_decisions | 0 | CLEAR |
| quick_quote_deliveries | 0 | CLEAR |
| quick_quote_events | 0 | CLEAR |
| quick_quote_items | 0 | CLEAR |
| quick_quote_links | 0 | CLEAR |
| quick_quote_original_pdfs | 0 | CLEAR |
| quick_quote_revision_items | 0 | CLEAR |
| quick_quote_revisions | 0 | CLEAR |
| quick_quote_sequence | 1 | KEEP |
| quick_quotes | 0 | CLEAR |
| quote_authorization_line_decisions | 0 | CLEAR |
| quote_authorization_snapshots | 0 | CLEAR |
| remove_stock | 0 | CLEAR |
| sales | 0 | CLEAR |
| service_types | 16 | KEEP |
| sessions | 0 | CLEAR |
| set_type | 0 | KEEP |
| spares_used | 0 | CLEAR |
| staff | 19 | KEEP |
| staff_targets | 0 | KEEP |
| stock | 0 | KEEP_RESET |
| stock_category | 4 | KEEP |
| stock_ledger_control | 0 | KEEP |
| stock_links | 0 | KEEP |
| stock_listed_units | 0 | CLEAR |
| stock_movement_ledger | 0 | CLEAR |
| stock_part_number_locks | 0 | KEEP |
| stock_rebuild_jobs | 0 | CLEAR |
| stock_take | 0 | CLEAR |
| stock_take_rebuild_adjustments | 0 | CLEAR |
| stock_take_rebuild_units | 0 | CLEAR |
| stock_takes | 0 | CLEAR |
| supplier_credit_note_lines | 0 | CLEAR |
| supplier_notes | 0 | CLEAR |
| supplier_order_audit_log | 0 | CLEAR |
| supplier_order_inbound_events | 0 | CLEAR |
| supplier_order_integrations | 0 | CLEAR |
| supplier_order_line_integrations | 0 | CLEAR |
| supplier_order_outbox | 0 | CLEAR |
| supplier_order_outbox_attempts | 0 | CLEAR |
| supplier_order_settings | 6 | KEEP |
| supplier_payment_batch_allocations | 0 | CLEAR |
| supplier_payment_batches | 0 | CLEAR |
| supplier_rfc_headers | 0 | CLEAR |
| supplier_rfc_lines | 0 | CLEAR |
| suppliers | 0 | KEEP_RESET |
| tax_codes | 4 | KEEP |
| temp_age | 0 | CLEAR |
| test_drive_authorizations | 0 | CLEAR |
| tool_audit_log | 0 | CLEAR |
| tool_bookings | 0 | CLEAR |
| tool_categories | 0 | KEEP |
| tool_maintenance | 0 | CLEAR |
| tool_photos | 0 | KEEP |
| tool_reservations | 0 | CLEAR |
| tools | 0 | KEEP_RESET |
| user_groups | 0 | KEEP |
| vat_links | 0 | KEEP |
| vat_migration_audit | 0 | KEEP |
| vehicle_checkin | 5 | KEEP |
| vehicle_qr_labels | 0 | CLEAR |
| warranty_claim | 0 | CLEAR |
| warranty_claim_assessment | 0 | CLEAR |
| warranty_claim_custom_field_value | 0 | CLEAR |
| warranty_claim_decision | 0 | CLEAR |
| warranty_claim_disassembly_auth | 0 | CLEAR |
| warranty_claim_document | 0 | CLEAR |
| warranty_claim_event | 0 | CLEAR |
| warranty_claim_outbox | 0 | CLEAR |
| warranty_claim_phase7_state | 0 | CLEAR |
| warranty_claim_photo | 0 | CLEAR |
| warranty_claim_service_history | 0 | CLEAR |
| warranty_claim_settlement_report | 0 | CLEAR |
| warranty_claim_split_link | 0 | CLEAR |
| warranty_claim_submission | 0 | CLEAR |
| warranty_claim_submission_artifact | 0 | CLEAR |
| warranty_claim_submission_staged_object | 0 | CLEAR |
| warranty_claim_supplement | 0 | CLEAR |
| warranty_excess_authorizations | 0 | CLEAR |
| warranty_job_split_draft_lines | 0 | CLEAR |
| wip_status | 33 | KEEP |
| work_done | 0 | CLEAR |
| work_time | 1 | KEEP |
| work_timer | 0 | CLEAR |
| work_todo | 0 | CLEAR |
| workshop_ai_settings | 1 | KEEP |
| workshop_display_devices | 0 | KEEP |
| workshop_supplier_order_credentials | 0 | KEEP |
| xero_settings | 0 | KEEP |
