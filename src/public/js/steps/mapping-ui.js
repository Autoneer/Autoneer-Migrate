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
	 * Get Firebird tables as array
	 */
	getFirebirdTables() {
		const tablesObj = this.schema?.firebird?.tables || {};
		return Array.isArray(tablesObj) ? tablesObj : Object.values(tablesObj);
	}

	/**
	 * Get MySQL tables as array
	 */
	getMysqlTables() {
		const tablesObj = this.schema?.mysql?.tables || {};
		return Array.isArray(tablesObj) ? tablesObj : Object.values(tablesObj);
	}

	/**
	 * Get table by name from schema
	 */
	getTableByName(dbType, tableName) {
		const tables = dbType === 'firebird' ? this.getFirebirdTables() : this.getMysqlTables();
		return tables.find(t => t?.name === tableName) || null;
	}

	/**
	 * Get columns as array for a table
	 */
	getColumnsArray(table) {
		if (!table?.columns) return [];
		return Array.isArray(table.columns) ? table.columns : Object.values(table.columns);
	}

	/**
	 * Get available MySQL target tables not yet used
	 */
	getAvailableTargetTables(sourceTableName) {
		const mysqlTables = this.getMysqlTables();
		const usedTargets = new Set(
			Object.values(this.mapping.tables || {})
				.map(t => t?.targetTable)
				.filter(Boolean)
		);

		const currentTarget = this.mapping.tables?.[sourceTableName]?.targetTable;
		return mysqlTables.filter(t => !usedTargets.has(t.name) || t.name === currentTarget);
	}

	/**
	 * Render mapping builder UI
	 */
	render() {
		const container = document.getElementById('mapping-content');
		if (!container) return;

		const firebirdTables = this.getFirebirdTables();

		container.innerHTML = `
      <div class="mapping-builder">
        <h2>Build Mapping Profile</h2>
        <p>Select tables to migrate and configure field mappings</p>
        
        <!-- Profile Settings -->
        <div class="profile-settings">
          <div class="form-group">
            <label for="mapping-profile-name">Profile Name:</label>
            <input type="text" id="mapping-profile-name" class="form-control" 
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
		const tableList = Array.isArray(tables) ? tables : Object.values(tables || {});

		return tableList.map(table => {
			const isSelected = this.selectedTables.has(table.name);
			const targetTable = this.mapping.tables[table.name]?.targetTable || '';
			const status = this.getTableStatus(table.name);
			const columnCount = table.columns ? Object.keys(table.columns).length : 0;
			const availableTargets = this.getAvailableTargetTables(table.name);
			const canEditOrAutoMap = isSelected && targetTable;

			return `
        <tr class="table-row ${isSelected ? 'selected' : ''}" data-table="${table.name}">
          <td>
            <input type="checkbox" class="table-checkbox" 
                   ${isSelected ? 'checked' : ''} 
                   data-table="${table.name}">
          </td>
          <td><strong>${table.name}</strong></td>
          <td>
						<select class="form-control target-table-select" 
										data-table="${table.name}"
										${!isSelected ? 'disabled' : ''}>
							<option value="">Select target...</option>
							${availableTargets.map(t => `
								<option value="${t.name}" ${targetTable === t.name ? 'selected' : ''}>${t.name}</option>
							`).join('')}
						</select>
          </td>
			  <td>${columnCount}</td>
          <td>
            <span class="status-badge status-${status.level}">
              ${status.icon} ${status.label}
            </span>
          </td>
          <td class="actions-cell">
            <button class="btn btn-sm btn-secondary" 
                    onclick="window.wizard.steps[1].component.autoMapFieldsForTable('${table.name}')"
                    title="Auto-map fields by name matching"
                    ${!canEditOrAutoMap ? 'disabled' : ''}>
              🪄 Auto-Map
            </button>
            <button class="btn btn-sm btn-secondary" 
                    onclick="window.wizard.steps[1].component.editTable('${table.name}')"
                    title="Edit field mappings"
                    ${!canEditOrAutoMap ? 'disabled' : ''}>
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
		// Profile name input - scoped to mapping step
		const container = document.getElementById('mapping-content');
		const profileName = container?.querySelector('#mapping-profile-name');
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

		// Target table selects
		document.querySelectorAll('.target-table-select').forEach(select => {
			select.addEventListener('change', (e) => {
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
	 * Edit field mappings for a table in a modal
	 */
	editTable(tableName) {
		this.currentTable = tableName;

		// Create draft of current mappings
		const sourceTable = this.getTableByName('firebird', tableName);
		const targetTableName = this.mapping.tables[tableName]?.targetTable;
		const targetTable = this.getTableByName('mysql', targetTableName);

		if (!sourceTable || !targetTable) {
			this.wizard.showError('Source or target table not found');
			return;
		}

		// Create modal with field editor
		const contentHTML = this.renderFieldEditorHTML(tableName);

		Modal.custom({
			title: `Edit Field Mappings: ${tableName} → ${targetTableName}`,
			contentHTML,
			type: 'info',
			size: 'xl',
			confirmText: 'Save',
			cancelText: 'Cancel',
			onMount: (modalEl) => {
				this.attachFieldEditorListeners(tableName, modalEl);
			},
			onConfirm: () => {
				this.saveFieldEditorChanges(tableName);
			},
			onCancel: () => {
				// Discard any unsaved changes
				this.currentTable = null;
			}
		});
	}

	/**
	 * Render field mapping editor HTML (for use in modal)
	 */
	renderFieldEditorHTML(tableName) {
		const sourceTable = this.getTableByName('firebird', tableName);
		const targetTableName = this.mapping.tables[tableName]?.targetTable;
		const targetTable = this.getTableByName('mysql', targetTableName);

		if (!sourceTable) return '<p>Source table not found</p>';
		if (!targetTable) return '<p>Please select a target table first</p>';

		const tableConfig = this.mapping.tables[tableName];
		const sourceColumns = this.getColumnsArray(sourceTable);
		const targetColumns = this.getColumnsArray(targetTable);
		const sortedTargetColumns = [...targetColumns].sort((a, b) =>
			(a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' })
		);

		// Add action button inside modal
		return `
      <div class="field-editor-modal">
        <div class="field-editor-actions">
          <button class="btn btn-sm btn-secondary" 
                  onclick="window.wizard.steps[1].component.autoMapFieldsForTable('${tableName}', true)"
                  title="Auto-map fields by name matching">
            🪄 Auto-Map Fields
          </button>
        </div>

        <table class="field-mapping-table">
          <thead>
            <tr>
              <th width="30">Omit</th>
              <th>Source Column</th>
              <th width="100">Type</th>
              <th width="30">→</th>
              <th>Target Column</th>
              <th width="120">Transform</th>
              <th width="140">Default Value</th>
            </tr>
          </thead>
          <tbody>
			${sourceColumns.map(col => {
			const mapping = tableConfig.columns[col.name] || {};
			const targetColMetadata = sortedTargetColumns.find(tc => tc.name === mapping.targetColumn);
			const isOmitted = mapping.omit === true;
			const defaultValue = mapping.defaultValue ?? this.getTypeSafeDefault(targetColMetadata?.type);

			return `
                <tr class="field-row ${isOmitted ? 'omitted' : ''}">
                  <td class="checkbox-cell">
                    <input type="checkbox" class="field-omit" 
                           data-source="${col.name}"
                           ${isOmitted ? 'checked' : ''}
                           title="Omit this field from migration">
                  </td>
                  <td><strong>${col.name}</strong></td>
                  <td><code>${col.type}</code></td>
                  <td>→</td>
                  <td>
                    <select class="form-control target-column" data-source="${col.name}" ${isOmitted ? 'disabled' : ''}>
                      <option value="">Select...</option>
										${sortedTargetColumns.map(tCol => `
                        <option value="${tCol.name}" 
                                ${mapping.targetColumn === tCol.name ? 'selected' : ''}>
                          ${tCol.name} (${tCol.type})
                        </option>
                      `).join('')}
                    </select>
                  </td>
                  <td>
                    <select class="form-control transform" data-source="${col.name}" ${isOmitted ? 'disabled' : ''}>
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
                           placeholder="${this.getTypeSafeDefault(targetColMetadata?.type)}" 
                           value="${defaultValue || ''}"
                           data-source="${col.name}"
                           ${isOmitted ? 'disabled' : ''}>
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
	attachFieldEditorListeners(tableName, modalEl) {
		const container = modalEl || document.body;

		// Omit checkboxes
		container.querySelectorAll('.field-omit').forEach(checkbox => {
			checkbox.addEventListener('change', (e) => {
				const sourceCol = e.target.dataset.source;
				const isOmitted = e.target.checked;

				// Disable/enable target column and other fields when omitted
				const row = e.target.closest('tr');
				if (row) {
					const targetSelect = row.querySelector('.target-column');
					const transformSelect = row.querySelector('.transform');
					const defaultInput = row.querySelector('.default-value');

					if (isOmitted) {
						row.classList.add('omitted');
						if (targetSelect) targetSelect.disabled = true;
						if (transformSelect) transformSelect.disabled = true;
						if (defaultInput) defaultInput.disabled = true;
					} else {
						row.classList.remove('omitted');
						if (targetSelect) targetSelect.disabled = false;
						if (transformSelect) transformSelect.disabled = false;
						if (defaultInput) defaultInput.disabled = false;
					}
				}

				this.setFieldMapping(tableName, sourceCol, 'omit', isOmitted);
			});
		});

		// Target column selects
		container.querySelectorAll('.target-column').forEach(select => {
			select.addEventListener('change', (e) => {
				const sourceCol = e.target.dataset.source;
				this.setFieldMapping(tableName, sourceCol, 'targetColumn', e.target.value);

				// Update default value placeholder when target column changes
				const targetTable = this.getTableByName('mysql', this.mapping.tables[tableName].targetTable);
				const targetColumns = this.getColumnsArray(targetTable);
				const targetColMetadata = targetColumns.find(tc => tc.name === e.target.value);
				const defaultInput = e.target.closest('tr').querySelector('.default-value');
				if (defaultInput && !defaultInput.value) {
					defaultInput.placeholder = this.getTypeSafeDefault(targetColMetadata?.type);
				}
			});
		});

		// Transform selects
		container.querySelectorAll('.transform').forEach(select => {
			select.addEventListener('change', (e) => {
				const sourceCol = e.target.dataset.source;
				this.setFieldMapping(tableName, sourceCol, 'transform', e.target.value);
			});
		});

		// Default value inputs
		container.querySelectorAll('.default-value').forEach(input => {
			const handleUpdate = (e) => {
				const sourceCol = e.target.dataset.source;
				this.setFieldMapping(tableName, sourceCol, 'defaultValue', e.target.value);
			};
			input.addEventListener('input', handleUpdate);
			input.addEventListener('change', handleUpdate);
		});
	}

	/**
	 * Save field editor changes and update mapping
	 */
	saveFieldEditorChanges(tableName) {
		// Changes were already applied via setFieldMapping during editing
		// Just persist to state and update validation
		this.state.updateMapping(this.mapping);
		this.updateValidation();
		this.render();
		this.currentTable = null;
	}

	/**
	 * Get type-safe default value for a column type
	 */
	getTypeSafeDefault(mysqlType) {
		if (!mysqlType) return '';

		const type = mysqlType.toUpperCase();

		// Numeric types
		if (['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE'].includes(type)) {
			return '0';
		}

		// Boolean
		if (['BOOLEAN', 'BOOL'].includes(type)) {
			return '0';
		}

		// Date types
		if (['DATE'].includes(type)) {
			return '1970-01-01';
		}

		// DateTime/Timestamp types
		if (['DATETIME', 'TIMESTAMP'].includes(type)) {
			return '1970-01-01 00:00:00';
		}

		// Time type
		if (['TIME'].includes(type)) {
			return '00:00:00';
		}

		// String types
		if (['CHAR', 'VARCHAR', 'TEXT', 'LONGTEXT', 'MEDIUMTEXT', 'TINYTEXT'].includes(type)) {
			return '';
		}

		// JSON type
		if (['JSON'].includes(type)) {
			return '{}';
		}

		// Fallback to empty string
		return '';
	}

	/**
	 * Auto-map fields for a specific table
	 */
	autoMapFieldsForTable(tableName, silent = false) {
		const sourceTable = this.getTableByName('firebird', tableName);
		const targetTableName = this.mapping.tables[tableName]?.targetTable;
		const targetTable = this.getTableByName('mysql', targetTableName);

		if (!sourceTable || !targetTable) return;

		let mappedCount = 0;

		const sourceColumns = this.getColumnsArray(sourceTable);
		const targetColumns = this.getColumnsArray(targetTable);

		sourceColumns.forEach(srcCol => {
			const srcName = srcCol.name.toLowerCase();

			// Try exact match first
			let targetCol = targetColumns.find(tc => tc.name.toLowerCase() === srcName);

			if (!targetCol) {
				// Try fuzzy match (removing underscores, etc.)
				const fuzzyName = srcName.replace(/[_\s-]/g, '');
				targetCol = targetColumns.find(tc =>
					tc.name.toLowerCase().replace(/[_\s-]/g, '') === fuzzyName
				);
			}

			if (targetCol) {
				// Initialize if needed
				if (!this.mapping.tables[tableName].columns[srcCol.name]) {
					this.mapping.tables[tableName].columns[srcCol.name] = {};
				}

				// Set target column and pre-fill default value if needed
				this.mapping.tables[tableName].columns[srcCol.name].targetColumn = targetCol.name;

				// Pre-fill default value if target is NOT NULL and no default exists
				const currentDefault = this.mapping.tables[tableName].columns[srcCol.name].defaultValue;
				if (!currentDefault && targetCol.nullable === false) {
					this.mapping.tables[tableName].columns[srcCol.name].defaultValue = this.getTypeSafeDefault(targetCol.type);
				}

				mappedCount++;
			}
		});

		this.state.updateMapping(this.mapping);

		// If in modal, just update without showing message
		if (silent) {
			return;
		}

		// Re-render field editor if open
		if (this.currentTable === tableName) {
			this.editTable(tableName);
		} else {
			this.render();
		}
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

		// Always save mapping to ensure it has an ID for plan creation
		// (Plans require a mapping ID reference)
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
