# Testing Guide: Wizard Step 2 + 3 Fixes

## Quick Test Procedure

### Pre-Test Setup
1. Server is running on http://localhost:3000
2. Open browser and navigate to the wizard
3. Open browser DevTools console to see debug logs

### Test 1: Mapping Name Persistence (Step 2)
**Objective**: Verify mapping name saves and persists correctly

1. Navigate to Step 2 (Mapping)
2. Enter a unique name in the "Profile Name" field (e.g., "Test Mapping 2025-01-20")
3. Select at least one table and configure its mapping
4. Click "Next" to go to Step 3
5. Click "Previous" to return to Step 2
6. **Verify**: The mapping name should still be "Test Mapping 2025-01-20"
7. Refresh the page and return to Step 2
8. **Verify**: The mapping name should still be persisted

**Expected Console Logs**:
```
[MappingUI] Initializing Mapping Builder...
```

**What Fixed**: 
- Changed input ID from `profile-name` to `mapping-profile-name`
- Added scoped selector to prevent conflicts with Step 3

---

### Test 2: Plan Name Persistence (Step 3)
**Objective**: Verify plan name saves and persists correctly

1. Navigate to Step 3 (Plan)
2. Enter a unique name in the "Save as Profile" field (e.g., "Test Plan 2025-01-20")
3. **Verify**: The input is visible and editable
4. Click "Previous" to go to Step 2
5. Click "Next" to return to Step 3
6. **Verify**: The plan name should still be "Test Plan 2025-01-20"

**Expected Console Logs**:
```
[PlanUI] Initializing Plan Builder...
```

**What Fixed**:
- Changed input ID from `profile-name` to `plan-profile-name`
- Added scoped selector to prevent conflicts with Step 2
- Plan name is captured from input before any operations

---

### Test 3: Dry Run with Plan Name Persistence
**Objective**: Verify dry run captures current plan name and runs successfully

1. Navigate to Step 3 (Plan)
2. Enter a unique plan name (e.g., "Dry Run Test 2025-01-20")
3. Click "Run Dry Run" button
4. **Watch Console**: Should see logs like:
   ```
   [PlanUI] Running dry run with plan: { name: "Dry Run Test 2025-01-20", id: 1, mappingId: 1 }
   [PlanUI] Created plan: 1
   OR
   [PlanUI] Updated plan: 1
   ```
5. **Verify**: 
   - Loading indicator appears
   - Dry run completes successfully
   - Results container becomes visible
   - Results show table count, estimated rows, and per-table breakdown

**Backend Console Logs** (in server terminal):
```
[Dry Run] Request for plan 1 { tableName: '(all tables)' }
```

**Expected UI Elements**:
- "Dry Run Results ✓" or "Dry Run Results ❌" header
- Results summary showing:
  - Table count
  - Estimated rows
  - Estimated time
- Per-table summary table (if multiple tables)
- Warnings/errors list (if any)
- Success message (if no errors)

**What Fixed**:
- Plan name is read from input before API calls
- Plan is created/updated with full payload before dry run
- Dry run endpoint accepts missing `tableName` for plan-level runs
- Results are properly inserted into DOM with `innerHTML`

---

### Test 4: No Duplicate ID Errors
**Objective**: Verify no DOM conflicts between Step 2 and Step 3

1. Open browser DevTools Console
2. Navigate through Step 2 → Step 3 → Step 2 → Step 3
3. Type in both profile name fields
4. **Verify**: No JavaScript errors in console
5. **Verify**: Each step's input updates its own data independently

**What to Look For**:
- No "Cannot read property of null" errors
- No "getElementById returned null" warnings
- Typing in Step 2's "Profile Name" shouldn't affect Step 3's "Save as Profile"
- Typing in Step 3's "Save as Profile" shouldn't affect Step 2's "Profile Name"

**What Fixed**:
- Step 2 uses `#mapping-profile-name` with container-scoped selector
- Step 3 uses `#plan-profile-name` with container-scoped selector
- No global `getElementById` calls that could bind to wrong element

---

### Test 5: Plan-Level Dry Run Response Format
**Objective**: Verify new response format renders correctly

1. Create a plan with multiple tables (3-5 tables)
2. Run dry run
3. **Verify Results Show**:
   - Total table count
   - Per-table breakdown with:
     - Table name
     - Estimated rows
     - Status badge (✓ OK / ⚠ Warnings / ❌ Errors)
   - Aggregated warnings list
   - Aggregated errors list

**What Fixed**:
- Backend returns `results.perTable` array with per-table details
- Frontend renders per-table summary table
- Enhanced rendering logic handles both old and new response formats

---

## Debugging Tips

### If Mapping Name Not Persisting:
1. Check browser console for errors
2. Verify input has correct ID: `mapping-profile-name`
3. Check that event listener is attached to correct element
4. Verify localStorage has mapping data: `localStorage.getItem('wizardState')`

### If Plan Name Not Persisting:
1. Check browser console for logs: `[PlanUI] Running dry run with plan: ...`
2. Verify input has correct ID: `plan-profile-name`
3. Check that value is being read before API calls
4. Verify plan is being saved: look for "Created plan:" or "Updated plan:" logs

### If Dry Run Fails:
1. Check browser console for errors
2. Check server terminal for backend errors
3. Verify mapping ID exists: `console.log(this.mapping?.id)`
4. Check backend logs for: `[Dry Run] Request for plan X`
5. Verify dry run results container has ID: `dry-run-results`

### If Results Don't Show:
1. Check that `resultsDiv.style.display` is set to 'block'
2. Verify `renderDryRunResults()` is returning HTML string
3. Check that `resultsDiv.innerHTML` is being set
4. Look for JavaScript errors in rendering logic

---

## Expected Log Flow

### Frontend (Browser Console):
```
[PlanUI] Initializing Plan Builder...
[PlanUI] Running dry run with plan: { name: "Test Plan", id: 1, mappingId: 1 }
[PlanUI] Created plan: 1
(or)
[PlanUI] Updated plan: 1
```

### Backend (Server Terminal):
```
[Dry Run] Request for plan 1 { tableName: '(all tables)' }
```

---

## Success Criteria

✅ Step 2 mapping name saves and persists across navigation  
✅ Step 3 plan name saves and persists across navigation  
✅ Dry run captures current plan name from input  
✅ Dry run works without tableName parameter  
✅ Dry run results display in UI  
✅ No duplicate ID errors in console  
✅ No JavaScript errors during normal operation  
✅ Server starts without errors  
✅ All route handlers use helper function

---

## Rollback Instructions

If issues occur, the following files were modified:
1. `src/public/js/steps/mapping-ui.js` - Revert to use `profile-name`
2. `src/public/js/steps/plan-ui.js` - Revert to use `profile-name`  
3. `src/routes/api/plans.js` - Revert dry-run endpoint changes

Git rollback:
```bash
git checkout HEAD~1 src/public/js/steps/mapping-ui.js
git checkout HEAD~1 src/public/js/steps/plan-ui.js
git checkout HEAD~1 src/routes/api/plans.js
```

---

## Additional Notes

- All changes are backward compatible
- No database migrations required
- Existing saved mappings/plans will continue to work
- Both per-table and plan-level dry runs are supported
- Error handling has been enhanced with better logging
