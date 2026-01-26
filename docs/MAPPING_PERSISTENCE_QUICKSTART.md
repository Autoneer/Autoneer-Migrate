# MAPPING PERSISTENCE - QUICK START

## ⚡ Immediate Actions Required

### 1. Run SQL Migration (5 minutes)

```bash
# Connect to your MySQL target database
mysql -u root -p autoneer

# Run the migration
source data/add_mapping_persistence_tables.sql;

# Verify tables created
SHOW TABLES LIKE 'migration_%';
# Should show: migration_run_mappings, migration_id_map

# Check structure
DESC migration_run_mappings;
DESC migration_id_map;
```

**What this does:**
- Creates `migration_run_mappings` table for immutable mapping snapshots
- Creates `migration_id_map` table for source→target PK tracking
- Adds indexes for fast FK lookups

### 2. Test Mapping Persistence (Already Working!)

The foundation is already integrated:

```bash
# Start a migration run
npm start

# Open wizard, create/select a plan, run migration

# Check if mappings were saved
mysql -u root -p autoneer
SELECT run_id, COUNT(*) as table_count 
FROM migration_run_mappings 
GROUP BY run_id;

# Should see row(s) with table counts matching your plan
```

**Current Status:**
✅ Mapping snapshots saved automatically when run starts
✅ Canonical table name normalization applied
✅ ID tracking infrastructure ready
⚠️  ID tracking not yet integrated into insert logic (Phase 2)
⚠️  FK resolution not yet using ID map (Phase 3)
⚠️  Plan reuse not yet loading from snapshots (Phase 4)

---

## 📋 What's Implemented

### ✅ Phase 1: Foundation (COMPLETE)

**Files Created:**
- `data/add_mapping_persistence_tables.sql` - Database schema
- `src/migrate/mappingPersistence.js` - Save/load mapping snapshots
- `src/migrate/idMapTracker.js` - Track source→target PK mappings
- `docs/MAPPING_PERSISTENCE_IMPLEMENTATION.md` - Full implementation guide

**Files Modified:**
- `src/migrate/runner.js` - Integrated mapping persistence at run startup

**What Works:**
- ✅ Every migration run saves its mapping configuration to `migration_run_mappings`
- ✅ Mappings use canonical TARGET table names (WORK_DONE not WORKDONE)
- ✅ Full column mappings stored (no placeholders)
- ✅ Ready for reuse and audit trails

**What's Next:**
- ⚠️  Phase 2: Track INSERT/SKIP/UPDATE operations in `migration_id_map`
- ⚠️  Phase 3: Use ID map for FK resolution (stop guessing)
- ⚠️  Phase 4: Load plans from `migration_run_mappings` instead of profiles

---

## 🔧 How to Verify

### Check Mapping Snapshots

```sql
-- See all runs with saved mappings
SELECT 
  r.run_id,
  r.run_label,
  r.started_at,
  COUNT(m.id) as table_count
FROM migration_runs r
LEFT JOIN migration_run_mappings m ON r.run_id = m.run_id
GROUP BY r.run_id
ORDER BY r.started_at DESC
LIMIT 10;

-- View mapping details for a specific run
SELECT 
  table_name,
  source_table,
  target_table,
  JSON_LENGTH(mapping_json, '$.columns') as column_count,
  created_at
FROM migration_run_mappings
WHERE run_id = 123  -- Replace with your run_id
ORDER BY table_name;

-- See full mapping JSON for a table
SELECT 
  table_name,
  JSON_PRETTY(mapping_json) as mapping
FROM migration_run_mappings
WHERE run_id = 123 AND table_name = 'WORK_DONE';
```

### Check ID Map (Will be empty until Phase 2)

```sql
-- Count ID mappings by operation type
SELECT 
  run_id,
  table_name,
  operation,
  COUNT(*) as count
FROM migration_id_map
WHERE run_id = 123
GROUP BY run_id, table_name, operation;

-- See sample ID mappings
SELECT * FROM migration_id_map
WHERE run_id = 123 AND table_name = 'WORK_DONE'
LIMIT 10;
```

---

## 🐛 Troubleshooting

### "Table 'migration_run_mappings' doesn't exist"
**Solution:** Run the SQL migration:
```bash
mysql -u root -p autoneer < data/add_mapping_persistence_tables.sql
```

### "Failed to save run mappings" in logs
**Check:**
1. SQL migration ran successfully
2. Database user has INSERT permission
3. Run ID is valid
4. Mapping object has `tables` property

**Debug:**
```bash
# Check server logs for details
tail -f logs/migration.log | grep MappingPersistence
```

### No mappings saved after run
**Check:**
1. Run completed successfully (check `migration_runs.status`)
2. Plan had tables marked as `include: true`
3. Server logs for errors during mapping save

### Migration_id_map is empty
**Expected:** Phase 2 not yet complete. ID tracking will be added in next phase.

---

## 📚 Documentation

- **Full Implementation Guide:** [docs/MAPPING_PERSISTENCE_IMPLEMENTATION.md](./MAPPING_PERSISTENCE_IMPLEMENTATION.md)
- **Table Name Normalization:** [docs/TABLE_NAME_NORMALIZATION_FIX.md](./TABLE_NAME_NORMALIZATION_FIX.md)
- **API Reference:**
  - `mappingPersistence.saveRunMappings(pool, { runId, planId, mappingProfileId, mapping, includedTables })`
  - `mappingPersistence.loadRunMappings(pool, runId)`
  - `idMapTracker.recordBatch(pool, { runId, tableName, mappings })`
  - `idMapTracker.lookupTargetPk(pool, { runId, parentTable, sourcePk })`

---

## 🎯 Acceptance Criteria

When fully implemented, the system will:

| Criterion | Status | Notes |
|-----------|--------|-------|
| Mappings saved per run | ✅ DONE | Automatic in runner.js |
| Mappings use target table names | ✅ DONE | Via tableNameCanonical |
| ID mappings track INSERT | ⚠️ TODO | Phase 2 |
| ID mappings track SKIP | ⚠️ TODO | Phase 2 |
| ID mappings track UPDATE | ⚠️ TODO | Phase 2 |
| FK resolution uses ID map | ⚠️ TODO | Phase 3 |
| Plans reuse from snapshots | ⚠️ TODO | Phase 4 |
| Profile changes don't break old plans | ⚠️ TODO | Phase 4 |
| Self-healing backfills old runs | ⚠️ TODO | Phase 5 |

---

## 🚀 Next Actions

1. **Immediate:** Run SQL migration if not done
2. **Test:** Run a migration, verify mappings saved
3. **Phase 2:** Implement ID tracking in runner.js insert logic
4. **Phase 3:** Replace FK guessing with ID map lookups
5. **Phase 4:** Update plan API to load from snapshots
6. **Phase 5:** Create backfill script for old runs

---

**Questions?** See [MAPPING_PERSISTENCE_IMPLEMENTATION.md](./MAPPING_PERSISTENCE_IMPLEMENTATION.md) for detailed implementation guide.
