# 🎨 Wizard UI Visual Guide

This guide shows what users will see at each step of the wizard.

## Navigation

**Sidebar Link:**
```
┌─────────────────────────────┐
│  Autoneer Migrator          │
├─────────────────────────────┤
│  🧙 Wizard (New)    ← NEW!  │
│  Setup                      │
│  Plan                       │
│  Mapping                    │
│  Run                        │
│  Migration History          │
│  Results                    │
└─────────────────────────────┘
```

## Progress Bar (All Steps)

```
┌─────────────────────────────────────────────────────────────────┐
│  [1] Schema  →  [2] Mapping  →  [3] Plan  →  [4] Run  →  [5] Results  │
│  ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  20%    │
└─────────────────────────────────────────────────────────────────┘
```

**Color Coding:**
- 🔵 Active Step - Blue with checkmark
- ⚪ Upcoming Step - Gray
- ✅ Completed Step - Green with checkmark

---

## Step 1: Schema Discovery

### Initial View
```
┌───────────────────────────────────────────────────────────┐
│  Step 1 of 5: Schema Discovery                            │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  Discover tables and columns from your databases.        │
│                                                           │
│  ┌──────────────────────────────────┐                   │
│  │  📊 Discover Schemas             │                   │
│  └──────────────────────────────────┘                   │
│                                                           │
│  ℹ️ This will scan both Firebird and MySQL databases    │
│     to find all available tables and columns.            │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### Discovering (Loading State)
```
┌───────────────────────────────────────────────────────────┐
│  Step 1 of 5: Schema Discovery                            │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────────────────────────────────────┐        │
│  │  ⚙️  Discovering schemas...                 │        │
│  │                                              │        │
│  │        [◐ Loading spinner]                  │        │
│  │                                              │        │
│  │  This may take 10-15 seconds                │        │
│  └─────────────────────────────────────────────┘        │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### Discovered (Success State)
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 1 of 5: Schema Discovery                                    │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ✅ Schemas discovered successfully!                              │
│                                                                   │
│  📦 Cached: 2025-01-20 10:30:45  [🔄 Refresh Cache]              │
│                                                                   │
│  ┌─────────────────────────┬─────────────────────────┐          │
│  │  Firebird Tables (42)   │  MySQL Tables (38)      │          │
│  ├─────────────────────────┼─────────────────────────┤          │
│  │  [Search...]            │  [Search...]            │          │
│  │                         │                         │          │
│  │  ○ customers (12 cols)  │  ○ customers (12 cols)  │          │
│  │  ○ invoices (8 cols)    │  ○ invoices (8 cols)    │          │
│  │  ○ products (15 cols)   │  ○ products (15 cols)   │          │
│  │  ○ spares_used (6 cols) │  ○ spares_used (6 cols) │          │
│  │  ...                    │  ...                    │          │
│  └─────────────────────────┴─────────────────────────┘          │
│                                                                   │
│  [◀ Back]                                      [Next ▶]          │
└───────────────────────────────────────────────────────────────────┘
```

---

## Step 2: Build Mapping Profile

### Table Selection View
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 2 of 5: Build Mapping Profile                               │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Select tables to migrate and configure field mappings.          │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Source Table         Target Table        Actions          │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  ☑ customers          [customers ▼]       [Edit] [Remove] │ │
│  │  ☑ invoices           [invoices ▼]        [Edit] [Remove] │ │
│  │  ☐ products           [Select target ▼]   [Edit] [Remove] │ │
│  │  ☑ spares_used        [spares_used ▼]     [Edit] [Remove] │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  📊 Validation Summary:                                           │
│  ✅ 3 tables mapped correctly                                     │
│  ❌ 1 error: "products" has no target table selected              │
│  ⚠️ 2 warnings: Missing field mappings                            │
│                                                                   │
│  [◀ Back]                      [Save Mapping]     [Next ▶]       │
└───────────────────────────────────────────────────────────────────┘
```

