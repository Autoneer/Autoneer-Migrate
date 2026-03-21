-- ============================================================================
-- sp_convert_transactional_accnr
-- ============================================================================
-- Converts legacy Firebird accnr values in all transactional tables to the
-- new 4-digit accnr values used in gl_accounts after the Rebuild GL process.
--
-- The conversion formula (matches sp_rebuild_gl_accounts exactly):
--   Group accounts (acctype = 'group account', accclass <> 7):
--     accnr 1601200 → 6200
--     accnr 1601300 → 6301
--     accnr 6606300 → 6302
--     all others    → MOD(accnr, 10000)
--   Non-group accounts: unchanged
--
-- Tables and fields converted:
--   customers          : acc
--   suppliers          : acc
--   invoices           : acc
--   invoices_supplier  : acc
--   stock              : siid, acc, accasset
--   spares_used        : siid, acc, accasset
--   work_done          : siid, acc
--   payments           : acc
--   payments_suppliers : accnr, acc
--   invoice_items      : siid, acc
--   labour_pricing     : siid, acc
--
-- Prerequisites:
--   • accounts table must be migrated (staging, with original Firebird accnr values)
--   • gl_accounts must be populated (run Rebuild GL Accounts first)
--
-- Idempotent: running again is safe — values already converted will resolve
-- to themselves via the accounts JOIN (no match → unchanged).
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS sp_convert_transactional_accnr $$

