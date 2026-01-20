/**
 * MappingUI - Step 2: Build Mapping Profile
 * 
 * Handles table and field mapping configuration with:
 * - Table selection
 * - Field-to-field mapping
 * - Transform functions
 * - Profile saving
 */
class MappingUI {
	constructor(wizard) {
		this.wizard = wizard;
		this.state = window.WizardState;
		this.api = window.MappingAPI;
		this.schema = null;
		this.mapping = null;
		this.selectedTables = new Set();
		this.currentTable = null;
	}

	/**
	 * Initialize mapping builder
	 */
	async initialize() {
		console.log('Initializing Mapping Builder...');

		// Get schema from previous step
		this.schema = this.state.get('schema');
		if (!this.schema) {
			this.wizard.showError('Schema not available. Please go back to Step 1.');
			return;
		}

		// Try to load existing mapping
		this.mapping = this.state.get('mapping');

		if (!this.mapping || !this.mapping.name) {
			// Create new mapping
			this.mapping = {
				id: null,
				name: `Mapping ${new Date().toLocaleDateString()}`,
				tables: {},
				saveProfile: false
			};
		}

		// Initialize selected tables from mapping
		if (this.mapping.tables) {
			this.selectedTables = new Set(Object.keys(this.mapping.tables));
		}

		this.render();
	}

	/**
	 * Render mapping builder UI
	 */
	render() {
		const container = document.getElementById('mapping-content');
		if (!container) return;

		const firebirdTables = this.schema.firebird?.tables || [];

		container.innerHTML = `
      <div class="mapping-builder">
        <h2>Build Mapping Profile</h2>
        <p>Select tables to migrate and configure field mappings</p>
        
        <!-- Profile Settings -->
        <div class="profile-settings">
          <div class="form-group">
            <label for="profile-name">Profile Name:</label>
            <input type="text" id="profile-name" class="form-control" 
                   value="${this.mapping.name}" 
                   placeholder="Enter profile name">
          </div>
          
          <div class="form-group">
            <label>
              <input type="checkbox" id="save-profile" 
                     ${this.mapping.saveProfile ? 'checked' : ''}>
              Save this profile for reuse
            </label>
          </div>
        </div>
        
        <!-- Table Selection -->
        <div class="table-selection">
          <h3>Select Tables to Map</h3>
          
          <div class="table-actions">
            <input type="text" id="table-filter" class="form-control" 
                   placeholder="🔍 Filter tables...">
            <button class="btn btn-secondary btn-sm" onclick="window.wizard.steps[1].component.selectAll()">
              ☑ Select All
            </button>
            <button class="btn btn-secondary btn-sm" onclick="window.wizard.steps[1].component.deselectAll()">
              ☐ Deselect All
            </button>
          </div>
          
          <table class="mapping-table">
            <thead>
              <tr>
                <th width="50">
                  <input type="checkbox" id="select-all-checkbox">
                </th>
                <th>Source Table</th>
                <th>Target Table</th>
                <th>Fields</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="table-list">
              ${this.renderTableRows(firebirdTables)}
            </tbody>
          </table>
        </div>
        
        <!-- Field Mapping Editor -->
        <div id="field-editor-container" style="display: none;">
          <div id="field-editor"></div>
        </div>
        
        <!-- Validation Summary -->
        <div id="validation-summary" class="validation-summary"></div>
      </div>
    `;

		this.attachEventListeners();
		this.updateValidation();
	}

	/**
	 * Render table rows
	 */
	renderTableRows(tables) {
		return tables.map(table => {
			const isSelected = this.selectedTables.has(table.name);
			const targetTable = this.mapping.tables[table.name]?.targetTable || '';
			const status = this.getTableStatus(table.name);

			return `
        <tr class="table-row ${isSelected ? 'selected' : ''}" data-table="${table.name}">
          <td>
            <input type="checkbox" class="table-checkbox" 
                   ${isSelected ? 'checked' : ''} 
                   data-table="${table.name}">
          </td>
          <td><strong>${table.name}</strong></td>
          <td>
            <input type="text" class="form-control target-table-input" 
                   placeholder="Select target..." 
                   value="${targetTable}"
                   data-table="${table.name}"
                   ${!isSelected ? 'disabled' : ''}>
          </td>
          <td>${table.columns?.length || 0}</td>
          <td>
            <span class="status-badge status-${status.level}">
              ${status.icon} ${status.label}
            </span>
          </td>
          <td>
            <button class="btn btn-sm btn-secondary" 
                    onclick="window.wizard.steps[1].component.editTable('${table.name}')"
                    ${!isSelected || !targetTable ? 'disabled' : ''}>
              ⚙ Edit Fields
            </button>
          </td>
        </tr>
      `;
		}).join('');
	}

