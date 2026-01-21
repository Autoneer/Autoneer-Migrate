/**
 * PlanUI - Step 3: Create Migration Plan
 * 
 * Handles migration plan creation, table selection,
 * dry-run simulation, and validation.
 */
class PlanUI {
	constructor(wizard) {
		this.wizard = wizard;
		this.state = window.WizardState;
		this.api = window.PlanAPI;
		this.mapping = null;
		this.plan = null;
		this.dryRunResults = null;
	}

	/**
	 * Initialize plan builder
	 */
	async initialize() {
		console.log('Initializing Plan Builder...');

		// Get mapping from previous step
		this.mapping = this.state.get('mapping');
		if (!this.mapping || !this.mapping.tables) {
			this.wizard.showError('Mapping not available. Please go back to Step 2.');
			return;
		}

		// Try to load existing plan
		this.plan = this.state.get('plan');

		if (!this.plan || !this.plan.name) {
			// Create new plan from mapping
			this.plan = {
				id: null,
				name: `Plan ${new Date().toLocaleDateString()}`,
				mappingId: this.mapping.id,
				tables: Object.keys(this.mapping.tables),
				config: {
					batchSize: 1000,
					continueOnError: false,
					validateData: true
				}
			};
		} else if (Array.isArray(this.plan.tables) && this.plan.tables.length === 0) {
			// Repair empty plan tables from current mapping
			this.plan.tables = Object.keys(this.mapping.tables);
		}

		// Persist plan so wizard validation sees selected tables
		this.state.setPlan(this.plan);
		this.wizard.renderNavigation();

		this.render();
	}

	/**
	 * Render plan builder UI
	 */
	render() {
		const container = document.getElementById('plan-content');
		if (!container) return;

		container.innerHTML = `
      <div class="plan-builder">
        <h2>Create Migration Plan</h2>
        <p>Review and configure the migration execution plan</p>
        
        <!-- Plan Settings -->
        <div class="plan-settings">
          <div class="form-group">
            <label for="plan-name">Plan Name:</label>
            <input type="text" id="plan-name" class="form-control" 
                   value="${this.plan.name}" 
                   placeholder="Enter plan name">
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label for="batch-size">Batch Size:</label>
              <input type="number" id="batch-size" class="form-control" 
                     value="${this.plan.config.batchSize}" 
                     min="100" max="10000" step="100">
              <small>Number of rows to migrate per batch</small>
            </div>
            
            <div class="form-group">
              <label>
                <input type="checkbox" id="continue-on-error" 
                       ${this.plan.config.continueOnError ? 'checked' : ''}>
                Continue on Error
              </label>
              <small>Keep migrating other tables if one fails</small>
            </div>
            
            <div class="form-group">
              <label>
                <input type="checkbox" id="validate-data" 
                       ${this.plan.config.validateData ? 'checked' : ''}>
                Validate Data
              </label>
              <small>Validate data types and constraints</small>
            </div>
          </div>
        </div>
        
        <!-- Table Selection and Order -->
        <div class="table-plan">
          <div class="form-group">
            <label for="plan-profile-name">Save as Profile:</label>
            <input type="text" id="plan-profile-name" class="form-control" 
                   value="${this.plan.name || this.mapping?.name || ''}" 
                   placeholder="Enter profile name for this migration run">
            <small>This name will be used to save and track the migration run</small>
          </div>
          
          <h3>Tables to Migrate (in order)</h3>
          <p class="help-text">Drag to reorder tables or use ↑↓ buttons</p>
          
          <table class="plan-table">
            <thead>
              <tr>
                <th width="50">#</th>
                <th>Table Name</th>
                <th>Source → Target</th>
                <th>Fields Mapped</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="plan-table-list">
              ${this.renderPlanTables()}
            </tbody>
          </table>
        </div>
        
        <!-- Dry Run Section -->
        <div class="dry-run-section">
          <h3>Test Migration (Dry Run)</h3>
          <p>Run a simulation to validate the plan without migrating data</p>
          
          <button class="btn btn-secondary" onclick="window.wizard.steps[2].component.runDryRun()">
            🧪 Run Dry Run
          </button>
          
          <div id="dry-run-results" style="display: none;">
            ${this.renderDryRunResults()}
          </div>
        </div>
        
        <!-- Validation Summary -->
        <div id="plan-validation" class="validation-summary"></div>
      </div>
    `;

		this.attachEventListeners();
		this.updateValidation();
	}

