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
		console.log('Initializing Schema Discovery...');

		// Try to load from state first
		this.schema = this.state.get('schema');

		if (this.schema) {
			this.render();
			return;
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
			this.wizard.showLoading('Discovering database schemas...');

			// Try to get cached schema first
			this.schema = await this.api.getCached(3600000); // 1 hour cache

			if (!this.schema) {
				// No cache or too old, trigger discovery
				this.schema = await this.api.discover();
			}

			// Save to state
			this.state.setSchema(this.schema);

			// Render results
			this.render();

		} catch (err) {
			console.error('Schema discovery failed:', err);
			this.renderError(err.message);
		} finally {
			this.isDiscovering = false;
			this.wizard.hideLoading();
		}
	}

	/**
	 * Refresh schema (force re-discovery)
	 */
	async refresh() {
		if (this.isDiscovering) return;

		if (!confirm('This will re-scan the databases. Continue?')) {
			return;
		}

		this.isDiscovering = true;

		try {
			this.wizard.showLoading('Refreshing database schemas...');

			this.schema = await this.api.refresh();
			this.state.setSchema(this.schema);

			this.render();
			this.wizard.clearMessages();

		} catch (err) {
			console.error('Schema refresh failed:', err);
			this.wizard.showError(`Refresh failed: ${err.message}`);
		} finally {
			this.isDiscovering = false;
			this.wizard.hideLoading();
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

		const firebirdTables = this.schema.firebird?.tables || [];
		const mysqlTables = this.schema.mysql?.tables || [];

		container.innerHTML = `
      <div class="schema-summary">
        <h2>Schema Discovery Complete ✓</h2>
        <p>Found tables in both databases</p>
        
        <div class="schema-stats">
          <div class="stat-card">
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
	 * Render detailed table lists
	 */
	renderTableLists() {
		const firebirdTables = this.schema.firebird?.tables || [];
		const mysqlTables = this.schema.mysql?.tables || [];

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
                  <td>${table.columns?.length || 0}</td>
                  <td>${table.primaryKey || '—'}</td>
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
                  <td>${table.columns?.length || 0}</td>
                  <td>${table.primaryKey || '—'}</td>
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
		if (!this.schema) {
			this.wizard.showError('Schema must be discovered before proceeding');
			return false;
		}

		const firebirdTables = this.schema.firebird?.tables || [];
		if (firebirdTables.length === 0) {
			this.wizard.showError('No tables found in Firebird database');
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
