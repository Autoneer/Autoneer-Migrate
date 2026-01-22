# Modal CSS and Field Editor Styling Guide

## Modal Styling Architecture

### Base Modal Overlay
```css
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
```

Provides:
- Full-screen backdrop with 50% opacity
- Centered dialog positioning
- Click-outside-to-close behavior handled in JS

### Modal Dialog Sizing

#### Default (modal-lg)
```css
.modal-dialog.modal-lg {
  max-width: 800px;
  width: 90%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
```

#### Extra Large (modal-xl)
```css
.modal-dialog.modal-xl {
  max-width: 1000px;
  width: 95%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
```

**Usage**:
- Field editor uses `modal-xl` for comfortable field table viewing
- Other modals use `modal-lg` (80% width)
- Always respects viewport: `max-height: 90vh`

### Modal Structure

```
.modal-overlay (backdrop)
  └─ .modal-dialog (container)
       ├─ .modal-header (title + close)
       ├─ .modal-body (scrollable content)
       └─ .modal-footer (buttons)
```

**Header**:
```css
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  border-bottom: 1px solid #dee2e6;
}
```

**Body**:
```css
.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;  /* Takes remaining space */
}
```

**Footer**:
```css
.modal-footer {
  padding: 20px;
  border-top: 1px solid #dee2e6;
  text-align: right;
}
```

---

## Field Editor Custom Content Modal

### Custom Modal Body
For arbitrary HTML content (like field mapping table):

```css
.modal-body-custom {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  /* Allows internal table to scroll */
}
```

### Field Table Inside Modal
```css
.modal-body-custom table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}

.modal-body-custom table thead {
  background: #f6f8fa;
  border-bottom: 2px solid #d0d7de;
  position: sticky;
  top: 0;  /* Sticky header */
}

.modal-body-custom table th {
  padding: 10px;
  text-align: left;
  font-weight: 600;
  color: #24292f;
  white-space: nowrap;
}

.modal-body-custom table td {
  padding: 8px 10px;
  border-bottom: 1px solid #d0d7de;
}
```

### Scrollable Table Body
```css
.modal-body-custom table tbody {
  max-height: 400px;  /* Limit height */
  overflow-y: auto;   /* Enable scrolling */
  display: block;     /* Required for overflow to work */
}

.modal-body-custom table thead {
  display: table;
  width: 100%;        /* Match tbody width */
}

.modal-body-custom table tbody tr {
  display: table;
  width: 100%;        /* Full width rows */
}
```

**Why this structure?**
- Standard table display for visual consistency
- Head stays fixed at top while body scrolls
- Avoids scrolling entire page
- Responsive column widths

### Form Controls in Table
```css
.modal-body-custom table td input[type="checkbox"] {
  cursor: pointer;
  margin: 0;
  width: 16px;
  height: 16px;
}

.modal-body-custom table td input[type="text"],
.modal-body-custom table td select {
  width: 100%;
  padding: 4px 6px;
  font-size: 11px;
  border: 1px solid #ced4da;
  border-radius: 3px;
  box-sizing: border-box;
}

.modal-body-custom table td input[type="text"]:focus,
.modal-body-custom table td select:focus {
  outline: none;
  border-color: var(--wizard-primary);
  box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.1);
}
```

### Omitted Field Styling
```css
.field-row.omitted {
  opacity: 0.6;           /* Visual indication */
  background: #f9f9f9;    /* Optional: light background */
}

.field-row.omitted td input,
.field-row.omitted td select {
  background: #f5f5f5;
  cursor: not-allowed;
  color: #999;
}
```

---

## Layout Behavior

### Page Layout (No Scroll)
```
┌──────────────────────────────────────┐
│       Wizard Container               │
├──────────────────────────────────────┤
│  Step 2: Build Mapping               │
│  ┌─ Table Selection               ─┐ │
│  │ ┌──────────────────────────┐    │ │
│  │ │ Firebird | Target | ◆◆◆ │    │ │
│  │ │ Table_A  | Table_1│ ⚙ 🪄 │    │ │
│  │ │ Table_B  | Table_2│ ⚙ 🪄 │    │ │
│  │ └──────────────────────────┘    │ │
│  └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### Modal Overlay (On Top)
```
                Fixed Overlay
     ┌─────────────────────────┐
     │ Field Mapping: T → T'   │
     ├─────────────────────────┤
     │ ┌─────────────────────┐ │
     │ │ Source  ┆ Target  │ │ ← Sticky header
     │ ├─────────────────────┤ │
     │ │ COL_A   ┆ COL_1   │ │ ← Scrollable
     │ │ COL_B   ┆ COL_2   │ │    area
     │ │ ...     ┆ ...     │ │   (max 400px)
     │ │ COL_N   ┆ COL_N   │ │
     │ └─────────────────────┘ │
     ├─────────────────────────┤
     │ [Cancel]  [Save]        │
     └─────────────────────────┘
