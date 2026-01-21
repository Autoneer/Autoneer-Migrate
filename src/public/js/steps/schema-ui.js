/**
 * SchemaUI - Step 1: Schema Discovery
 * 
 * Handles database schema discovery, caching, and display.
 * Users can view discovered tables and proceed to mapping.
 */
class SchemaUI {
	constructor(wizard) {
		this.wizard = wizard;
		this.state = window.WizardState;
		this.api = window.SchemaAPI;
		this.schema = null;
		this.isDiscovering = false;
	}

	/**
	 * Initialize schema discovery step
	 */
	async initialize() {
		console.log('[SchemaUI] Initializing Schema Discovery...');

		// Try to load from state first
		this.schema = this.state.get('schema');
		console.log('[SchemaUI] Schema from state:', this.schema);

		// Validate loaded schema has actual tables
		if (this.schema) {
			const firebirdTables = Object.keys(this.schema?.firebird?.tables || {});
			const mysqlTables = Object.keys(this.schema?.mysql?.tables || {});
			console.log('[SchemaUI] Loaded schema tables - Firebird:', firebirdTables.length, 'MySQL:', mysqlTables.length);

			// Only use cached schema if it has tables
			if (firebirdTables.length > 0) {
				this.render();
				return;
			} else {
				console.log('[SchemaUI] Cached schema is empty, will rediscover');
				this.schema = null;
			}
		}

		// Try to discover schemas
		await this.discover();
	}

	/**
	 * Discover schemas from databases
	 */
	async discover() {
		if (this.isDiscovering) return;

		this.isDiscovering = true;
		this.renderDiscovering();

		try {
			// Set wizard busy
			this.wizard.setBusy(true, 'Discovering database schemas...');
			this.wizard.setStepStatus(1, { type: 'info', message: 'Connecting to databases...' });

			// Try to get cached schema first
			this.schema = await this.api.getCached(3600000); // 1 hour cache
			console.log('[SchemaUI] Cached schema result:', this.schema);

			if (!this.schema) {
				// No cache or too old, trigger discovery
				this.wizard.setStepStatus(1, { type: 'info', message: 'Analyzing tables and columns...' });
				this.schema = await this.api.discover();
				console.log('[SchemaUI] Discovery result:', this.schema);
				this.wizard.setStepStatus(1, { type: 'info', message: 'Caching schema metadata...' });
			}

			// Validate the schema has tables
			const firebirdTables = Object.keys(this.schema?.firebird?.tables || {});
			const mysqlTables = Object.keys(this.schema?.mysql?.tables || {});
			console.log('[SchemaUI] Tables found - Firebird:', firebirdTables.length, 'MySQL:', mysqlTables.length);

			// Save to state
			this.state.setSchema(this.schema);

			// Render results
			this.render();

			// Show success status
			this.wizard.setStepStatus(1, {
				type: 'success',
				message: `Schema discovery complete! Found ${firebirdTables.length} Firebird and ${mysqlTables.length} MySQL tables.`
			});

		} catch (err) {
			console.error('Schema discovery failed:', err);
			this.renderError(err.message);
			this.wizard.setStepStatus(1, {
				type: 'error',
				message: `Schema discovery failed: ${err.message}`
			});
		} finally {
			this.isDiscovering = false;
			this.wizard.setBusy(false);
		}
	}

