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
		this.accountingOrderAdjusted = false;
	}

	getDefaultPlanConfig(config = {}) {
		return {
			batchSize: 1000,
			continueOnError: false,
			validateData: true,
			transactionalDateFilter: {
				enabled: config?.transactionalDateFilter?.enabled === true,
				startDate: config?.transactionalDateFilter?.startDate || ''
			},
			...config
		};
	}

	applyAccountingOrder() {
		if (!Array.isArray(this.plan?.tables) || !window.AccountingOrderUtils) return false;
		const reordered = window.AccountingOrderUtils.reorderPlanTables(this.plan.tables);
		const changed = JSON.stringify(reordered) !== JSON.stringify(this.plan.tables);
		if (changed) {
			this.plan.tables = reordered;
			this.accountingOrderAdjusted = true;
			this.state.setPlan(this.plan);
		}
		return changed;
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

		this.plan.config = this.getDefaultPlanConfig(this.plan.config || {});

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

		// A plan may have been loaded before the Step 2 selection changed.
		// Keep only targets that are still present in the current mapping.
		const selectedTargets = new Set(
			Object.values(this.mapping.tables || {})
				.map(config => String(config?.targetTable || config?.target || '').toUpperCase())
				.filter(Boolean)
		);
		this.plan.tables = this.plan.tables.filter(table =>
			selectedTargets.has(String(table || '').toUpperCase())
		);

		this.applyAccountingOrder();

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
		// Reattach to server work without blocking wizard navigation on its completion.
		void this.runDataQualityAudit({ resumeOnly: true });
	}

	/**
	 * Render plan builder UI
	 */
	render() {
		const container = document.getElementById('plan-content');
		if (!container) return;

		const planName = this.plan?.name || '';
		const config = this.getDefaultPlanConfig(this.plan?.config || {});
		const tables = Array.isArray(this.plan?.tables) ? this.plan.tables : [];

		const mappingProfileName = this.mapping?.name || 'Not set';

		container.innerHTML = `
      <div class="plan-builder">
        <div class="plan-builder-head"><h2>Create Migration Plan</h2><button type="button" class="btn btn-secondary btn-sm" id="plan-toggle-all">Collapse all</button></div>

        
        <!-- Plan Settings -->
        <details class="plan-settings" id="plan-settings-section" ${this.settingsCollapsed ? '' : 'open'}>
          <summary class="plan-settings-summary">
            <span class="table-plan-title">Plan Settings</span>
            <span class="table-plan-chevron" aria-hidden="true"></span>
          </summary>
          <div class="plan-settings-body">
					<div class="plan-settings-grid">
						<div class="form-group">
							<label for="plan-name">Plan Name</label>
							<input type="text" id="plan-name" class="form-control" value="${planName}" placeholder="Enter plan name">
						</div>
						<div class="form-group">
							<label for="mapping-profile-display">Mapping Profile</label>
							<input type="text" id="mapping-profile-display" class="form-control" value="${mappingProfileName}" disabled>
							<small>Using the profile saved in Step 2</small>
						</div>
					</div>

					<div class="plan-settings-grid plan-settings-grid-3">
						<div class="form-group">
							<label for="batch-size">Batch Size</label>
							<input type="number" id="batch-size" class="form-control" value="${config.batchSize}" min="100" max="10000" step="100">
							<small>Rows migrated per batch</small>
						</div>
						<label class="plan-option">
							<input type="checkbox" id="continue-on-error" ${config.continueOnError ? 'checked' : ''}>
							<span><strong>Continue on Error</strong><small>Keep migrating other tables if one fails</small></span>
						</label>
						<label class="plan-option">
							<input type="checkbox" id="validate-data" ${config.validateData ? 'checked' : ''}>
							<span><strong>Validate Data</strong><small>Check data types and constraints</small></span>
						</label>
					</div>

					<div class="plan-date-filter">
						<label class="plan-option">
							<input type="checkbox" id="transactional-date-filter-enabled" ${config.transactionalDateFilter?.enabled ? 'checked' : ''}>
							<span>
								<strong>Only Migrate Transactional Data From Date</strong>
								<small>Jobs, invoices, payments and other transactional tables only import records on or after the start date. Master data such as customers, stock and accounts is always migrated in full.</small>
							</span>
						</label>
						<div class="form-group">
							<label for="transactional-date-filter-start">Start Date</label>
							<input type="date" id="transactional-date-filter-start" class="form-control"
								value="${config.transactionalDateFilter?.startDate || ''}"
								${config.transactionalDateFilter?.enabled ? '' : 'disabled'}>
						</div>
					</div>
          </div>
        </details>
        
        <!-- Table Selection and Order -->
				<details class="table-plan" id="table-plan-section" ${this.tablesCollapsed ? '' : 'open'}>
          <summary>
            <span class="table-plan-title">Tables to Migrate (in order)</span>
            <span class="table-plan-count">${tables.length} table${tables.length === 1 ? '' : 's'}</span>
            <span class="table-plan-chevron" aria-hidden="true"></span>
          </summary>

          <table class="plan-table">
            <thead>
              <tr>
                <th width="50">#</th>
                <th>Table Name</th>
                <th>Source → Target</th>
                <th>Fields Mapped</th>
				<th title="Checked tables are emptied before migration">Truncate first</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="plan-table-list">
							${this.renderPlanTables(tables)}
            </tbody>
          </table>
        </details>

        <details class="dry-run-section plan-check-card plan-section" id="check-section" ${this.checkCollapsed ? '' : 'open'}>
          <summary class="plan-check-header">
            <div>
              <h3>Check and Clean Migration Data</h3>
              <p>Check every selected table and its relationships. Confirmed junk is quarantined; records needing repair stop the migration. The legacy database stays intact.</p>
              <small>Migration repeats this full check and imports the audited snapshot. The date filter applies to the records checked.</small>
            </div>
            <button id="data-quality-scan" class="btn btn-primary" onclick="window.wizard.steps[2].component.runDataQualityAudit()" ${this.auditRunning ? 'disabled' : ''}>
              ${this.auditRunning ? 'Scan in progress…' : 'Check All Selected Tables'}
            </button>
            <span class="table-plan-chevron" aria-hidden="true"></span>
          </summary>
          <div id="data-quality-results" aria-live="polite">${this.renderDataQualityReport()}</div>
        </details>

        <!-- Dry Run Section -->
        <details class="dry-run-section plan-check-card plan-section" id="dry-run-card" ${this.dryRunCollapsed ? '' : 'open'}>
          <summary class="plan-check-header">
            <div>
              <h3>Test Migration (Dry Run)</h3>
              <p>Check a few sample rows per table without migrating data. Use Check All Selected Tables above to audit every record.</p>
            </div>
            <button class="btn btn-secondary" id="dry-run-btn" onclick="window.wizard.steps[2].component.runDryRun()">
              Run Dry Run
            </button>
            <span class="table-plan-chevron" aria-hidden="true"></span>
          </summary>
          <div id="dry-run-results" style="display: none;">
            ${this.renderDryRunResults()}
          </div>
        </details>
        
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
			const cleanBefore = this.plan.tableConfigs?.[targetTableName]?.cleanBefore === true;

			return `
        <tr data-table="${targetTableName}">
          <td>${index + 1}</td>
          <td><strong>${targetTableName}</strong></td>
          <td>${sourceTableName} → ${targetTableName}</td>
          <td>${fieldCount} fields</td>
		  <td style="text-align:center;">
			<label title="Empty ${targetTableName} before migrating">
			  <input type="checkbox"
					 ${cleanBefore ? 'checked' : ''}
					 onchange="window.wizard.steps[2].component.setTableCleanBefore(${index}, this.checked)">
			</label>
		  </td>
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

	/** Set the destructive clean option directly from the table row. */
	setTableCleanBefore(index, cleanBefore) {
		const tableName = this.plan.tables[index];
		if (!tableName) return;
		if (!this.plan.tableConfigs) this.plan.tableConfigs = {};

		const config = this.plan.tableConfigs[tableName] || {};
		config.cleanBefore = cleanBefore === true;
		this.plan.tableConfigs[tableName] = config;
		this.state.set(`plan.tableConfigs.${tableName}`, config);
	}

	/**
	 * Attach event listeners
	 */
	attachEventListeners() {
		this.plan.config = this.getDefaultPlanConfig(this.plan.config || {});

		// The scan result is redrawn often; remember whether it was folded.
		document.getElementById('data-quality-results')?.addEventListener('toggle', event => {
			if (event.target.id === 'quality-result') this.resultCollapsed = !event.target.open;
		}, true);

		// Remember which page sections are collapsed across re-renders, and drive the Collapse all / Expand all button.
		const sections = { 'plan-settings-section': 'settingsCollapsed', 'table-plan-section': 'tablesCollapsed', 'check-section': 'checkCollapsed', 'dry-run-card': 'dryRunCollapsed' };
		const toggleAll = document.getElementById('plan-toggle-all');
		const visibleSections = () => Object.keys(sections).map(id => document.getElementById(id)).filter(section => section && section.offsetParent !== null);
		const syncToggleAll = () => { if (toggleAll) toggleAll.textContent = visibleSections().some(section => section.open) ? 'Collapse all' : 'Expand all'; };
		for (const [id, flag] of Object.entries(sections)) {
			const section = document.getElementById(id);
			section?.addEventListener('toggle', () => { this[flag] = !section.open; syncToggleAll(); });
		}
		toggleAll?.addEventListener('click', () => {
			const open = !visibleSections().some(section => section.open);
			for (const section of visibleSections()) section.open = open;
		});
		syncToggleAll();

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

		const transactionalFilterEnabled = document.getElementById('transactional-date-filter-enabled');
		const transactionalFilterStart = document.getElementById('transactional-date-filter-start');
		if (transactionalFilterEnabled && transactionalFilterStart) {
			transactionalFilterEnabled.addEventListener('change', (e) => {
				const enabled = e.target.checked;
				transactionalFilterStart.disabled = !enabled;
				if (!this.plan.config.transactionalDateFilter) {
					this.plan.config.transactionalDateFilter = { enabled: false, startDate: '' };
				}
				this.plan.config.transactionalDateFilter.enabled = enabled;
				if (!enabled) {
					this.plan.config.transactionalDateFilter.startDate = '';
					transactionalFilterStart.value = '';
				}
				this.state.set('plan.config.transactionalDateFilter', this.plan.config.transactionalDateFilter);
				this.updateValidation();
			});

			transactionalFilterStart.addEventListener('change', (e) => {
				if (!this.plan.config.transactionalDateFilter) {
					this.plan.config.transactionalDateFilter = { enabled: true, startDate: '' };
				}
				this.plan.config.transactionalDateFilter.startDate = e.target.value;
				this.state.set('plan.config.transactionalDateFilter', this.plan.config.transactionalDateFilter);
				this.updateValidation();
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

			this.applyAccountingOrder();
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

			this.applyAccountingOrder();
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
							Empties the target table before inserting (uses TRUNCATE, falls back to DELETE). Use with caution.
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
		this.plan.tables.splice(index, 1);
		this.applyAccountingOrder();
		this.state.setPlan(this.plan);
		this.render();
	}

	/**
	 * Run dry-run simulation
	 */
	async runDryRun() {
		if (this.dryRunLive) return;
		// Open the card if it was folded, so the progress is visible.
		const card = document.getElementById('dry-run-card');
		if (card && !card.open) card.open = true;
		// Show the table list straight away; statuses fill in as the server checks each table.
		const button = document.getElementById('dry-run-btn');
		if (button) { button.disabled = true; button.textContent = 'Running…'; }
		const planTables = (this.plan?.tables || []).map(t => String(typeof t === 'string' ? t : (t?.targetTable || t?.table || t?.value || '')).toUpperCase()).filter(Boolean);
		this.dryRunLive = { tables: planTables, results: new Map(), started: false };
		this.drawDryRunLive();
		// Bring the card to the top of the window (after the table list is drawn, so the page is tall enough to scroll that far).
		const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		card?.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });

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
			// Ensure we have the latest mapping loaded from the profile before dry-run
			try {
				if (mappingProfileId) {
					const mappingProfile = await window.MappingAPI.getById(mappingProfileId);
					if (mappingProfile) {
						// mappingProfile contains { id, name, tables }
						this.mapping = {
							id: mappingProfile.id,
							mappingProfileId: mappingProfile.id,
							name: mappingProfile.name,
							tables: mappingProfile.tables
						};
						// Persist mapping into wizard state so it survives navigation
						this.state.set('mapping', this.mapping);
					}
				}
			} catch (err) {
				console.warn('[PlanUI] Failed to load mapping profile for dry-run:', err);
			}

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
			this.applyAccountingOrder();

			// mappingProfileId already determined above with strict precedence
			console.log('[PlanUI] Running dry run with plan:', { name: this.plan.name, id: this.plan.id, mappingProfileId });

			// Create or update plan first to ensure it's persisted
			let planId = this.plan.id;

			// Build tables payload including per-table overrides (batchSize, cleanBefore)
			const normalizedTablesObj = {};
			const tableConfigs = this.plan.tableConfigs || {};
			for (const t of (this.plan.tables || [])) {
				const target = (typeof t === 'string') ? t.toUpperCase() : (t && (t.targetTable || t.table || t.value) ? String(t.targetTable || t.table || t.value).toUpperCase() : String(t || '').toUpperCase());
				const cfg = tableConfigs[target] || {};
				normalizedTablesObj[target] = {
					mode: cfg.mode || 'INSERT',
					keyStrategy: cfg.keyStrategy || 'preserve',
					onDuplicate: cfg.onDuplicate || 'SKIP',
					dedupeKeys: cfg.dedupeKeys || [],
					batchSize: cfg.batchSize || undefined,
					cleanBefore: typeof cfg.cleanBefore === 'boolean' ? cfg.cleanBefore : false
				};
			}

			const fullPayload = {
				name: this.plan.name,
				mappingProfileId,
				tables: normalizedTablesObj,
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
			// Stream the plan-level dry run so each table's status appears as soon as it is checked.
			this.dryRunResults = await this.api.dryRunStream(planId, event => {
				if (event.type === 'start') this.dryRunLive.tables = event.tables;
				if (event.type === 'table') this.dryRunLive.results.set(event.table.tableName, event.table);
				this.dryRunLive.started = true;
				this.drawDryRunLive();
			});
			this.dryRunLive = null;

			// Render results
			const resultsDiv = document.getElementById('dry-run-results');
			if (resultsDiv) {
				resultsDiv.innerHTML = this.renderDryRunResults();
				resultsDiv.style.display = 'block';
			}

		} catch (err) {
			console.error('Dry run failed:', err);
			this.wizard.showError(`Dry run failed: ${err.message}`);
		} finally {
			// Early returns and failures leave the live list behind; go back to the last complete result (or nothing).
			if (this.dryRunLive) {
				this.dryRunLive = null;
				const resultsDiv = document.getElementById('dry-run-results');
				if (resultsDiv) {
					resultsDiv.innerHTML = this.dryRunResults ? this.renderDryRunResults() : '';
					resultsDiv.style.display = this.dryRunResults ? 'block' : 'none';
				}
			}
			this.wizard.hideLoading();
			const button = document.getElementById('dry-run-btn');
			if (button) { button.disabled = false; button.textContent = 'Run Dry Run'; }
		}
	}

	/**
	 * Draw the dry run while it runs: the table list with a status per table, filled in as results arrive.
	 */
	drawDryRunLive() {
		const resultsDiv = document.getElementById('dry-run-results');
		const live = this.dryRunLive;
		if (!resultsDiv || !live) return;
		const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
		const done = live.results.size;
		const total = live.tables.length;
		const failed = [...live.results.values()].filter(result => result.errors?.length);
		resultsDiv.style.display = 'block';
		resultsDiv.innerHTML = `<div class="dry-run-results dry-run-summary dry-run-live" role="status">
			<div class="quality-record-progress"><span><strong>${live.started ? `Checking ${Math.min(done + 1, total)} of ${total} tables` : 'Saving the plan…'}</strong></span><strong>${total ? Math.round(done / total * 100) : 0}%</strong></div>
			<div class="qbar" role="progressbar" aria-label="Dry run progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="--from:${total ? (Math.max(0, done - 1) / total * 100).toFixed(2) : 0}%;--to:${total ? (done / total * 100).toFixed(2) : 0}%"></span></div>
			${failed.length ? `<ul class="dry-run-issues errors">${failed.flatMap(result => result.errors.map(message => `<li><strong>${escape(result.tableName)}</strong> ${escape(message)}</li>`)).join('')}</ul>` : ''}
			${this.dryRunTable(live.tables, live.results, live.started ? done : -1)}
		</div>`;
	}

	/**
	 * Render dry-run results
	 */
	async runDataQualityAudit({ resumeOnly = false } = {}) {
		if (this.auditRunning) return;
		// A started scan opens its card if it was folded, so the progress is visible.
		const checkSection = !resumeOnly && typeof document.getElementById === 'function' ? document.getElementById('check-section') : null;
		if (checkSection && !checkSection.open) checkSection.open = true;
		const previousReport = this.dataQualityReport;
		this.auditRunning = true;
		this.auditStopRequested = false;
		this.auditStopError = null;
		this.activeAuditId = null;
		this.auditResumed = false;
		this.auditStartedAt = Date.now();
		this.auditUpdatedAt = null;
		this.dataQualityReport = { status: 'running', progress: { phase: 'finding_active' }, tables: [] };
		const draw = () => this.drawDataQualityState();
		draw();
		if (!resumeOnly) document.getElementById('data-quality-results')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
		const ticker = setInterval(draw, 1000);
		let auditId;
		try {
			const active = await this.api.getActiveDataQualityAudit?.();
			if (active) {
				auditId = active.id;
				this.activeAuditId = auditId;
				this.auditResumed = true;
				this.dataQualityReport = active;
				this.auditStartedAt = Date.parse(active.createdAt) || this.auditStartedAt;
				this.auditStopRequested ||= active.status === 'stopping';
				draw();
				if (!['running', 'stopping'].includes(active.status)) return;
			} else if (resumeOnly) {
				const params = typeof URLSearchParams === 'function' ? new URLSearchParams(window.location?.search || '') : null;
				let rememberedId;
				try { rememberedId = window.sessionStorage?.getItem(`migration-audit:${this.plan?.id}`); } catch { /* Storage can be disabled. Server history still works. */ }
				const returnedId = params?.get('audit') || rememberedId;
				const saved = this.plan?.id ? await this.api.getLatestDataQualityAudit?.(this.plan.id) : null;
				// Explicit return links also recover reports created before plan-linked history existed.
				const returned = !saved && returnedId ? await this.api.getDataQualityAudit(returnedId).catch(err => { if (err.status === 404) return null; throw err; }) : null;
				this.dataQualityReport = saved || (returned && (returned.planId == null || String(returned.planId) === String(this.plan?.id)) ? { ...returned, settingsChanged: true } : null) || (['ready', 'blocked', 'cancelled', 'failed'].includes(previousReport?.status) ? previousReport : null);
				if (this.dataQualityReport && params?.get('decisionSaved')) this.dataQualityReport.settingsChanged = true;
				return;
			} else {
			this.dataQualityReport.progress = { phase: 'saving_plan' };
			draw();
			// Save inside the guarded operation so validation and save failures are visible here.
			if (!await this.onNext({ inline: true })) {
				this.dataQualityReport = { status: 'not_started', error: this.planSaveError || 'The plan could not be saved. Check the plan name, selected tables and saved mapping, then try again.' };
				return;
			}
			if (this.auditStopRequested) {
				this.dataQualityReport = { status: 'cancelled' };
				return;
			}
			this.dataQualityReport.progress = { phase: 'starting' };
			draw();
			const started = await this.api.auditDataQuality(this.plan.id);
			auditId = started.auditId;
			this.auditResumed = !!started.resumed;
			this.activeAuditId = auditId;
			}
			if (this.auditStopRequested) await this.stopDataQualityAudit(true);
			do {
				this.dataQualityReport = await this.api.getDataQualityAudit(auditId);
				this.auditStartedAt = Date.parse(this.dataQualityReport.createdAt) || this.auditStartedAt;
				this.auditUpdatedAt = Date.now();
				draw();
				if (!['running', 'stopping'].includes(this.dataQualityReport.status)) break;
				await new Promise(resolve => setTimeout(resolve, 1500));
			} while (true);
		} catch (err) {
			this.dataQualityReport = { ...this.dataQualityReport, id: auditId, status: auditId ? 'connection_lost' : 'not_started', error: err?.message || 'The scan request failed without an error message. Please try again.' };
		} finally {
			clearInterval(ticker);
			this.auditRunning = false;
			if (this.plan?.id && this.dataQualityReport?.id && ['ready', 'blocked'].includes(this.dataQualityReport.status)) {
				try { window.sessionStorage?.setItem(`migration-audit:${this.plan.id}`, this.dataQualityReport.id); } catch { /* Server history remains available. */ }
			}
			draw();
		}
	}

	drawDataQualityState() {
		const container = document.getElementById('data-quality-results');
		if (container) container.innerHTML = this.renderDataQualityReport();
		const button = document.getElementById('data-quality-scan');
		if (button) {
			button.disabled = this.auditRunning;
			button.textContent = this.auditRunning ? this.auditStopRequested ? 'Stopping…' : 'Scan in progress…' : 'Check All Selected Tables';
		}
	}

	async confirmBulkExclusion(count) {
		const records = count.toLocaleString();
		if (!window.Modal?.custom) {
			return window.confirm(`Exclude ${records} unresolved source records from the migration and rescan?\n\n• Any unresolved records the next scan finds are excluded too.\n• Every table switches to insert-only: existing target records are kept and no table is emptied first.\n• Financial transactions may be excluded, which can change opening balances. Add missing parent tables in Step 2 first.\n\nYour legacy database is not changed, and excluded records stay available for recovery.`);
		}
		return window.Modal.custom({
			title: 'Exclude unresolved records from this migration?',
			type: 'warning',
			size: 'md',
			confirmText: 'Exclude records and rescan',
			cancelText: 'Keep reviewing',
			contentHTML: `<div class="bulk-exclude">
				<p class="bulk-lead"><strong>${records} source records</strong> still need a decision. This leaves them out of the migration instead of repairing them.</p>
				<h4>What happens</h4>
				<ol>
					<li>The ${records} blocked records are excluded, along with any unresolved records the next scan finds.</li>
					<li>Every table switches to insert-only: existing target records are kept and no table is emptied first.</li>
					<li>A new full scan starts straight away so you can review the new totals.</li>
				</ol>
				<h4>Before you continue</h4>
				<ul class="bulk-warn">
					<li>Excluded records can include financial transactions, which can change opening balances.</li>
					<li>If records are blocked because a parent table is missing, add that table in Step 2 first.</li>
				</ul>
				<p class="bulk-safe">Your legacy database is not changed, and excluded records stay available for recovery.</p>
			</div>`,
			// Modal focuses the confirm button after 100ms; move focus to the safe choice for this destructive action.
			onMount: overlay => setTimeout(() => overlay.querySelector('.modal-cancel')?.focus(), 150)
		});
	}

	async setUnresolvedPolicy(exclude) {
		if (this.auditRunning) return;
		const count = this.dataQualityReport?.totals?.review || 0;
		if (exclude && !await this.confirmBulkExclusion(count)) return;
		this.plan.config ||= {};
		this.plan.config.dataQuality = { ...this.plan.config.dataQuality, excludeUnresolved: exclude };
		if (exclude) {
			// The confirmed bulk action explicitly retains destination records.
			this.plan.tableConfigs ||= {};
			for (const table of this.plan.tables || []) this.plan.tableConfigs[table] = { ...this.plan.tableConfigs[table], cleanBefore: false, mode: 'INSERT', onDuplicate: 'SKIP' };
		}
		await this.runDataQualityAudit();
	}

	async stopDataQualityAudit(dispatchQueued = false) {
		if (!this.auditRunning || (this.auditStopRequested && !dispatchQueued)) return;
		this.auditStopRequested = true;
		this.auditStopError = null;
		this.drawDataQualityState();
		// If the start request is in flight, send the stop as soon as its ID arrives.
		if (!this.activeAuditId) return;
		try {
			await this.api.stopDataQualityAudit(this.activeAuditId);
		} catch (err) {
			this.auditStopRequested = false;
			this.auditStopError = `Could not request stop: ${err?.message || 'No error details were returned'}. The scan may still be running; try Stop Scan again.`;
		}
		this.drawDataQualityState();
	}

	renderDataQualityReport() {
		const report = this.dataQualityReport;
		if (!report) return '<p class="quality-idle">No scan run yet. Click Check All Selected Tables to see which records can migrate and which need attention. This check does not import data or change the legacy database.</p>';
		const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
		if (report.status === 'cancelled') return '<div class="quality-progress" role="status"><p><strong>Scan stopped</strong></p><p>No data was imported or deleted. This scan is incomplete and cannot be used as a migration result.</p><p>Click Check All Selected Tables to start a new scan from the beginning.</p></div>';
		if (['running', 'stopping'].includes(report.status)) {
			const stopping = this.auditStopRequested || report.status === 'stopping';
			const progress = report.progress || {};
			const phases = { saving_plan: 'Saving your current plan', starting: 'Starting the scan', target_metadata: 'Reading target database rules', connecting_source: 'Connecting to the legacy database', table_metadata: 'Checking table columns and mappings', date_scope: 'Preparing the selected date range', account_mapping: 'Preparing account number mappings', collecting_seed_keys: 'Finding records in the selected date range', seed_keys_collected: 'Date range records found', link_traversal: 'Finding linked records', link_traversal_table: 'Finding linked records', link_traversal_converged: 'Date range links prepared', validating_definition: 'Checking required fields and mappings', counting: 'Counting source records', reading: 'Reading and checking source records', validating_rows: 'Checking required values, types and duplicates', table_blocked: 'Table needs mapping repairs', scan_complete: 'Row scan complete — relationship checks follow', target_keys: 'Checking keys against existing target records', parent_keys: 'Loading related record keys', existing_children: 'Checking existing dependent records', checking_relationships: 'Checking links between records', saving_quarantine: 'Saving accepted and excluded records' };
			const phase = progress.phase === 'finding_active' ? 'Looking for an existing scan' : phases[progress.phase] || (progress.table ? 'Checking records' : 'Preparing database checks');
			const measured = progress.total != null && Number.isFinite(Number(progress.total)) && Number(progress.total) >= 0;
			const total = measured ? Number(progress.total) : 0;
			const scanned = Math.max(0, Number(progress.scanned) || 0);
			const percent = measured ? (total ? Math.min(100, Math.round(scanned / total * 1000) / 10) : 100) : null;
			const number = value => Number(value || 0).toLocaleString();
			const stage = progress.stage || ({ checking_relationships: 'links', saving_quarantine: 'results' }[progress.phase]) || (progress.table ? 'rows' : 'prepare');
			const stages = [['prepare', 'Prepare'], ['rows', 'Check rows'], ['links', 'Check links'], ['results', 'Save results']];
			const stageIndex = Math.max(0, stages.findIndex(([key]) => key === stage));
			// Overall progress: each stage covers a share of the bar; within a stage, finished tables plus the current table's share.
			const weights = { prepare: 5, rows: 60, links: 20, results: 15 };
			const tableCount = Number(progress.tableCount) || 0;
			const tableIndex = Number(progress.tableIndex) || 0;
			const within = tableCount && tableIndex ? Math.min(1, (tableIndex - 1 + (measured && total ? Math.min(1, scanned / total) : 0)) / tableCount) : 0;
			const overall = Math.min(99, Math.round(stages.slice(0, stageIndex).reduce((sum, [key]) => sum + weights[key], 0) + (weights[stage] || 0) * within));
			const tablesLeft = tableCount && tableIndex ? tableCount - tableIndex : null;
			const stagesLeft = stages.length - 1 - stageIndex;
			const overallDetail = stage === 'prepare' ? 'Preparing the scan' : `Stage ${stageIndex + 1} of ${stages.length}${tablesLeft != null ? ` · ${tablesLeft} ${tablesLeft === 1 ? 'table' : 'tables'} left in this stage` : ''}${stagesLeft ? `, then ${stagesLeft} more ${stagesLeft === 1 ? 'stage' : 'stages'}` : ''}`;
			// Animated bars: each redraw slides from the previous value to the new one (reset when the table changes),
			// and the shine keeps its phase across redraws so it does not restart every second.
			this._bars ||= {};
			const phaseDelay = period => `-${Date.now() % period}ms`;
			const bar = (key, label, value, max, tone, id = key) => {
				if (max == null) return `<div class="qbar ${tone} indeterminate" role="progressbar" aria-label="${label}"><span style="animation-delay:${phaseDelay(1400)}"></span></div>`;
				const to = max ? Math.min(100, value / max * 100) : 100;
				const from = this._bars[key]?.id === id ? Math.min(this._bars[key].pct, to) : 0;
				this._bars[key] = { id, pct: to };
				return `<div class="qbar ${tone}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}"><span style="--from:${from.toFixed(2)}%;--to:${to.toFixed(2)}%;--shine-delay:${phaseDelay(1800)}"></span></div>`;
			};
			const elapsed = Math.max(0, Math.floor((Date.now() - this.auditStartedAt) / 1000));
			// Optional lines always keep their slot so the card does not jump in height between updates.
			const slot = (className, html) => `<p class="quality-slot ${className}"${html ? '' : ' aria-hidden="true"'}>${html || '&nbsp;'}</p>`;
			return `<div class="quality-progress" role="status">
				${this.auditResumed ? '<p>Reconnected to the existing scan. It uses the table selection saved when that scan started.</p>' : ''}
				<div class="quality-stop-controls"><strong>${stopping ? 'Stopping scan…' : 'Scan in progress'}</strong><button class="btn btn-secondary" onclick="window.wizard.steps[2].component.stopDataQualityAudit()" ${stopping ? 'disabled' : ''}>${stopping ? 'Stopping…' : 'Stop Scan'}</button></div>
				${stopping ? '<p>Waiting for the current database operation to finish, then releasing connections. Stopping can take a little time.</p>' : ''}
				${this.auditStopError ? `<p role="alert">${escape(this.auditStopError)}</p>` : ''}
				<ol class="quality-stages" aria-label="Audit stages">${stages.map(([key, label], i) => `<li class="${i === stageIndex ? 'active' : i < stageIndex ? 'complete' : ''}" ${i === stageIndex ? 'aria-current="step"' : ''}>${i + 1}. ${label}</li>`).join('')}</ol>
				<div class="quality-overall"><div class="quality-record-progress"><span><strong>Overall progress</strong> · ${escape(overallDetail)}</span><strong>${overall}%</strong></div>${bar('overall', 'Overall scan progress', overall, 100, 'overall')}</div>
				<div class="quality-current-header"><p class="quality-status-title"><span class="quality-spinner" aria-hidden="true"></span><span>${progress.table ? escape(String(progress.table).toUpperCase()) : stage === 'prepare' ? 'Preparing audit' : escape(stages[stageIndex][1])}</span><span class="quality-phase">${escape(phase)}${progress.relatedTable ? ` · ${escape(String(progress.relatedTable).toUpperCase())}` : ''}${progress.pass > 1 ? ` · pass ${escape(progress.pass)}` : ''}</span></p>${progress.tableIndex ? `<strong class="quality-table-position">Table ${escape(progress.tableIndex)} of ${escape(progress.tableCount)} · ${escape(stages[stageIndex][1])}</strong>` : ''}</div>
				${slot('quality-source', progress.sourceTable && String(progress.sourceTable).toLowerCase() !== String(progress.table).toLowerCase() ? `Legacy source: ${escape(progress.sourceTable)}` : '')}
				<div class="quality-record-progress"><span>${measured ? `${number(scanned)} of ${number(total)} records ${progress.phase === 'reading' ? 'read' : progress.stage === 'results' ? 'saved' : 'checked'}` : progress.scanned != null ? `${number(scanned)} records checked` : progress.phase === 'counting' ? 'Counting records…' : 'Working…'}</span>${measured ? `<strong>${percent}%</strong>` : ''}</div>
				${bar('table', 'Current table records', total ? Math.min(scanned, total) : 1, measured ? (total || 1) : null, 'table', `${stage}:${progress.table || ''}`)}
				${slot('quality-flagged', progress.flagged != null ? `${number(progress.flagged)} records flagged so far. Final decisions follow relationship checks.` : '')}
				${slot('quality-next', progress.nextTable ? `Next table: ${escape(String(progress.nextTable).toUpperCase())}` : '')}
				<div class="quality-footer">
					<p><small>Elapsed: ${Number.isFinite(elapsed) ? elapsed : 0}s${this.auditUpdatedAt ? ` · Last server response ${Math.max(0, Math.floor((Date.now() - this.auditUpdatedAt) / 1000))}s ago` : ''}. Keep this page open to see the result.</small></p>
					<p><small>Checking data only. No records are being imported or deleted from the legacy database.</small></p>
				</div>
			</div>`;
		}
		if (['not_started', 'failed', 'connection_lost'].includes(report.status)) {
			const title = { not_started: 'Scan could not start', failed: 'Scan failed — no complete result', connection_lost: 'Unable to retrieve scan progress' }[report.status];
			return `<div class="validation-errors" role="alert"><p><strong>${title}</strong></p><p>${escape(report.error)}</p><p>${report.status === 'connection_lost' ? 'The server scan may still be running. No completed result has been confirmed.' : 'Resolve the error above, then click Check All Selected Tables to retry.'}</p>${report.id ? `<p><a href="/api/quality-audits/${encodeURIComponent(report.id)}?download=report">View latest audit report</a></p>` : ''}</div>`;
		}
		const totals = report.totals || {};
		const tables = report.tables || [];
		const hasRule = rule => tables.some(table => table.rules?.[rule]);
		const blocked = report.status === 'blocked';
		const audit = report.id ? `/api/quality-audits/${encodeURIComponent(report.id)}` : '';
		// Parent tables that records point to but that were not part of this scan.
		const selected = new Set(tables.map(table => String(table.table).toLowerCase()));
		const missing = new Set();
		for (const table of tables) for (const sample of table.samples || []) for (const reason of sample.reasons || []) {
			const parent = /^No accepted ([a-z0-9_]+) parent/i.exec(reason.message || '')?.[1];
			if (parent && !selected.has(parent.toLowerCase())) missing.add(parent);
		}
		// A short list of next steps, each with its own action.
		const steps = [];
		if (blocked) {
			if (hasRule('TARGET_EXPRESSION')) steps.push('<strong>Fix the audit expression error.</strong> This is a checker or schema problem, not bad data.');
			if (missing.size) steps.push(`<strong>Add the missing tables in Step 2:</strong> ${[...missing].map(escape).join(', ')}. Records point to them but they are not in this migration.`);
			if (totals.review && !report.excludeUnresolved) steps.push(`<strong>Decide what to do with ${escape(Number(totals.review).toLocaleString())} blocked ${Number(totals.review) === 1 ? 'record' : 'records'}.</strong>${audit ? ` <a class="btn btn-primary btn-sm" href="${audit}/groups">Review grouped repair decisions</a>` : ''} <span class="quality-or">or <button class="btn btn-secondary btn-sm" onclick="window.wizard.steps[2].component.setUnresolvedPolicy(true)">Leave them all out and rescan</button></span>`);
			steps.push('<strong>Run Check All Selected Tables again.</strong> Continue to migration once the scan is ready.');
		}
		const counts = `${escape(totals.scanned || 0)} checked · ${escape(totals.accepted || 0)} accepted · ${escape(totals.quarantined || 0)} quarantined · ${escape(totals.review || 0)} need review`;
		const title = report.settingsChanged ? 'Saved scan results — out of date' : report.status === 'ready' ? 'Scan complete — ready to migrate' : 'Scan complete — Migration blocked';
		// is-ready marks a current, ready full check; the one-row dry run is then hidden because the full check supersedes it.
		// The result card folds to its status line; the open state survives redraws (see attachEventListeners).
		return `<details id="quality-result" class="quality-result ${report.status === 'ready' ? 'validation-success' : 'validation-errors'}${report.status === 'ready' && !report.settingsChanged ? ' is-ready' : ''}"${this.resultCollapsed ? '' : ' open'}>
			<summary class="quality-result-head"><p role="status"><strong>${title}</strong></p><p class="quality-counts">${counts}</p></summary>
			${report.settingsChanged ? '<p class="quality-stale">Your settings or decisions changed after this scan. Run <strong>Check All Selected Tables</strong> to check them.</p>' : ''}
			${report.error ? `<p>${escape(report.error)}</p>` : ''}
			${report.excludeUnresolved ? '<p class="quality-policy"><strong>All unresolved records are being left out.</strong> Only accepted records will migrate. <button class="btn btn-secondary btn-sm" onclick="window.wizard.steps[2].component.setUnresolvedPolicy(false)">Require repair decisions and rescan</button></p>' : ''}
			${steps.length ? `<div class="quality-next-actions"><h4>What to do next</h4><ol class="quality-steps">${steps.map(step => `<li>${step}</li>`).join('')}</ol></div>` : report.status === 'ready' && !report.settingsChanged ? '<p>Quarantined records are left out. Click <strong>Next →</strong> to continue to the migration.</p>' : ''}
			${report.appliedCorrectionCount ? `<p class="quality-note">${escape(report.appliedCorrectionCount)} saved ${Number(report.appliedCorrectionCount) === 1 ? 'correction was' : 'corrections were'} applied in this scan.</p>` : ''}
			<details class="quality-more"><summary>Results by table</summary>
				<table class="plan-table"><thead><tr><th>Source → Target</th><th>Checked</th><th>Accepted</th><th>Quarantined</th><th>Review</th><th>Findings</th></tr></thead><tbody>
				${tables.map(table => `<tr><td>${escape(table.sourceTable)} → ${escape(table.table)}</td><td>${table.scanned}</td><td>${table.accepted}</td><td>${table.quarantined}</td><td>${table.review}</td><td>${[...(table.errors || []), ...Object.entries(table.rules || {}).map(([rule, count]) => `${rule}: ${count}`)].map(escape).join('<br>')}</td></tr>`).join('')}
				</tbody></table>
				${tables.filter(table => table.samples?.length).map(table => `<details><summary>${escape(table.table)} — example findings</summary><ul>${table.samples.map(sample => `<li>Source row ${escape(sample.ordinal + 1)}: ${sample.reasons.map(reason => escape(reason.message)).join('; ')}</li>`).join('')}</ul></details>`).join('')}
			</details>
			${report.automaticRepairs?.length ? `<details class="quality-more"><summary>Automatic repairs prepared (${report.automaticRepairs.length})</summary><ul>${report.automaticRepairs.map(item => `<li><strong>${escape(item.table)}</strong>: ${escape(item.action)}. ${escape(item.explanation)}</li>`).join('')}</ul></details>` : ''}
			${audit ? `<p class="quality-links"><a href="${audit}/view" target="_blank" rel="noopener">Record details</a> · <a href="${audit}/view?download=html">Download readable summary</a> · <a href="${audit}?download=report">Audit JSON</a> · <a href="${audit}?download=quarantine">Record evidence JSON</a>${report.completedAt ? ` · <span>Completed ${escape(new Date(report.completedAt).toLocaleString())}</span>` : ''}</p>` : ''}</details>`;
	}

	renderDryRunResults() {
		if (!this.dryRunResults) {
			return '<p>No dry-run results available</p>';
		}

		const results = this.dryRunResults.results || this.dryRunResults;
		const perTable = results.perTable || [];
		const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
		const withErrors = perTable.filter(table => table.errors?.length);
		const withWarnings = perTable.filter(table => !table.errors?.length && table.warnings?.length);
		const total = results.tableCount || perTable.length;
		const headline = withErrors.length
			? `✕ ${withErrors.length} of ${total} ${total === 1 ? 'table has' : 'tables have'} errors`
			: withWarnings.length ? `⚠ All ${total} tables passed, ${withWarnings.length} with warnings` : `✓ All ${total} tables passed`;
		const rows = results.estimatedRowsDisplay || results.estimatedRows || results.totals?.estimatedRows || 0;
		// "2962 seconds" reads better as "about 49 min".
		const seconds = parseInt(String(results.estimatedTime || ''), 10);
		const plus = String(results.estimatedTime || '').includes('+') ? '+' : '';
		const duration = !Number.isFinite(seconds) ? null : seconds < 90 ? `${seconds} sec${plus}` : seconds < 5400 ? `${Math.round(seconds / 60)} min${plus}` : `${Math.floor(seconds / 3600)} h ${Math.round(seconds % 3600 / 60)} min${plus}`;
		const issues = (list, kind) => list.length ? `<ul class="dry-run-issues ${kind}">${list.flatMap(table => (table[kind] || []).map(message => `<li><strong>${escape(table.tableName)}</strong> ${escape(message)}</li>`)).join('')}</ul>` : '';
		const tableMap = new Map(perTable.map(table => [table.tableName, table]));
		return `<div class="dry-run-results dry-run-summary ${withErrors.length ? 'has-errors' : withWarnings.length ? 'has-warnings' : 'all-ok'}">
			<div class="dry-run-head"><strong>${headline}</strong><ul class="dry-run-stats"><li><strong>${escape(total)}</strong> tables</li><li><strong>${escape(this.formatCount(rows))}</strong> estimated rows</li>${duration ? `<li>about <strong>${escape(duration)}</strong> to migrate</li>` : ''}</ul></div>
			<p class="dry-run-note">A few sample rows per table. Estimated rows are table sizes, not errors. Use <strong>Check All Selected Tables</strong> to check every record.</p>
			${issues(withErrors, 'errors')}${issues(withWarnings, 'warnings')}
			${this.dryRunTable(perTable.map(table => table.tableName), tableMap)}
		</div>`;
	}

	formatCount(value) {
		return /^\d+$/.test(String(value)) ? Number(value).toLocaleString() : String(value ?? '');
	}

	/**
	 * Dry run table shared by the live view and the final result: rows right-aligned, status on the right.
	 * checkingIndex marks the table currently being checked (live view only).
	 */
	dryRunTable(names, results, checkingIndex = -1) {
		const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
		const badge = (result, index) => {
			if (result?.errors?.length) return '<span class="status-badge status-warning">✕ Errors</span>';
			if (result?.warnings?.length) return '<span class="status-badge status-warning">⚠ Warnings</span>';
			if (result) return '<span class="status-badge status-success">✓ OK</span>';
			return index === checkingIndex ? '<span class="status-badge status-checking"><span class="dry-spinner" aria-hidden="true"></span> Checking…</span>' : '<span class="status-badge status-pending">Waiting</span>';
		};
		return `<table class="plan-table dry-run-table"><thead><tr><th>Table</th><th class="num">Est. rows</th><th class="status-col">Status</th></tr></thead><tbody>
			${names.map((name, index) => { const result = results.get(name); return `<tr${result ? '' : ' class="dry-pending"'}><td>${escape(name)}</td><td class="num">${result ? escape(this.formatCount(result.estimatedRowsDisplay || result.estimatedRows || 0)) : '—'}</td><td class="status-col">${badge(result, index)}</td></tr>`; }).join('')}
			</tbody></table>`;
	}

	/**
	 * Update validation summary
	 */
	updateValidation() {
		const summary = document.getElementById('plan-validation');
		if (!summary) return;

		const errors = [];
		const warnings = [];
		const tables = Array.isArray(this.plan?.tables) ? this.plan.tables : [];

		if (!this.plan.name || this.plan.name.trim() === '') {
			errors.push('Plan name is required');
		}

		if (tables.length === 0) {
			errors.push('At least one table must be selected');
		}

		if (window.AccountingOrderUtils) {
			const orderIssues = window.AccountingOrderUtils.findOrderIssues(tables);
			if (orderIssues.length > 0) {
				warnings.push(`Accounting tables will be auto-reordered. ${orderIssues.join(' ')}`);
			} else if (this.accountingOrderAdjusted) {
				warnings.push('Accounting tables were auto-ordered so accounts and GL prerequisites run first.');
			}

			if (window.AccountingOrderUtils.requiresGlRebuild(tables)) {
				warnings.push("GL journal tables need rebuilt GL accounts in the database. Migrate accounts, run 'Rebuild GL Accounts', then start the GL journal migration.");
			}
		}

		const transactionalDateFilter = this.plan?.config?.transactionalDateFilter || {};
		if (transactionalDateFilter.enabled && !transactionalDateFilter.startDate) {
			errors.push('Select a start date when the transactional data filter is enabled');
		} else if (transactionalDateFilter.enabled && transactionalDateFilter.startDate) {
			warnings.push(`Transactional tables will be filtered to rows on or after ${transactionalDateFilter.startDate}. Master data remains unfiltered.`);
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
		} else if (warnings.length > 0) {
			summary.innerHTML = `
        <div class="validation-success">
          <h4>✓ Plan Valid</h4>
          <p>Migration plan is ready.</p>
          <ul>
            ${warnings.map(warn => `<li>${warn}</li>`).join('')}
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
	async onNext({ inline = false } = {}) {
		this.wizard.clearMessages();
		this.planSaveError = null;

		if (!this.plan.name || this.plan.name.trim() === '') {
			this.planSaveError = 'Missing plan name. Stay on Step 3, enter a plan name, then save the plan.';
			this.wizard.showError(this.planSaveError);
			return false;
		}

		if (this.plan.tables.length === 0) {
			this.planSaveError = 'No tables selected. Stay on Step 3, select at least one table, then save the plan.';
			this.wizard.showError(this.planSaveError);
			return false;
		}

		if (!this.mapping?.mappingProfileId && !this.mapping?.id) {
			this.planSaveError = 'Mapping profile missing. Go back to Step 2 to save the mapping, then return to Step 3.';
			this.wizard.showError(this.planSaveError);
			return false;
		}

		this.applyAccountingOrder();

		// Create/update plan
		try {
			if (!inline) this.wizard.showLoading('Saving migration plan...');

			const mappingProfileId = this.mapping.mappingProfileId || this.mapping.id;

			// Build full plan payload with per-table configs
			const normalizedTables = (this.plan.tables || []).map(tableName => {
				const tableConfig = this.plan.tableConfigs?.[tableName] || {};
				const result = {
					table: tableName,
					include: true,
					mode: tableConfig.mode || 'INSERT',
					keyStrategy: tableConfig.keyStrategy || 'preserve',
					onDuplicate: tableConfig.onDuplicate || 'SKIP',
					dedupeKeys: tableConfig.dedupeKeys || []
				};
				if (tableConfig.batchSize) result.batchSize = tableConfig.batchSize;
				result.cleanBefore = tableConfig.cleanBefore === true;
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
			if (!inline) this.wizard.hideLoading();

			return true;

		} catch (err) {
			if (!inline) this.wizard.hideLoading();
			this.planSaveError = `Failed to save plan: ${err.message}`;
			this.wizard.showError(this.planSaveError);
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
