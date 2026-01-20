# Testing Checklist

Use this checklist to verify all features work correctly.

---

## ✅ Pre-Testing Setup

- [ ] Application is running: `npm run dev`
- [ ] Firebird connection configured
- [ ] MySQL connection configured
- [ ] At least one table in migration plan with `include: true`
- [ ] Browser: Chrome, Firefox, or Edge

---

## ✅ Test 1: Pre-Migration Summary Display

### Setup
- [ ] Navigate to Setup → Plan → Mapping → Run
- [ ] Ensure at least 2 tables are included in the plan

### Test Steps
1. [ ] Load the Run page
2. [ ] Verify "Migration Plan Summary" section appears
3. [ ] Verify table shows these columns:
   - [ ] Source Table
   - [ ] Arrow (→)
   - [ ] Target Table
   - [ ] Mode (badge)
   - [ ] Key Strategy (badge)
   - [ ] Dedupe Keys (or "none")

### Expected Results
- [ ] Summary appears before the "Run Migration" button
- [ ] All included tables are listed
- [ ] Source → Target mappings are correct
- [ ] Mode badges show INSERT or UPSERT
- [ ] Key Strategy badges show preserve or rekey
- [ ] Dedupe keys show comma-separated list or "none"

### Test Cases
- [ ] Default mapping (source name = target name)
- [ ] Custom mapping (different source/target names)
- [ ] Table with dedupe keys
- [ ] Table without dedupe keys
- [ ] Multiple tables

---

## ✅ Test 2: Inline Plan Editor - Error Detection

### Setup
- [ ] Configure a table with `keyStrategy: rekey` and NO dedupe keys
- [ ] Ensure the table has no unique index
- [ ] Navigate to Run page

### Test Steps
1. [ ] Click "Run Migration" button
2. [ ] Wait for validation

### Expected Results
- [ ] Error alert appears
- [ ] "⚠️ Fix Plan Configuration" section appears
- [ ] Error message lists the problem:
   ```
   • Table <name>: Re-key IDs requires dedupe keys or a unique index on natural keys.
   ```
- [ ] Plan editor form appears below error message

### Verify Form Contents
- [ ] Table name shown
- [ ] Mode dropdown present with current value selected
- [ ] Key Strategy dropdown present with "rekey" selected
- [ ] Dedupe Keys text input present (empty)
- [ ] On Duplicate dropdown present with current value selected
- [ ] "Update Plan" button present
- [ ] "Edit Full Plan" link present

---

## ✅ Test 3: Inline Plan Editor - Fix Error

### Setup
- [ ] Complete Test 2 (error is showing)

### Test Steps
1. [ ] Enter dedupe keys in text field: `code, name`
2. [ ] Click "Update Plan" button
3. [ ] Wait for page to reload

### Expected Results
- [ ] Page redirects to `/run`
- [ ] Success message appears:
   ```
   ✅ Plan updated successfully
   Migration options have been updated. You can now run the migration.
   ```
- [ ] Plan editor section disappears
- [ ] Table mappings summary updates to show new dedupe keys
- [ ] Dedupe Keys column shows "code, name" for updated table

### Verify Changes Persisted
- [ ] Click "Run Migration" again
- [ ] Verify NO error occurs (or different error if other issues)
- [ ] If migration starts, check that dedupe keys are being used

---

## ✅ Test 4: Multiple Tables with Errors

### Setup
- [ ] Configure 3 tables with validation errors:
   1. Table A: rekey without dedupe keys
   2. Table B: UPSERT without dedupe keys or primary key
   3. Table C: INSERT without dedupe keys or unique index

### Test Steps
1. [ ] Click "Run Migration"
2. [ ] Verify all 3 errors listed
3. [ ] Verify all 3 tables appear in editor form

### Expected Results
- [ ] All error messages shown in bullet list
- [ ] All problematic tables shown in form
- [ ] Each table has its own row with editable fields