	/**
	 * Render plan tables
	 */
	renderPlanTables() {
		return this.plan.tables.map((tableName, index) => {
			const tableConfig = this.mapping.tables[tableName];
			const fieldCount = Object.keys(tableConfig?.columns || {}).length;

			return `
        <tr data-table="${tableName}">
          <td>${index + 1}</td>
          <td><strong>${tableName}</strong></td>
          <td>${tableName} → ${tableConfig?.targetTable || '?'}</td>
          <td>${fieldCount} fields</td>
          <td>
            <button class="btn btn-sm btn-secondary" 
                    onclick="window.wizard.steps[2].component.moveUp(${index})"
                    ${index === 0 ? 'disabled' : ''}>
              ↑
            </button>
            <button class="btn btn-sm btn-secondary" 
                    onclick="window.wizard.steps[2].component.moveDown(${index})"
                    ${index === this.plan.tables.length - 1 ? 'disabled' : ''}>
              ↓
            </button>
            <button class="btn btn-sm btn-danger" 
                    onclick="window.wizard.steps[2].component.removeTable(${index})">
              ✕
            </button>
          </td>
        </tr>
      `;
		}).join('');
	}

	/**
	 * Attach event listeners
	 */
	attachEventListeners() {
		// Plan name
		const planName = document.getElementById('plan-name');
		if (planName) {
			planName.addEventListener('input', (e) => {
				this.plan.name = e.target.value;
				this.state.set('plan.name', e.target.value);
			});
		}

		// Batch size
		const batchSize = document.getElementById('batch-size');
		if (batchSize) {
			batchSize.addEventListener('change', (e) => {
				this.plan.config.batchSize = parseInt(e.target.value, 10);
				this.state.set('plan.config.batchSize', this.plan.config.batchSize);
			});
		}

		// Profile name (save as) - scoped to plan step
		const container = document.getElementById('plan-content');
		const profileName = container?.querySelector('#plan-profile-name');
		if (profileName) {
			profileName.addEventListener('input', (e) => {
				this.plan.name = e.target.value;
				this.state.set('plan.name', this.plan.name);
			});
		}

		// Continue on error
		const continueOnError = document.getElementById('continue-on-error');
		if (continueOnError) {
			continueOnError.addEventListener('change', (e) => {
				this.plan.config.continueOnError = e.target.checked;
				this.state.set('plan.config.continueOnError', e.target.checked);
			});
		}

		// Validate data
		const validateData = document.getElementById('validate-data');
		if (validateData) {
			validateData.addEventListener('change', (e) => {
				this.plan.config.validateData = e.target.checked;
				this.state.set('plan.config.validateData', e.target.checked);
			});
		}
	}

	/**
	 * Move table up in order
	 */
	moveUp(index) {
		if (index > 0) {
			[this.plan.tables[index], this.plan.tables[index - 1]] =
				[this.plan.tables[index - 1], this.plan.tables[index]];

			this.state.setPlan(this.plan);
			this.render();
		}
	}

	/**
	 * Move table down in order
	 */
	moveDown(index) {
		if (index < this.plan.tables.length - 1) {
			[this.plan.tables[index], this.plan.tables[index + 1]] =
				[this.plan.tables[index + 1], this.plan.tables[index]];

			this.state.setPlan(this.plan);
			this.render();
		}
	}

	/**
	 * Remove table from plan
	 */
	removeTable(index) {
		if (confirm(`Remove ${this.plan.tables[index]} from plan?`)) {
			this.plan.tables.splice(index, 1);
			this.state.setPlan(this.plan);
			this.render();
		}
	}

	/**
	 * Run dry-run simulation
	 */
	async runDryRun() {
		this.wizard.showLoading('Running dry-run simulation...');

		try {
			// Ensure we have a mapping ID before creating plan
			if (!this.mapping?.id) {
				console.error('[PlanUI] No mapping ID found. Mapping:', this.mapping);
				this.wizard.showError('No mapping profile found. Please save your mapping in Step 2 first.');
				return;
			}

			// Read current plan name from input before API calls
			const container = document.getElementById('plan-content');
			const planNameInput = container?.querySelector('#plan-profile-name');
			if (planNameInput) {
				this.plan.name = planNameInput.value.trim();
			}

			console.log('[PlanUI] Running dry run with plan:', { name: this.plan.name, id: this.plan.id, mappingId: this.mapping.id });

			// Create or update plan first to ensure it's persisted
			let planId = this.plan.id;

			const fullPayload = {
				name: this.plan.name,
				mappingId: this.mapping.id,
				tables: this.plan.tables || [],
				config: this.plan.config
			};

			if (planId) {
				// Update existing plan
				await this.api.update(planId, fullPayload);
				console.log('[PlanUI] Updated plan:', planId);
			} else {
				// Create new plan
				const created = await this.api.create(fullPayload);
				planId = created.id;
				this.plan.id = planId;
				this.state.setPlan(this.plan);
				console.log('[PlanUI] Created plan:', planId);
			}

			// Run dry-run (without tableName for plan-level dry run)
			this.dryRunResults = await this.api.dryRun(planId);

			// Render results
			const resultsDiv = document.getElementById('dry-run-results');
			if (resultsDiv) {
				resultsDiv.innerHTML = this.renderDryRunResults();
				resultsDiv.style.display = 'block';
				resultsDiv.scrollIntoView({ behavior: 'smooth' });
			}

		} catch (err) {
			console.error('Dry run failed:', err);
			this.wizard.showError(`Dry run failed: ${err.message}`);
		} finally {
			this.wizard.hideLoading();
		}
	}

