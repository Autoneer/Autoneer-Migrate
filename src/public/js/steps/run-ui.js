/**
 * RunUI - Step 4: Execute Migration
 * 
 * Handles migration execution with real-time progress tracking,
 * table-by-table status, and error handling.
 */
class RunUI {
	constructor(wizard) {
		this.wizard = wizard;
		this.state = window.WizardState;
		this.api = window.RunAPI;
		this.plan = null;
		this.run = null;
		this.pollInterval = null;
		this.startTime = null;
	}

	/**
	 * Initialize execution monitor
	 */
	async initialize() {
		console.log('Initializing Execution Monitor...');

		// Get plan from previous step
		this.plan = this.state.get('plan') || {};
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

		if (!this.plan || !this.plan.id) {
			this.wizard.showError('Plan not available. Please go back to Step 3 and save the plan.');
			return;
		}

		if (this.plan.tables.length === 0) {
			this.wizard.showError('Plan has no tables. Go back to Step 3 and re-save the plan.');
			return;
		}

		// Check if there's an existing run
		const runId = this.state.get('run.id');
		if (runId) {
			try {
				this.run = await this.api.getById(runId);
				if (String(this.run.status || '').toUpperCase() === 'RUNNING') {
					// Resume monitoring
					this.startPolling();
				}
			} catch (err) {
				console.warn('Could not load existing run:', err);
			}
		}

		this.render();
	}

	/**
	 * Render execution monitor UI
	 */
	render() {
		const container = document.getElementById('run-content');
		if (!container) return;

		// Normalize status to uppercase for comparison
		const status = this.run ? String(this.run.status || '').toUpperCase() : '';

		if (!this.run) {
			// Not started yet
			container.innerHTML = this.renderPreExecution();
		} else if (status === 'RUNNING') {
			// Currently running
			container.innerHTML = this.renderRunning();
			this.startPolling();
		} else if (status === 'SUCCESS' || status === 'COMPLETED') {
			// Completed
			container.innerHTML = this.renderCompleted();
		} else if (status === 'COMPLETED_WITH_ERRORS') {
			// Completed with errors
			container.innerHTML = this.renderCompletedWithErrors();
		} else if (status === 'FAILED') {
			// Failed
			container.innerHTML = this.renderFailed();
		}
	}

	/**
	 * Render pre-execution state
	 */
	renderPreExecution() {
		const DEFAULT_PLAN_CONFIG = {
			batchSize: 1000,
			continueOnError: false,
			validateData: true
		};
		const config = {
			...DEFAULT_PLAN_CONFIG,
			...(this.plan?.config || {})
		};
		const planName = this.plan?.name || 'Migration Plan';
		const tableCount = Array.isArray(this.plan?.tables) ? this.plan.tables.length : 0;

		return `
      <div class="run-pre-execution">
       
        <div class="execution-summary"> 
          <h3>Plan Summary</h3>
          <ul>
						<li><strong>Plan:</strong> ${planName}</li>
						<li><strong>Tables:</strong> ${tableCount}</li>
						<li><strong>Batch Size:</strong> ${config.batchSize} rows</li>
						<li><strong>Continue on Error:</strong> ${config.continueOnError ? 'Yes' : 'No'}</li>
          </ul>
        </div>
        
        <div class="execution-actions">
          <button class="btn btn-primary btn-large" onclick="window.wizard.steps[3].component.startMigration()">
            ▶  Start Migration
          </button>
        </div>
      </div>
    `;
	}

	/**
	 * Render running state
	 */
	renderRunning() {
		const progress = this.state.get('run.progress') || 0;
		const tableResults = this.state.get('run.tableResults') || [];

		return `
      <div class="run-executing">
        <h2>Migration In Progress</h2>
        
        <!-- Overall Progress -->
        <div class="overall-progress">
          <div class="progress-header">
            <span>Overall Progress: ${progress}%</span>
            <span>${this.getElapsedTime()}</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width: ${progress}%"></div>
          </div>
        </div>
        
        <!-- Table Progress -->
        <div class="table-progress">
          <h3>Table Status</h3>
          <table class="status-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Progress</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody id="table-status-list">
              ${this.renderTableStatus(tableResults)}
            </tbody>
          </table>
        </div>
        
        <!-- Live Log -->
        <div class="live-log">
          <h3>Live Log</h3>
          <div id="log-container" class="log-container"></div>
        </div>
        
        <div class="execution-actions">
          <button class="btn btn-danger" onclick="window.wizard.steps[3].component.stopMigration()">
            ■ Stop Migration
          </button>
        </div>
      </div>
    `;
	}

