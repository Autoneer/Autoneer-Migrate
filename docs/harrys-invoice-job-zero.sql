-- Proposed target-schema repair for harrys; not an invoice data migration.
-- The source has no job_information row numbered 0. Preserve invoice.job_number
-- as recorded and exclude only that no-job sentinel from the active-job key.
-- Keeps the unique index and existing split/void/credit rules. Historical and
-- active classifications are unchanged. This resolves the 358 job-zero errors;
-- it does not resolve the two remaining non-split real-job conflicts.
ALTER TABLE `harrys`.`invoices`
  MODIFY COLUMN `job_number_active` INT GENERATED ALWAYS AS (
    CASE WHEN `job_number` <> 0
      AND COALESCE(`is_split_invoice`, 0) = 0
      AND `voided_at` IS NULL
      AND `credit_for_invoice_nr` IS NULL
    THEN `job_number` ELSE NULL END
  ) STORED;
