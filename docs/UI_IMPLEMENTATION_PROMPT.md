# UI IMPLEMENTATION PROMPT: Linear Wizard-Based Migration Interface

## OBJECTIVE
Refactor the existing Autoneer UI from a confusing multi-step flow to a **clear, linear 4-step wizard** that guides users through the migration process with contextual help, real-time validation, and intuitive error recovery.

---

## CORE DESIGN PRINCIPLES

1. **Linear Flow** - One step at a time, no jumping around
2. **Progressive Disclosure** - Show only relevant options for current step
3. **Immediate Feedback** - Validation runs as user types, not after submit
4. **Helpful Errors** - Show what went wrong + how to fix it
5. **Persistent State** - Save progress to localStorage so users can resume
6. **Accessible** - WCAG 2.1 AA compliance, keyboard navigation, screen reader support

---

## TECHNICAL ARCHITECTURE

### File Organization

```
views/
├── layouts/
│   ├── main.hbs           # Base layout with header/footer
│   └── wizard.hbs         # Wizard-specific layout
│
├── steps/
│   ├── 1-schema.hbs       # Step 1 template
│   ├── 2-mapping.hbs      # Step 2 template
│   ├── 3-plan.hbs         # Step 3 template
│   ├── 4-run.hbs          # Step 4 template
│   └── 5-results.hbs      # Results template
│
└── components/
    ├── connection-badge.hbs
    ├── table-selector.hbs
    ├── field-editor.hbs
    ├── progress-indicator.hbs
    ├── error-modal.hbs
    └── validation-summary.hbs

public/js/
├── app.js                 # Main entry point
├── wizard.js              # Wizard controller
├── api/
│   ├── client.js          # HTTP utilities
│   ├── schema-api.js
│   ├── mapping-api.js
│   ├── plan-api.js
│   └── run-api.js
│
├── steps/
│   ├── schema-ui.js
│   ├── mapping-ui.js
│   ├── plan-ui.js
│   ├── run-ui.js
│   └── results-ui.js
│
├── components/
│   ├── field-editor.js
│   ├── table-selector.js
│   ├── modal.js
│   ├── validator.js
│   └── events.js
│
└── utils/
    ├── storage.js
    ├── state.js
    ├── formatter.js
    └── logger.js

public/css/
├── app.css
├── wizard.css
├── steps.css
├── components.css
├── responsive.css
└── themes.css
```

---

## TASK 1: CORE UTILITIES & INFRASTRUCTURE

### 1.1 public/js/utils/storage.js

```javascript
/**
 * Persistent session state management
 * Stores user progress so they can resume wizard at any step
 */

class WizardStorage {
  static PREFIX = 'autoneer_wizard';

  /**
   * Save step data
   */
  static saveStep(stepNum, data) {
    const key = `${this.PREFIX}_step_${stepNum}`;
    localStorage.setItem(key, JSON.stringify(data));
  }

  /**
   * Load step data
   */
  static loadStep(stepNum) {
    const key = `${this.PREFIX}_step_${stepNum}`;
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Save entire wizard state
   */
  static save(wizardState) {
    const key = `${this.PREFIX}_state`;
    localStorage.setItem(key, JSON.stringify(wizardState));
  }

  /**
   * Load entire wizard state
   */
  static load() {
    const key = `${this.PREFIX}_state`;
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : this.getDefaultState();
  }

  /**
   * Clear all wizard data
   */
  static clear() {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith(this.PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  }

  /**
   * Default empty state
   */
  static getDefaultState() {
    return {
      currentStep: 1,
      schema: null,
      mapping: null,
      plan: null,
      run: null,
      completedSteps: new Set()
    };
  }

  /**
   * Mark step as completed
   */
  static markStepComplete(stepNum) {
    const state = this.load();
    state.completedSteps.add(stepNum);
    this.save(state);
  }

  /**
   * Check if step is completed
   */
  static isStepComplete(stepNum) {
    const state = this.load();
    return state.completedSteps.has(stepNum);
  }
}

export default WizardStorage;
```

**Acceptance Criteria:**
- [ ] Stores/loads individual step data
- [ ] Persists across browser sessions
- [ ] Handles invalid JSON gracefully
- [ ] Can clear entire session
- [ ] 100% unit test coverage

---

### 1.2 public/js/utils/state.js

