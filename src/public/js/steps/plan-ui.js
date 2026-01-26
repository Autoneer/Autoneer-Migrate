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
			this.wizard.showError('Mapping not available. Go back to Step 2 to save a mapping profile, then return to Step 3.');
			return;
		}

		// Try to load existing plan from state
		let planFromState = this.state.get('plan') || {};

		// If planId exists, reload from DB to ensure we have latest state
		if (planFromState.id) {
			console.log('[PlanUI] Reloading plan from DB:', planFromState.id);
			try {
				const reloadedPlan = await this.api.getById(planFromState.id);
				if (reloadedPlan) {
					planFromState = reloadedPlan;
					// Set tableConfigs from reloaded plan
					if (reloadedPlan.tableConfigs) {
						planFromState.tableConfigs = reloadedPlan.tableConfigs;
					}
					console.log('[PlanUI] Plan reloaded from DB');
				}
			} catch (err) {
				console.warn('[PlanUI] Failed to reload plan from DB, using local state:', err);
			}
		}

		this.plan = planFromState;

		const DEFAULT_PLAN_CONFIG = {
			batchSize: 1000,
			continueOnError: false,
			validateData: true
		};

		this.plan.config = {
			...DEFAULT_PLAN_CONFIG,
			...(this.plan.config || {})
		};

		if (!Array.isArray(this.plan.tables)) {
			this.plan.tables = [];
		}

		// Default to TARGET table names (not source keys)
		if (this.plan.tables.length === 0) {
			this.plan.tables = Object.entries(this.mapping.tables || {})
				.map(([src, cfg]) => (cfg?.targetTable || cfg?.target || '').toUpperCase())
				.filter(Boolean);
		}

		// CRITICAL: Normalize existing tables to TARGET names (fix reused plans with source keys)
		// This fixes "0 fields mapped" when plan contains WORKDONE instead of WORK_DONE
		if (this.plan.tables.length > 0 && window.TableNameUtils) {
			const normalizedTables = window.TableNameUtils.normalizePlanTables(this.plan.tables, this.mapping);
			if (JSON.stringify(normalizedTables) !== JSON.stringify(this.plan.tables)) {
				console.warn('[PlanUI] Normalized plan tables to targets:', { before: this.plan.tables, after: normalizedTables });
				this.plan.tables = normalizedTables;
			}
		}

		if (!this.plan.name || this.plan.name.trim() === '') {
			const baseName = this.mapping?.name ? this.mapping.name : 'Plan';
			this.plan.name = `${baseName} ${new Date().toLocaleDateString()}`;
		}

		if (this.mapping?.mappingProfileId || this.mapping?.id) {
			this.plan.mappingProfileId = this.mapping.mappingProfileId || this.mapping.id;
		}

		// Load per-table configs
		if (!this.plan.tableConfigs) {
			this.plan.tableConfigs = this.state.get('plan.tableConfigs') || {};
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

		const DEFAULT_PLAN_CONFIG = {
			batchSize: 1000,
			continueOnError: false,
			validateData: true
		};

		const planName = this.plan?.name || '';
		const config = {
			...DEFAULT_PLAN_CONFIG,
			...(this.plan?.config || {})
		};
		const tables = Array.isArray(this.plan?.tables) ? this.plan.tables : [];

		const mappingProfileName = this.mapping?.name || 'Not set';

		container.innerHTML = `
      <div class="plan-builder">
        <h2>Create Migration Plan</h2>

        
        <!-- Plan Settings -->
        <div class="plan-settings">
					<div class="form-group" style="display:flex;flex-direction:column;">
						<div style="display:flex;align-items:center;gap:0.5rem;">
							<label for="plan-name" style="margin:0;white-space:nowrap;">Plan Name:</label>
							<input type="text" id="plan-name" class="form-control" 
									 value="${planName}" 
									 placeholder="Enter plan name" style="flex:1;min-width:160px;">
						</div>
					</div>

					<div class="form-group" style="display:flex;flex-direction:column;">
						<div style="display:flex;align-items:center;gap:0.5rem;">
							<label for="mapping-profile-display" style="margin:0;white-space:nowrap;">Mapping Profile:</label>
							<input type="text" id="mapping-profile-display" class="form-control" 
									 value="${mappingProfileName}" disabled style="flex:1;min-width:160px;">
						</div>
						<small style="margin-top:0.4rem;">Using the profile saved in Step 2</small>
					</div>
          
					<div class="form-row" style="display:flex;gap:1rem;flex-wrap:wrap;">
						<div class="form-group" style="flex:1;min-width:220px;display:flex;flex-direction:column;">
							<div style="display:flex;align-items:center;gap:0.5rem;">
								<label for="batch-size" style="margin:0;white-space:nowrap;">Batch Size:</label>
								<input type="number" id="batch-size" class="form-control" 
																					 value="${config.batchSize}" 
											 min="100" max="10000" step="100" style="flex:1;min-width:80px;">
							</div>
							<small style="margin-top:0.4rem;">Number of rows to migrate per batch</small>
						</div>
            
						<div class="form-group" style="flex:1;min-width:220px;display:flex;flex-direction:column;">
							<label style="display:inline-flex;align-items:center;">
								<input type="checkbox" id="continue-on-error" 
											${config.continueOnError ? 'checked' : ''} style="margin-right:0.5rem;">
								Continue on Error
							</label>
							<small style="margin-top:0.4rem;">Keep migrating other tables if one fails</small>
						</div>
            
						<div class="form-group" style="flex:1;min-width:220px;display:flex;flex-direction:column;">
							<label style="display:inline-flex;align-items:center;">
								<input type="checkbox" id="validate-data" 
																						 ${config.validateData ? 'checked' : ''} style="margin-right:0.5rem;">
								Validate Data
							</label>
							<small style="margin-top:0.4rem;">Validate data types and constraints</small>
						</div>
					</div> 
        </div>
        
        <!-- Table Selection and Order -->
				<div class="table-plan">
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
							${this.renderPlanTables(tables)}
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
	renderPlanTables(tables) {
		return tables.map((targetTableName, index) => {
			// tables array now contains TARGET table names (e.g., WORK_DONE)
			// Find the source table entry in mapping by matching targetTable
			let sourceTableName = targetTableName;
			let tableConfig = null;

			// Search mapping.tables to find entry where targetTable matches
			if (this.mapping?.tables) {
				for (const [srcName, cfg] of Object.entries(this.mapping.tables)) {
					if ((cfg?.targetTable || '').toUpperCase() === targetTableName.toUpperCase()) {
						sourceTableName = srcName;
						tableConfig = cfg;
						break;
					}
				}
			}

			const fieldCount = Object.keys(tableConfig?.columns || {}).length;

			return `
        <tr data-table="${targetTableName}">
          <td>${index + 1}</td>
          <td><strong>${targetTableName}</strong></td>
          <td>${sourceTableName} → ${targetTableName}</td>
          <td>${fieldCount} fields</td>
          <td>
            <button class="btn btn-sm btn-secondary" 
                    onclick="window.wizard.steps[2].component.moveUp(${index})"
                    ${index === 0 ? 'disabled' : ''}>
              ↑
            </button>
            <button class="btn btn-sm btn-secondary" 
                    onclick="window.wizard.steps[2].component.moveDown(${index})"
					${index === (tables.length - 1) ? 'disabled' : ''}>
              ↓
            </button>
            <button class="btn btn-sm btn-info" 
                    onclick="window.wizard.steps[2].component.showTableOptions(${index})">
              ⚙ Options
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
		if (!this.plan.config) {
			this.plan.config = {
				batchSize: 1000,
				continueOnError: false,
				validateData: true
			};
		}

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

		// Mapping profile display is read-only

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
	 * Show per-table advanced options modal
	 */
	showTableOptions(index) {
		const tableName = this.plan.tables[index];
		if (!tableName) return;

		if (!this.plan.tableConfigs) {
			this.plan.tableConfigs = {};
		}
		if (!this.plan.tableConfigs[tableName]) {
			this.plan.tableConfigs[tableName] = {};
		}

		const config = this.plan.tableConfigs[tableName];
		const batchSize = config.batchSize || this.plan.config?.batchSize || 1000;
		const cleanBefore = config.cleanBefore || false;

		const html = `
			<div class="table-options-modal" style="padding:0;">
				<h3 style="margin-top:0;">Advanced Options: ${tableName}</h3>
				<div style="margin-top:1.5rem;">
					<div class="form-group">
						<label for="table-batch-size-${index}" style="display:block;margin-bottom:0.5rem;">
							<strong>Batch Size (rows per write):</strong>
						</label>
						<input type="number" id="table-batch-size-${index}" class="form-control" 
						       value="${batchSize}" min="100" max="10000" step="100">
						<small>Override global batch size for this table. Leave blank to use plan default (${this.plan.config?.batchSize || 1000}).</small>
					</div>
					<div class="form-group" style="margin-top:1rem;">
						<label style="display:inline-flex;align-items:center;">
							<input type="checkbox" id="table-clean-before-${index}" 
							       ${cleanBefore ? 'checked' : ''} style="margin-right:0.5rem;">
							<strong>Clean target table before migrate</strong>
						</label>
						<small style="display:block;margin-top:0.5rem;">
							Deletes all rows in the target table before inserting. Use with caution.
						</small>
					</div>
				</div>
			</div>
		`;

		const modal = document.createElement('div');
		modal.innerHTML = html;

		const confirmBtn = document.createElement('button');
		confirmBtn.className = 'btn btn-primary';
		confirmBtn.textContent = 'Save';
		confirmBtn.onclick = () => this.saveTableOptions(index, overlay);

		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'btn btn-secondary';
		cancelBtn.textContent = 'Cancel';
		cancelBtn.onclick = () => overlay.remove();

		const footer = document.createElement('div');
		footer.style.marginTop = '1.5rem';
		footer.style.display = 'flex';
		footer.style.gap = '0.5rem';
		footer.appendChild(confirmBtn);
		footer.appendChild(cancelBtn);
		modal.querySelector('.table-options-modal').appendChild(footer);

		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
		const dialogBox = document.createElement('div');
		dialogBox.className = 'modal-dialog';
		dialogBox.style.cssText = 'background:white;border-radius:8px;padding:1.5rem;max-width:500px;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
		dialogBox.appendChild(modal.querySelector('.table-options-modal'));
		overlay.appendChild(dialogBox);
		overlay.onclick = (e) => {
			if (e.target === overlay) overlay.remove();
		};

		document.body.appendChild(overlay);
	}

	/**
	 * Save per-table options
	 */
	saveTableOptions(index, overlay) {
		const tableName = this.plan.tables[index];
		if (!tableName) return;

		if (!this.plan.tableConfigs) {
			this.plan.tableConfigs = {};
		}

		const batchSizeInput = document.getElementById(`table-batch-size-${index}`);
		const cleanBeforeInput = document.getElementById(`table-clean-before-${index}`);

		const config = {};
		if (batchSizeInput && batchSizeInput.value.trim()) {
			config.batchSize = parseInt(batchSizeInput.value, 10);
		}
		if (cleanBeforeInput) {
			config.cleanBefore = cleanBeforeInput.checked;
		}

		this.plan.tableConfigs[tableName] = config;
		this.state.set(`plan.tableConfigs.${tableName}`, config);

		// Close modal
		overlay.remove();

		// Show success message
		// this.wizard.showSuccess(`Updated options for ${tableName}`);
	}

	/**
	 * Remove table from plan
	 */
	async removeTable(index) {
		const confirmed = await Modal.confirm({
			title: 'Remove Table',
			message: `Remove ${this.plan.tables[index]} from plan?`,
			type: 'warning',
			confirmText: 'Remove',
			cancelText: 'Cancel'
		});

		if (confirmed) {
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
			// CRITICAL: Determine mappingProfileId with strict precedence
			let mappingProfileId = null;

			// If plan exists in DB, reload to get its mappingProfileId
			if (this.plan?.id) {
				try {
					const reloadedPlan = await this.api.getById(this.plan.id);
					if (reloadedPlan?.mappingProfileId) {
						mappingProfileId = reloadedPlan.mappingProfileId;
					}
				} catch (err) {
					console.warn('[PlanUI] Could not reload plan for mappingProfileId:', err);
				}
			}

			// Fall back to state mapping
			if (!mappingProfileId) {
				mappingProfileId = this.state.get('mappingProfileId') || this.mapping?.mappingProfileId || this.mapping?.id;
			}

			// HARD BLOCK: No mapping = no dry run
			if (!mappingProfileId) {
				console.error('[PlanUI] No mapping profile ID found. Mapping:', this.mapping);
				this.wizard.hideLoading();

				// Show modal with action to go back to Step 2
				const confirmGoBack = confirm(
					'No mapping found.\n\n' +
					'Dry Run requires a saved mapping profile. ' +
					'Go back to Step 2 and create/save a mapping.\n\n' +
					'Click OK to go to Step 2, or Cancel to stay here.'
				);

				if (confirmGoBack) {
					await this.wizard.showStep(2);
				}
				return;
			}

			// Validate mapping has tables
			if (!this.mapping?.tables || Object.keys(this.mapping.tables).length === 0) {
				this.wizard.hideLoading();
				this.wizard.showError('Mapping profile is empty. Go back to Step 2 and map at least one table.');
				return;
			}

			// Read current plan name from input before API calls
			const planNameInput = document.getElementById('plan-name');
			if (planNameInput) {
				this.plan.name = planNameInput.value.trim();
			}

			const resolvedPlanName = this.plan.name?.trim() || this.mapping?.name || `Plan ${new Date().toLocaleDateString()}`;
			this.plan.name = resolvedPlanName;
			if (planNameInput && planNameInput.value.trim() !== resolvedPlanName) {
				planNameInput.value = resolvedPlanName;
			}

			// mappingProfileId already determined above with strict precedence
			console.log('[PlanUI] Running dry run with plan:', { name: this.plan.name, id: this.plan.id, mappingProfileId });

			// Create or update plan first to ensure it's persisted
			let planId = this.plan.id;

			// Ensure tables are serialized as plain uppercase strings
			const normalizedTables = (this.plan.tables || []).map(t => {
				if (typeof t === 'string') return t.toUpperCase();
				if (t && typeof t === 'object') {
					if (t.value) return String(t.value).toUpperCase();
					if (t.targetTable) return String(t.targetTable).toUpperCase();
					if (t.table) return String(t.table).toUpperCase();
					return JSON.stringify(t).toUpperCase();
				}
				return String(t || '').toUpperCase();
			});

			const fullPayload = {
				name: this.plan.name,
				mappingProfileId,
				tables: normalizedTables,
				config: this.plan.config
			};

			if (planId) {
				// Update existing plan
				await this.api.update(planId, fullPayload);
				this.plan.mappingProfileId = mappingProfileId;
				console.log('[PlanUI] Updated plan:', planId);
			} else {
				// Create new plan
				const created = await this.api.create(fullPayload);
				planId = created.id;
				this.plan.id = planId;
				this.plan.mappingProfileId = mappingProfileId;
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
		const tables = Array.isArray(this.plan?.tables) ? this.plan.tables : [];

		if (!this.plan.name || this.plan.name.trim() === '') {
			errors.push('Plan name is required');
		}

		if (tables.length === 0) {
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
			this.wizard.showError('Missing plan name. Stay on Step 3, enter a plan name, then save the plan.');
			return false;
		}

		if (this.plan.tables.length === 0) {
			this.wizard.showError('No tables selected. Stay on Step 3, select at least one table, then save the plan.');
			return false;
		}

		if (!this.mapping?.mappingProfileId && !this.mapping?.id) {
			this.wizard.showError('Mapping profile missing. Go back to Step 2 to save the mapping, then return to Step 3.');
			return false;
		}

		// Create/update plan
		try {
			this.wizard.showLoading('Saving migration plan...');

			const mappingProfileId = this.mapping.mappingProfileId || this.mapping.id;

			// Build full plan payload with per-table configs
			const normalizedTables = (this.plan.tables || []).map(tableName => {
				const tableConfig = this.plan.tableConfigs?.[tableName] || {};
				const result = {
					table: tableName,
					include: true,
					mode: 'INSERT',
					keyStrategy: 'preserve',
					onDuplicate: 'SKIP',
					dedupeKeys: []
				};
				if (tableConfig.batchSize) result.batchSize = tableConfig.batchSize;
				if (tableConfig.cleanBefore) result.cleanBefore = tableConfig.cleanBefore;
				return result;
			});

			const fullPayload = {
				name: this.plan.name,
				mappingProfileId,
				tables: normalizedTables,
				config: this.plan.config || {
					batchSize: 1000,
					continueOnError: false,
					validateData: true
				}
			};
			this.plan.mappingProfileId = mappingProfileId;

			if (this.plan.id) {
				await this.api.update(this.plan.id, fullPayload);
			} else {
				const created = await this.api.create(fullPayload);
				this.plan.id = created.id;
			}

			this.state.setPlan(this.plan);
			this.wizard.renderNavigation();
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
