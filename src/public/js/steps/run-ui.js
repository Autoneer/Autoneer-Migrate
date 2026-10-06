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
		this._pollInFlight = false;
		this._pollGeneration = 0;
		this.startTime = null;
		this._loggedTables = new Set();
		this._logFetchInFlight = false;
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
				this.state.set('run.status', this.run.status);

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
		this._loggedTables = new Set();
		this._logFetchInFlight = false;
		this.startTime = this.run?.startedAt ? new Date(this.run.startedAt).getTime() : null;

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
		} else if (['RUNNING', 'PENDING', 'ABORTING'].includes(status)) {
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
			transactionalDateFilter: { enabled: false, startDate: '' },
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
						<li><strong>Transactional Date Filter:</strong> ${config.transactionalDateFilter?.enabled && config.transactionalDateFilter?.startDate ? `On or after ${config.transactionalDateFilter.startDate}` : 'Off'}</li>
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
          <p id="current-table-status" aria-live="polite">Preparing migration…</p>
          <p class="progress-explanation">Tables run one at a time, in the order below. Processed rows include written, skipped, and failed records.</p>
          <table class="status-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Status</th>
                <th>Rows Processed</th>
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
          <p class="progress-explanation">One result per completed or failed table. Detailed row errors are available in <a href="/migration/history" target="_blank" rel="noopener">Migration History</a>.</p>
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
		return this.renderFailed();
	}

	/**
	 * Render failed state
	 */
	renderFailed() {
		setTimeout(() => this._loadAndRenderRowErrors(), 0);
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
          <p style="white-space:pre-wrap;word-break:break-word;">${this.wizard.escapeHtml(errorMsg)}</p>
        </div>
        
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
        
        <p>Account conversion is blocked until the migration succeeds. Existing matching invoices are counted as skipped when you retry or start the plan again. Correct the remaining conflicts before retrying.</p>
        <div id="run-row-errors-container"></div>
        <div class="failure-actions">
          <button class="btn btn-secondary" onclick="window.wizard.steps[3].component.retryMigration()">
            Retry Failed / Unattempted Tables
          </button>
          <button class="btn btn-secondary" onclick="window.wizard.steps[3].component.editMigration(3)">
            ← Amend Plan
          </button>
          <button class="btn btn-primary" onclick="window.wizard.nextStep()">
            View Failure Results →
          </button>
        </div>
      </div>
    `;
	}

	/**
	 * Render table status rows
	 */
	renderTableStatus(tableResults) {
		// The runner can reorder dependencies; its snapshot is the execution order.
		const rows = tableResults?.length ? tableResults : (this.plan?.tables || []).map(table => ({ table }));
		return rows.map(result => {
			const tableName = result.table || result.name || result.table_name || '';
			const raw = String(result.status || result.state || 'pending').toLowerCase();
			const normalized = ({ success: 'completed', queued: 'pending', not_run: 'pending' })[raw] || raw;
			const status = ['completed', 'pending', 'running', 'failed', 'skipped'].includes(normalized) ? normalized : 'pending';
			const written = Number(result.rowsMigrated ?? result.migrated ?? result.rows_migrated ?? 0);
			const skipped = Number(result.skippedDuplicates ?? result.rows_skipped_duplicates ?? 0);
			const errors = Number(result.errors ?? result.rows_error ?? 0);
			const processed = Number(result.rowsProcessed ?? result.processed ?? result.last_offset ?? (written + skipped + errors));
			const total = result.totalRows ?? result.total ?? result.rows_source ?? null;
			const percent = Number(result.progress ?? (total > 0 ? Math.min(100, Math.round(processed / total * 100)) : status === 'completed' ? 100 : 0));
			const statusLabel = status === 'running' && ['validating', 'preparing'].includes(result.phase) ? result.phase : status;
			const number = value => Number(value).toLocaleString();
			return `
        <tr class="table-status-${status}">
          <td><strong>${this.wizard.escapeHtml(String(tableName).toUpperCase())}</strong></td>
          <td><span class="status-badge status-${status}">${this.getStatusIcon(status)} ${statusLabel}</span></td>
          <td>${number(processed)} / ${total == null ? '?' : number(total)}
            <small class="row-outcomes">${number(written)} written · ${number(skipped)} skipped · ${number(errors)} failed</small>
          </td>
          <td>
            <div class="mini-progress-bar" role="progressbar" aria-label="Table rows processed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
              <div class="mini-progress-fill" style="width: ${percent}%"></div>
            </div><small>${percent}%</small>
          </td>
          <td>${this.formatDuration(Number(result.duration ?? result.durationMs ?? 0))}</td>
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
			this.wizard.storage.clearStepsFrom(4);

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

	async editMigration(step = 3) {
		this.stopPolling();
		this.run = null;
		this._loggedTables = new Set();
		this.startTime = null;
		this.state.set('run', { id: null, status: null, progress: 0, tableResults: [] });
		this.wizard.storage.clearStepsFrom(4);
		await this.wizard.showStep(step);
	}

	/**
	 * Retry failed migration
	 */
	async retryMigration() {
		this.wizard.showLoading('Retrying failed and unattempted tables...');

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
				this.wizard.storage.clearStepsFrom(4);
				this.state.set('run.id', newRunId);
				this.state.set('run.status', 'running');
				this.run = null; // Clear stale run reference
				this.startTime = Date.now();
				this._loggedTables = new Set();
				this.wizard.hideLoading();

				// Reload the run from the server to get fresh state
				try {
					this.run = await this.api.getById(newRunId);
				} catch (e) {
					// Fall back to minimal run object
					this.run = { id: newRunId, status: 'RUNNING' };
				}
				await this.wizard.showStep(4);
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
		const generation = this._pollGeneration;
		const runId = this.run.id;
		const poll = async () => {
			if (this._pollInFlight) return;
			this._pollInFlight = true;
			try {
				const progress = await this.api.getProgress(runId);
				if (generation !== this._pollGeneration || this.run?.id !== runId) return;
				const percent = progress?.percent ?? progress?.progress ?? 0;
				const status = progress?.status || 'RUNNING';
				const tables = progress?.tables || [];
				this.state.set('run.progress', percent);
				this.state.set('run.status', status);
				this.state.set('run.tableResults', tables);
				this.state.set('run.tablesCompleted', progress.tablesCompleted || 0);
				this.state.set('run.tablesTotal', progress.tablesTotal || tables.length);
				await this.updateProgressDisplay({ ...progress, percent, status, tables });
				if (generation !== this._pollGeneration || this.run?.id !== runId) return;
				if (['SUCCESS', 'FAILED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'STOPPED', 'CANCELLED'].includes(String(status).toUpperCase())) {
					const run = await this.api.getById(runId);
					if (generation !== this._pollGeneration || this.run?.id !== runId) return;
					this.stopPolling();
					this.run = run;
					this.render();
				}
			} catch (error) {
				console.error('Progress poll error:', error);
			} finally { this._pollInFlight = false; }
		};
		this.pollInterval = setInterval(poll, 1000);
		void poll();
	}

	/**
	 * Stop polling for progress
	 */
	stopPolling() {
		this._pollGeneration += 1;
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	/**
	 * Update progress display
	 */
	async updateProgressDisplay(progress) {
		const generation = this._pollGeneration;
		// Update overall progress bar
		const progressBar = document.querySelector('#run-content .overall-progress .progress-bar-fill');
		if (progressBar) {
			progressBar.style.width = `${progress.percent || 0}%`;
		}

		// Update progress text
		const progressText = document.querySelector('#run-content .progress-header span');
		if (progressText) {
			progressText.textContent = `Overall Progress: ${progress.percent || 0}%`;
		}

		// Update table status list
		const tableList = document.getElementById('table-status-list');
		if (tableList) {
			tableList.innerHTML = this.renderTableStatus(progress.tables || []);
		}

		const current = document.getElementById('current-table-status');
		if (current) {
			const active = (progress.tables || []).find(table => table.status === 'running');
			const phase = active?.phase === 'validating' ? 'Validating' : active?.phase === 'preparing' ? 'Preparing' : 'Migrating';
			current.textContent = active ? `${phase}: ${String(active.table).toUpperCase()} · ${progress.tablesCompleted || 0} of ${progress.tablesTotal || 0} tables completed`
				: progress.tablesTotal > 0 && progress.tablesCompleted === progress.tablesTotal ? 'Finalizing migration…' : 'Preparing the next table…';
		}

		// Update elapsed time
		const timeDisplay = document.querySelector('#run-content .progress-header span:last-child');
		if (timeDisplay) {
			timeDisplay.textContent = this.getElapsedTime();
		}

		// Fetch and render logs (new entries only)
		let logFetchStarted = false;
		try {
			const runId = this.state.get('run.id');
			if (runId) {
				// RunAPI.getLogs() already returns the logs array directly
				if (this._logFetchInFlight) return;
				this._logFetchInFlight = true;
				logFetchStarted = true;
				// Fetch the small result snapshot so row-error bursts cannot hide earlier tables.
				const logs = await this.api.getLogs(runId, { view: 'table-results', limit: 1000 });
				if (generation !== this._pollGeneration || String(this.run?.id) !== String(runId)) return;
				const logArray = Array.isArray(logs) ? logs : (logs?.logs || []);
				this.appendLogEntries(logArray);
			}
		} catch (e) {
			console.warn('Failed to fetch logs:', e);
		} finally {
			if (logFetchStarted) {
				this._logFetchInFlight = false;
			}
		}
	}

	/**
	 * Format a structured log event into { icon, text, cls } for display.
	 * Only completed and failed table results appear in Step 4.
	 */
	formatLogEntry(e) {
		if (e.phase !== 'table_finalize') return null;
		const status = String(e.status || '').toLowerCase();
		if (!['success', 'failed'].includes(status)) return null;
		const singleLine = value => String(value || '').replace(/\s+/g, ' ').trim();
		const table = singleLine(e.tableName || e.table);
		if (!table) return null;
		if (status === 'success') {
			return { icon: '✓', text: `${table}: completed — inserted ${Number(e.inserted || 0).toLocaleString()}, updated ${Number(e.updated || 0).toLocaleString()}, skipped ${Number(e.skipped || 0).toLocaleString()}`, cls: 'log-success' };
		}
		const errorCount = Number(e.errors) || Number(String(e.error || '').match(/(?:failed with|completed with) ([\d,]+) (?:row )?errors?/i)?.[1]?.replaceAll(',', '')) || 0;
		const reason = errorCount > 0 ? `${errorCount.toLocaleString()} row error${errorCount === 1 ? '' : 's'}` : singleLine(e.error || 'Table migration failed').slice(0, 160);
		return { icon: '✕', text: `${table}: failed — ${reason}. See Migration History for details.`, cls: 'log-error' };
	}

	/**
	 * Append log entries to the live log container
	 */
	appendLogEntries(entries) {
		const container = document.getElementById('log-container');
		if (!container || !entries || !entries.length) return;
		if (this._logContainer !== container || this._logRunId !== this.run?.id) {
			this._loggedTables.clear();
			this._logContainer = container;
			this._logRunId = this.run?.id;
		}
		for (const e of entries) {
			const formatted = this.formatLogEntry(e);
			if (!formatted) continue;
			const tableKey = String(e.tableName || e.table).toLowerCase();
			if (this._loggedTables.has(tableKey)) continue;
			this._loggedTables.add(tableKey);

			const el = document.createElement('div');
			el.className = `log-entry ${formatted.cls}`;

			const iconSpan = document.createElement('span');
			iconSpan.className = 'log-icon';
			iconSpan.textContent = formatted.icon;

			const textSpan = document.createElement('span');
			textSpan.className = 'log-text';
			textSpan.textContent = formatted.text;

			if (e.timestamp) {
				const tsSpan = document.createElement('span');
				tsSpan.className = 'log-ts';
				tsSpan.textContent = new Date(e.timestamp).toLocaleTimeString();
				el.appendChild(tsSpan);
			}
			el.appendChild(iconSpan);
			el.appendChild(textSpan);
			container.appendChild(el);
		}
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

		if (['RUNNING', 'PENDING', 'ABORTING'].includes(String(this.run.status || '').toUpperCase())) {
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

		try {
			const summary = await this.api.getSummary(this.run.id);
			container.innerHTML = window.ResultsRenderer.renderFailureSummary(summary);
		} catch (error) {
			container.innerHTML = '<p>Could not load failure details. Open Failure Results to try again.</p>';
		}
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
