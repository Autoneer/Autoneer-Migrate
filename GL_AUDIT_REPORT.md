# GL Account-Type Migration Audit Report

**Date:** 2025-01-XX  
**Scope:** End-to-end audit of Autoneer-Migrate GL classification pipeline  
**Branch:** `fix/wizard-run-stability`

---

## Executive Summary

The audit identified **four critical gaps** in the GL migration pipeline. All four have been resolved with deterministic, version-controlled, GAAP-auditable code:

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | `sp_rebuild_gl_accounts` not in source control | **CRITICAL** | Version-controlled in `data/sql/sp_rebuild_gl_accounts.sql` |
| 2 | `gl_account_types` has no seeding mechanism | **CRITICAL** | `glAccountTypes.seedAccountTypes()` idempotent seed |
| 3 | No post-migration GL validation | **HIGH** | 6 automated checks in `glValidation.js` + 4 GAAP checks in `glReconciliation.js` |
| 4 | Journal backfill process opaque | **HIGH** | Documented in `data/sql/sp_backfill_gl_journals.sql` |

---

## 1. Discovery: Migration Flow

```
Firebird ACCOUNTS → MySQL accounts (staging)
                         ↓
          sp_rebuild_gl_accounts(truncateJournals)
                         ↓
                ┌────────┴────────┐
          gl_account_types    gl_accounts
          (6 canonical rows)  (via MOD + CASE)
                         ↓
          sp_backfill_gl_journals
                         ↓
          gl_journal_headers + gl_journal_lines
```

**Key derivation logic:**
- Group Accounts: `accnr = MOD(staging.accnr, 10000)`, `type_id = CASE accclass WHEN 1 THEN 1 ... END`
- Detail Accounts: `accnr = staging.accnr`, same CASE type_id derivation
- Unmappable accounts (accclass NOT IN 1-6): logged, excluded

---

## 2. Authoritative ACCCLASS → gl_account_types Mapping

| Firebird ACCCLASS | gl_account_types.id | name | statement_section | statement_group |
|-------------------|---------------------|------|-------------------|-----------------|
| 1 | 1 | INCOME | IS | Revenue |
| 2 | 2 | EXPENSE | IS | Operating Expenses |
| 3 | 3 | ASSET | BS | Assets |
| 4 | 4 | EQUITY | BS | Equity |
| 5 | 5 | LIABILITY | BS | Liabilities |
| 6 | 6 | COS | IS | Cost of Sales |

**Source of truth:** `src/migrate/gl/glAccountTypes.js` → `GL_ACCOUNT_TYPES` (frozen array)

This mapping is:
- **Deterministic:** Each ACCCLASS maps to exactly one type_id (1:1)
- **Complete:** All 6 Firebird ACCCLASS values are covered
- **Exclusive:** Any ACCCLASS outside 1-6 triggers a hard fail

---

## 3. Verification Queries (Post-Migration)

### Automated Checks (run by `glValidation.runAllChecks()`)

| Check | Name | What It Verifies |
|-------|------|------------------|
| A | Account Type Mismatches | `gl_accounts.type_id` matches CASE(accclass) from staging |
| B | Posting Line Types | Every journal line's account has a type_id matching the original ACCCLASS |
| C | Orphan Postings | No journal lines reference non-existent `accnr` or invalid `type_id` |
| D | COS Integrity | COS accounts (type_id=6) are separate from EXPENSE (type_id=2) |
| E | Canonical Types | `gl_account_types` contains exactly 6 rows matching the authoritative set |
| F | All Accounts Typed | Every `gl_accounts` row has a valid, non-NULL `type_id` |

### GAAP Consistency Checks (run by `glReconciliation.runAllGAAPChecks()`)

| Check | Name | What It Verifies |
|-------|------|------------------|
| GAAP-1 | Trial Balance | Σ debits = Σ credits (within tolerance) |
| GAAP-2 | Balance Sheet Identity | Assets = Liabilities + Equity |
| GAAP-3 | Income Statement Purity | No BS accounts (type 3,4,5) appear in IS aggregation |
| GAAP-4 | COS Consistency | COS total from gl_journal_lines matches legacy journal |

### Standalone SQL (in `data/sql/gl_verification_queries.sql`)

10 queries (A-J) covering all of the above plus legacy journal orphan detection.

---

## 4. Determinism Proof

The mapping from Firebird ACCCLASS to `gl_account_types.id` is a **pure function**:

```
f(accclass) = accclass   (identity, for accclass ∈ {1,2,3,4,5,6})
f(accclass) = ERROR       (for all other values)
```

**No ambiguity exists because:**
1. The CASE statement in `sp_rebuild_gl_accounts.sql` is exhaustive for 1-6
2. `resolveTypeId()` in `glAccountTypes.js` throws on anything outside 1-6
3. The preflight guard in `runner.js` aborts the entire migration if `gl_account_types` doesn't contain exactly the canonical 6 rows

