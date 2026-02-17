/**
 * ResultsUI - Step 5: View Results
 * 
 * Displays migration results, statistics, errors, and provides
 * options to export reports or start new migrations.
 */
const ResultsRenderer = {
	formatNumber(num) {
		return Number(num || 0).toLocaleString();
	},
	formatDuration(ms) {
		if (!ms) return '—';
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		if (hours > 0) {
			return `${hours}h ${minutes % 60}m`;
		}
		if (minutes > 0) {
			return `${minutes}m ${seconds % 60}s`;
		}
		return `${seconds}s`;
	},
	renderTableResults(summary) {
		const tableResults = summary?.tableDetails || [];
		return tableResults.map(table => {
			const normalizedStatus = String(table.status || '').toUpperCase();
			const statusClass = normalizedStatus === 'COMPLETED' || normalizedStatus === 'SUCCESS' ? 'success' :
				normalizedStatus === 'FAILED' ? 'error' : 'warning';
			const statusIcon = normalizedStatus === 'COMPLETED' || normalizedStatus === 'SUCCESS' ? '✓' :
				normalizedStatus === 'FAILED' ? '✕' : '⚠';

			return `
				<tr class="table-result-${statusClass}">
					<td><strong>${table.name}</strong></td>
					<td>
						<span class="status-badge status-${statusClass}">
							${statusIcon} ${table.status}
						</span>
					</td>
					<td>${ResultsRenderer.formatNumber(table.rowsMigrated || 0)}</td>
					<td>${ResultsRenderer.formatDuration(table.duration)}</td>
					<td>${table.errorCount || 0}</td>
				</tr>
			`;
		}).join('');
	},
	renderErrors(errors) {
		if (!errors || errors.length === 0) {
			return '';
		}

		return `
			<div class="error-details">
				<h3>⚠ Errors Encountered (${errors.length})</h3>
        
				<div class="error-list">
					${errors.map((error) => `
						<details class="error-item">
							<summary>
								<span class="error-icon">✕</span>
								<span class="error-table">${error.table || 'Unknown'}</span>
								<span class="error-message">${error.message}</span>
							</summary>
							<div class="error-content">
								<div class="error-detail">
									<strong>Time:</strong> ${error.timestamp ? new Date(error.timestamp).toLocaleString() : '—'}
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
	},
	render(container, payload, handlers = {}) {
		if (!container) return;
		const { run, summary, errors } = payload || {};
		const runStatus = String(run?.status || '').toUpperCase();
		const errorCount = summary?.errorCount || 0;
		const isSuccess = (runStatus === 'SUCCESS' || runStatus === 'COMPLETED') && errorCount === 0;

		container.innerHTML = `
			<div class="results-viewer">
				<!-- Status Header -->
				<div class="results-header ${isSuccess ? 'success' : 'warning'}">
					<div class="status-icon">${isSuccess ? '✓' : '⚠'}</div>
					<div class="status-content">
						<h2>${isSuccess ? 'Migration Completed Successfully' : 'Migration Completed with Issues'}</h2>
						<p>${run?.completedAt ? 'Completed at ' + new Date(run.completedAt).toLocaleString() : ''}</p>
					</div>
				</div>
        
				<!-- Summary Statistics -->
				<div class="results-stats">
					<div class="stat-card ${(summary?.tableCount || 0) === (summary?.successCount || 0) ? 'success' : 'warning'}">
						<div class="stat-icon">📊</div>
						<div class="stat-content">
							<div class="stat-value">${summary?.successCount || 0} / ${summary?.tableCount || 0}</div>
							<div class="stat-label">Tables Migrated</div>
						</div>
					</div>
          
					<div class="stat-card">
						<div class="stat-icon">📝</div>
						<div class="stat-content">
							<div class="stat-value">${ResultsRenderer.formatNumber(summary?.totalRows || summary?.rows?.migrated || 0)}</div>
							<div class="stat-label">Rows Migrated</div>
						</div>
					</div>
          
					<div class="stat-card">
						<div class="stat-icon">⏱️</div>
						<div class="stat-content">
							<div class="stat-value">${ResultsRenderer.formatDuration(summary?.duration || summary?.durationMs)}</div>
							<div class="stat-label">Duration</div>
						</div>
					</div>
          
					<div class="stat-card ${(summary?.errorCount || 0) > 0 ? 'error' : 'success'}">
						<div class="stat-icon">${(summary?.errorCount || 0) > 0 ? '⚠' : '✓'}</div>
						<div class="stat-content">
							<div class="stat-value">${summary?.errorCount || 0}</div>
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
							${ResultsRenderer.renderTableResults(summary)}
						</tbody>
					</table>
				</div>
        
				<!-- Errors (if any) -->
				${ResultsRenderer.renderErrors(errors || [])}
        
				<!-- Actions -->
				<div class="results-actions">
					<button class="btn btn-secondary" data-results-action="download-json">
						📥 Download JSON Report
					</button>
					<button class="btn btn-secondary" data-results-action="download-csv">
						📥 Download CSV Report
					</button>
					<button class="btn btn-secondary" data-results-action="view-logs">
						📋 View Logs
					</button>
					<button class="btn btn-primary" data-results-action="start-new">
						🔄 Start New Migration
					</button>
				</div>
			</div>
		`;

		container.querySelectorAll('[data-results-action]')?.forEach(btn => {
			btn.addEventListener('click', (event) => {
				const action = event.currentTarget.getAttribute('data-results-action');
				if (action === 'download-json' && handlers.onDownload) handlers.onDownload('json');
				if (action === 'download-csv' && handlers.onDownload) handlers.onDownload('csv');
				if (action === 'view-logs' && handlers.onViewLogs) handlers.onViewLogs();
				if (action === 'start-new' && handlers.onStartNew) handlers.onStartNew();
			});
		});

		// Populate profile/plan names in modal header
		const populateMetadata = async () => {
			try {
				const runId = payload?.run?.id || payload?.run?.runId;
				if (!runId) return;

				const profileEl = document.getElementById('results-profile-name');
				const planEl = document.getElementById('results-plan-name');
				if (!profileEl && !planEl) return;

				// Attempt to fetch metadata from server
				try {
					const response = await fetch(`/api/runs/${runId}/metadata`).catch(() => null);
					if (response && response.ok) {
						const data = await response.json();
						const meta = data?.metadata || {};
						if (meta.planName && planEl) planEl.textContent = meta.planName;
						if (meta.mappingName && profileEl) profileEl.textContent = meta.mappingName;
					}
				} catch (e) {
					// ignore API errors
				}
			} catch (err) {
				// silently ignore metadata population errors
			}
		};

		// Trigger population after a brief delay to ensure DOM is ready
		setTimeout(populateMetadata, 100);
	}
};