### Field Mapping Editor (Modal)
```
┌─────────────────────────────────────────────────────────────────────┐
│  Edit Field Mapping: customers → customers                  [✕ Close]│
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [🔄 Auto-Map Fields]                                               │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  Source Field   Target Field    Transform       Default      │ │
│  ├───────────────────────────────────────────────────────────────┤ │
│  │  CUST_ID        [id ▼]         [None ▼]         [        ]  │ │
│  │  CUST_NAME      [name ▼]       [trim ▼]         [        ]  │ │
│  │  CUST_EMAIL     [email ▼]      [lowercase ▼]    [        ]  │ │
│  │  CREATED_DATE   [created_at ▼] [toDate ▼]       [NOW()   ]  │ │
│  │  PHONE          [phone ▼]      [trim ▼]         [        ]  │ │
│  │                 [+ Add Field Mapping]                        │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Available Transforms:                                              │
│  • trim - Remove whitespace   • toNumber - Convert to number       │
│  • toDate - Parse date string • toBoolean - Convert to true/false  │
│  • uppercase - Convert to UPPERCASE  • lowercase - to lowercase    │
│                                                                     │
│              [Cancel]                         [Save Changes]       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Create Migration Plan

### Plan Configuration View
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 3 of 5: Create Migration Plan                               │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Configure migration order and execution options.                │
│                                                                   │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐  │
│  │  Execution Options      │  │  Table Order                 │  │
│  ├─────────────────────────┤  ├──────────────────────────────┤  │
│  │  Batch Size: [1000]     │  │  1. ↑↓ customers (1,234 rows)│  │
│  │  ☑ Continue on error    │  │  2. ↑↓ products (5,678 rows) │  │
│  │  ☑ Validate data        │  │  3. ↑↓ invoices (890 rows)   │  │
│  └─────────────────────────┘  │  4. ↑↓ spares_used (234 rows)│  │
│                                │      [❌ Remove]               │  │
│                                └──────────────────────────────┘  │
│                                                                   │
│  📊 Estimated: 8,036 rows • ~2 minutes                            │
│                                                                   │
│  [🧪 Run Dry Run]                                                 │
│                                                                   │
│  [◀ Back]                                      [Next ▶]          │
└───────────────────────────────────────────────────────────────────┘
```

### Dry-Run Results (Success)
```
┌───────────────────────────────────────────────────────────────────┐
│  Dry-Run Results                                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ✅ Dry-run completed successfully!                                │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Table          Status     Sample Data                     │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  customers      ✅ Pass    Transformed 5 sample rows        │ │
│  │  products       ✅ Pass    Transformed 5 sample rows        │ │
│  │  invoices       ⚠️ Warning Date format inconsistent         │ │
│  │  spares_used    ✅ Pass    Transformed 5 sample rows        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ⚠️ 1 warning found - Review before proceeding                   │
│                                                                   │
│                                        [Close] [Proceed to Run]  │
└───────────────────────────────────────────────────────────────────┘
```

---

## Step 4: Execute Migration

### Pre-Execution Confirmation
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 4 of 5: Execute Migration                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  📋 Migration Summary:                                             │
│                                                                   │
│  • Tables to migrate: 4                                           │
│  • Total estimated rows: 8,036                                    │
│  • Batch size: 1,000                                              │
│  • Continue on error: Yes                                         │
│  • Validate data: Yes                                             │
│                                                                   │
│  ⚠️ This will write data to MySQL. Make sure you have backups!   │
│                                                                   │
│  [◀ Back]                              [▶ Start Migration]       │
└───────────────────────────────────────────────────────────────────┘
```

### Running Migration
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 4 of 5: Execute Migration                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  🔄 Migration in progress...                                       │
│                                                                   │
│  Overall Progress:                                                │
│  ████████████████████████░░░░░░░░░░░░░░░░░░░░░░  65%              │
│  5,223 / 8,036 rows migrated                                      │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Table          Status     Progress       Rows    Duration │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  customers      ✅ Done    ████████████  1,234   00:00:08  │ │
│  │  products       ✅ Done    ████████████  5,678   00:00:35  │ │
│  │  invoices       🔄 Running ██████░░░░░░    534   00:00:03  │ │
│  │  spares_used    ⏳ Waiting ░░░░░░░░░░░░      0   --:--:--  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ⏱️ Elapsed: 00:00:46  •  ETA: 00:00:25                          │
│                                                                   │
│                               [⏸️ Stop Migration]                 │
└───────────────────────────────────────────────────────────────────┘
```