	/**
	 * Get table status
	 */
	getTableStatus(tableName) {
		if (!this.selectedTables.has(tableName)) {
			return { level: 'inactive', icon: '○', label: 'Not selected' };
		}

		const tableConfig = this.mapping.tables[tableName];
		if (!tableConfig || !tableConfig.targetTable) {
			return { level: 'warning', icon: '⚠', label: 'Missing target' };
		}

		const columnCount = Object.keys(tableConfig.columns || {}).length;
		if (columnCount === 0) {
			return { level: 'warning', icon: '⚠', label: 'No fields mapped' };
		}

		return { level: 'success', icon: '✓', label: 'Configured' };
	}

	/**
	 * Attach event listeners
	 */
	attachEventListeners() {
		// Profile name input
		const profileName = document.getElementById('profile-name');
		if (profileName) {
			profileName.addEventListener('input', (e) => {
				this.mapping.name = e.target.value;
				this.state.updateMapping({ name: e.target.value });
			});
		}

		// Save profile checkbox
		const saveProfile = document.getElementById('save-profile');
		if (saveProfile) {
			saveProfile.addEventListener('change', (e) => {
				this.mapping.saveProfile = e.target.checked;
				this.state.updateMapping({ saveProfile: e.target.checked });
			});
		}

		// Table filter
		const tableFilter = document.getElementById('table-filter');
		if (tableFilter) {
			tableFilter.addEventListener('input', (e) => {
				this.filterTables(e.target.value);
			});
		}

		// Select all checkbox
		const selectAllCheckbox = document.getElementById('select-all-checkbox');
		if (selectAllCheckbox) {
			selectAllCheckbox.addEventListener('change', (e) => {
				if (e.target.checked) {
					this.selectAll();
				} else {
					this.deselectAll();
				}
			});
		}

		// Table checkboxes
		document.querySelectorAll('.table-checkbox').forEach(checkbox => {
			checkbox.addEventListener('change', (e) => {
				const tableName = e.target.dataset.table;
				this.toggleTableSelection(tableName, e.target.checked);
			});
		});

		// Target table inputs
		document.querySelectorAll('.target-table-input').forEach(input => {
			input.addEventListener('change', (e) => {
				const tableName = e.target.dataset.table;
				this.setTargetTable(tableName, e.target.value);
			});
		});
	}

	/**
	 * Toggle table selection
	 */
	toggleTableSelection(tableName, selected) {
		if (selected) {
			this.selectedTables.add(tableName);

			// Initialize table config if not exists
			if (!this.mapping.tables[tableName]) {
				this.mapping.tables[tableName] = {
					targetTable: '',
					columns: {}
				};
			}
		} else {
			this.selectedTables.delete(tableName);
			delete this.mapping.tables[tableName];
		}

		this.state.updateMapping(this.mapping);
		this.render();
	}

	/**
	 * Set target table for a source table
	 */
	setTargetTable(sourceName, targetName) {
		if (!this.mapping.tables[sourceName]) {
			this.mapping.tables[sourceName] = { columns: {} };
		}

		this.mapping.tables[sourceName].targetTable = targetName;
		this.state.updateMapping(this.mapping);
		this.updateValidation();

		// Re-render to update status
		const row = document.querySelector(`tr[data-table="${sourceName}"]`);
		if (row) {
			const status = this.getTableStatus(sourceName);
			const statusCell = row.querySelector('.status-badge');
			if (statusCell) {
				statusCell.className = `status-badge status-${status.level}`;
				statusCell.innerHTML = `${status.icon} ${status.label}`;
			}

			// Enable Edit Fields button
			const editBtn = row.querySelector('button');
			if (editBtn) {
				editBtn.disabled = !targetName;
			}
		}
	}

	/**
	 * Edit field mappings for a table
	 */
	editTable(tableName) {
		this.currentTable = tableName;

		const container = document.getElementById('field-editor-container');
		const editor = document.getElementById('field-editor');
		if (!container || !editor) return;

		container.style.display = 'block';
		editor.innerHTML = this.renderFieldEditor(tableName);

		// Scroll to editor
		container.scrollIntoView({ behavior: 'smooth' });

		// Attach field editor event listeners
		this.attachFieldEditorListeners(tableName);
	}