	/**
	 * Render completed state
	 */
	renderCompleted() {
		return `
			<div class="run-completed">
				<div style="display:flex;align-items:center;gap:0.5rem;" class="completed-header">
					<div class="success-icon" style="font-size:1.6rem;line-height:1;">✓</div>
					<h2 style="margin:0;">Migration Completed Successfully!</h2>
				</div>
				<p style="margin-top:0.5rem;">All tables have been migrated</p>
        
        <div class="completion-summary">
          <div class="stat">
		  <span>Tables Migrated</span>
            <strong>${this.run.tablesCompleted || 0}</strong>
          </div>
          <div class="stat">
		  <span>Total Rows</span>
            <strong>${this.run.rowsMigrated || 0}</strong>
          </div>
          <div class="stat">
		  <span>Duration</span>
            <strong>${this.formatDuration(this.run.duration)}</strong>
          </div>
        </div>
        
        <div class="completion-actions">
          <button class="btn btn-primary" onclick="window.wizard.nextStep()">
            View Results →
          </button>
        </div>
      </div>
    `;
	}

	/**
	 * Render completed with errors state
	 */
	renderCompletedWithErrors() {
		return `
			<div class="run-completed-with-errors">
				<div style="display:flex;align-items:center;gap:0.5rem;" class="completed-header">
					<div class="warning-icon" style="font-size:1.6rem;line-height:1;">⚠</div>
					<h2 style="margin:0;">Migration Completed With Errors</h2>
				</div>
				<p style="margin-top:0.5rem;">Some tables failed but migration continued for remaining tables</p>
        
        <div class="completion-summary">
          <div class="stat">
		  <span>Tables Completed</span>
            <strong>${this.run.tablesCompleted || 0}</strong>
          </div>
          <div class="stat">
		  <span>Tables Failed</span>
            <strong style="color:#d9534f;">${this.run.tablesFailed || 0}</strong>
          </div>
          <div class="stat">
		  <span>Total Rows Migrated</span>
            <strong>${this.run.rowsMigrated || 0}</strong>
          </div>
          <div class="stat">
		  <span>Duration</span>
            <strong>${this.formatDuration(this.run.duration)}</strong>
          </div>
        </div>

        <div style="background:#fcf8e3;border:1px solid #faebcc;border-radius:4px;padding:1rem;margin:1rem 0;">
          <h4 style="margin-top:0;">Error Details</h4>
          <p>${this.run.errorMessage || 'See logs for details'}</p>
        </div>
        
        <div class="completion-actions">
          <button class="btn btn-primary" onclick="window.wizard.nextStep()">
            View Results →
          </button>
        </div>
      </div>
    `;
	}

	/**
	 * Render failed state
	 */
	renderFailed() {
		return `
      <div class="run-failed">
        <div class="error-icon">✕</div>
        <h2>Migration Failed</h2>
        <p>${this.run.error || 'An error occurred during migration'}</p>
        
        <div class="failure-summary">
          <div class="stat">
            <strong>${this.run.tablesCompleted || 0}</strong>
            <span>Tables Completed</span>
          </div>
          <div class="stat">
            <strong>${this.run.tablesFailed || 0}</strong>
            <span>Tables Failed</span>
          </div>
        </div>
        
        <div class="failure-actions">
          <button class="btn btn-secondary" onclick="window.wizard.steps[3].component.retryMigration()">
            🔄 Retry Failed Tables
          </button>
          <button class="btn btn-primary" onclick="window.wizard.nextStep()">
            View Details →
          </button>
        </div>
      </div>
    `;
	}

	/**
	 * Render table status rows
	 */
	renderTableStatus(tableResults) {
		return this.plan.tables.map(tableName => {
			const result = tableResults.find(r => r.table === tableName) || {};
			const status = result.status || 'pending';
			const icon = this.getStatusIcon(status);

			return `
        <tr class="table-status-${status}">
          <td><strong>${tableName}</strong></td>
          <td><span class="status-badge status-${status}">${icon} ${status}</span></td>
          <td>${result.rowsProcessed || 0} / ${result.totalRows || '?'}</td>
          <td>
            <div class="mini-progress-bar">
              <div class="mini-progress-fill" style="width: ${result.progress || 0}%"></div>
            </div>
          </td>
          <td>${this.formatDuration(result.duration)}</td>
        </tr>
      `;
		}).join('');
	}

	/**
	 * Get status icon
	 */
	getStatusIcon(status) {
		const icons = {
			pending: '○',
			running: '⏳',
			completed: '✓',
			failed: '✕',
			skipped: '⊘'
		};
		return icons[status] || '?';
	}