	/**
	 * Refresh schema (force re-discovery)
	 */
	async refresh() {
		if (this.isDiscovering) return;

		const confirmed = await Modal.confirm({
			title: 'Rescan Databases',
			message: 'This will re-scan the databases. Continue?',
			type: 'info',
			confirmText: 'Rescan',
			cancelText: 'Cancel'
		});

		if (!confirmed) {
			return;
		}

		this.isDiscovering = true;

		try {
			this.wizard.setBusy(true, 'Refreshing database schemas...');
			this.wizard.setStepStatus(1, { type: 'info', message: 'Re-discovering database schemas...' });

			this.schema = await this.api.refresh();
			const firebirdTables = Object.keys(this.schema?.firebird?.tables || {});
			const mysqlTables = Object.keys(this.schema?.mysql?.tables || {});

			if (!this.schema || firebirdTables.length === 0) {
				this.state.setSchema(null);
				this.renderError('Schema refresh returned no tables. Please retry discovery.');
				this.wizard.setStepStatus(1, {
					type: 'warning',
					message: 'Schema refresh returned no tables. Please retry discovery.'
				});
				this.wizard.renderNavigation();
				return;
			}

			this.state.setSchema(this.schema);
			this.render();
			this.wizard.setStepStatus(1, {
				type: 'success',
				message: `Schema refreshed successfully! Found ${firebirdTables.length} Firebird and ${mysqlTables.length} MySQL tables.`
			});
			this.wizard.renderNavigation();

		} catch (err) {
			console.error('Schema refresh failed:', err);
			this.wizard.showError(`Refresh failed: ${err.message}`);
			this.wizard.setStepStatus(1, { type: 'error', message: `Refresh failed: ${err.message}` });
		} finally {
			this.isDiscovering = false;
			this.wizard.setBusy(false);
		}
	}

	/**
	 * Render discovering state
	 */
	renderDiscovering() {
		const container = document.getElementById('schema-content');
		if (!container) return;

		container.innerHTML = `
      <div class="discovery-status">
        <div class="spinner-large"></div>
        <h3>Discovering Database Schemas...</h3>
        <p>Please wait while we scan your databases</p>
        
        <div class="discovery-steps">
          <div class="step active">
            <span class="spinner-sm"></span>
            Connecting to Firebird...
          </div>
          <div class="step">
            <span class="icon">○</span>
            Analyzing tables...
          </div>
          <div class="step">
            <span class="icon">○</span>
            Caching metadata...
          </div>
        </div>
      </div>
    `;
	}

	/**
	 * Render discovered schema
	 */
	render() {
		const container = document.getElementById('schema-content');
		if (!container) return;

		if (!this.schema) {
			this.renderError('No schema data available');
			return;
		}

		// Tables are objects keyed by name, convert to arrays
		const firebirdTablesObj = this.schema.firebird?.tables || {};
		const mysqlTablesObj = this.schema.mysql?.tables || {};
		const firebirdTables = Object.keys(firebirdTablesObj);
		const mysqlTables = Object.keys(mysqlTablesObj);

		// Show warning if no Firebird tables
		const firebirdWarning = firebirdTables.length === 0 ? `
			<div class="alert alert-warning">
				<h4>⚠️ No Firebird Tables Found</h4>
				<p>The Firebird database appears to be empty or contains only system tables/views.</p>
				<button class="btn btn-sm btn-primary" onclick="window.wizard.steps[0].component.runDiagnostic()">
					🔍 Run Diagnostic
				</button>
				<p style="margin-top: 10px; font-size: 0.875rem;">
					This will show all relations in the Firebird database to help identify the issue.
				</p>
			</div>
		` : '';

		container.innerHTML = `
      <div class="schema-summary">
        <h2>Schema Discovery Complete ✓</h2>
        <p>Found tables in databases</p>
        
        ${firebirdWarning}
        
        <div class="schema-stats">
          <div class="stat-card ${firebirdTables.length === 0 ? 'status-warning' : ''}">
            <div class="stat-icon">🗄️</div>
            <div class="stat-content">
              <div class="stat-label">Firebird (Source)</div>
              <div class="stat-value">${firebirdTables.length}</div>
              <div class="stat-detail">tables</div>
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-icon">🗃️</div>
            <div class="stat-content">
              <div class="stat-label">MySQL (Target)</div>
              <div class="stat-value">${mysqlTables.length}</div>
              <div class="stat-detail">tables</div>
            </div>
          </div>
        </div>
        
        <div class="schema-actions">
          <button class="btn btn-secondary" onclick="window.wizard.steps[0].component.refresh()">
            🔄 Refresh Schemas
          </button>
          <button class="btn btn-secondary" onclick="window.wizard.steps[0].component.showDetails()">
            📋 View Details
          </button>
        </div>
      </div>
      
      <div id="schema-details" class="schema-details" style="display: none;">
        ${this.renderTableLists()}
      </div>
      
      <div class="step-help">
        <h3>What's Next?</h3>
        <p>
          Schemas have been discovered and cached. Click <strong>Next</strong> to proceed 
          to mapping configuration where you'll select which tables to migrate and configure 
          field mappings.
        </p>
      </div>
    `;
	}

