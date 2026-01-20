# Wizard Quick Start Guide 🚀

Get started with the new Migration Wizard in 5 minutes!

## Prerequisites

✅ Firebird database accessible  
✅ MySQL server running  
✅ Node.js installed  
✅ Dependencies installed (`npm install`)

## Step 1: Start the Application

```bash
npm start
# or
npm run dev  # For development with auto-reload
```

Application starts at **http://localhost:3000**

## Step 2: Configure Database Connections

**First-time setup only:**

1. Navigate to **http://localhost:3000/setup**
2. Enter Firebird credentials:
   - Host, port, database path
   - Username/password (or use default SYSDBA/masterkey)
3. Click "Test Firebird" - should show ✅ Connected
4. Enter MySQL credentials:
   - Host, port, username, password
   - Target schema name
5. Click "Test MySQL" - should show ✅ Connected
6. Click "Save Configuration"

## Step 3: Launch the Wizard

1. Click **"🧙 Wizard (New)"** in the sidebar
2. Or navigate directly to **http://localhost:3000/wizard**

You'll see the 5-step progress bar:
```
[1] Schema → [2] Mapping → [3] Plan → [4] Run → [5] Results
```

## Step-by-Step Wizard Flow

### Step 1: Discover Schemas ⚙️

**What it does:** Scans both Firebird and MySQL to find all tables and columns.

**Actions:**
1. Click **"Discover Schemas"** button
2. Wait 5-15 seconds for discovery to complete
3. Review the table lists:
   - **Firebird Tables** - Source database tables
   - **MySQL Tables** - Target database tables
4. Use search box to filter tables (optional)
5. Click **"Next"** to proceed

**Tip:** Schema discovery results are cached for 1 hour. Click "Refresh Cache" to force rediscovery.

---

### Step 2: Build Mapping Profile 🗺️

**What it does:** Maps source tables to target tables and configures field transformations.

**Actions:**
1. **Select tables** to migrate (check boxes on left)
2. For each table, click **"Edit"** to configure:
   - **Target Table** - Choose MySQL destination table
   - **Field Mappings** - Map source columns to target columns
   - **Transforms** - Apply data transformations (trim, toNumber, toDate, etc.)
   - **Default Values** - Set defaults for missing data
3. Click **"Auto-Map"** to automatically match fields by name
4. Review **Validation Summary** - Fix any errors/warnings
5. (Optional) Click **"Save Mapping Profile"** to reuse later
6. Click **"Next"** to proceed

**Validation:**
- ✅ All selected tables must have target table set
- ✅ At least one field mapping per table
- ⚠️ Warnings won't block progress (but review them!)

**Pro Tip:** Use "Auto-Map" first, then manually adjust mismatched fields.

---

### Step 3: Create Migration Plan 📋

**What it does:** Orders table migration sequence and configures execution options.

**Actions:**
1. **Review table order** - Tables will migrate in this sequence
2. **Reorder tables** using ↑↓ buttons (important for foreign keys!)
3. **Configure options:**
   - **Batch Size** - Rows per batch (default: 1000)
     - Smaller = slower but more reliable
     - Larger = faster but more memory
   - **Continue on Error** - Keep migrating if one table fails
   - **Validate Data** - Check data types before insert
4. Click **"Run Dry Run"** to simulate migration (recommended!)
5. Review dry-run results - Check for errors/warnings
6. Click **"Next"** to proceed

**Table Ordering Tips:**
- Parent tables before child tables (foreign key dependencies)
- Lookup tables first (countries, categories, etc.)
- Large tables last (logs, transactions, etc.)

**Dry Run Benefits:**
- Tests transformations without writing data
- Validates data types and constraints
- Shows sample transformed rows
- Estimates migration time

---

### Step 4: Execute Migration ▶️

**What it does:** Runs the actual data migration with real-time progress tracking.

**Actions:**
1. **Review pre-migration summary:**
   - Total tables to migrate
   - Total estimated rows
   - Configuration options
2. Click **"Start Migration"** - Confirm when prompted
3. **Watch real-time progress:**
   - Overall progress bar (0-100%)
   - Table-by-table status
   - Rows migrated counter
   - Elapsed time (HH:MM:SS)
   - Estimated time remaining
4. **During migration:**
   - ⏸️ Click "Stop Migration" to abort (safe stop)
   - 🔄 Progress updates every 2 seconds
   - ✅ Tables turn green when complete
   - ❌ Failed tables show in red
5. Wait for completion (status changes to "Completed")
6. Click **"Next"** to view results

**Safety Features:**
- Stop button safely aborts after current table
- Progress persisted to database
- Failed tables can be retried
- Logs saved automatically

---

### Step 5: View Results 📊

**What it does:** Shows migration statistics, errors, and export options.

