# Wizard Reset & Modal Dialog Implementation

## Summary
This implementation adds two major features to the Autoneer Migration Wizard:
1. **Reset Wizard** - A button that clears all wizard progress and returns to Step 1
2. **Modal Dialog System** - Replaces all browser alert/confirm/prompt with a reusable, accessible modal utility

## Changes Overview

### New Files Created
- **src/public/js/utils/modal.js** - Reusable modal utility with Promise-based API
- **src/public/css/modal.css** - Modal styling with accessibility features

### Modified Files
- **src/views/wizard.hbs** - Added modal CSS/JS includes, wizard toolbar with reset button
- **src/views/layouts/main.hbs** - Added modal CSS/JS for non-wizard pages
- **src/public/css/wizard.css** - Added toolbar styling
- **src/public/js/wizard.js** - Added reset button handler and Modal.confirm usage
- **src/public/js/app.js** - Replaced window.confirm with Modal.confirm
- **src/public/js/steps/schema-ui.js** - Replaced 3x dialog calls with Modal methods
- **src/public/js/steps/plan-ui.js** - Replaced confirm with Modal.confirm
- **src/public/js/steps/run-ui.js** - Replaced 2x confirm calls with Modal.confirm
- **src/public/js/steps/results-ui.js** - Replaced confirm with Modal.confirm

## Feature Details

### Reset Wizard Button
- **Location**: Wizard toolbar (top-right of wizard page)
- **Functionality**:
  1. Shows warning modal confirming intent
  2. If confirmed:
     - Clears all WizardStorage keys (schema, mapping, plan, run, step)
     - Resets WizardState to initial values
     - Returns to Step 1
     - Shows success modal
  3. If cancelled, no action taken

### Modal Dialog Utility (window.Modal)
Three methods providing Promise-based replacements for native dialogs:

#### Modal.alert()
```javascript
await Modal.alert({
  title: 'Title',
  message: 'Message',
  type: 'info' | 'success' | 'warning' | 'error',
  confirmText: 'OK'
});
```
- Shows informational/status messages
- Single OK button
- Returns Promise<void>

#### Modal.confirm()
```javascript
const confirmed = await Modal.confirm({
  title: 'Title',
  message: 'Message',
  type: 'warning' | 'error' | 'info',
  confirmText: 'Confirm',
  cancelText: 'Cancel'
});
```
- For destructive/important actions
- Two buttons: Confirm and Cancel
- Returns Promise<boolean>

#### Modal.prompt()
```javascript
const {ok, value} = await Modal.prompt({
  title: 'Title',
  message: 'Message',
  inputLabel: 'Enter value:',
  defaultValue: 'initial',
  confirmText: 'OK',
  cancelText: 'Cancel'
});
```
- Text input + confirm/cancel buttons
- Auto-selects input on open
- Returns Promise<{ok: boolean, value: string|null}>

## Accessibility Features
- ✓ Overlay click closes as cancel
- ✓ ESC key cancels
- ✓ ENTER key confirms (except for prompts where ENTER in input confirms)
- ✓ Semantic HTML with ARIA attributes
- ✓ Focus management (input auto-focus on prompt, button focus for alerts)
- ✓ High contrast color scheme
- ✓ Responsive design for mobile

## Replaced Dialog Calls (9 total)
1. ✓ **wizard.js** - Reset confirmation
2. ✓ **schema-ui.js** - Database rescan confirmation (2x) + diagnostics messages (2x)
3. ✓ **plan-ui.js** - Remove table confirmation
4. ✓ **run-ui.js** - Start migration + stop migration confirmations (2x)
5. ✓ **results-ui.js** - Start new migration confirmation
6. ✓ **app.js** - Stop run confirmation

**Verification**: Zero remaining `alert()`, `confirm()`, or `prompt()` calls in application code.

## UI/UX Notes
- Modal dialogs have type-specific header styling (info=blue, success=green, warning=yellow, error=red)
- Buttons styled with existing .btn classes for consistency
- Modal overlays at z-index 10000 (above all other content)
- Smooth animations (fade-in overlay, slide-up dialog)
- Maximum width 500px, 80vh max-height for readability
- Mobile responsive (full-width on < 600px)

## Testing Checklist
- [ ] Open wizard, click "Reset Wizard" button
- [ ] Confirm warning modal appears
- [ ] Cancel returns to wizard without changes
- [ ] Confirm clears all state and returns to Step 1 with success message
- [ ] Step 1: Run diagnostics, confirm uses modal
- [ ] Step 2: (Skip schema rescan in this test)
- [ ] Step 3: Remove table from plan, confirm uses modal
- [ ] Step 4: Start migration, confirm uses modal
- [ ] Step 4: Stop migration, confirm uses modal
- [ ] Step 5: Start new migration, confirm uses modal
- [ ] All modals close on ESC key
- [ ] All modals close on overlay click (except input prompts)
- [ ] Input fields auto-focus in prompt dialogs

## No Breaking Changes
- Migration logic unchanged
- Storage formats unchanged
- API contracts unchanged
- Only UI/UX enhancements
- Fully backward compatible