```

---

## Responsive Design

### Mobile (< 768px)
```css
@media (max-width: 768px) {
  .modal-dialog.modal-xl {
    max-width: calc(100% - 20px);
    width: 100%;
  }
  
  .modal-dialog.modal-lg {
    max-width: calc(100% - 20px);
    width: 100%;
  }
  
  .modal-body-custom table {
    font-size: 11px;
  }
  
  .modal-body-custom table th,
  .modal-body-custom table td {
    padding: 6px 4px;
  }
}
```

### Tablet (768px - 1024px)
- Uses modal-xl: 95% width, max 1000px

### Desktop (> 1024px)
- Uses modal-xl: 95% width, max 1000px
- Field table comfortable for viewing ~15-20 columns

---

## Animation/Transitions

### Modal Fade-In (Optional Enhancement)
```css
.modal-overlay {
  animation: fadeIn 0.2s ease-in-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
```

### Button Hover
```css
.modal-footer button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
```

---

## Accessibility

### Focus Management
- Modal receives focus on open (JS handles via setTimeout)
- ESC key closes modal (JS handles)
- Overlay click closes modal (JS handles)
- Focus trap not implemented (optional enhancement)

### ARIA Attributes
```html
<div class="modal-overlay" 
     role="dialog" 
     aria-modal="true" 
     aria-labelledby="modal-title">
  <div class="modal-dialog">
    <h2 id="modal-title">...</h2>
```

### Color Contrast
- Modal body text: `#24292f` on white (WCAG AAA)
- Button text: white on colored background (WCAG AA)
- Placeholder text: `#6c757d` (sufficient contrast)

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Position: fixed | ✅ | ✅ | ✅ | ✅ |
| Flexbox | ✅ | ✅ | ✅ | ✅ |
| Sticky position | ✅ | ✅ | ✅ | ✅ |
| CSS Variables | ✅ | ✅ | ✅ | ✅ |
| Focus visible | ⚠️ | ⚠️ | ⚠️ | ⚠️ |

(All modern browsers supported; no IE support)

---

## Common Patterns

### Disable Row
```javascript
const row = element.closest('tr');
row.querySelectorAll('input, select').forEach(el => {
  el.disabled = true;
});
row.classList.add('omitted');
```

### Update Table Header
```javascript
const stickyHeader = table.querySelector('thead');
// Automatically sticky due to position: sticky; top: 0;
```

### Handle Overflow
```javascript
// Table scrolls automatically due to tbody { overflow-y: auto; }
// No manual scroll handling needed
```

---

## Troubleshooting

### Table Not Scrolling?
Check:
1. `overflow-y: auto` on tbody
2. `display: block` on tbody
3. `max-height` set (e.g., 400px)
4. Header uses `display: table; width: 100%`

### Header Moving with Scroll?
Solution:
```css
table thead {
  position: sticky;
  top: 0;
  z-index: 1;  /* Above tbody content */
}
```

### Modal Too Small?
Use `modal-xl` class instead of `modal-lg`:
```javascript
Modal.custom({
  size: 'xl',  // max-width: 1000px
  // ...
})
```

### Input Fields Too Wide?
They expand to fill `<td>` width. Adjust `<th>` width:
```html
<th width="100">Target Column</th>
```

---

## Future CSS Enhancements

1. **Dark Mode**:
   ```css
   @media (prefers-color-scheme: dark) {
     .modal-dialog { background: #1e1e1e; }
     .modal-body-custom table { color: #e0e0e0; }
   }
   ```

2. **Compact Mode** (for low viewport height):
   ```css
   @media (max-height: 600px) {
     .modal-body-custom table tbody { max-height: 200px; }
   }
   ```

3. **Print Stylesheet**:
   ```css
   @media print {
     .modal-overlay { display: none; }
   }
   ```

---

**Last Updated**: January 2026  
**CSS Version**: 1.0  
**Status**: Production
