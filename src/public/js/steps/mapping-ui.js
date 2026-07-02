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
		this.showOnlySelected = false;
		// Keep the current table filter query so it survives re-renders
		this.tableFilterQuery = '';
	}

	/**
	 * Load presets from API and render buttons
	 */
	async loadPresets() {
		const container = document.getElementById('preset-shortcuts-container');
		if (!container) return;
		container.innerHTML = '<em>Loading presets...</em>';
		try {
			const res = await fetch('/api/presets');
			const data = await res.json();
			if (!data || !data.presets) {
				container.innerHTML = '';
				return;
			}
			container.innerHTML = '';
			// render system presets first
			data.presets.forEach(p => {
				const btn = document.createElement('button');
				btn.className = 'btn btn-secondary btn-sm';
				btn.textContent = p.name;
				btn.title = p.description || p.code;
				btn.dataset.presetId = p.preset_id;
				btn.addEventListener('click', async () => {
					if (!window.confirm(`Replace current mappings with '${p.name}' preset?`)) return;
					try {
						// Create profile from preset on server and get mapping
						const resp = await fetch(`/api/profiles/from-preset/${p.preset_id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${p.name} (temp)` }) });
						const jr = await resp.json();
						if (!jr.success) {
							console.error('Failed to apply preset', jr);
							return;
						}
						const mapping = jr.mapping;
						if (mapping) {
							this.mapping = mapping;
							// populate selectedTables set
							this.selectedTables = new Set(Object.keys(this.mapping.tables || {}));
							this.state.set('mapping', this.mapping);
							this.render();
							console.debug('[MappingShortcut] Applied preset', p.code || p.name);
						}
					} catch (e) {
						console.error('Preset apply error', e);
					}
				});
				container.appendChild(btn);
				container.appendChild(document.createTextNode(' '));
			});
		} catch (e) {
			container.innerHTML = '';
			console.debug('[MappingShortcut] Failed to load presets', e.message);
		}
	}

	/**
	 * Load saved profiles into dropdown
	 */
	async loadProfiles() {
		const select = document.getElementById('profile-load-select');
		if (!select) return;
		select.innerHTML = '<option value="">Loading...</option>';
		try {
			const res = await fetch('/api/profiles');
			const data = await res.json();
			select.innerHTML = '';
			if (!data || !data.profiles) return;
			const placeholder = document.createElement('option');
			placeholder.value = '';
			placeholder.textContent = 'Load Profile...';
			select.appendChild(placeholder);
			data.profiles.forEach(p => {
				const opt = document.createElement('option');
				opt.value = p.profile_id;
				opt.textContent = `${p.name} ${p.created_from_preset_code ? '(' + p.created_from_preset_code + ')' : ''}`;
				select.appendChild(opt);
			});
			// wire buttons
			const loadBtn = document.getElementById('btn-load-profile');
			if (loadBtn) loadBtn.onclick = () => this.handleLoadProfile();
			const updateBtn = document.getElementById('btn-update-profile');
			if (updateBtn) updateBtn.onclick = () => this.handleUpdateProfile();
			const deleteBtn = document.getElementById('btn-delete-profile');
			if (deleteBtn) deleteBtn.onclick = () => this.handleDeleteProfile();
			const saveBtn = document.getElementById('btn-save-profile');
			if (saveBtn) saveBtn.onclick = () => this.handleSaveProfile();
		} catch (e) {
			select.innerHTML = '';
			console.debug('[Profiles] Failed to load profiles', e.message);
		}
	}

	/**
	 * Handle Save as Profile action (open modal for name/description)
	 */
	async handleSaveProfile() {
		const currentMapping = this.mapping;
		if (!currentMapping) return Modal.alert({ title: 'No mapping', message: 'No mapping to save' });
		const result = await Modal.custom({
			title: 'Save Mapping as Profile',
			contentHTML: `<div class="form-group"><label>Name</label><input id="save-profile-name" class="form-control" value="${this.mapping.name || ''}"></div><div class="form-group"><label>Description</label><input id="save-profile-desc" class="form-control"></div>`,
			onMount: (el) => { },
			onConfirm: async (overlayEl) => {
				const nameEl = overlayEl.querySelector('#save-profile-name');
				const descEl = overlayEl.querySelector('#save-profile-desc');
				const name = nameEl ? nameEl.value : (this.mapping.name || `Profile ${new Date().toLocaleString()}`);
				const desc = descEl ? descEl.value : null;
				try {
					const resp = await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: desc, mapping_json: currentMapping }) });
					const jr = await resp.json();
					if (jr.success) {
						Modal.alert({ title: 'Saved', message: 'Profile saved successfully' });
						this.loadProfiles();
					} else {
						Modal.alert({ title: 'Error', message: JSON.stringify(jr) });
					}
				} catch (e) {
					Modal.alert({ title: 'Error', message: e.message });
				}
			}
		});
	}

	/**
	 * Update selected profile with current mapping
	 */
	async handleUpdateProfile() {
		const select = document.getElementById('profile-load-select');
		if (!select) return Modal.alert({ title: 'Error', message: 'Profile selector not found' });
		const id = select.value;
		if (!id) return Modal.alert({ title: 'Select', message: 'Please choose a profile to update' });
		const proceed = await Modal.confirm({ title: 'Confirm', message: 'This will overwrite the selected profile with the current mapping. Continue?' });
		if (!proceed) return;
		const currentMapping = this.mapping;
		if (!currentMapping) return Modal.alert({ title: 'No mapping', message: 'No mapping to save' });
		// Use profile name input value if available
		const container = document.getElementById('mapping-content');
		const nameInput = container?.querySelector('#mapping-profile-name');
		const name = nameInput ? nameInput.value : (currentMapping.name || `Profile ${new Date().toLocaleString()}`);
		try {
			const resp = await fetch(`/api/profiles/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: null, mapping_json: currentMapping }) });
			const jr = await resp.json();
			if (jr.success) {
				Modal.alert({ title: 'Updated', message: 'Profile updated successfully' });
				this.loadProfiles();
			} else {
				Modal.alert({ title: 'Error', message: JSON.stringify(jr) });
			}
		} catch (e) {
			Modal.alert({ title: 'Error', message: e.message });
		}
	}

	/**
	 * Delete selected profile after confirmation
	 */
	async handleDeleteProfile() {
		const select = document.getElementById('profile-load-select');
		if (!select) return Modal.alert({ title: 'Error', message: 'Profile selector not found' });
		const id = select.value;
		if (!id) return Modal.alert({ title: 'Select', message: 'Please choose a profile to delete' });
		const proceed = await Modal.confirm({ title: 'Confirm Deletion', message: 'This will permanently delete the selected profile. Continue?' });
		if (!proceed) return;
		try {
			const resp = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
			const jr = await resp.json();
			if (jr.success) {
				Modal.alert({ title: 'Deleted', message: 'Profile deleted' });
				this.loadProfiles();
				// clear selection/state if the deleted profile was applied
				if (this.mapping && String(this.mapping.id) === String(id)) {
					this.mapping = { id: null, mappingProfileId: null, name: `Mapping ${new Date().toLocaleDateString()}`, tables: {} };
					this.state.updateMapping(this.mapping);
					this.render();
				}
			} else {
				Modal.alert({ title: 'Error', message: JSON.stringify(jr) });
			}
		} catch (e) {
			Modal.alert({ title: 'Error', message: e.message });
		}
	}

	/**
	 * Handle Load Profile action: confirm and apply
	 */
	async handleLoadProfile() {
		const select = document.getElementById('profile-load-select');
		if (!select) return;
		const id = select.value;
		if (!id) return Modal.alert({ title: 'Select', message: 'Please choose a profile to load' });
		// const ok = await Modal.confirm({ title: 'Confirm', message: 'Replace current mappings with selected profile?' });
		// if (!ok) return;
		try {
			const res = await fetch(`/api/profiles/${id}`);
			const data = await res.json();
			if (!data || !data.profile) return Modal.alert({ title: 'Error', message: 'Failed to load profile' });
			const mapping = typeof data.profile.mapping_json === 'string' ? JSON.parse(data.profile.mapping_json) : data.profile.mapping_json;
			this.mapping = mapping;
			this.selectedTables = new Set(Object.keys(this.mapping.tables || {}));
			this.state.set('mapping', this.mapping);
			this.render();

			// Modal.alert({ title: 'Loaded', message: 'Profile applied' });
		} catch (e) {
			Modal.alert({ title: 'Error', message: e.message });
		}
	}

	/**
	 * Initialize mapping builder
	 */
	async initialize() {
		console.log('Initializing Mapping Builder...');

		// Get schema from previous step
		this.schema = this.state.get('schema');
		if (!this.schema) {
			// Schema may have expired from localStorage cache — try re-fetching from the API
			try {
				console.log('[MappingUI] Schema missing from state, attempting to re-fetch cached schema...');
				const cached = await window.SchemaAPI.getCached();
				if (cached) {
					this.state.setSchema(cached);
					this.schema = cached;
					console.log('[MappingUI] Recovered schema from API cache');
				}
			} catch (e) {
				console.warn('[MappingUI] Failed to re-fetch schema from API:', e);
			}
		}
		if (!this.schema) {
			this.wizard.showError('Schema not available. Please go back to Step 1.');
			return;
		}

		// Try to load existing mapping
		this.mapping = this.state.get('mapping');
		if (this.mapping && !this.mapping.mappingProfileId) {
			this.mapping.mappingProfileId = this.mapping.id || this.mapping.profileId || null;
		}

		if (!this.mapping || !this.mapping.name) {
			// Create new mapping
			this.mapping = {
				id: null,
				mappingProfileId: null,
				name: `Mapping ${new Date().toLocaleDateString()}`,
				tables: {}
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
		const visibleTables = this.showOnlySelected ? firebirdTables.filter(t => this.selectedTables.has(t.name)) : firebirdTables;

		container.innerHTML = `
		<div class="mapping-builder">
		<h2>Build a table and Field Map</h2>
		
        <!-- Profile Settings -->
        <div class="profile-settings">
          <div class="form-group">
            <label for="mapping-profile-name">Profile Name:</label>
            <input type="text" id="mapping-profile-name" class="form-control" 
                   value="${this.mapping.name}" 
                   placeholder="Enter profile name">
          </div>
        </div>
        
				<!-- Table Selection -->
				<div class="table-selection"> 
					<!-- Preset shortcuts (populated from server) -->
					<div class="preset-shortcuts" style="margin-bottom:10px;" id="preset-shortcuts-container">
						<!-- Buttons loaded dynamically -->
					</div>
					<div class="profile-actions" style="margin-bottom:10px;">
						<select id="profile-load-select" class="form-control" style="display:inline-block; width:300px; margin-right:8px;"></select>
						<button class="btn btn-secondary btn-sm" id="btn-load-profile">Load Profile</button>
						<button class="btn btn-secondary btn-sm" id="btn-update-profile">Update Profile</button>
						<button class="btn btn-danger btn-sm" id="btn-delete-profile">Delete Profile</button>
						<button class="btn btn-secondary btn-sm" id="btn-save-profile">Save as Profile</button>
					</div>
          <h3>Select Tables to Map</h3>
					<div class="table-actions">
						<input style="margin-bottom: 10px !important;" type="text" id="table-filter" class="form-control" 
								 placeholder="🔍 Filter tables..." value="${this.tableFilterQuery || ''}">
						<div style="display:inline-block; margin-left:8px; vertical-align: top;">
						  <select id="table-visibility-select" class="form-control">
							<option value="all" ${this.showOnlySelected ? '' : 'selected'}>All</option>
							<option value="checked" ${this.showOnlySelected ? 'selected' : ''}>Checked</option>
						  </select>
						</div>
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
							${this.renderTableRows(visibleTables)}
						</tbody>
          </table>
        </div>
        
        <!-- Field Mapping Editor -->
        <div id="field-editor-container" style="display: none;">
          <div id="field-editor"></div>
        </div>
        
				<!-- Validation Summary -->
				<div id="validation-summary" class="validation-summary"></div>
				<!-- Floating scroll-to-top button -->
				<button id="scroll-top-btn" class="btn btn-primary scroll-top-btn" title="Back to top">↑</button>
      </div>
    `;

		this.attachEventListeners();
		// Load presets from server and wire handlers
		this.loadPresets();
		// Load profiles for load/save
		this.loadProfiles();
		// Re-apply any active table filter after event handlers are attached
		this.filterTables(this.tableFilterQuery || '');
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
						<select class="form-control target-table-select ${!targetTable ? 'empty' : ''}" 
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

		// Mapping profiles are always saved on Next in this step

		// Table filter
		const tableFilter = document.getElementById('table-filter');
		if (tableFilter) {
			tableFilter.addEventListener('input', (e) => {
				// persist the filter query so it survives render()
				this.tableFilterQuery = e.target.value || '';
				this.filterTables(this.tableFilterQuery);
			});
		}

		// Table visibility select (All / Checked)
		const visibilitySelect = document.getElementById('table-visibility-select');
		if (visibilitySelect) {
			visibilitySelect.addEventListener('change', (e) => {
				this.showOnlySelected = e.target.value === 'checked';
				this.render();
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
				// toggle empty class so placeholder selects appear silver
				e.target.classList.toggle('empty', !e.target.value);
			});
		});

		// Scroll-to-top floating button
		const scrollBtn = document.getElementById('scroll-top-btn');
		if (scrollBtn) {
			scrollBtn.addEventListener('click', (e) => {
				const containerEl = document.getElementById('mapping-content');
				if (containerEl && containerEl.scrollTo) {
					containerEl.scrollTo({ top: 0, behavior: 'smooth' });
				}
				window.scrollTo({ top: 0, behavior: 'smooth' });
			});

			// Optionally hide button when near top
			const toggleVisibility = () => {
				const containerEl = document.getElementById('mapping-content');
				const scrolled = (containerEl && containerEl.scrollTop) ? containerEl.scrollTop : window.scrollY;
				scrollBtn.classList.toggle('hidden', scrolled < 120);
			};

			// Attach scroll listeners
			const containerEl = document.getElementById('mapping-content');
			if (containerEl) containerEl.addEventListener('scroll', toggleVisibility);
			window.addEventListener('scroll', toggleVisibility);
			// initialize visibility
			toggleVisibility();
		}
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

		// Replace the complete mapping so tables removed from the selection are
		// also removed from persisted wizard state. updateMapping() deliberately
		// merges table keys and would otherwise retain unchecked profile tables.
		this.state.set('mapping', this.mapping);
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
		this.state.set('mapping', this.mapping);
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
			// onConfirm: () => {
			// 	this.saveFieldEditorChanges(tableName);
			// },
			onConfirm: (overlayEl) => {
				this.commitFieldEditorFromModal(tableName, overlayEl);
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
										<select class="form-control target-column ${!mapping.targetColumn ? 'empty' : ''}" data-source="${col.name}" ${isOmitted ? 'disabled' : ''}>
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
				// toggle empty class so placeholder selects appear silver
				e.target.classList.toggle('empty', !e.target.value);

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

	commitFieldEditorFromModal(tableName, overlayEl) {
		if (!overlayEl) return;

		// Omit checkboxes
		overlayEl.querySelectorAll('.field-omit').forEach(cb => {
			const sourceCol = cb.dataset.source;
			this.setFieldMapping(tableName, sourceCol, 'omit', cb.checked === true);
		});

		// Target selects (even if disabled, we read current value)
		overlayEl.querySelectorAll('.target-column').forEach(sel => {
			const sourceCol = sel.dataset.source;
			const val = sel.value || '';
			this.setFieldMapping(tableName, sourceCol, 'targetColumn', val);
		});

		// Transform selects
		overlayEl.querySelectorAll('.transform').forEach(sel => {
			const sourceCol = sel.dataset.source;
			this.setFieldMapping(tableName, sourceCol, 'transform', sel.value || null);
		});

		// Default values
		overlayEl.querySelectorAll('.default-value').forEach(inp => {
			const sourceCol = inp.dataset.source;
			this.setFieldMapping(tableName, sourceCol, 'defaultValue', inp.value ?? null);
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
	 * Confirm replacement if mappings exist and clear current mappings
	 * @returns {boolean} proceed
	 */
	confirmReplaceAndClear() {
		const hasMappings = this.mapping && this.mapping.tables && Object.keys(this.mapping.tables).length > 0;
		if (!hasMappings) return true;
		const proceed = window.confirm('This will replace current mappings. Continue?');
		if (!proceed) return false;
		this.deselectAll();
		return true;
	}

	/**
	 * Apply Stock preset mappings (STOCK -> stock, PRICING -> labour_pricing)
	 */
	async applyStockPreset() {
		console.debug('[MappingShortcut] Applying Stock preset');
		if (!this.confirmReplaceAndClear()) return;

		const presets = [
			{ source: 'STOCK', target: 'stock' },
			{ source: 'PRICING', target: 'labour_pricing' }
		];

		for (const p of presets) {
			const src = p.source;
			const tgt = p.target;
			const srcTable = this.getTableByName('firebird', src);
			const tgtTable = this.getTableByName('mysql', tgt);
			if (!srcTable || !tgtTable) {
				console.debug('[MappingShortcut] Stock preset skipped missing table', p);
				continue;
			}

			// Use actual schema table name so UI selection matches
			const srcKey = srcTable.name;
			// Add mapping entry
			this.selectedTables.add(srcKey);
			this.mapping.tables[srcKey] = this.mapping.tables[srcKey] || { targetTable: '', columns: {} };
			this.mapping.tables[srcKey].targetTable = tgt;
			this.mapping.tables[src].autoGenerated = true;

			// Auto-map fields silently then apply forced overrides
			this.autoMapFieldsForTable(srcKey, true);

			// Forced field mappings for STOCK only
			if (src === 'STOCK') {
				const overrides = { LOCATION: 'location', WIPSTATUS: 'wip_status' };
				// Try to map source column names case-insensitively
				const srcCols = this.getColumnsArray(srcTable).map(c => c.name);
				const normalizedOverrides = {};
				for (const [s, t] of Object.entries(overrides)) {
					const match = srcCols.find(c => c.toLowerCase() === s.toLowerCase());
					if (match) normalizedOverrides[match] = t;
				}
				window.MappingEngine.applyForcedFieldMappings(this.mapping.tables[srcKey], normalizedOverrides);
			}
		}

		this.state.updateMapping(this.mapping);
		this.render();
		console.debug('[MappingShortcut] Applied Stock preset');
	}

	/**
	 * Apply Customer preset mappings (only if tables exist on both schemas)
	 */
	async applyCustomerPreset() {
		console.debug('[MappingShortcut] Applying Customer preset');
		if (!this.confirmReplaceAndClear()) return;

		const list = [
			['CUSTOMER', 'customers'],
			['INVOICES', 'invoices'],
			['CNOTE', 'credit_notes'],
			['JOB_INFORMATION', 'job_information'],
			['SPARES_USED', 'spares_used'],
			['WORKDONE', 'work_done'],
			['PAYMENTS', 'payments'],
			['JOBREPORT', 'job_report']
		];

		for (const [src, tgt] of list) {
			const srcTable = this.getTableByName('firebird', src);
			const tgtTable = this.getTableByName('mysql', tgt);
			if (!srcTable || !tgtTable) {
				console.debug('[MappingShortcut] Customer preset skipped missing table', { src, tgt });
				continue;
			}

			const srcKey = srcTable.name;
			this.selectedTables.add(srcKey);
			this.mapping.tables[srcKey] = this.mapping.tables[srcKey] || { targetTable: '', columns: {} };
			this.mapping.tables[srcKey].targetTable = tgt;
			this.mapping.tables[srcKey].autoGenerated = true;
			this.autoMapFieldsForTable(srcKey, true);
		}

		this.state.updateMapping(this.mapping);
		this.render();
		console.debug('[MappingShortcut] Applied Customer preset');
	}

	/**
	 * Apply Supplier preset mappings (only if tables exist on both schemas)
	 */
	async applySupplierPreset() {
		console.debug('[MappingShortcut] Applying Supplier preset');
		if (!this.confirmReplaceAndClear()) return;

		const list = [
			['SUPPLIER', 'suppliers'],
			['INVOICESUPPLIER', 'invoices_supplier'],
			['CNOTESUPP', 'credit_notes_supplier'],
			['PAYMENTSSUPP', 'payments_suppliers'],
			['INVTOTAL', 'invoice_items']
		];

		for (const [src, tgt] of list) {
			const srcTable = this.getTableByName('firebird', src);
			const tgtTable = this.getTableByName('mysql', tgt);
			if (!srcTable || !tgtTable) {
				console.debug('[MappingShortcut] Supplier preset skipped missing table', { src, tgt });
				continue;
			}

			const srcKey = srcTable.name;
			this.selectedTables.add(srcKey);
			this.mapping.tables[srcKey] = this.mapping.tables[srcKey] || { targetTable: '', columns: {} };
			this.mapping.tables[srcKey].targetTable = tgt;
			this.mapping.tables[srcKey].autoGenerated = true;
			this.autoMapFieldsForTable(srcKey, true);
		}

		this.state.updateMapping(this.mapping);
		this.render();
		console.debug('[MappingShortcut] Applied Supplier preset');
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
			this.mapping.mappingProfileId = this.mapping.id;

			// Store mappingProfileId in state for subsequent steps
			this.state.set('mappingProfileId', this.mapping.id);

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
