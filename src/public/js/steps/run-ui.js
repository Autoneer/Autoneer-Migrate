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
		this._lastLogTs = null;
	}

	planRequiresGLRebuild() {
		const tables = Array.isArray(this.plan?.tables) ? this.plan.tables : [];
		return !!(window.AccountingOrderUtils && window.AccountingOrderUtils.requiresGlRebuild(tables));
	}

	isGLRebuildMarkedDone() {
		if (!this.plan?.id) return false;
		return this.state.get('run.glRebuildPlanId') === this.plan.id;
	}

	/**
	 * Initialize execution monitor
	 */
	async initialize() {
		console.log('Initializing Execution Monitor...');

		// Stop any leftover polling from a previous run
		this.stopPolling();

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
				// Run not found in DB — clear stale reference
				this.run = null;
			}
		} else {
			// No run.id in state — clear any stale instance reference
			// This is the key fix: after a reset/new plan, this.run must be null
			// so render() shows the pre-execution screen instead of old results
			this.run = null;
		}

		// Reset log tracking for fresh display
		this._lastLogTs = null;
		this.startTime = null;

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
		} else if (status === 'STOPPED' || status === 'CANCELLED') {
			container.innerHTML = this.renderStopped();
		} else if (status === 'COMPLETED_WITH_ERRORS') {
			// Completed with errors
			container.innerHTML = this.renderCompletedWithErrors();
		} else if (status === 'FAILED') {
			// Failed
			container.innerHTML = this.renderFailed();
		}
	}

	/**
	 * Render stopped/cancelled state
	 */
	renderStopped() {
		return `
			<div class="run-stopped">
				<div style="display:flex;align-items:center;gap:0.5rem;" class="stopped-header">
					<div class="stopped-icon" style="font-size:1.6rem;line-height:1;">■</div>
					<h2 style="margin:0;">Migration Stopped</h2>
				</div>
				<p style="margin-top:0.5rem;">The migration was stopped by user request. Some tables may have completed while others were not run.</p>
				<div class="completion-summary">
					<div class="stat">
						<span>Tables Completed</span>
						<strong>${this.run?.tablesCompleted || this.state.get('run.tablesCompleted') || 0}</strong>
					</div>
					<div class="stat">
						<span>Tables Not Run</span>
						<strong>${(this.run?.tablesTotal || this.state.get('run.tablesTotal') || 0) - (this.run?.tablesCompleted || this.state.get('run.tablesCompleted') || 0)}</strong>
					</div>
				</div>
				<div class="completion-actions">
					<button class="btn btn-primary" onclick="window.wizard.steps[3].component.retryMigration()">Retry Failed Tables</button>
					<button class="btn btn-secondary" onclick="window.wizard.previousStep()">Back to Plan</button>
				</div>
			</div>
		`;
	}

	/**
	 * Render pre-execution state
	 */
	renderPreExecution() {
		const config = {
			batchSize: 1000,
			continueOnError: false,
			validateData: true,
			...(this.plan?.config || {})
		};
		const planName = this.plan?.name || 'Migration Plan';
		const tableCount = Array.isArray(this.plan?.tables) ? this.plan.tables.length : 0;
		const needsGlRebuild = this.planRequiresGLRebuild();
		const glRebuildDone = this.isGLRebuildMarkedDone();

		const glSection = needsGlRebuild ? `
        <div class="execution-summary">
          <h3>Accounting Prerequisite</h3>
          <p>${glRebuildDone
				? 'GL accounts were rebuilt for this plan. You can start the migration.'
				: 'This plan includes GL journal posting tables. Rebuild GL accounts before starting the migration so postings use the converted account numbers.'}</p>
          <p><strong>Rebuild Status:</strong> ${glRebuildDone ? 'Ready for this plan' : 'Required before GL posting runs'}</p>
          <div class="execution-actions">
            <button class="btn btn-secondary" onclick="window.wizard.steps[3].component.rebuildGLAccounts(this)">
              ${glRebuildDone ? 'Rebuild GL Accounts Again' : 'Rebuild GL Accounts Now'}
            </button>
          </div>
        </div>` : '';

		return `
      <div class="run-pre-execution">

        <div class="execution-summary">
          <h3>Plan Summary</h3>
          <ul>
						<li><strong>Plan:</strong> ${planName}</li>
						<li><strong>Tables:</strong> ${tableCount}</li>
						<li><strong>Batch Size:</strong> ${config.batchSize} rows</li>
						<li><strong>Continue on Error:</strong> ${config.continueOnError ? 'Yes' : 'No'}</li>
				<li><strong>Clean target before migrate:</strong> ${(() => { const anyClean = Object.values(this.plan.tableConfigs || {}).some(c => c && c.cleanBefore === true); return anyClean ? 'Yes' : 'No'; })()}</li>
          </ul>
        </div>

        ${glSection}

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
		const currentStatus = String(this.state.get('run.status') || '').toUpperCase();
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
        
		${currentStatus === 'ABORTING' ? `<div class="alert alert-warning">Stopping migration... (please wait)</div>` : ''}

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
					<button class="btn btn-danger" onclick="window.wizard.steps[3].component.stopMigration()" ${currentStatus === 'ABORTING' ? 'disabled' : ''}>
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
		setTimeout(() => this._loadAndRenderRowErrors(), 0);
		const glRebuildDone = this.isGLRebuildMarkedDone();
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
          <button class="btn btn-secondary" onclick="window.wizard.steps[3].component.rebuildGLAccounts(this)">
            ${glRebuildDone ? 'Rebuild GL Accounts Again' : 'Rebuild GL Accounts'}
          </button>
          <button class="btn btn-primary" onclick="window.wizard.nextStep()">
            Convert Account Numbers →
          </button>
        </div>

        <div id="run-row-errors-container"></div>
      </div>
    `;
	}

	/**
	 * Render completed with errors state
	 */
	renderCompletedWithErrors() {
		setTimeout(() => this._loadAndRenderRowErrors(), 0);
		const glRebuildDone = this.isGLRebuildMarkedDone();
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
          <button class="btn btn-secondary" onclick="window.wizard.steps[3].component.rebuildGLAccounts(this)">
            ${glRebuildDone ? 'Rebuild GL Accounts Again' : 'Rebuild GL Accounts'}
          </button>
          <button class="btn btn-primary" onclick="window.wizard.nextStep()">
            Convert Account Numbers →
          </button>
        </div>

        <div id="run-row-errors-container"></div>
      </div>
    `;
	}

	/**
	 * Render failed state
	 */
	renderFailed() {
		// The error message could be in several places depending on source (in-memory vs DB)
		const errorMsg = this.run.errorMessage
			|| this.run.error_message
			|| this.run.lastError?.message
			|| this.run.error
			|| 'An error occurred during migration';

		return `
      <div class="run-failed">
        <div class="error-icon">✕</div>
        <h2>Migration Failed</h2>
        
        <div style="background:#f8d7da;border:1px solid #f5c6cb;border-radius:4px;padding:1rem;margin:1rem 0;">
          <h4 style="margin-top:0;">Error Details</h4>
          <p style="white-space:pre-wrap;word-break:break-word;">${errorMsg}</p>
        </div>
        
        <div class="failure-summary">
          <div class="stat">
            <strong>${this.run.tablesCompleted || 0}</strong>
            <span>Tables Completed</span>
          </div>
          <div class="stat">
            <strong>${this.run.tablesFailed || this.plan?.tables?.length || 0}</strong>
            <span>Tables Failed</span>
          </div>
        </div>
        
        <div class="failure-actions">
          <button class="btn btn-secondary" onclick="window.wizard.steps[3].component.retryMigration()">
            🔄 Retry Failed Tables
          </button>
          <button class="btn btn-secondary" onclick="window.wizard.previousStep()">
            ← Back to Plan
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
			// find result by normalized key (support .table or .name)
			const result = (tableResults || []).find(r => {
				const key = (r.table || r.name || '').toString().toUpperCase();
				return key === (tableName || '').toString().toUpperCase();
			}) || {};
			// determine status with fallback normalization
			const rawStatus = (result.status || result.state || 'pending');
			const status = String(rawStatus || '').toLowerCase();
			const icon = this.getStatusIcon(status);

			const rowsProcessed = Number(result.rowsProcessed ?? result.migrated ?? result.rowsMigrated ?? result.rows_migrated ?? 0) || 0;
			const totalRowsVal = (result.totalRows ?? result.total ?? result.totalRows === 0 ? result.totalRows : null);
			const totalRows = (totalRowsVal === null || totalRowsVal === undefined) ? '?' : totalRowsVal;
			const progress = Number(result.progress ?? (typeof totalRowsVal === 'number' && totalRowsVal > 0 ? Math.round((rowsProcessed / totalRowsVal) * 100) : 0)) || 0;
			const duration = Number(result.duration ?? result.durationMs ?? 0) || 0;

			return `
        <tr class="table-status-${status}">
          <td><strong>${tableName}</strong></td>
          <td><span class="status-badge status-${status}">${icon} ${status}</span></td>
          <td>${rowsProcessed} / ${totalRows}</td>
          <td>
            <div class="mini-progress-bar">
              <div class="mini-progress-fill" style="width: ${progress}%"></div>
            </div>
          </td>
          <td>${this.formatDuration(duration)}</td>
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

	async rebuildGLAccounts(triggerButton = null) {
		if (!window.RebuildGLTool || typeof window.RebuildGLTool.run !== 'function') {
			this.wizard.showError('Rebuild GL Accounts tool is not available.');
			return;
		}

		try {
			const result = await window.RebuildGLTool.run(triggerButton);
			if (result?.cancelled) return;
			if (this.plan?.id) {
				this.state.set('run.glRebuildPlanId', this.plan.id);
			}
			this.render();
		} catch (err) {
			// dialog already shown by RebuildGLTool
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

		// Immediately reflect stopping state in UI and keep polling to observe final state
		this.state.set('run.status', 'ABORTING');
		this.wizard.showLoading('Stopping migration...');

		try {
			const resp = await this.api.stop(this.run.id);
			console.log('Stop requested:', resp);
			// don't stop polling here; wait for runner to transition to STOPPED/CANCELLED
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
			const resp = await this.api.retry(this.run.id);
			if (!resp || !resp.success) {
				this.wizard.hideLoading();
				const errorMsg = resp?.error || 'No failed tables recorded for this run.';
				await Modal.alert({
					title: 'Retry Failed',
					message: `${errorMsg}\n\nTip: Go back to the Plan step and start a fresh migration instead.`,
					type: 'info'
				});
				return;
			}

			// If a new run was started, navigate into it
			const newRunId = resp.runId || resp.run?.id || null;
			if (newRunId) {
				this.state.set('run.id', newRunId);
				this.state.set('run.status', 'running');
				this.run = null; // Clear stale run reference
				this.startTime = Date.now();
				this._lastLogTs = null;
				this.wizard.hideLoading();

				// Reload the run from the server to get fresh state
				try {
					this.run = await this.api.getById(newRunId);
				} catch (e) {
					// Fall back to minimal run object
					this.run = { id: newRunId, status: 'RUNNING' };
				}
				this.render();
				return;
			}

			this.wizard.hideLoading();
			await Modal.alert({ title: 'Retry', message: resp.message || 'Retry requested', type: 'info' });

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

				// Update UI (including logs)
				await this.updateProgressDisplay({ percent, status, tables });

				// Stop polling if complete (handle both uppercase from backend and lowercase for compatibility)
				const normalizedStatus = String(status || '').toUpperCase();
				if (normalizedStatus === 'SUCCESS' || normalizedStatus === 'FAILED' || normalizedStatus === 'COMPLETED' || normalizedStatus === 'COMPLETED_WITH_ERRORS' || normalizedStatus === 'STOPPED' || normalizedStatus === 'CANCELLED') {
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
	async updateProgressDisplay(progress) {
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

		// Fetch and render logs (new entries only)
		try {
			const runId = this.state.get('run.id');
			if (runId) {
				// RunAPI.getLogs() already returns the logs array directly
				const logs = await this.api.getLogs(runId);
				const logArray = Array.isArray(logs) ? logs : (logs?.logs || []);
				// Filter logs newer than last seen timestamp
				const newLogs = [];
				for (const l of logArray) {
					const ts = l.timestamp ? new Date(l.timestamp).getTime() : 0;
					if (!this._lastLogTs || ts > this._lastLogTs) newLogs.push(l);
				}
				if (newLogs.length) {
					this._lastLogTs = newLogs[newLogs.length - 1].timestamp ? new Date(newLogs[newLogs.length - 1].timestamp).getTime() : this._lastLogTs;
					this.appendLogEntries(newLogs);
				}
			}
		} catch (e) {
			console.warn('Failed to fetch logs:', e);
		}
	}

	/**
	 * Append log entries to the live log container with special rendering
	 */
	appendLogEntries(entries) {
		const container = document.getElementById('log-container');
		if (!container || !entries || !entries.length) return;
		for (const e of entries) {
			const el = document.createElement('div');
			el.className = 'log-entry';

			// icon element
			const iconDiv = document.createElement('div');
			iconDiv.className = 'log-icon';

			// body element
			const bodyDiv = document.createElement('div');
			bodyDiv.className = 'log-body';

			if (e.type === 'table_cleaning_started') {
				iconDiv.textContent = '🧹';
				el.classList.add('log-cleaning-start');

				const strong = document.createElement('strong');
				strong.textContent = 'Cleaning started';
				const sep = document.createTextNode(' — ');
				const em = document.createElement('em');
				em.textContent = e.table || '';

				const wrapper = document.createElement('div');
				wrapper.className = 'log-cleaning-start';
				wrapper.appendChild(strong);
				wrapper.appendChild(sep);
				wrapper.appendChild(em);
				bodyDiv.appendChild(wrapper);

			} else if (e.type === 'table_cleaned') {
				iconDiv.textContent = '✅';
				el.classList.add('log-cleaned');

				const strong = document.createElement('strong');
				strong.textContent = 'Table cleaned';
				const sep = document.createTextNode(' — ');
				const em = document.createElement('em');
				em.textContent = e.table || '';
				const small = document.createElement('small');
				const method = e.method || 'DELETE';
				let smallText = `(${method}`;
				if (typeof e.affectedRows === 'number') smallText += `, rows:${e.affectedRows}`;
				smallText += ')';
				small.textContent = smallText;

				const wrapper = document.createElement('div');
				wrapper.className = 'log-cleaned';
				wrapper.appendChild(strong);
				wrapper.appendChild(sep);
				wrapper.appendChild(em);
				wrapper.appendChild(small);
				bodyDiv.appendChild(wrapper);

			} else if (e.level === 'error' || e.type === 'table_failed') {
				iconDiv.textContent = '❌';
				el.classList.add('log-error');

				const strong = document.createElement('strong');
				strong.textContent = e.phase || e.type || 'error';
				const sep = document.createTextNode(' — ');
				const textNode = document.createTextNode(e.error || e.message || JSON.stringify(e));

				const wrapper = document.createElement('div');
				wrapper.className = 'log-error';
				wrapper.appendChild(strong);
				wrapper.appendChild(sep);
				wrapper.appendChild(textNode);
				bodyDiv.appendChild(wrapper);

			} else {
				// Generic log line
				iconDiv.textContent = '•';
				el.classList.add('log-generic');

				if (e.timestamp) {
					const smallTs = document.createElement('small');
					smallTs.textContent = e.timestamp;
					bodyDiv.appendChild(smallTs);
				}
				const msg = document.createTextNode(e.message || e.phase || e.type || JSON.stringify(e));
				bodyDiv.appendChild(msg);
			}

			el.appendChild(iconDiv);
			el.appendChild(bodyDiv);
			container.appendChild(el);
		}
		// Auto-scroll
		container.scrollTop = container.scrollHeight;
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
	 * Fetch and render row-level errors into the #run-row-errors-container placeholder.
	 */
	async _loadAndRenderRowErrors() {
		const container = document.getElementById('run-row-errors-container');
		if (!container || !this.run?.id) return;

		container.innerHTML = '<p style="color:#888;font-size:0.9em;">Loading failed records...</p>';

		let errors = [];
		try {
			errors = await this.api.getErrors(this.run.id);
		} catch (e) {
			container.innerHTML = '<p style="color:#888;font-size:0.9em;">Could not load failed records.</p>';
			return;
		}

		if (!errors || errors.length === 0) {
			container.innerHTML = '';
			return;
		}

		// Group errors by table
		const byTable = {};
		for (const err of errors) {
			const t = err.table || 'Unknown';
			if (!byTable[t]) byTable[t] = [];
			byTable[t].push(err);
		}

		let html = `<div style="margin-top:1.5rem;">
			<h4 style="margin-bottom:0.5rem;">Failed Records (${errors.length})</h4>`;

		for (const [table, rows] of Object.entries(byTable)) {
			html += `<details style="margin-bottom:0.5rem;border:1px solid #f5c6cb;border-radius:4px;padding:0.5rem 0.75rem;background:#fff8f8;">
				<summary style="cursor:pointer;font-weight:600;color:#c0392b;">${table} — ${rows.length} error(s)</summary>
				<table style="width:100%;border-collapse:collapse;margin-top:0.5rem;font-size:0.85em;">
					<thead><tr style="background:#f8d7da;">
						<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #f5c6cb;">Row</th>
						<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #f5c6cb;">Column</th>
						<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #f5c6cb;">Value</th>
						<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #f5c6cb;">Error</th>
					</tr></thead>
					<tbody>`;
			for (const err of rows) {
				const row = err.row != null ? err.row : '—';
				const col = err.column || '—';
				const val = err.value != null ? String(err.value) : '—';
				const msg = err.message || '—';
				html += `<tr>
					<td style="padding:4px 6px;border-bottom:1px solid #fde">${row}</td>
					<td style="padding:4px 6px;border-bottom:1px solid #fde">${col}</td>
					<td style="padding:4px 6px;border-bottom:1px solid #fde;max-width:160px;word-break:break-all;">${val}</td>
					<td style="padding:4px 6px;border-bottom:1px solid #fde;max-width:300px;word-break:break-word;">${msg}</td>
				</tr>`;
			}
			html += `</tbody></table></details>`;
		}

		html += '</div>';
		container.innerHTML = html;
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
