# Autoneer Migration PWA - UI/UX Refactoring Plan

## OVERVIEW

Current UI is tightly coupled to confusing workflow (Setup → Plan → Mapping → Run → Results). New UI will have a **linear, single-step-at-a-time flow** where each step is clear, validates before proceeding, and guides the user with helpful context.

---

## NEW WORKFLOW DESIGN

### Current vs New Flow

**CURRENT (Confusing):**
```
Setup → Plan (optional?) → Mapping (complex) → Run (discover errors) → Results
```

**NEW (Linear, Validated):**
```
┌──────────────────────────────────────────────────────────────┐
│                    MIGRATION WIZARD                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Step 1: Discover Schemas                                  │
│  ✓ Connect to Firebird & MySQL                             │
│  ✓ Cache table/column metadata                             │
│  → Auto-proceed to Step 2                                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Step 2: Build Mapping Profile (PERSISTENT)               │
│  ✓ Select source tables to map                             │
│  ✓ Map to target tables (auto-match or manual)             │
│  ✓ Configure column transformations                        │
│  ✓ Validate completeness                                  │
│  ✓ Save as "Profile v1" (reusable across runs)            │
│  → Can exit and resume later                              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Step 3: Create Migration Plan (SESSION)                  │
│  ✓ Load saved Profile                                     │
│  ✓ Select which tables to migrate                         │
│  ✓ Per-table options:                                     │
│    - Mode (INSERT / UPSERT / TRUNCATE+INSERT)             │
│    - Key Strategy (Preserve IDs / Re-key IDs)             │
│    - Dedupe Keys (if UPSERT)                              │
│    - Clean Before (delete old data first)                 │
│  ✓ Validate plan against schema                           │
│  → Can review/adjust before running                       │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Step 4: Execute Migration                                │
│  ✓ Show pre-run summary                                   │
│  ✓ Stream live progress per table                         │
│  ✓ If error: offer choices (Skip / Fix / Abort)           │
│  ✓ Completion: Show results with audit trail              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## FILE STRUCTURE

### Views (Handlebars templates)

```
views/
├── layouts/
│   ├── main.hbs              # Header/footer
│   └── wizard.hbs            # 4-step wizard wrapper
│
├── steps/
│   ├── 1-schema.hbs          # Step 1: Schema discovery
│   ├── 2-mapping.hbs         # Step 2: Build mapping profile
│   ├── 3-plan.hbs            # Step 3: Create plan
│   ├── 4-run.hbs             # Step 4: Execute migration
│   └── 5-results.hbs         # Results & audit
│
├── components/
│   ├── connection-status.hbs # Firebird/MySQL status badge
│   ├── table-selector.hbs    # Checkbox list of tables
│   ├── field-editor.hbs      # Source → Target mapping UI
│   ├── modal.hbs             # Generic modal
│   ├── progress-bar.hbs      # Linear progress indicator
│   ├── error-recovery.hbs    # Error + action choices
│   └── audit-trail.hbs       # Run events log
│
└── legacy/
    ├── setup.hbs             # DEPRECATED (but keep for backward compat)
    ├── plan.hbs              # DEPRECATED
    ├── mapping.hbs           # DEPRECATED
    └── run.hbs               # DEPRECATED
```

### Public Assets

```
public/
├── js/
│   ├── app.js                # Main app initialization
│   │
│   ├── wizard.js             # Step navigation logic
│   │
│   ├── steps/
│   │   ├── schema-ui.js      # Step 1: Schema discovery UI
│   │   ├── mapping-ui.js     # Step 2: Field mapping UI
│   │   ├── plan-ui.js        # Step 3: Plan builder UI
│   │   ├── run-ui.js         # Step 4: Execution monitor UI
│   │   └── results-ui.js     # Step 5: Results viewer UI
│   │
│   ├── components/
│   │   ├── fieldEditor.js    # Reusable field mapping editor
│   │   ├── tableSelector.js  # Reusable table selector
│   │   ├── modal.js          # Modal utilities
│   │   ├── progressBar.js    # Progress tracking
│   │   └── errorHandler.js   # User-friendly error display
│   │
│   ├── api/
│   │   ├── schemaAPI.js      # GET /api/schemas/*
│   │   ├── mappingAPI.js     # GET|POST /api/mappings/*
│   │   ├── planAPI.js        # POST /api/plans/*
│   │   ├── runAPI.js         # POST|GET /api/runs/*
│   │   └── healthAPI.js      # GET /api/health
│   │
│   └── utils/
│       ├── state.js          # Session state manager
│       ├── validator.js      # Client-side validation
│       ├── formatter.js      # Format numbers, dates, etc.
│       └── storage.js        # localStorage for session state
│
├── css/
│   ├── app.css               # Main styles
│   ├── wizard.css            # 4-step wizard layout
│   ├── steps.css             # Step-specific styles
│   ├── components.css        # Component styles
│   ├── responsive.css        # Mobile/tablet support
│   └── themes.css            # Dark mode, color themes
│
└── images/
    ├── icons/
    ├── illustrations/
    └── logos/
```

---

## STEP 1: SCHEMA DISCOVERY

### What Happens
User connects to databases → system discovers tables → caches schema → proceeds to Step 2

### UI Layout

```
┌─────────────────────────────────────────────────┐
│  Step 1 of 4: Discover Schemas                  │
│                                                 │
│  Connection Status                              │
│  ┌─────────────────────────────────────────┐   │
│  │ Firebird     ● Connected                │   │
│  │              Host: localhost:3050       │   │
│  │              DB: /path/to/firebird.fdb  │   │
│  │                                         │   │
│  │ MySQL        ● Connected                │   │
│  │              Host: localhost:3306       │   │
│  │              Schema: autoneer           │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  Schema Discovery                               │
│  ┌─────────────────────────────────────────┐   │
│  │ ⏳ Discovering tables from Firebird...  │   │
│  │                                         │   │
│  │ ✓ Found 12 tables                       │   │
│  │ ✓ Cached column metadata                │   │
│  │ ✓ Analyzed primary keys                 │   │
│  │                                         │   │
│  │ ✓ Found 8 tables in MySQL               │   │
│  │ ✓ Cached column metadata                │   │
│  │ ✓ Analyzed constraints                  │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  [Refresh] [Next: Build Mapping] →             │
└─────────────────────────────────────────────────┘
```

### Key Features
- **Auto-refresh** on page load (check cache age)
- **Manual refresh** if user suspects schema changed
- **Connection status indicator** - clickable for diagnostics
- **Progress animation** during discovery
- **Clear feedback** on what was found

### Implementation (schema-ui.js)

```javascript
class SchemaUI {
  constructor() {
    this.schema = null;
    this.isDiscovering = false;
  }