	/**
	 * Render field mapping editor
	 */
	renderFieldEditor(tableName) {
		const sourceTable = this.schema.firebird.tables.find(t => t.name === tableName);
		const targetTableName = this.mapping.tables[tableName]?.targetTable;
		const targetTable = this.schema.mysql.tables.find(t => t.name === targetTableName);

		if (!sourceTable) return '<p>Source table not found</p>';
		if (!targetTable) return '<p>Please select a target table first</p>';

		const tableConfig = this.mapping.tables[tableName];

		return `
      <div class="field-editor">
        <div class="field-editor-header">
          <h3>Field Mapping: ${tableName} → ${targetTableName}</h3>
          <button class="btn btn-sm btn-secondary" 
                  onclick="window.wizard.steps[1].component.autoMapFields('${tableName}')">
            🪄 Auto-Map Fields
          </button>
          <button class="btn btn-sm btn-secondary" 
                  onclick="window.wizard.steps[1].component.closeFieldEditor()">
            ✕ Close
          </button>
        </div>
        
        <table class="field-mapping-table">
          <thead>
            <tr>
              <th>Source Column</th>
              <th>Type</th>
              <th>→</th>
              <th>Target Column</th>
              <th>Transform</th>
              <th>Default Value</th>
            </tr>
          </thead>
          <tbody>
            ${sourceTable.columns.map(col => {
			const mapping = tableConfig.columns[col.name] || {};
			return `
                <tr>
                  <td><strong>${col.name}</strong></td>
                  <td><code>${col.type}</code></td>
                  <td>→</td>
                  <td>
                    <select class="form-control target-column" data-source="${col.name}">
                      <option value="">Select...</option>
                      ${targetTable.columns.map(tCol => `
                        <option value="${tCol.name}" 
                                ${mapping.targetColumn === tCol.name ? 'selected' : ''}>
                          ${tCol.name} (${tCol.type})
                        </option>
                      `).join('')}
                    </select>
                  </td>
                  <td>
                    <select class="form-control transform" data-source="${col.name}">
                      <option value="">None</option>
                      <option value="trim" ${mapping.transform === 'trim' ? 'selected' : ''}>Trim</option>
                      <option value="toNumber" ${mapping.transform === 'toNumber' ? 'selected' : ''}>To Number</option>
                      <option value="toDate" ${mapping.transform === 'toDate' ? 'selected' : ''}>To Date</option>
                      <option value="toBoolean" ${mapping.transform === 'toBoolean' ? 'selected' : ''}>To Boolean</option>
                      <option value="uppercase" ${mapping.transform === 'uppercase' ? 'selected' : ''}>Uppercase</option>
                      <option value="lowercase" ${mapping.transform === 'lowercase' ? 'selected' : ''}>Lowercase</option>
                    </select>
                  </td>
                  <td>
                    <input type="text" class="form-control default-value" 
                           placeholder="null" 
                           value="${mapping.defaultValue || ''}"
                           data-source="${col.name}">
                  </td>
                </tr>
              `;
		}).join('')}
          </tbody>
        </table>
      </div>
    `;
	}

	/**
	 * Attach field editor event listeners
	 */
	attachFieldEditorListeners(tableName) {
		// Target column selects
		document.querySelectorAll('.target-column').forEach(select => {
			select.addEventListener('change', (e) => {
				const sourceCol = e.target.dataset.source;
				this.setFieldMapping(tableName, sourceCol, 'targetColumn', e.target.value);
			});
		});

		// Transform selects
		document.querySelectorAll('.transform').forEach(select => {
			select.addEventListener('change', (e) => {
				const sourceCol = e.target.dataset.source;
				this.setFieldMapping(tableName, sourceCol, 'transform', e.target.value);
			});
		});

		// Default value inputs
		document.querySelectorAll('.default-value').forEach(input => {
			input.addEventListener('change', (e) => {
				const sourceCol = e.target.dataset.source;
				this.setFieldMapping(tableName, sourceCol, 'defaultValue', e.target.value);
			});
		});
	}

	/**
	 * Set field mapping property
	 */
	setFieldMapping(tableName, sourceColumn, property, value) {
		if (!this.mapping.tables[tableName].columns[sourceColumn]) {
			this.mapping.tables[tableName].columns[sourceColumn] = {};
		}

		this.mapping.tables[tableName].columns[sourceColumn][property] = value;
		this.state.updateMapping(this.mapping);
		this.updateValidation();
	}