**No runtime variability because:**
- `seedAccountTypes()` uses `INSERT ... ON DUPLICATE KEY UPDATE` — always converges to the canonical state
- `validateAccountTypes()` checks row count, id set, and name match

---

## 5. GAAP Consistency Assessment

| Requirement | Status | Mechanism |
|-------------|--------|-----------|
| Debits = Credits | ✅ Checked | GAAP-1 (both GL and legacy journal) |
| A = L + E | ✅ Checked | GAAP-2 (from gl_journal_lines grouped by type) |
| IS purity | ✅ Checked | GAAP-3 (no BS type_ids in IS aggregation) |
| COS separated from EXPENSE | ✅ Checked | Check D + GAAP-4 |
| statement_section is the classification authority | ✅ Enforced | gl_account_types.statement_section (IS/BS) used in all checks |
| No legacy field leakage | ✅ Verified | grep confirms no routes/views reference accclass/accounttype |

---

## 6. Implementation Deliverables

### New Files Created

| File | Purpose |
|------|---------|
| `src/migrate/gl/glAccountTypes.js` | Authoritative mapping + seed + validate |
| `src/migrate/gl/glValidation.js` | 6 post-migration verification checks |
| `src/migrate/gl/glReconciliation.js` | 4 GAAP consistency checks |
| `src/migrate/gl/index.js` | Barrel export |
| `data/sql/sp_rebuild_gl_accounts.sql` | Version-controlled stored procedure |
| `data/sql/sp_backfill_gl_journals.sql` | Journal normalization procedure |
| `data/sql/gl_verification_queries.sql` | 10 standalone SQL checks |
| `data/sql/gl_idempotent_patches.sql` | 5 data correction patches for existing data |

### Files Modified

| File | Changes |
|------|---------|
| `src/migrate/runner.js` | Added GL imports, preflight seed+validate guards, post-migration validation |
| `src/routes/api/tools.js` | Added GL module integration, SP installation from SQL file, post-rebuild validation, new `/tools/gl-validate` endpoint |
| `src/public/js/tools/rebuild-gl.js` | Enhanced result display with GL validation warnings |

### Hard-Fail Guards (in runner.js)

**Preflight (before any table migration):**
1. `seedAccountTypes(pool)` — ensures canonical 6 rows exist
2. `validateAccountTypes(pool)` — aborts run if canonical set doesn't match
3. Detects GL tables in migration plan and logs notification

**Post-migration (before marking SUCCESS):**
1. `runAllChecks(pool)` — runs all 6 GL validation checks
2. If any check fails → status downgraded to `COMPLETED_WITH_ERRORS`
3. Detailed results logged to migration run record

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tools/rebuild-gl` | Rebuild GL accounts (enhanced with validation) |
| POST | `/api/tools/gl-validate` | Run GL + GAAP validation on demand |

---

## 7. Idempotent Patches for Existing Data

Five patches in `data/sql/gl_idempotent_patches.sql`:

1. **Seed canonical types + remove surplus** — ensures exactly 6 rows in gl_account_types
2. **Fix type_id from ACCCLASS** — corrects both group and detail accounts
3. **Report unresolvable accounts** — SELECT query showing any accounts where ACCCLASS is not in 1-6
4. **Report orphan journal lines** — SELECT query showing accnr values in journal lines with no gl_accounts match
5. **Separate COS from EXPENSE** — ensures COS accounts have type_id=6, not type_id=2

All patches are safe to run multiple times (ON DUPLICATE KEY UPDATE / WHERE guards).

---

## 8. Remaining Manual Steps

1. **Deploy stored procedures:** Run `data/sql/sp_rebuild_gl_accounts.sql` and `data/sql/sp_backfill_gl_journals.sql` against the target MySQL schema
2. **Run idempotent patches** against any already-migrated databases: `data/sql/gl_idempotent_patches.sql`
3. **Verify with standalone queries:** Run `data/sql/gl_verification_queries.sql` against production data — all 10 should return 0 rows (except the summary queries)
4. **Test the new `/api/tools/gl-validate` endpoint** to confirm all checks pass on a real dataset
5. **Review the `sp_rebuild_gl_accounts` SQL file** to ensure it matches any server-side customizations that may have been made directly on MySQL

---

## 9. Classification Authority Chain

```
gl_account_types.statement_section  ←  SINGLE SOURCE OF TRUTH
        ↑
gl_accounts.type_id (FK)
        ↑
CASE(accounts.accclass)  ←  Firebird staging derivation
        ↑
Firebird ACCOUNTS.CLASSID  ←  Original source
```

**Rule:** Any code that needs to classify an account as Income Statement vs Balance Sheet MUST join to `gl_account_types.statement_section`. Direct use of `accclass`, `accounttype`, `acc_class`, or any other legacy field is prohibited post-migration.

---

*End of GL Audit Report*