  /**
   * Initialize schema discovery on page load
   */
  async initialize() {
    this.showSpinner('Discovering schemas...');
    
    try {
      // Try to use cache first
      const cached = await SchemaAPI.getCached();
      if (cached) {
        this.schema = cached;
        this.renderDiscovered();
        return;
      }

      // If no cache or too old, trigger discovery
      await this.discoverSchemas();
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * Trigger schema discovery from DBs
   */
  async discoverSchemas() {
    this.isDiscovering = true;
    this.showProgress('Connecting to Firebird...');

    try {
      const response = await SchemaAPI.discover();
      this.schema = response;
      
      this.showProgress('Analyzing tables...');
      await new Promise(r => setTimeout(r, 500)); // Brief pause for UX

      this.renderDiscovered();
      this.enableNextButton();
    } catch (err) {
      this.showError(`Discovery failed: ${err.message}`);
    } finally {
      this.isDiscovering = false;
    }
  }

  /**
   * Render discovered schema info
   */
  renderDiscovered() {
    const html = `
      <div class="discovered-schema">
        <div class="schema-source">
          <h3>Firebird</h3>
          <p>${this.schema.firebird.tableCount} tables</p>
          <p class="meta">${this.schema.firebird.columnCount} columns total</p>
        </div>
        <div class="schema-target">
          <h3>MySQL</h3>
          <p>${this.schema.mysql.tableCount} tables</p>
          <p class="meta">${this.schema.mysql.columnCount} columns total</p>
        </div>
      </div>
    `;
    document.getElementById('schema-status').innerHTML = html;
  }

  showSpinner(message) {
    const spinner = `<span class="spinner"></span> ${message}`;
    document.getElementById('discovery-status').innerHTML = spinner;
  }

  showProgress(message) {
    // Animated checklist of steps
  }

  showError(message) {
    document.getElementById('discovery-status').innerHTML = `
      <div class="error">
        <strong>⚠ Error:</strong> ${message}
        <button onclick="location.reload()">Retry</button>
      </div>
    `;
  }

  enableNextButton() {
    document.getElementById('next-mapping').disabled = false;
  }
}

// Auto-initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  new SchemaUI().initialize();
});
```

---

## STEP 2: BUILD MAPPING PROFILE

### What Happens
User selects source tables → maps to target tables → configures field transformations → saves profile

### UI Layout

```
┌───────────────────────────────────────────────────────────┐
│  Step 2 of 4: Build Mapping Profile                       │
│                                                           │
│  [← Back]  Step Progress: ████░░░░░░  [Next →]            │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Mapping Profile Name: [Profile v1           ]        │ │
│  │ ☐ Save this profile to reuse in future runs          │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  Tables to Map                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Filter: [Search tables...]                  [All] [✓] │ │
│  │                                                       │ │
│  │ SOURCE TABLE      →  TARGET TABLE      FIELDS  STATUS │ │
│  │ ─────────────────────────────────────────────────────  │
│  │ ☑ CUSTOMER        →  customers           18    ✓      │ │
│  │ ☑ INVOICES        →  invoices            6     ⚠      │ │
│  │ ☐ SPARES_USED     →  spares_used         25    ○      │ │
│  │ ☑ STOCK           →  stock               7     ✓      │ │
│  │                                                       │ │
│  │ [Select All] [Deselect All]                          │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  Field Mapping: CUSTOMER                                  │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ SOURCE COL      TYPE      →  TARGET COL     TRANSFORM │ │
│  │ ──────────────────────────────────────────────────    │ │
│  │ CID             INTEGER   →  cid            (none)    │ │
│  │ NAME            VARCHAR   →  name           trim      │ │
│  │ ADDRESS_1       VARCHAR   →  address_1      trim      │ │
│  │ BALANCE         NUMERIC   →  balance        toNumber  │ │
│  │ [+] Add field                                        │ │
│  │ [✓] All fields mapped                                │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ⚠ Warnings                                              │
│  • INVOICES missing INVOICE_DATE mapping (required)      │
│  • SPARES_USED has 3 unmapped columns (optional)         │
│                                                           │
│  [← Back]  [Save Profile]  [Next: Create Plan →]         │
└───────────────────────────────────────────────────────────┘
```

### Key Features

1. **Profile Name Input** - Save for reuse
2. **Table List with Status**
   - ✓ All fields mapped
   - ⚠ Missing/incomplete mappings
   - ○ Not yet configured
3. **Field Mapping Editor** (expandable per table)
   - Auto-match or manual mapping
   - Transformation function selector
   - Type compatibility warnings
4. **Validation Indicator** - Shows blockers vs warnings

### Implementation (mapping-ui.js)

```javascript
class MappingUI {
  constructor() {
    this.mapping = null;
    this.selectedTables = new Set();
    this.currentTable = null;
  }

  /**
   * Initialize mapping builder
   */
  async initialize() {
    // Load previous mapping if exists
    const saved = await MappingAPI.getLatest();
    if (saved) {
      this.mapping = saved;
      this.renderMappingForm();
    } else {
      this.createNewMapping();
    }
  }

  /**
   * Create new blank mapping
   */
  createNewMapping() {
    this.mapping = {
      id: null,
      name: `Profile ${new Date().toLocaleDateString()}`,
      tables: {}
    };
    this.renderMappingForm();
  }