```javascript
/**
 * In-memory session state
 * Acts as source of truth during wizard execution
 * Synced to localStorage for persistence
 */

class WizardState {
  constructor() {
    // Step 1: Schema Discovery
    this.schema = {
      firebird: null,
      mysql: null,
      lastDiscoveredAt: null,
      cacheAge: 0
    };

    // Step 2: Mapping Profile
    this.mapping = {
      id: null,
      name: null,
      tables: {},
      createdAt: null,
      updatedAt: null,
      isNew: true
    };

    // Step 3: Migration Plan
    this.plan = {
      mappingId: null,
      selectedTables: new Set(),
      perTable: {},
      isValidated: false,
      validationErrors: [],
      validationWarnings: []
    };

    // Step 4: Run Execution
    this.run = {
      id: null,
      status: null,
      startedAt: null,
      progress: 0,
      tables: [],
      logs: []
    };

    // Current position
    this.currentStep = 1;
    this.completedSteps = new Set();
  }

  /**
   * Validate state before proceeding to next step
   */
  canProceedToStep(stepNum) {
    const validators = {
      2: () => this.schema?.firebird && this.schema?.mysql,
      3: () => this.mapping?.tables && Object.keys(this.mapping.tables).length > 0,
      4: () => this.plan?.selectedTables && this.plan.selectedTables.size > 0,
      5: () => this.run?.id !== null
    };

    return validators[stepNum]?.() ?? true;
  }

  /**
   * Reset to specific step (discard subsequent data)
   */
  resetToStep(stepNum) {
    if (stepNum < 4) this.run = null;
    if (stepNum < 3) this.plan = null;
    if (stepNum < 2) this.mapping = null;
  }

  /**
   * Serialize for storage
   */
  toJSON() {
    return {
      schema: this.schema,
      mapping: this.mapping,
      plan: {
        ...this.plan,
        selectedTables: Array.from(this.plan.selectedTables)
      },
      run: this.run,
      currentStep: this.currentStep,
      completedSteps: Array.from(this.completedSteps)
    };
  }

  /**
   * Deserialize from storage
   */
  static fromJSON(obj) {
    const state = new WizardState();
    state.schema = obj.schema || state.schema;
    state.mapping = obj.mapping || state.mapping;
    state.plan = obj.plan || state.plan;
    state.plan.selectedTables = new Set(obj.plan?.selectedTables || []);
    state.run = obj.run || state.run;
    state.currentStep = obj.currentStep || 1;
    state.completedSteps = new Set(obj.completedSteps || []);
    return state;
  }
}

export default WizardState;
```

**Acceptance Criteria:**
- [ ] Stores all 4 step data
- [ ] Validates preconditions for each step
- [ ] Serializes/deserializes correctly
- [ ] Resets steps on backward navigation
- [ ] 100% unit test coverage

---

### 1.3 public/js/utils/validator.js

```javascript
/**
 * Client-side validation for forms
 * Real-time feedback as user types
 */

class FormValidator {
  /**
   * Validate mapping completeness
   */
  static validateMapping(mapping, schema) {
    const errors = [];
    const warnings = [];

    for (const [sourceTable, config] of Object.entries(mapping.tables || {})) {
      // Check target table exists
      if (!schema.mysql.tables.find(t => t.name === config.targetTable)) {
        errors.push(`Target table not found: ${config.targetTable}`);
        continue;
      }

      // Check fields are mapped
      const mappedFields = Object.keys(config.columns || {});
      if (mappedFields.length === 0) {
        errors.push(`No fields mapped for ${sourceTable}`);
      }

      // Check for type mismatches
      for (const [srcCol, fieldMap] of Object.entries(config.columns || {})) {
        const srcMeta = schema.firebird.tables
          .find(t => t.name === sourceTable)
          ?.columns
          .find(c => c.name === srcCol);

        const tgtMeta = schema.mysql.tables
          .find(t => t.name === config.targetTable)
          ?.columns
          .find(c => c.name === fieldMap.targetColumn);

        if (!tgtMeta) {
          errors.push(`Target column not found: ${config.targetTable}.${fieldMap.targetColumn}`);
        }

        // Warn about type conversions
        if (srcMeta && tgtMeta && !this.areTypesCompatible(srcMeta.type, tgtMeta.type)) {
          warnings.push(
            `Type mismatch: ${sourceTable}.${srcCol} (${srcMeta.type}) → ` +
            `${config.targetTable}.${fieldMap.targetColumn} (${tgtMeta.type})`
          );
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Check if Firebird type can convert to MySQL type
   */
  static areTypesCompatible(fbType, mysqlType) {
    const compatMap = {
      'INTEGER': ['INT', 'BIGINT', 'DECIMAL'],
      'NUMERIC': ['DECIMAL', 'FLOAT', 'DOUBLE'],
      'VARCHAR': ['VARCHAR', 'TEXT', 'LONGTEXT'],
      'CHAR': ['CHAR', 'VARCHAR', 'TEXT'],
      'DATE': ['DATE', 'DATETIME'],
      'TIME': ['TIME', 'DATETIME'],
      'BLOB': ['BLOB', 'LONGBLOB', 'MEDIUMBLOB']
    };

    const fbBase = fbType.split('(')[0].toUpperCase();
    const compatible = compatMap[fbBase] || [];

    return compatible.some(t => mysqlType.toUpperCase().includes(t));
  }

  /**
   * Validate plan configuration
   */
  static validatePlan(plan, mapping, schema) {
    const errors = [];
    const warnings = [];

    for (const table of plan.selectedTables) {
      const config = plan.perTable[table];
      if (!config) {
        errors.push(`No configuration for table: ${table}`);
        continue;
      }

      // UPSERT + rekey requires dedupe keys
      if (config.mode === 'UPSERT' && config.keyStrategy === 'rekey') {
        if (!config.dedupeKeys || config.dedupeKeys.length === 0) {
          errors.push(`${table}: UPSERT with re-key requires dedupe keys`);
        }
      }

      // Check dedupe keys exist in table
      if (config.dedupeKeys?.length > 0) {
        const tableSchema = schema.mysql.tables.find(t => t.name === table);
        const tableColumns = new Set((tableSchema?.columns || []).map(c => c.name));

        for (const key of config.dedupeKeys) {
          if (!tableColumns.has(key)) {
            errors.push(`${table}: Dedupe key not found: ${key}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Real-time field validation
   */
  static validateField(fieldName, value, schema, targetTable) {
    const column = schema.mysql.tables
      .find(t => t.name === targetTable)
      ?.columns
      .find(c => c.name === fieldName);

    if (!column) return { valid: false, error: 'Column not found' };

    // Check nullability
    if (column.nullable === false && !value) {
      return { valid: false, error: 'This column cannot be null' };
    }

    // Check type
    if (value && !this.isValueTypeValid(value, column.dataType)) {
      return { valid: false, error: `Invalid type for ${column.dataType}` };
    }

    return { valid: true };
  }

  static isValueTypeValid(value, columnType) {
    // Simple type checking
    const numeric = ['INT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE'];
    const date = ['DATE', 'DATETIME', 'TIMESTAMP'];

    if (numeric.some(t => columnType.includes(t))) {
      return !isNaN(Number(value));
    }

    if (date.some(t => columnType.includes(t))) {
      return !isNaN(new Date(value).getTime());
    }

    return true;
  }
}

