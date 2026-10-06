/**
 * ResultsUI - Final results and the failure branch before account conversion
 * 
 * Displays migration results, statistics, errors, and provides
 * options to export reports or start new migrations.
 */
const ResultsRenderer = {
	escape(value) {
		return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
	},
	renderFailureSummary(summary) {
		const groups = summary?.errorGroups || [];
		if (!groups.length) return '';
		const esc = ResultsRenderer.escape;
		return `<section class="failure-diagnostics" aria-label="Why the migration failed">
			<h3>Why the migration failed</h3>
			<p>${summary.successCount || 0} of ${summary.tableCount || 0} tables succeeded · ${summary.failedCount || 0} failed · ${summary.notRunCount || 0} not started.</p>
			${groups.map((group, index) => `<details class="failure-cause" ${index === 0 ? 'open' : ''}>
				<summary><strong>${esc(group.table || 'Migration')} — ${group.count} ${group.count === 1 ? 'error' : 'errors'}${group.value != null ? ` · ${esc(group.column || 'value')} ${esc(group.value)}` : ''}</strong></summary>
				<p>${esc(group.reason)}</p>
				<p><strong>What to change:</strong> ${esc(group.action)}</p>
				${group.sampleRows?.length ? `<p><strong>Example source ${group.table === 'invoices' ? 'invoice numbers' : 'record IDs'}:</strong> ${group.sampleRows.map(esc).join(', ')}</p>` : ''}
				<details><summary>Technical detail</summary><code>${esc(group.message)}</code></details>
			</details>`).join('')}
			<p class="recovery-note">The migration does not roll back rows already written. Review partial imports before retrying, especially invoices that preserve their original numbers. Retry includes failed and unattempted tables; completed tables are kept.</p>
		</section>`;
	},
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
					<td><strong>${ResultsRenderer.escape(table.name)}</strong></td>
					<td>
						<span class="status-badge status-${statusClass}">
							${statusIcon} ${ResultsRenderer.escape(table.status)}
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
								<span class="error-table">${ResultsRenderer.escape(error.table || 'Unknown')}</span>
								<span class="error-message">${ResultsRenderer.escape(error.message)}</span>
							</summary>
							<div class="error-content">
								<div class="error-detail">
									<strong>Time:</strong> ${error.timestamp ? new Date(error.timestamp).toLocaleString() : '—'}
								</div>
								${error.row != null ? `
									<div class="error-detail">
										<strong>${error.table === 'invoices' ? 'Source invoice number' : 'Source record'}:</strong> ${ResultsRenderer.escape(error.row)}
									</div>
								` : ''}
								${error.column ? `
									<div class="error-detail">
										<strong>Column:</strong> ${ResultsRenderer.escape(error.column)}
									</div>
								` : ''}
								${error.value != null ? `
									<div class="error-detail">
										<strong>Value:</strong> <code>${ResultsRenderer.escape(error.value)}</code>
									</div>
								` : ''}
								${error.stack ? `
									<div class="error-detail">
										<strong>Stack Trace:</strong>
										<pre>${ResultsRenderer.escape(error.stack)}</pre>
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
		const isFailed = ['FAILED', 'COMPLETED_WITH_ERRORS', 'STOPPED', 'CANCELLED', 'ABORTED'].includes(runStatus);
		const isSuccess = (runStatus === 'SUCCESS' || runStatus === 'COMPLETED') && errorCount === 0;

		container.innerHTML = `
			<div class="results-viewer">
				<!-- Status Header -->
				<div class="results-header ${isSuccess ? 'success' : isFailed ? 'error' : 'warning'}">
					<div class="status-icon">${isSuccess ? '✓' : '⚠'}</div>
					<div class="status-content">
						<h2>${isSuccess ? 'Migration Completed Successfully' : isFailed ? 'Migration Failed — Review and Retry' : 'Migration Results'}</h2>
						<p>${summary?.completedAt ? 'Finished at ' + new Date(summary.completedAt).toLocaleString() : ''}</p>
						${isFailed ? '<p>Resolve the failures before Step 5: Convert Account Numbers.</p>' : ''}
					</div>
				</div>
        
				${isFailed && handlers.onEdit ? `<div class="recovery-actions">
					<button class="btn btn-primary" data-results-action="edit-plan">Amend Plan</button>
					<button class="btn btn-secondary" data-results-action="edit-mapping">Amend Mapping</button>
					<button class="btn btn-secondary" data-results-action="retry">Retry Failed / Unattempted Tables</button>
				</div>` : ''}
				${ResultsRenderer.renderFailureSummary(summary)}
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
							<div class="stat-label">${summary?.rowErrorCount ? 'Row Errors' : 'Errors'}</div>
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
				if (action === 'edit-plan') handlers.onEdit?.(3);
				if (action === 'edit-mapping') handlers.onEdit?.(2);
				if (action === 'retry') handlers.onRetry?.();
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

			this.errors = [];
			this.run = await this.api.getById(runId);
			this.state.set('run.status', this.run.status);
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
		const container = document.getElementById('results-content');
		if (!container) return;

		ResultsRenderer.render(container, { run: this.run, summary: this.summary, errors: this.errors }, {
			onDownload: (format) => this.downloadReport(format),
			onViewLogs: () => this.viewLogs(),
			onStartNew: () => this.startNewMigration(),
			onEdit: (step) => this.wizard.steps[3].component.editMigration(step),
			onRetry: async () => {
				const component = this.wizard.steps[3].component;
				component.run = this.run;
				await component.retryMigration();
			}
		});

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
          <pre class="log-content">${ResultsRenderer.escape(this.renderLogs(logs))}</pre>
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
		// Clear our own stale data so re-entering this step doesn't show old results
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