  /**
   * Render main mapping form
   */
  renderMappingForm() {
    const tables = this.getAvailableTables();
    
    let html = `
      <div class="mapping-form">
        <div class="profile-header">
          <label>
            Profile Name:
            <input type="text" id="profile-name" value="${this.mapping.name}">
          </label>
          <label>
            <input type="checkbox" id="save-profile">
            Save to reuse later
          </label>
        </div>

        <div class="table-list">
          <h3>Select Tables to Map</h3>
          <input type="text" id="table-filter" placeholder="Search tables...">
          
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" id="select-all-tables"></th>
                <th>Source Table</th>
                <th>Target Table</th>
                <th>Fields</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
    `;

    for (const table of tables) {
      const status = this.getTableStatus(table.source);
      const checked = this.selectedTables.has(table.source) ? 'checked' : '';
      
      html += `
        <tr class="table-row" data-source="${table.source}">
          <td><input type="checkbox" class="table-select" ${checked}></td>
          <td>${table.source}</td>
          <td>
            <input type="text" 
                   class="target-table" 
                   value="${this.mapping.tables[table.source]?.targetTable || table.target}"
                   placeholder="Select target table">
          </td>
          <td>${this.getFieldCount(table.source)}</td>
          <td>${status.icon} ${status.label}</td>
        </tr>
      `;
    }

    html += `
            </tbody>
          </table>
        </div>

        <div class="field-editor" id="field-editor"></div>

        <div class="validation-summary" id="validation-summary"></div>

        <div class="actions">
          <button class="btn-secondary" onclick="history.back()">← Back</button>
          <button class="btn-primary" id="save-and-next">Save & Next →</button>
        </div>
      </div>
    `;

    document.getElementById('mapping-container').innerHTML = html;
    this.attachEventListeners();
    this.renderFieldEditor();
  }