const ResultsModal = {
	binded: false,
	open() {
		const modal = document.getElementById('results-modal');
		if (!modal) return;
		modal.style.display = 'flex';
		modal.setAttribute('aria-hidden', 'false');
		ResultsModal.bind();
	},
	close() {
		const modal = document.getElementById('results-modal');
		if (!modal) return;
		modal.style.display = 'none';
		modal.setAttribute('aria-hidden', 'true');
	},
	bind() {
		if (ResultsModal.binded) return;
		const modal = document.getElementById('results-modal');
		if (!modal) return;
		ResultsModal.binded = true;
		modal.addEventListener('click', (event) => {
			if (event.target === modal) {
				ResultsModal.close();
			}
		});
		const closeBtn = modal.querySelector('[data-results-close]');
		if (closeBtn) {
			closeBtn.addEventListener('click', () => ResultsModal.close());
		}
	}
};

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

			console.log('Results loaded:', {
				run: this.run,
				summary: this.summary,
				tableDetailsType: typeof this.summary?.tableDetails,
				tableDetailsIsArray: Array.isArray(this.summary?.tableDetails),
				tableDetailsLength: this.summary?.tableDetails?.length
			});

			if (String(this.run.status || '').toUpperCase() === 'FAILED' || this.summary.errorCount > 0) {
				this.errors = await this.api.getErrors(runId);
			}

			this.wizard.hideLoading();
			this.render();

		} catch (err) {
			this.wizard.hideLoading();
			console.error('Results initialization error:', err);
			this.wizard.showError(`Failed to load results: ${err.message}`);
		}
	}

	/**
	 * Render results viewer UI
	 */
	render() {
		const container = document.getElementById('results-modal-content') || document.getElementById('results-content');
		if (!container) return;

		ResultsRenderer.render(container, { run: this.run, summary: this.summary, errors: this.errors }, {
			onDownload: (format) => this.downloadReport(format),
			onViewLogs: () => this.viewLogs(),
			onStartNew: () => this.startNewMigration()
		});

		if (document.getElementById('results-modal')) {
			ResultsModal.open();
		}

		// Populate profile and plan meta in the modal header
		(async () => {
			try {
				const profileEl = document.getElementById('results-profile-name');
				const planEl = document.getElementById('results-plan-name');
				if (!profileEl && !planEl) return;

				// Try several locations for ids (server responses vary)
				const run = this.run || {};
				const possiblePlanId = run.planId || run.plan?.id || run.planId || run.plan_id || (run.toJSON ? (run.toJSON().planId || null) : null);
				const possibleMappingId = run.mappingProfileId || run.mapping_profile_id || run.mappingId || run.mapping_id || run.mappingProfile || run.mappingProfileId || null;

				// Resolve plan name
				if (planEl) {
					if (possiblePlanId && window.PlanAPI && typeof window.PlanAPI.getById === 'function') {
						try {
							const plan = await window.PlanAPI.getById(possiblePlanId);
							if (plan && plan.name) {
								planEl.textContent = plan.name;
							} else {
								planEl.textContent = String(possiblePlanId);
							}
						} catch (e) {
							// fallback to cached plan
							const cached = window.WizardStorage?.getPlan();
							if (cached && cached.name) planEl.textContent = cached.name;
						}
					} else {
						const cached = window.WizardStorage?.getPlan();
						if (cached && cached.name) planEl.textContent = cached.name;
					}
				}

				// Resolve mapping/profile name
				if (profileEl) {
					if (possibleMappingId && window.MappingAPI && typeof window.MappingAPI.getById === 'function') {
						try {
							const mapping = await window.MappingAPI.getById(possibleMappingId);
							if (mapping && mapping.name) {
								profileEl.textContent = mapping.name;
							} else {
								profileEl.textContent = String(possibleMappingId);
							}
						} catch (e) {
							const cached = window.WizardStorage?.getMapping();
							if (cached && cached.name) profileEl.textContent = cached.name;
						}
					} else {
						const cached = window.WizardStorage?.getMapping();
						if (cached && cached.name) profileEl.textContent = cached.name;
					}
				}
			} catch (err) {
				console.error('Failed to populate results metadata:', err);
			}
		})();
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
		if (!Array.isArray(logs) || logs.length === 0) {
			return '(no log entries)';
		}
		return logs.map(log => {
			const timestamp = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '--:--:--';
			const level = String(log.level || 'info').toUpperCase().padEnd(7);
			return `[${timestamp}] ${level} ${log.message || log.type || ''}`;
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
			// Clear our own stale data so re-entering Step 5 doesn't show old results
			this.run = null;
			this.summary = null;
			this.errors = null;

			// Also clear the RunUI instance state so Step 4 shows pre-execution
			const runComponent = this.wizard.steps[3]?.component;
			if (runComponent) {
				runComponent.stopPolling();
				runComponent.run = null;
				runComponent._lastLogTs = null;
				runComponent.startTime = null;
			}

			this.wizard.reset();
		})();
	}

	/**
	 * Format number with commas
	 */

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
window.ResultsRenderer = ResultsRenderer;
window.ResultsModal = ResultsModal;