	/**
	 * Run diagnostic on Firebird database
	 */
	async runDiagnostic() {
		try {
			this.wizard.setBusy(true, 'Running Firebird diagnostic...');
			console.log('[SchemaUI] Running Firebird diagnostic...');

			const diagnostic = await this.api.runFirebirdDiagnostic();
			console.log('[SchemaUI] Diagnostic results:', diagnostic);

			// Display results in modal or alert
			const userTables = diagnostic.userTables || [];
			const userViews = diagnostic.userViews || [];
			const stats = diagnostic.statistics || {};

			let message = `Firebird Database Diagnostic Results:\n\n`;
			message += `Total Relations: ${stats.totalRelations || 0}\n`;
			message += `User Tables: ${stats.userTables || 0}\n`;
			message += `User Views: ${stats.userViews || 0}\n`;
			message += `System Objects: ${stats.systemObjects || 0}\n\n`;

			if (userTables.length > 0) {
				message += `User Tables Found:\n${userTables.join(', ')}\n\n`;
				message += `The database DOES contain user tables but they're not being discovered. Check the Node.js console logs for [Schema] messages to see what's happening during discovery.`;
			} else {
				message += `No user tables found in the database.\n\n`;
				message += `This could mean:\n`;
				message += `- The database is new/empty\n`;
				message += `- Tables are marked as system tables\n`;
				message += `- All relations are views, not tables`;
			}

			if (userViews.length > 0) {
				message += `\n\nUser Views Found: ${userViews.length}\n`;
				message += userViews.slice(0, 10).join(', ');
				if (userViews.length > 10) message += '...';
			}

			await Modal.alert({
				title: 'Diagnostic Complete',
				message,
				type: 'info'
			});

			this.wizard.setStepStatus(1, {
				type: 'info',
				message: `Diagnostic complete: ${stats.userTables || 0} user tables, ${stats.userViews || 0} views`
			});

		} catch (err) {
			console.error('[SchemaUI] Diagnostic failed:', err);
			await Modal.alert({
				title: 'Diagnostic Failed',
				message: `${err.message}\n\nCheck browser console for details.`,
				type: 'error'
			});
		} finally {
			this.wizard.setBusy(false);
		}
	}