export default FormValidator;
```

**Acceptance Criteria:**
- [ ] Validates mapping completeness
- [ ] Checks type compatibility
- [ ] Validates plan configuration
- [ ] Real-time field validation
- [ ] Clear error messages
- [ ] 100% unit test coverage

---

### 1.4 public/js/api/client.js

```javascript
/**
 * HTTP client for API calls
 * Handles auth, error handling, retries
 */

class APIClient {
  constructor(baseURL = '/api') {
    this.baseURL = baseURL;
    this.timeout = 30000;
  }

  /**
   * Make HTTP request
   */
  async request(method, endpoint, data = null) {
    const url = `${this.baseURL}${endpoint}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(this.timeout)
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorData = await response.json();
        throw new APIError(
          errorData.message || `HTTP ${response.status}`,
          response.status,
          errorData
        );
      }

      return await response.json();
    } catch (err) {
      if (err instanceof APIError) throw err;

      throw new APIError(
        err.message || 'Network error',
        0,
        err
      );
    }
  }

  async get(endpoint) {
    return this.request('GET', endpoint);
  }

  async post(endpoint, data) {
    return this.request('POST', endpoint, data);
  }

  async put(endpoint, data) {
    return this.request('PUT', endpoint, data);
  }

  async delete(endpoint) {
    return this.request('DELETE', endpoint);
  }

  /**
   * Retry logic for failed requests
   */
  async withRetry(fn, maxAttempts = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;

        if (attempt < maxAttempts && this.isRetryable(err)) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise(r => setTimeout(r, delay));
        } else {
          break;
        }
      }
    }

    throw lastError;
  }

  isRetryable(error) {
    // Don't retry 4xx errors
    if (error.status >= 400 && error.status < 500) return false;
    // Retry 5xx and network errors
    return true;
  }
}

class APIError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.name = 'APIError';
  }
}

export { APIClient, APIError };
```

**Acceptance Criteria:**
- [ ] GET/POST/PUT/DELETE methods
- [ ] Proper error handling
- [ ] Retry logic with backoff
- [ ] Timeout handling
- [ ] Request/response logging
- [ ] 100% unit test coverage

---

## TASK 2: API CLIENTS (public/js/api/)

### 2.1 public/js/api/schema-api.js

```javascript
import { APIClient } from './client.js';

class SchemaAPI {
  static client = new APIClient();

  /**
   * Get cached schema
   */
  static async getCached() {
    try {
      return await this.client.get('/schemas');
    } catch (err) {
      console.warn('Schema cache miss:', err.message);
      return null;
    }
  }

  /**
   * Trigger fresh schema discovery
   */
  static async refresh() {
    return this.client.post('/schemas/refresh', {});
  }

  /**
   * Get firebird schema only
   */
  static async getFirebird() {
    return this.client.get('/schemas/firebird');
  }

  /**
   * Get MySQL schema only
   */
  static async getMySQL() {
    return this.client.get('/schemas/mysql');
  }
}

export default SchemaAPI;
```

### 2.2 public/js/api/mapping-api.js

```javascript
import { APIClient } from './client.js';

class MappingAPI {
  static client = new APIClient();

  /**
   * List all mapping profiles
   */
  static async listProfiles() {
    return this.client.get('/mappings');
  }

  /**
   * Get one profile
   */
  static async getProfile(id) {
    return this.client.get(`/mappings/${id}`);
  }

  /**
   * Create new mapping
   */
  static async create(mapping) {
    return this.client.post('/mappings', mapping);
  }

  /**
   * Update mapping
   */
  static async update(id, mapping) {
    return this.client.put(`/mappings/${id}`, mapping);
  }

  /**
   * Delete mapping
   */
  static async delete(id) {
    return this.client.delete(`/mappings/${id}`);
  }

  /**
   * Validate mapping against schema
   */
  static async validate(mapping) {
    return this.client.post('/mappings/validate', mapping);
  }

  /**
   * Get latest created mapping
   */
  static async getLatest() {
    const profiles = await this.listProfiles();
    return profiles?.[0] || null;
  }
}

export default MappingAPI;
```

### 2.3 public/js/api/plan-api.js

```javascript
import { APIClient } from './client.js';

class PlanAPI {
  static client = new APIClient();

  /**
   * Create plan from mapping + table selections
   */
  static async create(plan) {
    return this.client.post('/plans', plan);
  }

  /**
   * Validate plan before execution
   */
  static async validate(plan) {
    return this.client.post('/plans/validate', plan);
  }

  /**
   * Dry-run: simulate migration of first row
   */
  static async dryRun(plan) {
    return this.client.post('/plans/dry-run', plan);
  }
}

export default PlanAPI;
```

### 2.4 public/js/api/run-api.js

```javascript
import { APIClient } from './client.js';

class RunAPI {
  static client = new APIClient();

  /**
   * Start migration
   */
  static async start(plan) {
    return this.client.post('/runs', plan);
  }

  /**
   * Get run status
   */
  static async getStatus(runId) {
    return this.client.get(`/runs/${runId}`);
  }

  /**
   * Abort running migration
   */
  static async abort(runId, reason) {
    return this.client.post(`/runs/${runId}/abort`, { reason });
  }

  /**
   * Get per-table results
   */
  static async getTables(runId) {
    return this.client.get(`/runs/${runId}/tables`);
  }

  /**
   * Get errors for specific table
   */
  static async getTableErrors(runId, tableName) {
    return this.client.get(`/runs/${runId}/tables/${tableName}/errors`);
  }
}

export default RunAPI;
```

**Acceptance Criteria for All APIs:**
- [ ] All CRUD operations implemented
- [ ] Error handling with user-friendly messages
- [ ] Timeout handling
- [ ] Request logging
- [ ] 100% unit test coverage

---

## TASK 3: WIZARD CONTROLLER

### public/js/wizard.js

```javascript
import WizardStorage from './utils/storage.js';
import WizardState from './utils/state.js';

/**
 * Central wizard orchestrator
 * Manages step navigation, state, and UI updates
 */
class WizardManager {
  static STEPS = [
    { id: 1, title: 'Discover Schemas', component: 'SchemaUI', path: '/steps/schema-ui.js' },
    { id: 2, title: 'Build Mapping', component: 'MappingUI', path: '/steps/mapping-ui.js' },
    { id: 3, title: 'Create Plan', component: 'PlanUI', path: '/steps/plan-ui.js' },
    { id: 4, title: 'Execute Migration', component: 'RunUI', path: '/steps/run-ui.js' },
    { id: 5, title: 'Results', component: 'ResultsUI', path: '/steps/results-ui.js' }
  ];

  static state = null;
  static currentUIComponent = null;

  /**
   * Initialize wizard on page load
   */
  static async initialize() {
    console.log('[Wizard] Initializing...');

    // Load or create state
    this.state = WizardState.fromJSON(WizardStorage.load());

    // Render main wizard layout
    this.renderWizardLayout();

    // Go to current step (or Step 1 if new)
    await this.goToStep(this.state.currentStep);

    console.log('[Wizard] Ready. Current step:', this.state.currentStep);
  }

  /**
   * Navigate to specific step
   */
  static async goToStep(stepNum) {
    // Validate we can proceed
    if (!this.state.canProceedToStep(stepNum)) {
      console.warn(`[Wizard] Cannot proceed to step ${stepNum} - missing data`);
      alert('Please complete the previous step first.');
      return;
    }

    // If going backward, reset subsequent steps
    if (stepNum < this.state.currentStep) {
      this.state.resetToStep(stepNum);
    }

    this.state.currentStep = stepNum;
    WizardStorage.save(this.state.toJSON());

    const step = this.STEPS[stepNum - 1];
    console.log(`[Wizard] Navigating to step ${stepNum}: ${step.title}`);

    // Update progress bar
    this.updateProgressBar();

    // Load and initialize step component
    await this.loadStepComponent(step);
  }

  /**
   * Proceed to next step
   */
  static async nextStep() {
    if (this.state.currentStep < this.STEPS.length) {
      await this.goToStep(this.state.currentStep + 1);
    }
  }

  /**
   * Go back to previous step
   */
  static async prevStep() {
    if (this.state.currentStep > 1) {
      await this.goToStep(this.state.currentStep - 1);
    }
  }

  /**
   * Load and initialize step UI component
   */
  static async loadStepComponent(step) {
    // Clear previous component
    const container = document.getElementById('wizard-content');
    container.innerHTML = '<div class="loading"><p>Loading step...</p></div>';

    try {
      // Import step module
      const module = await import(step.path);
      const UIClass = module.default;

      // Cleanup previous component if exists
      if (this.currentUIComponent?.destroy) {
        this.currentUIComponent.destroy();
      }

      // Create new component instance
      this.currentUIComponent = new UIClass(this.state);

      // Initialize and render
      container.innerHTML = ''; // Clear loading state
      await this.currentUIComponent.initialize();

    } catch (err) {
      console.error(`[Wizard] Failed to load step ${step.id}:`, err);
      container.innerHTML = `
        <div class="error-panel">
          <h3>⚠ Error Loading Step</h3>
          <p>${err.message}</p>
          <button onclick="location.reload()">Reload Page</button>
        </div>
      `;
    }
  }

  /**
   * Render main wizard layout
   */
  static renderWizardLayout() {
    const wizardEl = document.getElementById('wizard');
    
    wizardEl.innerHTML = `
      <div class="wizard-header">
        <h1>Migration Wizard</h1>
        <p>Migrate data from Firebird to MySQL</p>
      </div>

      <div id="wizard-progress" class="wizard-progress"></div>

      <div id="wizard-content" class="wizard-content"></div>

      <div class="wizard-footer">
        <div class="wizard-actions">
          <button id="btn-back" class="btn-secondary" onclick="WizardManager.prevStep()">
            ← Back
          </button>
          <button id="btn-next" class="btn-primary" disabled>
            Next →
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Update progress bar
   */
  static updateProgressBar() {
    const step = this.STEPS[this.state.currentStep - 1];
    const progress = (this.state.currentStep / this.STEPS.length) * 100;

    document.getElementById('wizard-progress').innerHTML = `
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${progress}%"></div>
        <div class="progress-text">
          Step ${this.state.currentStep} of ${this.STEPS.length}: ${step.title}
        </div>
      </div>
    `;

    // Update button states
    document.getElementById('btn-back').disabled = this.state.currentStep === 1;
  }

  /**
   * Enable next button (called by step component when ready)
   */
  static enableNextButton() {
    document.getElementById('btn-next').disabled = false;
  }

  /**
   * Disable next button
   */
  static disableNextButton() {
    document.getElementById('btn-next').disabled = true;
  }

  /**
   * Save state snapshot
   */
  static saveState() {
    WizardStorage.save(this.state.toJSON());
  }

  /**
   * Clear all wizard state
   */
  static clearSession() {
    if (confirm('Clear all progress and start over?')) {
      WizardStorage.clear();
      location.reload();
    }
  }

  /**
   * Show user message
   */
  static showMessage(message, type = 'info') {
    const banner = document.createElement('div');
    banner.className = `message-banner ${type}`;
    banner.innerHTML = `
      <span>${message}</span>
      <button onclick="this.parentElement.remove()">×</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);

    // Auto-dismiss after 5 seconds
    setTimeout(() => banner.remove(), 5000);
  }

  /**
   * Show error dialog
   */
  static showError(title, message, suggestions = []) {
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.innerHTML = `
      <div class="modal-content">
        <h2>⚠ ${title}</h2>
        <p>${message}</p>
        ${suggestions.length > 0 ? `
          <h4>What to do:</h4>
          <ul>
            ${suggestions.map(s => `<li>${s}</li>`).join('')}
          </ul>
        ` : ''}
        <button class="btn-primary" onclick="this.closest('.modal').remove()">OK</button>
      </div>
    `;
    document.body.appendChild(modal);
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  WizardManager.initialize();
});

export default WizardManager;
```

**Acceptance Criteria:**
- [ ] Loads correct step component
- [ ] Manages state across steps
- [ ] Prevents navigation without data
- [ ] Resets subsequent steps on backward nav
- [ ] Progress bar updates correctly
- [ ] Error handling for component load failures
- [ ] 100% unit test coverage

---

## TASK 4: STEP UI COMPONENTS (public/js/steps/)

### 4.1 public/js/steps/schema-ui.js

```javascript
import SchemaAPI from '../api/schema-api.js';
import WizardManager from '../wizard.js';

/**
 * Step 1: Discover & Cache Database Schemas
 */
class SchemaUI {
  constructor(wizardState) {
    this.state = wizardState;
    this.isDiscovering = false;
  }

  /**
   * Initialize and render Step 1
   */
  async initialize() {
    const container = document.getElementById('wizard-content');

    container.innerHTML = `
      <div class="step-schema">
        <h2>Step 1: Discover Schemas</h2>
        <p class="step-description">
          We'll connect to your Firebird and MySQL databases to discover available tables and columns.
        </p>

        <div class="connection-status">
          <div id="firebird-status" class="status-card loading">
            <h3>Firebird</h3>
            <p class="spinner"></p>
            <p>Connecting...</p>
          </div>

          <div id="mysql-status" class="status-card loading">
            <h3>MySQL</h3>
            <p class="spinner"></p>
            <p>Connecting...</p>
          </div>
        </div>

        <div id="schema-info" class="schema-info hidden">
          <h3>Schema Discovery Complete</h3>
          <p>The following schemas have been cached for use in the mapping builder.</p>
          
          <div class="schema-summary">
            <div class="summary-item">
              <strong id="fb-table-count">0</strong>
              <span>Firebird Tables</span>
            </div>
            <div class="summary-item">
              <strong id="mysql-table-count">0</strong>
              <span>MySQL Tables</span>
            </div>
          </div>
        </div>

        <div id="discovery-error" class="error-panel hidden">
          <h3>⚠ Discovery Failed</h3>
          <p id="error-message"></p>
          <button class="btn-primary" onclick="location.reload()">Retry</button>
        </div>

        <div class="step-footer">
          <small>Cache valid for 5 minutes. <button onclick="SchemaUI_instance.refresh()">Refresh Now</button></small>
        </div>
      </div>
    `;

    // Store reference for inline onclick
    window.SchemaUI_instance = this;

    // Try to discover schemas
    await this.discoverSchemas();
  }

  /**
   * Discover schemas from databases
   */
  async discoverSchemas() {
    this.isDiscovering = true;

    try {
      // Try cache first
      let schema = await SchemaAPI.getCached();

      if (!schema) {
        // Trigger fresh discovery
        schema = await SchemaAPI.refresh();
      }

      this.state.schema = schema;
      this.renderSuccess(schema);
      WizardManager.enableNextButton();

    } catch (err) {
      console.error('[SchemaUI] Discovery failed:', err);
      this.renderError(err.message);
    } finally {
      this.isDiscovering = false;
    }
  }

  /**
   * Render success state
   */
  renderSuccess(schema) {
    // Hide spinners, show summary
    document.getElementById('firebird-status').innerHTML = `
      <h3>✓ Firebird</h3>
      <p>${schema.firebird.tableCount} tables</p>
      <p class="meta">${schema.firebird.columnCount} columns</p>
    `;

    document.getElementById('mysql-status').innerHTML = `
      <h3>✓ MySQL</h3>
      <p>${schema.mysql.tableCount} tables</p>
      <p class="meta">${schema.mysql.columnCount} columns</p>
    `;

    // Show schema info
    document.getElementById('schema-info').classList.remove('hidden');
    document.getElementById('fb-table-count').textContent = schema.firebird.tableCount;
    document.getElementById('mysql-table-count').textContent = schema.mysql.tableCount;

    WizardManager.showMessage('✓ Schemas discovered successfully', 'success');
  }

  /**
   * Render error state
   */
  renderError(message) {
    document.getElementById('discovery-error').classList.remove('hidden');
    document.getElementById('error-message').textContent = message;
  }

  /**
   * Refresh schema cache
   */
  async refresh() {
    this.initialize(); // Restart discovery
  }

  destroy() {
    delete window.SchemaUI_instance;
  }
}

export default SchemaUI;
```

### 4.2 public/js/steps/mapping-ui.js

```javascript
import MappingAPI from '../api/mapping-api.js';
import WizardManager from '../wizard.js';
import FormValidator from '../utils/validator.js';

/**
 * Step 2: Build Mapping Profile
 */
class MappingUI {
  constructor(wizardState) {
    this.state = wizardState;
    this.schema = wizardState.schema;
    this.mapping = wizardState.mapping || this.createBlankMapping();
    this.selectedTables = new Set(Object.keys(this.mapping.tables));
    this.currentTable = null;
  }

  /**
   * Initialize Step 2
   */
  async initialize() {
    const container = document.getElementById('wizard-content');

    container.innerHTML = `
      <div class="step-mapping">
        <h2>Step 2: Build Mapping Profile</h2>
        <p class="step-description">
          Select which Firebird tables to migrate and configure column mappings.
        </p>

        <div class="mapping-form">
          <div class="profile-header">
            <div class="form-group">
              <label for="profile-name">Profile Name:</label>
              <input 
                type="text" 
                id="profile-name" 
                value="${this.mapping.name || 'New Profile'}"
                placeholder="e.g., Production Migration v1">
            </div>

            <div class="form-group checkbox">
              <label>
                <input type="checkbox" id="save-profile">
                Save this profile to reuse in future migrations
              </label>
            </div>
          </div>

          <div class="table-selector">
            <h3>Select Tables to Map</h3>
            <input 
              type="text" 
              id="table-filter" 
              placeholder="Search tables..."
              onkeyup="MappingUI_instance.filterTables(this.value)">

            <div class="table-list" id="table-list"></div>

            <div class="table-actions">
              <button class="btn-small" onclick="MappingUI_instance.selectAllTables()">Select All</button>
              <button class="btn-small" onclick="MappingUI_instance.deselectAllTables()">Deselect All</button>
            </div>
          </div>

          <div class="field-editor" id="field-editor"></div>

          <div id="validation-panel" class="validation-panel"></div>
        </div>
      </div>
    `;

    window.MappingUI_instance = this;

    // Render table list
    this.renderTableList();

    // Select first table
    if (this.selectedTables.size > 0) {
      this.currentTable = Array.from(this.selectedTables)[0];
      this.renderFieldEditor();
    }

    // Validate on load
    this.validate();
  }

  /**
   * Render table selection list
   */
  renderTableList() {
    const fbTables = this.schema.firebird.tables || [];
    let html = '';

    for (const fbTable of fbTables) {
      const sourceName = fbTable.name;
      const isSelected = this.selectedTables.has(sourceName);
      const targetName = this.mapping.tables[sourceName]?.targetTable || fbTable.name.toLowerCase();
      const status = this.getTableStatus(sourceName);

      html += `
        <label class="table-row">
          <input type="checkbox" 
                 value="${sourceName}"
                 ${isSelected ? 'checked' : ''}
                 onchange="MappingUI_instance.onTableSelected(this)">
          <span class="source">${sourceName}</span>
          <span class="arrow">→</span>
          <input type="text" 
                 class="target-input"
                 value="${targetName}"
                 data-source="${sourceName}"
                 onchange="MappingUI_instance.onTargetTableChanged(this)"
                 placeholder="Target table">
          <span class="status-badge ${status.class}">${status.label}</span>
        </label>
      `;
    }

    document.getElementById('table-list').innerHTML = html;
  }

  /**
   * Handle table selection change
   */
  onTableSelected(checkbox) {
    const source = checkbox.value;

    if (checkbox.checked) {
      this.selectedTables.add(source);
    } else {
      this.selectedTables.delete(source);
    }

    // Initialize mapping for selected tables
    for (const table of this.selectedTables) {
      if (!this.mapping.tables[table]) {
        this.mapping.tables[table] = {
          targetTable: table.toLowerCase(),
          columns: {}
        };
      }
    }

    // Show field editor for first selected table
    if (this.selectedTables.size > 0 && !this.currentTable) {
      this.currentTable = Array.from(this.selectedTables)[0];
    }

    this.renderFieldEditor();
    this.validate();
  }

  /**
   * Render field mapping editor for current table
   */
  renderFieldEditor() {
    if (!this.currentTable) {
      document.getElementById('field-editor').innerHTML = '';
      return;
    }

    const fbTable = this.schema.firebird.tables.find(t => t.name === this.currentTable);
    const config = this.mapping.tables[this.currentTable];
    const mysqlTable = this.schema.mysql.tables.find(t => t.name === config.targetTable);

    let html = `
      <div class="field-editor">
        <h3>Field Mapping: ${this.currentTable}</h3>
        <p>Map source columns to target columns</p>

        <table class="field-table">
          <thead>
            <tr>
              <th>Source Column</th>
              <th>Type</th>
              <th>→</th>
              <th>Target Column</th>
              <th>Transform</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const fbCol of fbTable.columns || []) {
      const fieldMap = config.columns[fbCol.name] || {};
      const mysqlCols = mysqlTable?.columns || [];

      html += `
        <tr>
          <td>${fbCol.name}</td>
          <td class="type-badge">${fbCol.dataType}</td>
          <td>→</td>
          <td>
            <select class="target-col" 
                    data-source="${fbCol.name}"
                    onchange="MappingUI_instance.onFieldMappingChanged(this)">
              <option value="">-- Select --</option>
              ${mysqlCols.map(col => `
                <option value="${col.name}" 
                        ${fieldMap.targetColumn === col.name ? 'selected' : ''}>
                  ${col.name}
                </option>
              `).join('')}
            </select>
          </td>
          <td>
            <select class="transform" 
                    data-source="${fbCol.name}"
                    onchange="MappingUI_instance.onFieldMappingChanged(this)">
              <option value="">None</option>
              <option value="trim" ${fieldMap.transform === 'trim' ? 'selected' : ''}>Trim</option>
              <option value="toNumber" ${fieldMap.transform === 'toNumber' ? 'selected' : ''}>To Number</option>
              <option value="toDate" ${fieldMap.transform === 'toDate' ? 'selected' : ''}>To Date</option>
            </select>
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
   * Handle field mapping change
   */
  onFieldMappingChanged(element) {
    const source = element.dataset.source;
    const row = element.closest('tr');
    const targetCol = row.querySelector('.target-col').value;
    const transform = row.querySelector('.transform').value;

    if (!this.mapping.tables[this.currentTable].columns[source]) {
      this.mapping.tables[this.currentTable].columns[source] = {};
    }

    this.mapping.tables[this.currentTable].columns[source].targetColumn = targetCol;
    this.mapping.tables[this.currentTable].columns[source].transform = transform || null;

    this.validate();
  }

  /**
   * Validate mapping completeness
   */
  validate() {
    const validation = FormValidator.validateMapping(this.mapping, this.schema);

    if (!validation.valid) {
      this.renderValidationErrors(validation.errors);
      WizardManager.disableNextButton();
    } else if (validation.warnings.length > 0) {
      this.renderValidationWarnings(validation.warnings);
      WizardManager.enableNextButton();
    } else {
      this.renderValidationSuccess();
      WizardManager.enableNextButton();
    }
  }

  /**
   * Render validation panel
   */
  renderValidationSuccess() {
    document.getElementById('validation-panel').innerHTML = `
      <div class="validation-success">
        <h4>✓ Mapping is complete</h4>
        <p>All selected tables have field mappings.</p>
      </div>
    `;
  }

  renderValidationErrors(errors) {
    const html = `
      <div class="validation-error">
        <h4>✗ Mapping has errors</h4>
        <ul>${errors.map(e => `<li>${e}</li>`).join('')}</ul>
      </div>
    `;
    document.getElementById('validation-panel').innerHTML = html;
  }

  renderValidationWarnings(warnings) {
    const html = `
      <div class="validation-warning">
        <h4>⚠ Mapping has warnings</h4>
        <ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul>
        <p>You can proceed, but review these carefully.</p>
      </div>
    `;
    document.getElementById('validation-panel').innerHTML = html;
  }

  /**
   * Helper: Get table status icon
   */
  getTableStatus(source) {
    const config = this.mapping.tables[source];
    if (!config || Object.keys(config.columns || {}).length === 0) {
      return { label: '○ Not Started', class: 'pending' };
    }
    return { label: '✓ Mapped', class: 'success' };
  }

  /**
   * Save mapping and proceed
   */
  async saveMappingAndNext() {
    this.mapping.name = document.getElementById('profile-name').value;
    const shouldSave = document.getElementById('save-profile').checked;

    this.state.mapping = this.mapping;

    if (shouldSave && !this.mapping.id) {
      // Create new profile
      const created = await MappingAPI.create(this.mapping);
      this.mapping.id = created.id;
      WizardManager.showMessage('✓ Mapping profile saved', 'success');
    }

    WizardManager.saveState();
    await WizardManager.nextStep();
  }

  // ... Additional helper methods: filterTables, selectAllTables, etc.

  createBlankMapping() {
    return {
      id: null,
      name: 'New Profile',
      tables: {},
      createdAt: new Date().toISOString()
    };
  }

  destroy() {
    delete window.MappingUI_instance;
  }
}

export default MappingUI;
```

**Acceptance Criteria for Steps 2-5:**
- [ ] Initialize with wizard state data
- [ ] Render proper form/UI for step
- [ ] Real-time validation
- [ ] Enable/disable next button
- [ ] Save state on change
- [ ] Error handling and display
- [ ] Clean up on destroy
- [ ] 100% unit test coverage for non-async logic

---

## TASK 5: STYLING & RESPONSIVE DESIGN

### public/css/wizard.css

[See main UI Refactoring Plan for complete CSS]

**Acceptance Criteria:**
- [ ] Mobile-responsive (tested on 320px+)
- [ ] Dark mode support
- [ ] WCAG 2.1 AA color contrast
- [ ] Accessible focus indicators
- [ ] Print-friendly
- [ ] Smooth animations (not distracting)

---

## TASK 6: TESTING

### Unit Tests Example Structure

```
tests/
├── unit/
│   ├── wizard.test.js
│   ├── state.test.js
│   ├── validator.test.js
│   ├── api/
│   │   ├── client.test.js
│   │   ├── schema-api.test.js
│   │   └── mapping-api.test.js
│   └── steps/
│       ├── schema-ui.test.js
│       ├── mapping-ui.test.js
│       └── plan-ui.test.js
│
├── integration/
│   ├── wizard-flow.test.js
│   ├── state-persistence.test.js
│   └── api-integration.test.js
│
└── e2e/
    └── full-migration-workflow.test.js
```

**Acceptance Criteria:**
- [ ] 80%+ code coverage
- [ ] All validators have unit tests
- [ ] All APIs mocked and tested
- [ ] Wizard navigation tested
- [ ] State persistence tested
- [ ] Error scenarios covered
- [ ] E2E workflow tested end-to-end

---

## IMPLEMENTATION ORDER

1. **Utilities** (storage, state, validator, api client) - Foundation
2. **API Clients** (schema, mapping, plan, run APIs) - Data layer
3. **Wizard Controller** (wizard.js) - Navigation/orchestration
4. **Step 1 UI** (schema-ui.js) - Simplest step
5. **Step 2 UI** (mapping-ui.js) - Complex but core
6. **Step 3 UI** (plan-ui.js) - Builds on Step 2
7. **Step 4 UI** (run-ui.js) - Real-time updates
8. **Step 5 UI** (results-ui.js) - Data display
9. **Styling** (CSS files) - Visual polish
10. **Testing** (unit + integration + E2E) - Quality assurance

---

## SUCCESS METRICS

After Phase 2 (UI) completion:

✅ **User Experience**
- Users can complete migration in < 10 minutes
- Clear error messages guide toward solutions
- Progress is always visible
- No confusion about what to do next

✅ **Code Quality**
- All components independently testable
- No circular dependencies
- Clear separation of concerns
- < 300 lines per UI component

✅ **Accessibility**
- Keyboard navigation works throughout
- Screen reader compatible
- Color contrast ≥ 4.5:1
- Focus indicators visible

✅ **Performance**
- Page load < 2 seconds
- Step transitions < 500ms
- No jank on progress updates
- API calls timeout gracefully