### Migration Complete
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 4 of 5: Execute Migration                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ✅ Migration completed successfully!                              │
│                                                                   │
│  Overall Progress:                                                │
│  ████████████████████████████████████████████████████████  100%   │
│  8,036 / 8,036 rows migrated                                      │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Table          Status     Progress       Rows    Duration │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  customers      ✅ Done    ████████████  1,234   00:00:08  │ │
│  │  products       ✅ Done    ████████████  5,678   00:00:35  │ │
│  │  invoices       ✅ Done    ████████████    890   00:00:05  │ │
│  │  spares_used    ✅ Done    ████████████    234   00:00:01  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ⏱️ Total Time: 00:00:49                                          │
│                                                                   │
│  [◀ Back]                                      [Next ▶]          │
└───────────────────────────────────────────────────────────────────┘
```

---

## Step 5: View Results

### Results Dashboard
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 5 of 5: Migration Results                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐      │
│  │  📊 Tables  │  📈 Rows    │  ⏱️ Duration│  ❌ Errors   │      │
│  │    4 / 4    │    8,036    │   00:00:49  │      0      │      │
│  └─────────────┴─────────────┴─────────────┴─────────────┘      │
│                                                                   │
│  📋 Table Results:                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Table          Status  Rows    Duration   Actions        │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  customers      ✅      1,234   00:00:08   [View Details] │ │
│  │  products       ✅      5,678   00:00:35   [View Details] │ │
│  │  invoices       ✅        890   00:00:05   [View Details] │ │
│  │  spares_used    ✅        234   00:00:01   [View Details] │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [📥 Download Report ▼]  [📜 View Logs]  [🔄 Start New Migration]│
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Results with Errors
```
┌───────────────────────────────────────────────────────────────────┐
│  Step 5 of 5: Migration Results                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ⚠️ Migration completed with errors                               │
│                                                                   │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐      │
│  │  📊 Tables  │  📈 Rows    │  ⏱️ Duration│  ❌ Errors   │      │
│  │    3 / 4    │    7,146    │   00:00:45  │     15      │      │
│  └─────────────┴─────────────┴─────────────┴─────────────┘      │
│                                                                   │
│  📋 Table Results:                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Table          Status  Rows    Errors   Actions          │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  customers      ✅      1,234      0     [View Details]   │ │
│  │  products       ✅      5,678      0     [View Details]   │ │
│  │  invoices       ❌        234     15     [▼ Show Errors]  │ │
│  │    └─ Foreign key constraint failed                       │ │
│  │    └─ NULL value in required field                        │ │
│  │  spares_used    ⏭️          0      0     [Skipped]        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [📥 Download Report ▼]  [📜 View Logs]  [🔄 Retry Failed Tables]│
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## Mobile View (< 768px)

### Compact Layout
```
┌─────────────────────────┐
│  Autoneer Migrator      │
│  ☰ Menu                 │
├─────────────────────────┤
│                         │
│  Step 2 of 5            │
│  Build Mapping          │
│                         │
│  [••••◦◦◦◦◦◦] 40%       │
│                         │
│  ┌─────────────────────┐│
│  │  customers          ││
│  │  → customers        ││
│  │  [Edit]  [Remove]   ││
│  └─────────────────────┘│
│                         │
│  ┌─────────────────────┐│
│  │  invoices           ││
│  │  → invoices         ││
│  │  [Edit]  [Remove]   ││
│  └─────────────────────┘│
│                         │
│  [◀ Back]               │
│  [Next ▶]               │
│                         │
└─────────────────────────┘
```

---

## Color Scheme

### Status Colors
- 🟢 **Success** - `#28a745` (green)
- 🔵 **Primary** - `#007bff` (blue)
- 🟡 **Warning** - `#ffc107` (yellow/amber)
- 🔴 **Error** - `#dc3545` (red)
- ⚪ **Inactive** - `#6c757d` (gray)

### Progress States
- ✅ **Completed** - Green with checkmark
- 🔄 **Running** - Blue with spinner
- ⏳ **Waiting** - Gray
- ❌ **Failed** - Red with X
- ⏭️ **Skipped** - Yellow

### UI Elements
- **Buttons** - Blue primary, gray secondary
- **Forms** - White background, gray borders
- **Tables** - Striped rows, hover effect
- **Progress Bars** - Blue gradient fill
- **Modals** - White with shadow overlay

---

## Animations

### Loading States
- **Spinner** - Rotating circle (1s loop)
- **Progress Bar** - Smooth fill animation
- **Fade In** - 0.3s opacity transition
- **Slide In** - Step content slides from right

### Interactions
- **Hover** - Scale up 1.02x
- **Click** - Slight bounce effect
- **Focus** - Blue outline (2px)
- **Transitions** - All 0.2-0.3s ease

---

## Icons

- 🧙 Wizard/Magic
- 📊 Data/Schema
- 🗺️ Mapping
- 📋 Plan/List
- ▶️ Play/Run
- 📈 Results/Stats
- ✅ Success/Check
- ❌ Error/Cross
- ⚠️ Warning
- ℹ️ Info
- 🔄 Refresh/Reload
- ⏸️ Pause/Stop
- 📥 Download
- 📜 Logs/Document
- 🔍 Search
- ⚙️ Settings/Config
- 🔒 Lock/Secure
- 🔓 Unlock
- ⏱️ Time/Duration
- 📦 Cache/Storage

---

This visual guide shows the complete user journey through the wizard!