CREATE PROCEDURE sp_convert_transactional_accnr()
BEGIN

  -- ─────────────────────────────────────────────────────────────────────────
  -- Reusable conversion expression (documented here for reference).
  -- For each UPDATE below, t = the transactional table, a = accounts lookup.
  -- The LEFT JOIN is on a.accnr = t.<field>.
  -- Conversion:
  --   CASE
  --     WHEN a.accnr IS NOT NULL
  --          AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
  --          AND a.accclass IS NOT NULL
  --          AND a.accclass <> 7
  --     THEN CASE
  --            WHEN t.<field> = 1601200 THEN 6200
  --            WHEN t.<field> = 1601300 THEN 6301
  --            WHEN t.<field> = 6606300 THEN 6302
  --            ELSE MOD(t.<field>, 10000)
  --          END
  --     ELSE t.<field>
  --   END
  -- ─────────────────────────────────────────────────────────────────────────

  -- ── customers.acc ────────────────────────────────────────────────────────
  UPDATE customers t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── suppliers.acc ────────────────────────────────────────────────────────
  UPDATE suppliers t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── invoices.acc ─────────────────────────────────────────────────────────
  UPDATE invoices t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── invoices_supplier.acc ────────────────────────────────────────────────
  UPDATE invoices_supplier t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── stock.siid ───────────────────────────────────────────────────────────
  UPDATE stock t
    LEFT JOIN accounts a ON a.accnr = t.siid
  SET t.siid = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.siid = 1601200 THEN 6200
           WHEN t.siid = 1601300 THEN 6301
           WHEN t.siid = 6606300 THEN 6302
           ELSE MOD(t.siid, 10000)
         END
    ELSE t.siid
  END
  WHERE t.siid IS NOT NULL;

  -- ── stock.acc ────────────────────────────────────────────────────────────
  UPDATE stock t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── stock.accasset ───────────────────────────────────────────────────────
  UPDATE stock t
    LEFT JOIN accounts a ON a.accnr = t.accasset
  SET t.accasset = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.accasset = 1601200 THEN 6200
           WHEN t.accasset = 1601300 THEN 6301
           WHEN t.accasset = 6606300 THEN 6302
           ELSE MOD(t.accasset, 10000)
         END
    ELSE t.accasset
  END
  WHERE t.accasset IS NOT NULL;

  -- ── spares_used.siid ─────────────────────────────────────────────────────
  UPDATE spares_used t
    LEFT JOIN accounts a ON a.accnr = t.siid
  SET t.siid = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.siid = 1601200 THEN 6200
           WHEN t.siid = 1601300 THEN 6301
           WHEN t.siid = 6606300 THEN 6302
           ELSE MOD(t.siid, 10000)
         END
    ELSE t.siid
  END
  WHERE t.siid IS NOT NULL;

  -- ── spares_used.acc ──────────────────────────────────────────────────────
  UPDATE spares_used t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── spares_used.accasset ─────────────────────────────────────────────────
  UPDATE spares_used t
    LEFT JOIN accounts a ON a.accnr = t.accasset
  SET t.accasset = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.accasset = 1601200 THEN 6200
           WHEN t.accasset = 1601300 THEN 6301
           WHEN t.accasset = 6606300 THEN 6302
           ELSE MOD(t.accasset, 10000)
         END
    ELSE t.accasset
  END
  WHERE t.accasset IS NOT NULL;

  -- ── work_done.siid ───────────────────────────────────────────────────────
  UPDATE work_done t
    LEFT JOIN accounts a ON a.accnr = t.siid
  SET t.siid = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.siid = 1601200 THEN 6200
           WHEN t.siid = 1601300 THEN 6301
           WHEN t.siid = 6606300 THEN 6302
           ELSE MOD(t.siid, 10000)
         END
    ELSE t.siid
  END
  WHERE t.siid IS NOT NULL;

  -- ── work_done.acc ────────────────────────────────────────────────────────
  UPDATE work_done t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── payments.acc ─────────────────────────────────────────────────────────
  UPDATE payments t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── payments_suppliers.accnr ─────────────────────────────────────────────
  UPDATE payments_suppliers t
    LEFT JOIN accounts a ON a.accnr = t.accnr
  SET t.accnr = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.accnr = 1601200 THEN 6200
           WHEN t.accnr = 1601300 THEN 6301
           WHEN t.accnr = 6606300 THEN 6302
           ELSE MOD(t.accnr, 10000)
         END
    ELSE t.accnr
  END
  WHERE t.accnr IS NOT NULL;

  -- ── payments_suppliers.acc ───────────────────────────────────────────────
  UPDATE payments_suppliers t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── invoice_items.siid ────────────────────────────────────────────────────
  UPDATE invoice_items t
    LEFT JOIN accounts a ON a.accnr = t.siid
  SET t.siid = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.siid = 1601200 THEN 6200
           WHEN t.siid = 1601300 THEN 6301
           WHEN t.siid = 6606300 THEN 6302
           ELSE MOD(t.siid, 10000)
         END
    ELSE t.siid
  END
  WHERE t.siid IS NOT NULL;

  -- ── invoice_items.acc ─────────────────────────────────────────────────────
  UPDATE invoice_items t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── labour_pricing.siid ──────────────────────────────────────────────────
  UPDATE labour_pricing t
    LEFT JOIN accounts a ON a.accnr = t.siid
  SET t.siid = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.siid = 1601200 THEN 6200
           WHEN t.siid = 1601300 THEN 6301
           WHEN t.siid = 6606300 THEN 6302
           ELSE MOD(t.siid, 10000)
         END
    ELSE t.siid
  END
  WHERE t.siid IS NOT NULL;

  -- ── labour_pricing.acc ───────────────────────────────────────────────────
  UPDATE labour_pricing t
    LEFT JOIN accounts a ON a.accnr = t.acc
  SET t.acc = CASE
    WHEN a.accnr IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.acctype, ''))) = 'group account'
         AND a.accclass IS NOT NULL AND a.accclass <> 7
    THEN CASE
           WHEN t.acc = 1601200 THEN 6200
           WHEN t.acc = 1601300 THEN 6301
           WHEN t.acc = 6606300 THEN 6302
           ELSE MOD(t.acc, 10000)
         END
    ELSE t.acc
  END
  WHERE t.acc IS NOT NULL;

  -- ── Summary report ───────────────────────────────────────────────────────
  SELECT 'OK' AS status, 'Transactional accnr conversion complete' AS message;

END $$

DELIMITER ;