### Fix Errors
1. [ ] Add dedupe keys to Table A: `code`
2. [ ] Add dedupe keys to Table B: `sku`
3. [ ] Add dedupe keys to Table C: `email`
4. [ ] Click "Update Plan"
5. [ ] Verify success message
6. [ ] Verify all 3 tables updated in summary
7. [ ] Click "Run Migration"
8. [ ] Verify no validation errors

---

## ✅ Test 5: Change Mode/Key Strategy

### Setup
- [ ] Trigger validation error

### Test Steps
1. [ ] In plan editor, change Mode from UPSERT to INSERT
2. [ ] Change Key Strategy from rekey to preserve
3. [ ] Click "Update Plan"

### Expected Results
- [ ] Changes saved
- [ ] Table mappings summary reflects new mode
- [ ] Table mappings summary reflects new key strategy
- [ ] Error may change or disappear depending on configuration

---

## ✅ Test 6: Dedupe Keys Parsing

### Test Various Formats

Test that these all parse correctly:

1. [ ] Single key: `code`
   - Expected: `['code']`

2. [ ] Multiple keys: `code, name`
   - Expected: `['code', 'name']`

3. [ ] Keys with spaces: `code , name , date`
   - Expected: `['code', 'name', 'date']`

4. [ ] Keys with extra spaces: `  code  ,  name  `
   - Expected: `['code', 'name']`

5. [ ] Empty field: `` (blank)
   - Expected: `[]`

6. [ ] Three keys: `customer_code, invoice_date, line_number`
   - Expected: `['customer_code', 'invoice_date', 'line_number']`

### Verification
For each test:
- [ ] Enter the format in dedupe keys field
- [ ] Click "Update Plan"
- [ ] Check table mappings summary shows correct parsed values
- [ ] Click "Run Migration" to verify parsing worked

---

## ✅ Test 7: Navigation Without Errors

### Setup
- [ ] Configure all tables correctly (no validation errors)

### Test Steps
1. [ ] Navigate to Run page
2. [ ] Verify table mappings summary shows
3. [ ] Click "Run Migration"
4. [ ] Verify migration starts without showing plan editor

### Expected Results
- [ ] No error messages
- [ ] No plan editor appears
- [ ] Migration starts immediately
- [ ] Progress table shows migration progress

---

## ✅ Test 8: Edit Full Plan Link

### Setup
- [ ] Trigger validation error to show plan editor

### Test Steps
1. [ ] Click "Edit Full Plan" link in plan editor

### Expected Results
- [ ] Navigate to Plan page
- [ ] Can edit full configuration
- [ ] Can return to Run page

---

## ✅ Test 9: Success Notice Persistence

### Setup
- [ ] Fix an error using plan editor
- [ ] Success notice appears

### Test Steps
1. [ ] Refresh the page
2. [ ] Verify success notice disappears (cleared after one view)

### Expected Results
- [ ] Success notice shows after update
- [ ] Success notice does NOT show on refresh
- [ ] Notice is one-time only

---

## ✅ Test 10: Multiple Updates

### Setup
- [ ] Trigger validation error

### Test Steps
1. [ ] Update dedupe keys: `code`
2. [ ] Click "Update Plan"
3. [ ] Verify success
4. [ ] Click "Run Migration"
5. [ ] If error occurs, update again: `code, name`
6. [ ] Click "Update Plan"
7. [ ] Verify success
8. [ ] Continue until no errors

### Expected Results
- [ ] Can update multiple times
- [ ] Each update saves correctly
- [ ] Each update shows success message
- [ ] Changes accumulate correctly

---

## ✅ Test 11: Browser Compatibility

Test on multiple browsers:

### Chrome/Edge
- [ ] All features work
- [ ] Dropdowns functional
- [ ] Text inputs functional
- [ ] Form submission works
- [ ] Styling looks correct

### Firefox
- [ ] All features work
- [ ] Dropdowns functional
- [ ] Text inputs functional
- [ ] Form submission works
- [ ] Styling looks correct

### Safari (if available)
- [ ] All features work
- [ ] Dropdowns functional
- [ ] Text inputs functional
- [ ] Form submission works
- [ ] Styling looks correct

---