	/**
	 * Render detailed table lists
	 */
	renderTableLists() {
		// Tables are objects keyed by name, convert to arrays of table objects
		const firebirdTablesObj = this.schema.firebird?.tables || {};
		const mysqlTablesObj = this.schema.mysql?.tables || {};
		const firebirdTables = Object.values(firebirdTablesObj);
		const mysqlTables = Object.values(mysqlTablesObj);

		return `
      <div class="table-lists">
        <div class="table-list-section">
          <h3>Firebird Tables (Source)</h3>
          <div class="table-search">
            <input type="text" id="firebird-search" placeholder="Filter tables..." 
                   onkeyup="window.wizard.steps[0].component.filterTables('firebird', this.value)">
          </div>
          <table class="table-list" id="firebird-table-list">
            <thead>
              <tr>
                <th>Table Name</th>
                <th>Columns</th>
                <th>Primary Key</th>
              </tr>
            </thead>
            <tbody>
              ${firebirdTables.map(table => `
                <tr>
                  <td><strong>${table.name}</strong></td>
                  <td>${Object.keys(table.columns || {}).length}</td>
                  <td>${(table.primaryKey || []).join(', ') || '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        
        <div class="table-list-section">
          <h3>MySQL Tables (Target)</h3>
          <div class="table-search">
            <input type="text" id="mysql-search" placeholder="Filter tables..." 
                   onkeyup="window.wizard.steps[0].component.filterTables('mysql', this.value)">
          </div>
          <table class="table-list" id="mysql-table-list">
            <thead>
              <tr>
                <th>Table Name</th>
                <th>Columns</th>
                <th>Primary Key</th>
              </tr>
            </thead>
            <tbody>
              ${mysqlTables.map(table => `
                <tr>
                  <td><strong>${table.name}</strong></td>
                  <td>${Object.keys(table.columns || {}).length}</td>
                  <td>${(table.primaryKey || []).join(', ') || '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
	}

	/**
	 * Show/hide detailed view
	 */
	showDetails() {
		const details = document.getElementById('schema-details');
		if (details) {
			const isHidden = details.style.display === 'none';
			details.style.display = isHidden ? 'block' : 'none';

			// Update button text
			const btn = event.target;
			btn.textContent = isHidden ? '📋 Hide Details' : '📋 View Details';
		}
	}

	/**
	 * Filter table list
	 */
	filterTables(dbType, query) {
		const tableList = document.getElementById(`${dbType}-table-list`);
		if (!tableList) return;

		const rows = tableList.querySelectorAll('tbody tr');
		const lowerQuery = query.toLowerCase();

		rows.forEach(row => {
			const tableName = row.querySelector('td:first-child').textContent.toLowerCase();
			if (tableName.includes(lowerQuery)) {
				row.style.display = '';
			} else {
				row.style.display = 'none';
			}
		});
	}

	/**
	 * Render error state
	 */
	renderError(message) {
		const container = document.getElementById('schema-content');
		if (!container) return;

		container.innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <h3>Schema Discovery Failed</h3>
        <p>${message}</p>
        
        <div class="error-actions">
          <button class="btn btn-primary" onclick="window.wizard.steps[0].component.discover()">
            🔄 Retry Discovery
          </button>
          <button class="btn btn-secondary" onclick="location.reload()">
            🔄 Reload Page
          </button>
        </div>
        
        <details class="error-details">
          <summary>Troubleshooting</summary>
          <ul>
            <li>Verify database connections are configured correctly</li>
            <li>Check that both Firebird and MySQL databases are accessible</li>
            <li>Ensure you have sufficient permissions to read schema metadata</li>
            <li>Check the browser console for detailed error messages</li>
          </ul>
        </details>
      </div>
    `;
	}

	/**
	 * Validate step before proceeding
	 */
	async onNext() {
		console.log('[SchemaUI] onNext validation:', {
			schema: this.schema,
			hasSchema: !!this.schema,
			firebirdData: this.schema?.firebird,
			tables: this.schema?.firebird?.tables
		});

		if (!this.schema) {
			this.wizard.showError('Schema must be discovered before proceeding');
			return false;
		}

		const firebirdTablesObj = this.schema.firebird?.tables || {};
		const firebirdTables = Object.keys(firebirdTablesObj);

		console.log('[SchemaUI] Table validation:', {
			firebirdTablesObj,
			firebirdTables,
			count: firebirdTables.length
		});

		if (firebirdTables.length === 0) {
			this.wizard.showError('No tables found in Firebird database. Please check the schema discovery and refresh if needed.');
			return false;
		}

		return true;
	}

	/**
	 * Handle previous button (not applicable for first step)
	 */
	async onPrevious() {
		return false; // Can't go back from first step
	}
}

// Export to window
window.SchemaUI = SchemaUI;
