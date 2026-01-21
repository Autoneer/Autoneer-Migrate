/**
 * ResultsUI - Step 5: View Results
 * 
 * Displays migration results, statistics, errors, and provides
 * options to export reports or start new migrations.
 */
class ResultsUI {
	constructor(wizard) {
		this.wizard = wizard;
		this.state = window.WizardState;
		this.api = window.RunAPI;
		this.run = null;
		this.summary = null;
		this.errors = null;
	}

	/**
	 * Initialize results viewer
	 */
	async initialize() {
		console.log('Initializing Results Viewer...');

		// Get run from previous step
		const runId = this.state.get('run.id');
		if (!runId) {
			this.wizard.showError('No migration run found');
			return;
		}

		// Load run details
		try {
			this.wizard.showLoading('Loading results...');

			this.run = await this.api.getById(runId);
			this.summary = await this.api.getSummary(runId);

			if (this.run.status === 'failed' || this.summary.errorCount > 0) {
				this.errors = await this.api.getErrors(runId);
			}

			this.wizard.hideLoading();
			this.render();

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to load results: ${err.message}`);
		}
	}

	/**
	 * Render results viewer UI
	 */
	render() {
		const container = document.getElementById('results-content');
		if (!container) return;

		const isSuccess = this.run.status === 'completed' && this.summary.errorCount === 0;

		container.innerHTML = `
      <div class="results-viewer">
        <!-- Status Header -->
        <div class="results-header ${isSuccess ? 'success' : 'warning'}">
          <div class="status-icon">${isSuccess ? '✓' : '⚠'}</div>
          <div class="status-content">
            <h2>${isSuccess ? 'Migration Completed Successfully' : 'Migration Completed with Issues'}</h2>
            <p>${this.run.completedAt ? 'Completed at ' + new Date(this.run.completedAt).toLocaleString() : ''}</p>
          </div>
        </div>
        
        <!-- Summary Statistics -->
        <div class="results-stats">
          <div class="stat-card ${this.summary.tableCount === this.summary.successCount ? 'success' : 'warning'}">
            <div class="stat-icon">📊</div>
            <div class="stat-content">
              <div class="stat-value">${this.summary.successCount} / ${this.summary.tableCount}</div>
              <div class="stat-label">Tables Migrated</div>
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-icon">📝</div>
            <div class="stat-content">
              <div class="stat-value">${this.formatNumber(this.summary.totalRows || 0)}</div>
              <div class="stat-label">Rows Migrated</div>
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-icon">⏱️</div>
            <div class="stat-content">
              <div class="stat-value">${this.formatDuration(this.summary.duration)}</div>
              <div class="stat-label">Duration</div>
            </div>
          </div>
          
          <div class="stat-card ${this.summary.errorCount > 0 ? 'error' : 'success'}">
            <div class="stat-icon">${this.summary.errorCount > 0 ? '⚠' : '✓'}</div>
            <div class="stat-content">
              <div class="stat-value">${this.summary.errorCount || 0}</div>
              <div class="stat-label">Errors</div>
            </div>
          </div>
        </div>
        
        <!-- Table Results -->
        <div class="table-results">
          <h3>Table Details</h3>
          <table class="results-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Status</th>
                <th>Rows Migrated</th>
                <th>Duration</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              ${this.renderTableResults()}
            </tbody>
          </table>
        </div>
        
        <!-- Errors (if any) -->
        ${this.renderErrors()}
        
        <!-- Actions -->
        <div class="results-actions">
          <button class="btn btn-secondary" onclick="window.wizard.steps[4].component.downloadReport('json')">
            📥 Download JSON Report
          </button>
          <button class="btn btn-secondary" onclick="window.wizard.steps[4].component.downloadReport('csv')">
            📥 Download CSV Report
          </button>
          <button class="btn btn-secondary" onclick="window.wizard.steps[4].component.viewLogs()">
            📋 View Logs
          </button>
          <button class="btn btn-primary" onclick="window.wizard.steps[4].component.startNewMigration()">
            🔄 Start New Migration
          </button>
        </div>
      </div>
    `;
	}

	/**
	 * Render table results
	 */
	renderTableResults() {
		const tableResults = this.summary.tables || [];

		return tableResults.map(table => {
			const statusClass = table.status === 'completed' ? 'success' :
				table.status === 'failed' ? 'error' : 'warning';
			const statusIcon = table.status === 'completed' ? '✓' :
				table.status === 'failed' ? '✕' : '⚠';

			return `
        <tr class="table-result-${statusClass}">
          <td><strong>${table.name}</strong></td>
          <td>
            <span class="status-badge status-${statusClass}">
              ${statusIcon} ${table.status}
            </span>
          </td>
          <td>${this.formatNumber(table.rowsMigrated || 0)}</td>
          <td>${this.formatDuration(table.duration)}</td>
          <td>${table.errorCount || 0}</td>
        </tr>
      `;
		}).join('');
	}

	/**
	 * Render errors section
	 */
	renderErrors() {
		if (!this.errors || this.errors.length === 0) {
			return '';
		}

		return `
      <div class="error-details">
        <h3>⚠ Errors Encountered (${this.errors.length})</h3>
        
        <div class="error-list">
          ${this.errors.map((error, index) => `
            <details class="error-item">
              <summary>
                <span class="error-icon">✕</span>
                <span class="error-table">${error.table || 'Unknown'}</span>
                <span class="error-message">${error.message}</span>
              </summary>
              <div class="error-content">
                <div class="error-detail">
                  <strong>Time:</strong> ${new Date(error.timestamp).toLocaleString()}
                </div>
                ${error.row ? `
                  <div class="error-detail">
                    <strong>Row:</strong> ${error.row}
                  </div>
                ` : ''}
                ${error.column ? `
                  <div class="error-detail">
                    <strong>Column:</strong> ${error.column}
                  </div>
                ` : ''}
                ${error.value ? `
                  <div class="error-detail">
                    <strong>Value:</strong> <code>${error.value}</code>
                  </div>
                ` : ''}
                ${error.stack ? `
                  <div class="error-detail">
                    <strong>Stack Trace:</strong>
                    <pre>${error.stack}</pre>
                  </div>
                ` : ''}
              </div>
            </details>
          `).join('')}
        </div>
      </div>
    `;
	}

	/**
	 * Download report
	 */
	async downloadReport(format) {
		try {
			this.wizard.showLoading(`Generating ${format.toUpperCase()} report...`);

			const data = await this.api.export(this.run.id, format);

			// Create blob and download
			const blob = new Blob(
				[format === 'json' ? JSON.stringify(data, null, 2) : data],
				{ type: format === 'json' ? 'application/json' : 'text/csv' }
			);

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `migration-report-${this.run.id}.${format}`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);

			this.wizard.hideLoading();

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to download report: ${err.message}`);
		}
	}

	/**
	 * View detailed logs
	 */
	async viewLogs() {
		try {
			this.wizard.showLoading('Loading logs...');

			const logs = await this.api.getLogs(this.run.id);

			// Create modal with logs
			const modal = this.createModal('Migration Logs', `
        <div class="log-viewer">
          <div class="log-filters">
            <select id="log-level-filter">
              <option value="all">All Levels</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
            <input type="text" id="log-search" placeholder="Search logs...">
          </div>
          <pre class="log-content">${this.renderLogs(logs)}</pre>
        </div>
      `);

			document.body.appendChild(modal);

			this.wizard.hideLoading();

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to load logs: ${err.message}`);
		}
	}

	/**
	 * Render logs
	 */
	renderLogs(logs) {
		return logs.map(log => {
			const timestamp = new Date(log.timestamp).toLocaleTimeString();
			const level = log.level.toUpperCase().padEnd(7);
			return `[${timestamp}] ${level} ${log.message}`;
		}).join('\n');
	}

	/**
	 * Create modal dialog
	 */
	createModal(title, content) {
		const modal = document.createElement('div');
		modal.className = 'modal-overlay';
		modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-header">
          <h3>${title}</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          ${content}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
        </div>
      </div>
    `;
		return modal;
	}

	/**
	 * Start new migration
	 */
	startNewMigration() {
		(async () => {
			const confirmed = await Modal.confirm({
				title: 'Start New Migration',
				message: 'Start a new migration? This will reset the wizard.',
				type: 'warning',
				confirmText: 'Start New',
				cancelText: 'Cancel'
			});

			if (!confirmed) {
				return;
			}

			this.wizard.reset();
		})();
	}

	/**
	 * Format number with commas
	 */
	formatNumber(num) {
		return num.toLocaleString();
	}

	/**
	 * Format duration in ms to readable format
	 */
	formatDuration(ms) {
		if (!ms) return '—';

		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);

		if (hours > 0) {
			return `${hours}h ${minutes % 60}m`;
		} else if (minutes > 0) {
			return `${minutes}m ${seconds % 60}s`;
		} else {
			return `${seconds}s`;
		}
	}

	/**
	 * Validate before proceeding (this is the last step)
	 */
	async onNext() {
		// Last step - no next button
		return false;
	}

	/**
	 * Handle previous button
	 */
	async onPrevious() {
		// Can go back to view execution details
		return true;
	}
}

// Export to window
window.ResultsUI = ResultsUI;
