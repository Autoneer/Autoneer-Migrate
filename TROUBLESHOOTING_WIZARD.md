# 🔧 Wizard Troubleshooting Guide

## The Issue

You're seeing only "Skip to content" on the wizard page, which means the JavaScript isn't initializing properly.

## Quick Diagnostic Steps

### Step 1: Run Diagnostics Page

1. **Open:** http://localhost:3000/diagnostics.html
2. **Check:** All JavaScript classes should show "✓ Loaded"
3. **Test APIs:** Click "Test API Endpoints" button

**What to look for:**
- ✅ All 14 JavaScript classes loaded (green checkmarks)
- ✅ API endpoints respond with 200 status
- ❌ Any red "✗ Missing" or error messages

### Step 2: Check Browser Console

1. **Open wizard page:** http://localhost:3000/wizard
2. **Press F12** to open Developer Tools
3. **Go to Console tab**
4. **Look for errors** (red text)

**Common errors:**
- `404 Not Found` - File path is wrong
- `SyntaxError` - JavaScript has syntax errors
- `ReferenceError` - Missing dependency
- `Uncaught TypeError` - Class not defined

### Step 3: Check Network Tab

1. **With DevTools open (F12)**
2. **Go to Network tab**
3. **Refresh page** (Ctrl+R)
4. **Look for failed requests** (red text)

**Check these files load successfully (200 status):**
- `/public/css/wizard.css`
- `/public/css/responsive.css`
- `/public/js/utils/storage.js`
- `/public/js/utils/state.js`
- `/public/js/utils/validator.js`
- `/public/js/api/client.js`
- `/public/js/api/schema-api.js`
- `/public/js/api/mapping-api.js`
- `/public/js/api/plan-api.js`
- `/public/js/api/run-api.js`
- `/public/js/steps/schema-ui.js`
- `/public/js/steps/mapping-ui.js`
- `/public/js/steps/plan-ui.js`
- `/public/js/steps/run-ui.js`
- `/public/js/steps/results-ui.js`
- `/public/js/wizard.js`

## Common Issues & Fixes

### Issue 1: 404 Not Found for JavaScript files

**Cause:** Static file serving path is wrong

**Fix:**
Check that `app.js` has:
```javascript
app.use("/public", express.static(path.join(__dirname, "public")));
```

**Test:**
Open http://localhost:3000/public/js/wizard.js directly in browser
- Should show JavaScript code, not 404

### Issue 2: "WizardStorage is not defined"

**Cause:** JavaScript files loading out of order

**Fix:**
The files MUST load in this order:
1. Core utilities (storage, state, validator)
2. API clients
3. Step components
4. Wizard controller

**Check:**
Look at the `<script>` tags in wizard.hbs - they should be in the correct order.

### Issue 3: Wizard container is empty

**Cause:** JavaScript failed to initialize

**Fix:**
1. Open Console (F12)
2. Type: `window.wizard`
3. Should show `MigrationWizard` object

If undefined:
- Check for console errors
- Verify all scripts loaded
- Check DOMContentLoaded fired

### Issue 4: "Cannot read property 'style' of null"

**Cause:** HTML elements missing from template

**Fix:**
Ensure wizard.hbs has:
```html
<div id="wizard-container">
    <div id="wizard-progress"></div>
    <div class="step-indicator"></div>
    <div id="wizard-steps"></div>
    <div id="wizard-navigation"></div>
</div>
```

## Manual Test

If diagnostics fail, test step-by-step:

### Test 1: Load Storage Class
```javascript
// In browser console:
typeof WizardStorage
// Expected: "function"

const storage = new WizardStorage();
storage.exportAll();
// Expected: object with wizard data
```

### Test 2: Load State Class
```javascript
typeof WizardState
// Expected: "function"

const state = new WizardState();
state.get('currentStep');
// Expected: 1 (or current step number)
```

### Test 3: Initialize Wizard
```javascript
typeof MigrationWizard
// Expected: "function"

const wizard = new MigrationWizard();
wizard.initialize();
// Should show wizard UI
```

## Force Reload

Sometimes browser caching causes issues:

1. **Hard Refresh:** Ctrl + Shift + R (Windows) or Cmd + Shift + R (Mac)
2. **Clear Cache:** 
   - Open DevTools (F12)
   - Right-click refresh button
   - Select "Empty Cache and Hard Reload"
3. **Disable Cache:**
   - DevTools > Network tab
   - Check "Disable cache"
   - Refresh page

## Restart Server

If files were recently changed:

```bash
# Stop current server (Ctrl+C in terminal)
# Then restart:
npm start
```

Or use nodemon for auto-restart:
```bash
npm run dev
```

## Quick Fix: Test Without Layout

If the main layout is interfering, test the standalone version:

1. **Open:** http://localhost:3000/public/wizard-test.html
2. **This bypasses** the Handlebars layout
3. **Should show** the wizard if JavaScript is working

## Expected Behavior

When working correctly, you should see:

### Initial Load
```
┌──────────────────────────────────────────────┐
│  Step 1 of 5: Discover Schemas               │
├──────────────────────────────────────────────┤
│                                              │
│  [1] Schema → [2] Mapping → [3] Plan ...    │
│  ████░░░░░░░░░░░░░░░░░░░  20%               │
│                                              │
│  Discover tables and columns from your      │
│  databases.                                  │
│                                              │
│  ┌────────────────────────────┐             │
│  │  📊 Discover Schemas        │             │
│  └────────────────────────────┘             │
│                                              │
└──────────────────────────────────────────────┘
```

### Console Output (F12)
```
Initializing Migration Wizard...
WizardStorage initialized
WizardState initialized
Loading step components...
Showing step 1: schema
SchemaUI initialized
```

## Still Not Working?

### Collect Debug Info

1. **Open:** http://localhost:3000/diagnostics.html
2. **Screenshot:** The diagnostic results
3. **Console Errors:** Copy any red error messages
4. **Network Tab:** Screenshot failed requests (if any)

### Check File Permissions

Ensure the public directory is readable:
```bash
cd C:\Projects\Autoneer-Migrate
dir public\js\wizard.js
# Should show the file with size ~11KB
```

### Verify File Content

Open a JavaScript file directly:
```bash
cd C:\Projects\Autoneer-Migrate
type public\js\wizard.js
# Should show JavaScript code
```

If file is empty or shows strange characters:
- File might be corrupted
- Re-create the file

## Emergency Fallback

If all else fails, the classic UI still works:

- **Setup:** http://localhost:3000/setup
- **Plan:** http://localhost:3000/plan
- **Mapping:** http://localhost:3000/mapping
- **Run:** http://localhost:3000/run

These pages use the original UI and should work normally.

## Report Results

After running diagnostics, share:

1. ✅ or ❌ All JavaScript classes loaded?
2. ✅ or ❌ API endpoints responding?
3. Console error messages (if any)
4. Network tab status codes
5. Which browser and version

This will help identify the exact issue!