## ✅ Test 12: Mobile Responsiveness (Bonus)

Test on mobile device or mobile emulation:

- [ ] Table mappings summary readable
- [ ] Error messages readable
- [ ] Plan editor form usable
- [ ] Dropdowns work on touch
- [ ] Text inputs work on touch
- [ ] Buttons are tappable

---

## ✅ Test 13: Performance

### Test Steps
1. [ ] Create plan with 20+ tables
2. [ ] Navigate to Run page
3. [ ] Measure load time
4. [ ] Trigger validation with multiple errors
5. [ ] Measure response time

### Expected Results
- [ ] Page loads in < 2 seconds
- [ ] Validation response < 1 second
- [ ] No noticeable lag
- [ ] Table mappings summary renders quickly

---

## ✅ Test 14: Error Messages

Verify these common errors trigger correctly:

1. [ ] **Re-key without dedupe keys**
   - Setup: keyStrategy = rekey, dedupeKeys = []
   - Expected: "Re-key IDs requires dedupe keys or a unique index"

2. [ ] **UPSERT without dedupe keys**
   - Setup: mode = UPSERT, dedupeKeys = [], no primary key
   - Expected: "UPSERT requires a primary key or dedupe keys"

3. [ ] **INSERT without unique constraint**
   - Setup: mode = INSERT, dedupeKeys = [], no unique index
   - Expected: "INSERT requires dedupe keys or a unique index"

4. [ ] **Unmapped dedupe keys**
   - Setup: dedupeKeys = ['missing_field']
   - Expected: "Dedupe keys not mapped from source fields"

---

## ✅ Test 15: CSS Styling

### Verify Visual Elements

**Badges:**
- [ ] `.badge` class applied to mode and key strategy
- [ ] Badges have rounded corners
- [ ] Badges have subtle background/border
- [ ] Text is uppercase and readable

**Form Controls:**
- [ ] `.form-control` class makes inputs full-width
- [ ] Inputs have consistent height
- [ ] Dropdowns styled consistently
- [ ] Text inputs styled consistently

**Alerts:**
- [ ] Success alert has green styling
- [ ] Error alert has red styling
- [ ] Warning alert has yellow styling (if applicable)

**Cards:**
- [ ] Table mappings summary has card styling
- [ ] Plan editor has card styling
- [ ] Cards have proper spacing and borders

---

## 🎯 Final Verification

### All Features Working
- [ ] Pre-migration summary displays correctly
- [ ] Inline plan editor appears on validation errors
- [ ] Plan updates save and persist
- [ ] Success/error messages display correctly
- [ ] Navigation flow works smoothly
- [ ] No console errors
- [ ] No server errors
- [ ] Documentation matches implementation

### Ready for Production
- [ ] All tests pass
- [ ] No breaking changes
- [ ] Backward compatible
- [ ] Performance acceptable
- [ ] User experience excellent

---

## 📝 Testing Notes

**Date Tested:** _________________

**Tester:** _________________

**Browser(s):** _________________

**Issues Found:**
- _________________________________________________
- _________________________________________________
- _________________________________________________

**Overall Result:** ☐ PASS  ☐ FAIL  ☐ NEEDS WORK

**Additional Comments:**
___________________________________________________________
___________________________________________________________
___________________________________________________________

---

## 🐛 Bug Report Template

If issues are found, use this template:

**Issue Title:** [Component] Brief description

**Steps to Reproduce:**
1. 
2. 
3. 

**Expected Behavior:**


**Actual Behavior:**


**Screenshots/Logs:**


**Environment:**
- Browser: 
- OS: 
- Node version: 

**Severity:** ☐ Critical  ☐ Major  ☐ Minor

---

## ✅ Success Criteria

All tests must pass before considering feature complete:

- [ ] 15/15 tests passed
- [ ] No critical or major bugs
- [ ] Documentation matches implementation
- [ ] User experience is smooth and intuitive
- [ ] Performance is acceptable
- [ ] Code quality is good (no errors, follows patterns)

**Status:** ☐ READY FOR USE  ☐ NEEDS MORE WORK