	/**
	 * Auto-map fields based on name matching
	 */
	autoMapFields(tableName) {
		const sourceTable = this.schema.firebird.tables.find(t => t.name === tableName);
		const targetTableName = this.mapping.tables[tableName]?.targetTable;
		const targetTable = this.schema.mysql.tables.find(t => t.name === targetTableName);

		if (!sourceTable || !targetTable) return;

		let mappedCount = 0;

		sourceTable.columns.forEach(srcCol => {
			const srcName = srcCol.name.toLowerCase();

			// Try exact match first
			let targetCol = targetTable.columns.find(tc => tc.name.toLowerCase() === srcName);

			if (!targetCol) {
				// Try fuzzy match (removing underscores, etc.)
				const fuzzyName = srcName.replace(/[_\s-]/g, '');
				targetCol = targetTable.columns.find(tc =>
					tc.name.toLowerCase().replace(/[_\s-]/g, '') === fuzzyName
				);
			}

			if (targetCol) {
				this.setFieldMapping(tableName, srcCol.name, 'targetColumn', targetCol.name);
				mappedCount++;
			}
		});

		// Re-render field editor
		this.editTable(tableName);

		this.wizard.clearMessages();
		if (mappedCount > 0) {
			this.wizard.showWarning(`Auto-mapped ${mappedCount} fields. Please review and adjust as needed.`);
		} else {
			this.wizard.showWarning('No automatic matches found. Please map fields manually.');
		}
	}

	/**
	 * Close field editor
	 */
	closeFieldEditor() {
		const container = document.getElementById('field-editor-container');
		if (container) {
			container.style.display = 'none';
		}
		this.currentTable = null;
		this.updateValidation();
	}

	/**
	 * Filter tables by name
	 */
	filterTables(query) {
		const rows = document.querySelectorAll('.table-row');
		const lowerQuery = query.toLowerCase();

		rows.forEach(row => {
			const tableName = row.dataset.table.toLowerCase();
			row.style.display = tableName.includes(lowerQuery) ? '' : 'none';
		});
	}

	/**
	 * Select all tables
	 */
	selectAll() {
		const firebirdTables = this.schema.firebird?.tables || [];
		firebirdTables.forEach(table => {
			this.selectedTables.add(table.name);
			if (!this.mapping.tables[table.name]) {
				this.mapping.tables[table.name] = { targetTable: '', columns: {} };
			}
		});

		this.state.updateMapping(this.mapping);
		this.render();
	}

	/**
	 * Deselect all tables
	 */
	deselectAll() {
		this.selectedTables.clear();
		this.mapping.tables = {};
		this.state.updateMapping(this.mapping);
		this.render();
	}

	/**
	 * Update validation summary
	 */
	updateValidation() {
		const summary = document.getElementById('validation-summary');
		if (!summary) return;

		const errors = [];
		const warnings = [];

		// Check profile name
		if (!this.mapping.name || this.mapping.name.trim() === '') {
			errors.push('Profile name is required');
		}

		// Check table selection
		if (this.selectedTables.size === 0) {
			errors.push('At least one table must be selected');
		}

		// Check each selected table
		this.selectedTables.forEach(tableName => {
			const config = this.mapping.tables[tableName];

			if (!config.targetTable) {
				warnings.push(`${tableName}: Target table not selected`);
			}

			const columnCount = Object.keys(config.columns || {}).length;
			if (columnCount === 0) {
				warnings.push(`${tableName}: No fields mapped`);
			}
		});

		// Render validation summary
		if (errors.length > 0 || warnings.length > 0) {
			summary.innerHTML = `
        ${errors.length > 0 ? `
          <div class="validation-errors">
            <h4>⚠ Errors (must fix)</h4>
            <ul>
              ${errors.map(err => `<li>${err}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        
        ${warnings.length > 0 ? `
          <div class="validation-warnings">
            <h4>⚠ Warnings (recommended)</h4>
            <ul>
              ${warnings.map(warn => `<li>${warn}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      `;
		} else {
			summary.innerHTML = `
        <div class="validation-success">
          <h4>✓ Mapping Valid</h4>
          <p>All required fields are configured. You may proceed to the next step.</p>
        </div>
      `;
		}
	}

	/**
	 * Validate before proceeding
	 */
	async onNext() {
		this.wizard.clearMessages();

		// Validate mapping
		if (!this.mapping.name || this.mapping.name.trim() === '') {
			this.wizard.showError('Profile name is required');
			return false;
		}

		if (this.selectedTables.size === 0) {
			this.wizard.showError('At least one table must be selected');
			return false;
		}

		// Save mapping if checkbox is checked
		if (this.mapping.saveProfile) {
			try {
				this.wizard.showLoading('Saving mapping profile...');

				if (this.mapping.id) {
					await this.api.update(this.mapping.id, this.mapping);
				} else {
					const saved = await this.api.create(this.mapping);
					this.mapping.id = saved.id;
				}

				this.wizard.hideLoading();
			} catch (err) {
				this.wizard.hideLoading();
				this.wizard.showError(`Failed to save profile: ${err.message}`);
				return false;
			}
		}

		// Update state
		this.state.updateMapping(this.mapping);

		return true;
	}

	/**
	 * Handle previous button
	 */
	async onPrevious() {
		// Save current state before going back
		this.state.updateMapping(this.mapping);
		return true;
	}
}

// Export to window
window.MappingUI = MappingUI;