	/**
	 * Render dry-run results
	 */
	renderDryRunResults() {
		if (!this.dryRunResults) {
			return '<p>No dry-run results available</p>';
		}

		const results = this.dryRunResults.results || this.dryRunResults;
		const hasErrors = results.errors && results.errors.length > 0;
		const hasWarnings = results.warnings && results.warnings.length > 0;
		const perTable = results.perTable || [];

		return `
      <div class="dry-run-results">
        <h4>Dry Run Results ${hasErrors ? '❌' : '✓'}</h4>
        
        <div class="results-summary">
          <div class="stat">
            <strong>${results.tableCount || 0}</strong>
            <span>Tables</span>
          </div>
          <div class="stat">
            <strong>${results.estimatedRows || results.totals?.estimatedRows || 0}</strong>
            <span>Estimated Rows</span>
          </div>
          <div class="stat">
            <strong>${results.estimatedTime || 'Unknown'}</strong>
            <span>Est. Duration</span>
          </div>
        </div>
        
        ${perTable.length > 0 ? `
          <div class="per-table-results">
            <h5>Per-Table Summary</h5>
            <table class="plan-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Est. Rows</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${perTable.map(t => `
                  <tr>
                    <td>${t.tableName}</td>
                    <td>${t.estimatedRows || 0}</td>
                    <td>
                      ${t.errors.length > 0 ? '<span class="status-badge status-warning">❌ Errors</span>' : ''}
                      ${t.warnings.length > 0 ? '<span class="status-badge status-warning">⚠ Warnings</span>' : ''}
                      ${t.errors.length === 0 && t.warnings.length === 0 ? '<span class="status-badge status-success">✓ OK</span>' : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}
        
        ${hasErrors ? `
          <div class="dry-run-errors">
            <h5>⚠ Errors Found</h5>
            <ul>
              ${results.errors.map(err => `<li>${err}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        
        ${hasWarnings ? `
          <div class="dry-run-warnings">
            <h5>⚠ Warnings</h5>
            <ul>
              ${results.warnings.map(warn => `<li>${warn}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        
        ${!hasErrors && !hasWarnings ? `
          <div class="dry-run-success">
            <p>✓ Plan validated successfully. Ready to execute migration.</p>
          </div>
        ` : ''}
      </div>
    `;
	}

	/**
	 * Update validation summary
	 */
	updateValidation() {
		const summary = document.getElementById('plan-validation');
		if (!summary) return;

		const errors = [];

		if (!this.plan.name || this.plan.name.trim() === '') {
			errors.push('Plan name is required');
		}

		if (this.plan.tables.length === 0) {
			errors.push('At least one table must be selected');
		}

		if (errors.length > 0) {
			summary.innerHTML = `
        <div class="validation-errors">
          <h4>⚠ Errors</h4>
          <ul>
            ${errors.map(err => `<li>${err}</li>`).join('')}
          </ul>
        </div>
      `;
		} else {
			summary.innerHTML = `
        <div class="validation-success">
          <h4>✓ Plan Valid</h4>
          <p>Migration plan is ready. Run a dry-run to validate or proceed to execution.</p>
        </div>
      `;
		}
	}

	/**
	 * Validate before proceeding
	 */
	async onNext() {
		this.wizard.clearMessages();

		if (!this.plan.name || this.plan.name.trim() === '') {
			this.wizard.showError('Plan name is required');
			return false;
		}

		if (this.plan.tables.length === 0) {
			this.wizard.showError('At least one table must be selected');
			return false;
		}

		// Create/update plan
		try {
			this.wizard.showLoading('Saving migration plan...');

			if (this.plan.id) {
				await this.api.update(this.plan.id, this.plan);
			} else {
				const created = await this.api.create({
					name: this.plan.name,
					mappingId: this.mapping?.id
				});
				this.plan.id = created.id;
			}

			this.state.setPlan(this.plan);
			this.wizard.hideLoading();

			return true;

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to save plan: ${err.message}`);
			return false;
		}
	}

	/**
	 * Handle previous button
	 */
	async onPrevious() {
		this.state.setPlan(this.plan);
		return true;
	}
}

// Export to window
window.PlanUI = PlanUI;