**Review:**
- **Statistics Cards:**
  - ✅ Tables Migrated (X of Y)
  - 📈 Rows Migrated (total count)
  - ⏱️ Duration (HH:MM:SS)
  - ❌ Errors (count)
- **Table Results** - Per-table breakdown:
  - Status (✅ Completed / ❌ Failed)
  - Rows migrated
  - Duration
  - Error details (expandable)

**Actions:**
1. **Download Report** - Export as JSON or CSV
2. **View Logs** - Open full migration logs in modal
3. **Retry Failed Tables** - Restart only failed tables
4. **Start New Migration** - Reset wizard and begin again

**Troubleshooting:**
- If errors occurred, expand error details for specifics
- Check logs for full error messages and stack traces
- Common fixes:
  - Check data type mismatches
  - Verify foreign key constraints exist
  - Ensure target tables have correct schema
  - Review dedupe key configuration

---

## Keyboard Shortcuts ⌨️

- **Ctrl + Right Arrow** - Next step
- **Ctrl + Left Arrow** - Previous step
- **Tab** - Navigate through form fields
- **Enter** - Activate buttons/links
- **Esc** - Close modals

## Tips & Best Practices 💡

### First-Time Migration
1. ✅ Run with a **small subset** of tables first
2. ✅ Always use **"Run Dry Run"** before executing
3. ✅ Review **validation warnings** carefully
4. ✅ Keep **"Continue on Error"** OFF initially
5. ✅ Start with **smaller batch sizes** (500-1000)

### Production Migration
1. ✅ Backup both databases first!
2. ✅ Test with **dry run** on production-like data
3. ✅ Schedule during **low-traffic period**
4. ✅ Increase **batch size** for speed (5000-10000)
5. ✅ Monitor **progress logs** during execution

### Performance Optimization
- **Small datasets (< 10k rows):** Batch size 1000
- **Medium datasets (10k-100k rows):** Batch size 5000
- **Large datasets (> 100k rows):** Batch size 10000
- **Many small tables:** Enable "Continue on Error"
- **Few large tables:** Disable "Continue on Error"

### Troubleshooting Common Issues

**Schema discovery fails:**
```
✅ Verify database connections in /setup
✅ Check Firebird and MySQL are running
✅ Review server logs for connection errors
```

**Mapping validation errors:**
```
✅ Ensure all required fields are mapped
✅ Check for type mismatches (text vs number)
✅ Verify target table exists in MySQL
```

**Migration hangs:**
```
✅ Check for database locks (long transactions)
✅ Verify network connectivity
✅ Review batch size (try reducing)
✅ Check server logs for errors
```

**Data not appearing in MySQL:**
```
✅ Verify transaction committed (check MySQL logs)
✅ Check for ROLLBACK on error
✅ Verify target table schema matches mapping
✅ Review dedupe key configuration
```

## State Persistence 💾

The wizard automatically saves your progress:

- **localStorage** stores:
  - Current step
  - Schema cache (1-hour TTL)
  - Mapping configuration
  - Plan configuration
  - Progress state

- **To reset wizard:**
  1. Click "Start New Migration" in Results step
  2. Or clear browser localStorage
  3. Or navigate away and return

- **To export state** (debugging):
  ```javascript
  // Open browser console
  localStorage.getItem('wizard_state')
  localStorage.getItem('wizard_schema')
  localStorage.getItem('wizard_mapping')
  ```

## Browser Compatibility 🌐

✅ **Chrome 90+** - Fully supported  
✅ **Firefox 88+** - Fully supported  
✅ **Safari 14+** - Fully supported  
✅ **Edge 90+** - Fully supported  
⚠️ **IE11** - Not supported (use Chrome/Firefox)

Mobile browsers:
✅ **iOS Safari 14+**  
✅ **Chrome Mobile 90+**  
✅ **Samsung Internet 14+**

## Accessibility ♿

- ✅ Keyboard navigation (Tab, Arrow keys)
- ✅ Screen reader support (ARIA labels)
- ✅ Focus indicators (2px blue outline)
- ✅ High contrast mode
- ✅ Reduced motion support
- ✅ 4.5:1 contrast ratio for text
- ✅ 44x44px touch targets on mobile

## Need Help? 🆘

- **Documentation:** `/docs/PHASE_3_COMPLETE.md`
- **API Reference:** `/docs/WIZARD_INTEGRATION_COMPLETE.md`
- **Troubleshooting:** Check browser console for errors
- **Logs:** View migration logs in Step 5 or server logs

---

## Success! 🎉

You've successfully completed your first migration using the wizard!

**Next Steps:**
1. Review results and verify data in MySQL
2. Run data quality checks
3. Test application with migrated data
4. Schedule regular migrations (if needed)
5. Save mapping profile for future use

**Feedback:**
Found a bug or have suggestions? Open an issue on GitHub!