	/**
	 * Start migration execution
	 */
	async startMigration() {
		// const confirmed = await Modal.confirm({
		// 	title: 'Start Migration',
		// 	message: 'Start migration now? This will begin transferring data to MySQL.',
		// 	type: 'warning',
		// 	confirmText: 'Start Migration',
		// 	cancelText: 'Cancel'
		// });

		// if (!confirmed) {
		// 	return;
		// }

		this.wizard.showLoading('Starting migration...');

		try {
			this.run = await this.api.start(this.plan.id);

			this.state.set('run.id', this.run.id);
			this.state.set('run.status', 'running');
			this.startTime = Date.now();

			this.wizard.hideLoading();
			this.render();

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to start migration: ${err.message}`);
		}
	}

	/**
	 * Stop migration execution
	 */
	async stopMigration() {
		const confirmed = await Modal.confirm({
			title: 'Stop Migration',
			message: 'Stop migration? This may leave the database in an incomplete state.',
			type: 'error',
			confirmText: 'Stop Migration',
			cancelText: 'Cancel'
		});

		if (!confirmed) {
			return;
		}

		this.wizard.showLoading('Stopping migration...');

		try {
			await this.api.stop(this.run.id);
			this.stopPolling();

			this.state.set('run.status', 'stopped');
			this.wizard.hideLoading();
			this.render();

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to stop migration: ${err.message}`);
		}
	}

	/**
	 * Retry failed migration
	 */
	async retryMigration() {
		this.wizard.showLoading('Retrying failed tables...');

		try {
			this.run = await this.api.retry(this.run.id);

			this.state.set('run.status', 'running');
			this.wizard.hideLoading();
			this.render();

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to retry migration: ${err.message}`);
		}
	}

	/**
	 * Start polling for progress updates
	 */
	startPolling() {
		if (this.pollInterval) return;

		this.pollInterval = setInterval(async () => {
			try {
				const progress = await this.api.getProgress(this.run.id);
				const percent = typeof progress === 'number'
					? progress
					: (progress?.percent ?? progress?.progress ?? 0);
				const status = progress?.status || this.state.get('run.status') || 'RUNNING';
				const tables = progress?.tables || progress?.tableResults || [];

				// Update state
				this.state.set('run.progress', percent);
				this.state.set('run.status', status);
				this.state.set('run.tableResults', tables);

				// Update UI
				this.updateProgressDisplay({ percent, status, tables });

				// Stop polling if complete (handle both uppercase from backend and lowercase for compatibility)
				const normalizedStatus = String(status || '').toUpperCase();
				if (normalizedStatus === 'SUCCESS' || normalizedStatus === 'FAILED' || normalizedStatus === 'COMPLETED') {
					this.stopPolling();
					this.run = await this.api.getById(this.run.id);
					this.render();
				}

			} catch (err) {
				console.error('Progress poll error:', err);
			}
		}, 2000); // Poll every 2 seconds
	}

	/**
	 * Stop polling for progress
	 */
	stopPolling() {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	/**
	 * Update progress display
	 */
	updateProgressDisplay(progress) {
		// Update overall progress bar
		const progressBar = document.querySelector('.progress-bar-fill');
		if (progressBar) {
			progressBar.style.width = `${progress.percent || 0}%`;
		}

		// Update progress text
		const progressText = document.querySelector('.progress-header span');
		if (progressText) {
			progressText.textContent = `Overall Progress: ${progress.percent || 0}%`;
		}

		// Update table status list
		const tableList = document.getElementById('table-status-list');
		if (tableList) {
			tableList.innerHTML = this.renderTableStatus(progress.tables || []);
		}

		// Update elapsed time
		const timeDisplay = document.querySelector('.progress-header span:last-child');
		if (timeDisplay) {
			timeDisplay.textContent = this.getElapsedTime();
		}
	}

	/**
	 * Get elapsed time
	 */
	getElapsedTime() {
		if (!this.startTime) return '00:00:00';
		const elapsed = Date.now() - this.startTime;
		return this.formatDuration(elapsed);
	}

	/**
	 * Format duration in ms to HH:MM:SS
	 */
	formatDuration(ms) {
		if (!ms) return '—';

		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);

		return [
			hours.toString().padStart(2, '0'),
			(minutes % 60).toString().padStart(2, '0'),
			(seconds % 60).toString().padStart(2, '0')
		].join(':');
	}

	/**
	 * Validate before proceeding
	 */
	async onNext() {
		if (!this.run) {
			this.wizard.showError('Migration has not been executed');
			return false;
		}

		if (String(this.run.status || '').toUpperCase() === 'RUNNING') {
			this.wizard.showError('Migration is still in progress. Please wait for completion.');
			return false;
		}

		return true;
	}

	/**
	 * Handle previous button
	 */
	async onPrevious() {
		if (this.run && String(this.run.status || '').toUpperCase() === 'RUNNING') {
			this.wizard.showError('Cannot go back while migration is running');
			return false;
		}
		return true;
	}

	/**
	 * Cleanup on unmount
	 */
	destroy() {
		this.stopPolling();
	}
}

// Export to window
window.RunUI = RunUI;