  /**
   * Render field mapping for selected table
   */
  renderFieldEditor() {
    if (!this.currentTable) return;

    const tableConfig = this.mapping.tables[this.currentTable];
    if (!tableConfig) {
      this.mapping.tables[this.currentTable] = { 
        targetTable: '', 
        columns: {} 
      };
    }

    const schema = window.schema; // From Step 1
    const srcMeta = schema.getTable('firebird', this.currentTable);
    const tgtTable = this.mapping.tables[this.currentTable].targetTable;
    const tgtMeta = schema.getTable('mysql', tgtTable);

    let html = `
      <div class="field-editor">
        <h3>Field Mapping: ${this.currentTable}</h3>
        
        <table>
          <thead>
            <tr>
              <th>Source Column</th>
              <th>Type</th>
              <th>→</th>
              <th>Target Column</th>
              <th>Transform</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
    `;

    const srcColumns = Object.keys(srcMeta?.columns || {});
    for (const srcCol of srcColumns) {
      const mapping = this.mapping.tables[this.currentTable].columns[srcCol] || {};
      const srcType = srcMeta.columns[srcCol]?.type || 'UNKNOWN';
      
      html += `
        <tr class="field-row">
          <td>${srcCol}</td>
          <td class="type">${srcType}</td>
          <td>→</td>
          <td>
            <select class="target-col" data-source="${srcCol}">
              <option>Select...</option>
              ${(tgtMeta?.columns || []).map(col => 
                `<option value="${col.name}" ${mapping.targetColumn === col.name ? 'selected' : ''}>
                  ${col.name}
                </option>`
              ).join('')}
            </select>
          </td>
          <td>
            <select class="transform" data-source="${srcCol}">
              <option value="">None</option>
              <option value="trim" ${mapping.transform === 'trim' ? 'selected' : ''}>Trim</option>
              <option value="toNumber" ${mapping.transform === 'toNumber' ? 'selected' : ''}>To Number</option>
              <option value="toDate" ${mapping.transform === 'toDate' ? 'selected' : ''}>To Date</option>
              <option value="toBoolean" ${mapping.transform === 'toBoolean' ? 'selected' : ''}>To Boolean</option>
            </select>
          </td>
          <td>
            <input type="text" 
                   class="default-val" 
                   placeholder="null" 
                   data-source="${srcCol}"
                   value="${mapping.defaultValue || ''}">
          </td>
        </tr>
      `;
    }

    html += `
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('field-editor').innerHTML = html;
  }

  /**
   * Validate and save mapping
   */
  async saveMappingProfile() {
    // Collect form values
    this.mapping.name = document.getElementById('profile-name').value;
    this.mapping.tables = this.collectTableConfigs();

    // Validate
    const validation = MappingValidator.validate(this.mapping);
    if (!validation.valid) {
      alert(`Mapping has errors:\n${validation.errors.join('\n')}`);
      return;
    }

    // Save if checkbox checked
    if (document.getElementById('save-profile').checked) {
      await MappingAPI.create(this.mapping);
    }

    // Go to next step
    this.goToStep3();
  }

  attachEventListeners() {
    // Table selection
    document.querySelectorAll('.table-select').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const source = e.target.closest('tr').dataset.source;
        if (e.target.checked) {
          this.selectedTables.add(source);
          this.currentTable = source;
        } else {
          this.selectedTables.delete(source);
        }
        this.renderFieldEditor();
      });
    });

    // Select all tables
    document.getElementById('select-all-tables').addEventListener('change', (e) => {
      const checks = document.querySelectorAll('.table-select');
      checks.forEach(cb => cb.checked = e.target.checked);
    });

    // Save and next
    document.getElementById('save-and-next').addEventListener('click', () => {
      this.saveMappingProfile();
    });
  }

  collectTableConfigs() {
    // Gather all field mapping inputs
  }

  getAvailableTables() {
    // Return list of Firebird tables with MySQL matches
  }

  getTableStatus(source) {
    // Return icon + label based on mapping completeness
  }

  goToStep3() {
    WizardManager.goToStep(3);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new MappingUI().initialize();
});
```

---

## STEP 3: CREATE MIGRATION PLAN

### What Happens
User selects which tables to migrate → configures per-table options → validates plan → ready to run

### UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Step 3 of 4: Create Migration Plan                         │
│                                                             │
│  [← Back]  Step Progress: ████████░░  [Next →]              │
│                                                             │
│  Load Mapping Profile                                       │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ Profile: [Profile v1 ▼]                              │ │
│  │ ☐ Create new mapping                                 │ │
│  │ Last used: Jan 15, 2024                              │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  Select Tables to Migrate                                  │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ ☑ CUSTOMER        → customers                         │ │
│  │ ☑ INVOICES        → invoices                          │ │
│  │ ☑ SPARES_USED     → spares_used                       │ │
│  │ ☑ STOCK           → stock                             │ │
│  │                                                       │ │
│  │ [Select All] [Deselect All]                          │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  Per-Table Configuration                                   │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ TABLE: CUSTOMER                                       │ │
│  │                                                       │ │
│  │ Mode: [UPSERT ▼]                                      │ │
│  │   INSERT         - Add new rows only                  │ │
│  │   UPSERT         - Insert new, update existing        │ │
│  │   TRUNCATE+INSERT- Delete all, insert fresh          │ │
│  │                                                       │ │
│  │ Key Strategy: [Preserve IDs ▼]                        │ │
│  │   Preserve IDs - Keep original primary keys           │ │
│  │   Re-key IDs   - Generate new primary keys            │ │
│  │                                                       │ │
│  │ ☑ Clean Before: Delete old data first                │ │
│  │                                                       │ │
│  │ Dedupe Keys (for UPSERT): [cid ]                     │ │
│  │   (Leave blank if using primary key)                 │ │
│  │                                                       │ │
│  │ [← Previous Table] [Next Table →]                     │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  Validation                                                │
│  ☑ Schema compatibility verified                          │
│  ☑ All required fields mapped                             │
│  ⚠ Column types: 1 warning                                │
│    • INVOICES.inv_totalexlvat: NUMERIC(18,2) → DECIMAL   │
│                                                             │
│  [← Back]  [Validate & Preview]  [Next: Run →]            │
└─────────────────────────────────────────────────────────────┘
```

### Key Features

1. **Mapping Profile Selector** - Load saved profiles or create new
2. **Table Selection** - Checkbox list
3. **Per-Table Configurator** (tab-like interface)
   - Mode selector with descriptions
   - Key Strategy toggle
   - Clean Before checkbox
   - Dedupe Keys (if applicable)
4. **Real-time Validation**
   - Shows blockers (red)
   - Shows warnings (yellow)
   - Green checkmarks for ok items

### Implementation (plan-ui.js)

```javascript
class PlanUI {
  constructor() {
    this.plan = null;
    this.mapping = null;
    this.selectedTables = new Set();
    this.tableConfigs = {};
  }

  /**
   * Initialize plan builder
   */
  async initialize() {
    // Get mapping from previous step
    this.mapping = window.currentMapping; // From Step 2

    // Create new plan
    this.plan = {
      mappingId: this.mapping.id,
      tables: {}
    };

    this.renderForm();
    this.validatePlan();
  }

  /**
   * Render plan configuration form
   */
  renderForm() {
    const tables = Object.keys(this.mapping.tables);

    let html = `
      <div class="plan-form">
        <div class="table-selector">
          <h3>Select Tables to Migrate</h3>
          
          <div class="table-checkboxes">
    `;

    for (const table of tables) {
      const target = this.mapping.tables[table].targetTable;
      const checked = this.selectedTables.has(table) ? 'checked' : '';

      html += `
        <label class="table-checkbox">
          <input type="checkbox" 
                 value="${table}" 
                 ${checked}
                 class="table-selection"
                 onchange="planUI.onTableSelected(this)">
          <span>${table}</span> → <strong>${target}</strong>
        </label>
      `;
    }

    html += `
          </div>
          
          <div class="table-actions">
            <button class="btn-small" onclick="planUI.selectAll()">Select All</button>
            <button class="btn-small" onclick="planUI.deselectAll()">Deselect All</button>
          </div>
        </div>

        <div class="table-configurator">
          <h3 id="config-title">Configuration</h3>
          
          <div id="config-tabs" class="config-tabs"></div>
          
          <div id="config-panel" class="config-panel"></div>
        </div>

        <div class="validation-panel" id="validation-panel"></div>

        <div class="actions">
          <button class="btn-secondary" onclick="history.back()">← Back</button>
          <button class="btn-primary" id="validate-next" disabled>Validate & Next →</button>
        </div>
      </div>
    `;

    document.getElementById('plan-container').innerHTML = html;
  }

  /**
   * Handle table selection
   */
  onTableSelected(checkbox) {
    const table = checkbox.value;
    
    if (checkbox.checked) {
      this.selectedTables.add(table);
    } else {
      this.selectedTables.delete(table);
    }

    // Initialize config for this table
    if (!this.tableConfigs[table]) {
      this.tableConfigs[table] = {
        mode: 'UPSERT',
        keyStrategy: 'preserve',
        cleanBefore: false,
        dedupeKeys: []
      };
    }

    this.renderTableTabs();
    this.renderConfigPanel(Array.from(this.selectedTables)[0]);
  }

  /**
   * Render tabs for selected tables
   */
  renderTableTabs() {
    const html = Array.from(this.selectedTables).map(table => `
      <button class="config-tab" onclick="planUI.renderConfigPanel('${table}')">
        ${table}
      </button>
    `).join('');

    document.getElementById('config-tabs').innerHTML = html;
  }

  /**
   * Render configuration for a single table
   */
  renderConfigPanel(table) {
    const config = this.tableConfigs[table] || {};
    
    let html = `
      <div class="config-fields">
        <div class="field-group">
          <label for="mode-${table}">Migration Mode:</label>
          <select id="mode-${table}" 
                  class="config-select" 
                  onchange="planUI.updateConfig('${table}', 'mode', this.value)">
            <option value="INSERT" ${config.mode === 'INSERT' ? 'selected' : ''}>
              INSERT - Add new rows only
            </option>
            <option value="UPSERT" ${config.mode === 'UPSERT' ? 'selected' : ''}>
              UPSERT - Insert new, update existing
            </option>
            <option value="TRUNCATE+INSERT" ${config.mode === 'TRUNCATE+INSERT' ? 'selected' : ''}>
              TRUNCATE+INSERT - Delete all, insert fresh
            </option>
          </select>
          <small>
            ${this.getModeHelp(config.mode)}
          </small>
        </div>

        <div class="field-group">
          <label for="strategy-${table}">Primary Key Strategy:</label>
          <select id="strategy-${table}" 
                  class="config-select" 
                  onchange="planUI.updateConfig('${table}', 'keyStrategy', this.value)">
            <option value="preserve" ${config.keyStrategy === 'preserve' ? 'selected' : ''}>
              Preserve IDs - Keep original primary keys
            </option>
            <option value="rekey" ${config.keyStrategy === 'rekey' ? 'selected' : ''}>
              Re-key IDs - Generate new primary keys
            </option>
          </select>
          <small>
            ${this.getStrategyHelp(config.keyStrategy)}
          </small>
        </div>

        <div class="field-group checkbox">
          <label>
            <input type="checkbox" 
                   ${config.cleanBefore ? 'checked' : ''}
                   onchange="planUI.updateConfig('${table}', 'cleanBefore', this.checked)">
            Clean Before: Delete all existing rows first
          </label>
          <small>
            Useful if you're re-running migration and want fresh data
          </small>
        </div>

        ${config.mode === 'UPSERT' ? `
          <div class="field-group">
            <label for="dedupeKeys-${table}">Dedupe Keys (optional):</label>
            <input type="text" 
                   id="dedupeKeys-${table}"
                   placeholder="cid, email (comma-separated)"
                   value="${(config.dedupeKeys || []).join(', ')}"
                   onchange="planUI.updateConfig('${table}', 'dedupeKeys', this.value)">
            <small>
              Columns to identify duplicate rows. Leave empty to use primary key.
            </small>
          </div>
        ` : ''}
      </div>
    `;

    document.getElementById('config-panel').innerHTML = html;
  }

  /**
   * Update config for a table
   */
  updateConfig(table, field, value) {
    if (!this.tableConfigs[table]) {
      this.tableConfigs[table] = {};
    }

    if (field === 'dedupeKeys') {
      this.tableConfigs[table][field] = value
        .split(',')
        .map(k => k.trim())
        .filter(k => k);
    } else {
      this.tableConfigs[table][field] = value;
    }

    this.validatePlan();
  }

  /**
   * Validate entire plan
   */
  async validatePlan() {
    const config = {
      mappingId: this.mapping.id,
      tables: Array.from(this.selectedTables),
      perTable: this.tableConfigs
    };

    try {
      const result = await PlanAPI.validate(config);

      if (result.blockers.length > 0) {
        this.renderValidationErrors(result.blockers);
        document.getElementById('validate-next').disabled = true;
      } else if (result.warnings.length > 0) {
        this.renderValidationWarnings(result.warnings);
        document.getElementById('validate-next').disabled = false;
      } else {
        this.renderValidationSuccess();
        document.getElementById('validate-next').disabled = false;
      }
    } catch (err) {
      console.error('Validation error:', err);
    }
  }

  /**
   * Render validation panel
   */
  renderValidationSuccess() {
    document.getElementById('validation-panel').innerHTML = `
      <div class="validation-success">
        <h4>✓ Plan is ready to run</h4>
        <p>All tables and field mappings are valid.</p>
      </div>
    `;
  }

  renderValidationErrors(errors) {
    const html = `
      <div class="validation-error">
        <h4>✗ Plan has errors</h4>
        <ul>
          ${errors.map(e => `<li>${e}</li>`).join('')}
        </ul>
      </div>
    `;
    document.getElementById('validation-panel').innerHTML = html;
  }

  renderValidationWarnings(warnings) {
    const html = `
      <div class="validation-warning">
        <h4>⚠ Plan has warnings</h4>
        <ul>
          ${warnings.map(w => `<li>${w}</li>`).join('')}
        </ul>
        <p class="muted">You can proceed, but review these carefully.</p>
      </div>
    `;
    document.getElementById('validation-panel').innerHTML = html;
  }

  getModeHelp(mode) {
    const helps = {
      INSERT: 'Fails if duplicate rows found',
      UPSERT: 'Updates matching rows, inserts new',
      'TRUNCATE+INSERT': 'Deletes all data first'
    };
    return helps[mode] || '';
  }

  getStrategyHelp(strategy) {
    const helps = {
      preserve: 'Uses original IDs - recommended for data with foreign keys',
      rekey: 'Generates new IDs - requires dedupe keys to identify existing rows'
    };
    return helps[strategy] || '';
  }

  selectAll() {
    document.querySelectorAll('.table-selection').forEach(cb => cb.checked = true);
    Object.keys(this.mapping.tables).forEach(t => this.selectedTables.add(t));
    this.renderTableTabs();
  }

  deselectAll() {
    document.querySelectorAll('.table-selection').forEach(cb => cb.checked = false);
    this.selectedTables.clear();
    document.getElementById('config-tabs').innerHTML = '';
    document.getElementById('config-panel').innerHTML = '';
  }

  async proceedToRun() {
    // Save plan to session
    window.currentPlan = {
      mappingId: this.mapping.id,
      tables: Array.from(this.selectedTables),
      perTable: this.tableConfigs
    };

    WizardManager.goToStep(4);
  }
}

let planUI;
document.addEventListener('DOMContentLoaded', () => {
  planUI = new PlanUI();
  planUI.initialize();
});
```

---

## STEP 4: EXECUTE MIGRATION

### What Happens
User sees summary → migration runs table-by-table → can pause and fix errors → completion screen

### UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  Step 4 of 4: Execute Migration                          │
│                                                          │
│  [← Back]  Step Progress: ████████████  [Complete]       │
│                                                          │
│  Migration Summary (Read-only)                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Profile: Profile v1                                │ │
│  │ Mapping: 4 source → 4 target tables                │ │
│  │ Mode: UPSERT (update existing, insert new)         │ │
│  │ Dry Run: No                                        │ │
│  │ Clean Before: Customer, Invoices only              │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Live Progress                                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Overall:  ████████░░░░░░░░░░  50% (2 of 4 done)   │ │
│  │                                                    │ │
│  │ ✓ CUSTOMER        ████████████ (250/250 rows)     │ │
│  │                  Inserted: 245  |  Updated: 5      │ │
│  │                                                    │ │
│  │ ✓ STOCK           ████████████ (85/85 rows)       │ │
│  │                  Inserted: 85                      │ │
│  │                                                    │ │
│  │ ⏳ INVOICES        ████░░░░░░░░ (45/120 rows)      │ │
│  │                  Processing... [Stop]              │ │
│  │                                                    │ │
│  │ ○ SPARES_USED     ░░░░░░░░░░░░ (0/500 rows)       │ │
│  │                  Waiting...                        │ │
│  │                                                    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Logs                                                   │
│  ┌────────────────────────────────────────────────────┐ │
│  │ [Info] Starting table: CUSTOMER                   │ │
│  │ [Info] Batch 1: 50 rows processed                 │ │
│  │ [Warn] Found 1 duplicate CID                      │ │
│  │ [Info] Table CUSTOMER completed                  │ │
│  │ [Info] Starting table: STOCK                     │ │
│  │                                                    │ │
│  │ [✓] Auto-scroll   [⊞] Expand      [×] Clear      │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  [← Back]  [Stop Migration]  [Download Logs]            │
└──────────────────────────────────────────────────────────┘
```

### Error Handling During Run

If error occurs on a table:

```
┌──────────────────────────────────────────────────────────┐
│  ⚠ Error on INVOICES                                     │
│                                                          │
│  Column not found in MySQL: INVOICE_DATE                │ │
│                                                          │
│  What would you like to do?                              │
│                                                          │
│  ☐ Skip this table (continue with SPARES_USED)           │ │
│     Migration will proceed but INVOICES will not be done │ │
│                                                          │
│  ☐ Fix mapping and retry                                 │ │
│     Go back to Step 2 to fix field mapping               │ │
│                                                          │
│  ☐ Stop migration                                        │ │
│     Abort entirely, keep changes so far                  │ │
│                                                          │
│  [Skip] [Fix Mapping] [Stop]                             │ │
└──────────────────────────────────────────────────────────┘
```

### Completion Screen

```
┌──────────────────────────────────────────────────────────┐
│  ✓ Migration Complete!                                   │
│                                                          │
│  Summary                                                 │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Total Time: 2 minutes 34 seconds                  │ │
│  │ Total Rows: 940 read, 930 migrated, 10 skipped    │ │
│  │                                                    │ │
│  │ ✓ CUSTOMER    250 rows  (Inserted: 245, Updated: 5) │ │
│  │ ✓ STOCK       85 rows   (Inserted: 85)            │ │
│  │ ✓ INVOICES    120 rows  (Inserted: 120)           │ │
│  │ ✓ SPARES_USED 485 rows  (Inserted: 480, Updated: 5) │ │
│  │                                                    │ │
│  │ Issues: 0 errors, 10 skipped duplicates            │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Actions                                                │
│  [View Audit Trail]  [Download Report]  [View Results] │ │
│  [Run Again] [Create New Mapping]                       │ │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Implementation (run-ui.js)

```javascript
class RunUI {
  constructor() {
    this.runId = null;
    this.eventSource = null;
    this.tableProgress = new Map();
  }

  /**
   * Initialize and start migration
   */
  async initialize() {
    const plan = window.currentPlan;

    // Show summary
    this.renderSummary(plan);

    // Start migration
    try {
      const response = await RunAPI.startMigration(plan);
      this.runId = response.runId;

      // Connect to SSE for progress
      this.connectToEvents();

      // Show progress UI
      this.renderProgressPanel();
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * Render pre-run summary
   */
  renderSummary(plan) {
    const mapping = window.currentMapping;
    
    const html = `
      <div class="run-summary">
        <h3>Migration Plan Summary</h3>
        <dl>
          <dt>Profile</dt>
          <dd>${mapping.name}</dd>
          <dt>Tables</dt>
          <dd>${plan.tables.length} tables selected</dd>
          <dt>Mode</dt>
          <dd>UPSERT (update existing, insert new)</dd>
          <dt>Dry Run</dt>
          <dd>No - changes will be permanent</dd>
        </dl>
      </div>
    `;

    document.getElementById('run-summary').innerHTML = html;
  }

  /**
   * Render live progress panel
   */
  renderProgressPanel() {
    const html = `
      <div class="progress-panel">
        <div class="overall-progress">
          <div class="progress-label">Overall Progress</div>
          <div class="progress-bar">
            <div class="progress-fill" id="overall-fill" style="width: 0%"></div>
          </div>
          <div class="progress-text" id="overall-text">0 of 0 tables</div>
        </div>

        <div class="table-progress-list" id="table-progress-list"></div>

        <div class="run-logs">
          <div class="logs-header">
            <h4>Migration Logs</h4>
            <div class="log-controls">
              <label>
                <input type="checkbox" id="auto-scroll" checked>
                Auto-scroll
              </label>
              <button onclick="runUI.clearLogs()">Clear</button>
              <button onclick="runUI.downloadLogs()">Download</button>
            </div>
          </div>
          <pre id="run-logs" class="run-logs-content"></pre>
        </div>

        <div class="run-actions">
          <button id="stop-migration" class="btn-danger" onclick="runUI.stopMigration()">
            ⏹ Stop Migration
          </button>
        </div>
      </div>
    `;

    document.getElementById('run-container').innerHTML = html;
  }

  /**
   * Connect to SSE event stream
   */
  connectToEvents() {
    this.eventSource = new EventSource(`/api/runs/${this.runId}/events`);

    this.eventSource.addEventListener('runState', (e) => {
      const runState = JSON.parse(e.data);
      this.updateProgress(runState);
    });

    this.eventSource.addEventListener('log', (e) => {
      const entry = JSON.parse(e.data);
      this.addLogEntry(entry);
    });

    this.eventSource.addEventListener('error', () => {
      this.showError('Connection lost - attempting to reconnect...');
    });
  }

  /**
   * Update progress from server
   */
  updateProgress(runState) {
    // Update overall progress
    const progress = Math.round((runState.progress / 100) * 100);
    document.getElementById('overall-fill').style.width = progress + '%';
    document.getElementById('overall-text').textContent = 
      `${runState.completedTables} of ${runState.totalTables} tables`;

    // Update per-table progress
    for (const table of runState.tables) {
      this.updateTableProgress(table);
    }

    // Handle completion
    if (runState.status === 'SUCCESS') {
      this.showCompletion(runState);
    } else if (runState.status === 'FAILED') {
      this.showError(runState.lastError?.message || 'Migration failed');
    }
  }

  /**
   * Update single table progress row
   */
  updateTableProgress(table) {
    let row = document.getElementById(`table-progress-${table.name}`);
    
    if (!row) {
      row = document.createElement('div');
      row.id = `table-progress-${table.name}`;
      row.className = 'table-progress-row';
      document.getElementById('table-progress-list').appendChild(row);
    }

    const statusIcon = {
      'SUCCESS': '✓',
      'RUNNING': '⏳',
      'FAILED': '✗',
      'QUEUED': '○'
    }[table.status] || '○';

    const progress = table.total ? (table.migrated / table.total) * 100 : 0;

    row.innerHTML = `
      <div class="table-status-icon">${statusIcon}</div>
      <div class="table-name">${table.name}</div>
      <div class="table-progress-bar">
        <div class="progress-fill" style="width: ${progress}%"></div>
      </div>
      <div class="table-stats">
        ${table.migrated} / ${table.total} rows
        ${table.inserted ? `(Ins: ${table.inserted}, Upd: ${table.updated})` : ''}
      </div>
    `;
  }

  /**
   * Add log entry
   */
  addLogEntry(entry) {
    const logs = document.getElementById('run-logs');
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const level = entry.level.toUpperCase();
    const line = `[${time}] [${level}] ${entry.message || JSON.stringify(entry)}\n`;

    logs.textContent += line;

    if (document.getElementById('auto-scroll').checked) {
      logs.scrollTop = logs.scrollHeight;
    }
  }

  /**
   * Show completion modal
   */
  showCompletion(runState) {
    this.eventSource?.close();

    const summary = this.buildSummary(runState);

    const html = `
      <div class="completion-modal">
        <div class="modal-header">
          <h2>✓ Migration Complete!</h2>
        </div>

        <div class="modal-body">
          <div class="completion-summary">
            ${summary}
          </div>

          <div class="completion-actions">
            <button class="btn-primary" onclick="location.href='/results/${this.runId}'">
              View Results
            </button>
            <button class="btn-secondary" onclick="runUI.downloadLogs()">
              Download Logs
            </button>
            <button class="btn-secondary" onclick="location.href='/mapping'">
              Create New Migration
            </button>
          </div>
        </div>
      </div>
    `;

    // Show modal overlay
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.innerHTML = html;
    document.body.appendChild(modal);
  }

  buildSummary(runState) {
    let html = '<dl class="summary-list">';
    
    html += `<dt>Total Time</dt><dd>${this.formatDuration(runState.duration)}</dd>`;
    html += `<dt>Status</dt><dd>${runState.status}</dd>`;
    html += `<dt>Total Rows</dt><dd>${runState.totals.migrated} migrated, ${runState.totals.skipped} skipped</dd>`;
    
    for (const table of runState.tables) {
      html += `
        <dt>${table.status === 'SUCCESS' ? '✓' : '✗'} ${table.name}</dt>
        <dd>${table.migrated} rows (Ins: ${table.inserted}, Upd: ${table.updated})</dd>
      `;
    }

    html += '</dl>';
    return html;
  }

  /**
   * Stop migration
   */
  async stopMigration() {
    if (!confirm('Stop migration? Already migrated data will remain.')) return;

    await RunAPI.abort(this.runId);
    this.eventSource?.close();
    this.showError('Migration stopped by user');
  }

  /**
   * Download logs
   */
  downloadLogs() {
    const logs = document.getElementById('run-logs').textContent;
    const blob = new Blob([logs], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration-${this.runId}.log`;
    a.click();
  }

  clearLogs() {
    document.getElementById('run-logs').textContent = '';
  }

  showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-banner';
    errorDiv.innerHTML = `<strong>⚠</strong> ${message}`;
    document.body.insertBefore(errorDiv, document.body.firstChild);
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }
}

let runUI;
document.addEventListener('DOMContentLoaded', () => {
  runUI = new RunUI();
  runUI.initialize();
});
```

---

## STEP 5: RESULTS & AUDIT TRAIL

### What Happens
User reviews migration results → views error details → can inspect audit trail → decides next action

### UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  Results & Audit Trail                                   │
│                                                          │
│  Summary Card                                            │
│  ┌────────────────────────────────────────────────────┐ │
│  │ ✓ Migration Successful                             │ │
│  │ Date: Jan 20, 2024 @ 14:32 UTC                    │ │
│  │ Duration: 2m 34s                                  │ │
│  │ Total Rows: 940                                   │ │
│  │                                                    │ │
│  │ Inserted: 930  |  Updated: 5  |  Skipped: 5       │ │
│  │ Errors: 0                                          │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Per-Table Results                                      │
│  ┌────────────────────────────────────────────────────┐ │
│  │ TABLE          ROWS  INSERTED  UPDATED  SKIPPED ERRORS│ │
│  │ ──────────────────────────────────────────────────  │ │
│  │ CUSTOMER       250     245        5        0       0 │ │
│  │ STOCK          85      85         0        0       0 │ │
│  │ INVOICES       120     120        0        0       0 │ │
│  │ SPARES_USED    485     480        0        5       0 │ │
│  │                                                    │ │
│  │ [View Errors] [View Audit Log]                    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Integrity Checks                                       │
│  ┌────────────────────────────────────────────────────┐ │
│  │ ✓ Row count validation passed                      │ │
│  │ ✓ Checksum validation (invoice_totalinclvat)       │ │
│  │   Firebird sum: $45,230.50                         │ │
│  │   MySQL sum: $45,230.50                            │ │
│  │ ✓ Foreign key orphan check                         │ │
│  │   invoices.cid → customers.cid: 0 orphans          │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Audit Trail (Latest 10 events)                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │ 14:35:42 [INFO] Table SPARES_USED completed       │ │
│  │ 14:35:30 [INFO] Batch 9: 50 rows inserted         │ │
│  │ 14:34:52 [WARN] Found 5 duplicate rows            │ │
│  │ 14:34:45 [INFO] Checksum validation passed        │ │
│  │ 14:34:30 [INFO] Table INVOICES completed          │ │
│  │ 14:33:15 [INFO] Starting table INVOICES            │ │
│  │ 14:33:00 [INFO] Table STOCK completed             │ │
│  │ 14:32:15 [INFO] Starting table STOCK               │ │
│  │ 14:32:05 [INFO] Starting table CUSTOMER            │ │
│  │ 14:32:00 [INFO] Migration started                 │ │
│  │                                                    │ │
│  │ [← Previous 10] [Next 10 →] [Export as CSV]       │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Next Steps                                              │
│  [ ] Create New Migration from Same Profile              │
│  [ ] Build New Mapping Profile                          │
│  [ ] Schedule Recurring Migrations (Pro Feature)         │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## MASTER WIZARD CONTROLLER

### File: public/js/wizard.js

```javascript
class WizardManager {
  static STEPS = [
    { id: 1, title: 'Discover Schemas', template: '1-schema' },
    { id: 2, title: 'Build Mapping', template: '2-mapping' },
    { id: 3, title: 'Create Plan', template: '3-plan' },
    { id: 4, title: 'Execute', template: '4-run' },
    { id: 5, title: 'Results', template: '5-results' }
  ];

  static currentStep = 1;
  static state = {};

  /**
   * Initialize wizard
   */
  static init() {
    this.renderHeader();
    this.renderProgressBar();
    this.goToStep(1);
  }

  /**
   * Navigate to specific step
   */
  static goToStep(stepNum) {
    if (stepNum < 1 || stepNum > this.STEPS.length) return;

    const step = this.STEPS[stepNum - 1];
    this.currentStep = stepNum;

    // Clear previous UI
    document.getElementById('wizard-content').innerHTML = '';

    // Load step template and script
    this.loadStepTemplate(step);
    this.loadStepScript(step);

    // Update progress
    this.updateProgressBar();
  }

  static loadStepTemplate(step) {
    fetch(`/templates/${step.template}.html`)
      .then(r => r.text())
      .then(html => {
        document.getElementById('wizard-content').innerHTML = html;
      });
  }

  static loadStepScript(step) {
    const script = document.createElement('script');
    script.src = `/js/steps/${step.template.replace('-', '')}-ui.js`;
    document.head.appendChild(script);
  }

  static renderProgressBar() {
    const progress = (this.currentStep / this.STEPS.length) * 100;
    const html = `
      <div class="wizard-progress">
        <div class="progress-fill" style="width: ${progress}%"></div>
        <div class="progress-text">
          Step ${this.currentStep} of ${this.STEPS.length}: ${this.STEPS[this.currentStep - 1].title}
        </div>
      </div>
    `;
    document.getElementById('wizard-progress').innerHTML = html;
  }

  static updateProgressBar() {
    this.renderProgressBar();
  }

  static renderHeader() {
    const html = `
      <div class="wizard-header">
        <h1>Migration Wizard</h1>
        <p class="subtitle">Migrate data from Firebird to MySQL</p>
      </div>
    `;
    document.getElementById('wizard-header').innerHTML = html;
  }

  static saveState(key, value) {
    this.state[key] = value;
    localStorage.setItem(`wizard_${key}`, JSON.stringify(value));
  }

  static getState(key) {
    const stored = localStorage.getItem(`wizard_${key}`);
    return stored ? JSON.parse(stored) : null;
  }

  static clearState() {
    localStorage.clear();
    this.state = {};
  }
}

document.addEventListener('DOMContentLoaded', () => {
  WizardManager.init();
});
```

---

## STYLING (public/css/)

### wizard.css

```css
.wizard-container {
  max-width: 1000px;
  margin: 0 auto;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.wizard-header {
  text-align: center;
  margin-bottom: 40px;
  padding-bottom: 20px;
  border-bottom: 1px solid #e0e0e0;
}

.wizard-header h1 {
  margin: 0;
  font-size: 28px;
  color: #1a1a1a;
}

.wizard-header .subtitle {
  margin: 10px 0 0;
  font-size: 14px;
  color: #666;
}

/* Progress Bar */
.wizard-progress {
  position: relative;
  height: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  margin-bottom: 40px;
  overflow: hidden;
}

.wizard-progress .progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50, #45a049);
  transition: width 0.3s ease;
}

.wizard-progress .progress-text {
  position: absolute;
  top: 10px;
  left: 0;
  font-size: 13px;
  font-weight: 600;
  color: #333;
}

/* Step Content */
#wizard-content {
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 40px;
  min-height: 400px;
}

/* Form Elements */
input[type="text"],
input[type="number"],
select,
textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
}

input[type="text"]:focus,
select:focus {
  outline: none;
  border-color: #4CAF50;
  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.1);
}

/* Buttons */
.btn-primary {
  background: #4CAF50;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-primary:hover {
  background: #45a049;
}

.btn-primary:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.btn-secondary {
  background: #f5f5f5;
  color: #333;
  border: 1px solid #ddd;
  padding: 12px 24px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary:hover {
  background: #efefef;
}

.btn-danger {
  background: #f44336;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
}

/* Tables */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 20px 0;
}

thead {
  background: #f9f9f9;
  border-bottom: 2px solid #e0e0e0;
}

th {
  padding: 12px;
  text-align: left;
  font-weight: 600;
  color: #333;
}

td {
  padding: 12px;
  border-bottom: 1px solid #f0f0f0;
}

tr:hover {
  background: #f9f9f9;
}

/* Status Badges */
.status-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
}

.status-badge.success {
  background: #e8f5e9;
  color: #2e7d32;
}

.status-badge.error {
  background: #ffebee;
  color: #c62828;
}

.status-badge.warning {
  background: #fff3e0;
  color: #e65100;
}

.status-badge.running {
  background: #e3f2fd;
  color: #1565c0;
}

/* Progress Bars */
.progress-bar {
  height: 20px;
  background: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50, #45a049);
  transition: width 0.3s ease;
}

/* Modals */
.modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  align-items: center;
  justify-content: center;
}

.modal.show {
  display: flex;
}

.modal-content {
  background: white;
  border-radius: 8px;
  padding: 40px;
  max-width: 500px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}

/* Alerts */
.error-banner,
.warning-banner,
.success-banner {
  padding: 12px 16px;
  border-radius: 4px;
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.error-banner {
  background: #ffebee;
  color: #c62828;
  border: 1px solid #ef5350;
}

.warning-banner {
  background: #fff3e0;
  color: #e65100;
  border: 1px solid #ffb74d;
}

.success-banner {
  background: #e8f5e9;
  color: #2e7d32;
  border: 1px solid #66bb6a;
}

/* Responsive */
@media (max-width: 768px) {
  #wizard-content {
    padding: 20px;
  }

  table {
    font-size: 12px;
  }

  th, td {
    padding: 8px;
  }

  .btn-primary,
  .btn-secondary {
    padding: 10px 16px;
    font-size: 13px;
  }
}
```

---

## KEY UI IMPROVEMENTS SUMMARY

| Aspect | Old | New |
|--------|-----|-----|
| **Navigation** | 5 confusing routes | Linear 4-step wizard |
| **Progress Indication** | Unclear | Clear progress bar + step indicator |
| **Field Mapping** | Inline, hard to edit | Dedicated UI with table filtering |
| **Error Handling** | Fails silently | Presents choices (Skip / Fix / Abort) |
| **Live Feedback** | Minimal | Real-time progress + logs |
| **Reusability** | Unclear | "Save Profile" button on Step 2 |
| **Mobile Friendly** | Not optimized | Responsive design |
| **Accessibility** | Limited | Proper labels, ARIA attributes |

---

## IMPLEMENTATION CHECKLIST

- [ ] Handlebars templates for all 5 steps
- [ ] Step JS files with event handlers
- [ ] CSS styling (main + responsive)
- [ ] Wizard controller for navigation
- [ ] API clients (schema, mapping, plan, run)
- [ ] Session state management
- [ ] Error recovery UI
- [ ] Mobile-responsive testing
- [ ] Accessibility audit (WCAG 2.1)

