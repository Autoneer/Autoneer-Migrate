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
			<p class="recovery-note">Retry includes failed and unattempted tables and counts existing records as skipped. Existing invoices keep their numbers, job links, and customer links; conflicting links remain errors. Completed tables are kept.</p>
		</section>`;
	},
	renderWarnings(summary) {
		const warnings = summary?.warnings || [];
		if (!warnings.length) return '';
		const esc = ResultsRenderer.escape;
		return `<section class="results-warnings" aria-label="Post-import warnings">
			<h3>Post-import warnings <span class="results-count">${warnings.length}</span></h3>
			<p>The data was imported. Check these records in the new system.</p>
			<ul>${warnings.map(w => `<li><code>${esc(w.table || 'Migration')}</code> ${esc(w.message)}</li>`).join('')}</ul>
		</section>`;
	},
	formatNumber(num) {
		return Number(num || 0).toLocaleString();
	},
	formatDuration(ms) {
		if (!ms) return '—';
		if (ms < 1000) return '<1s';
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
			const statusText = String(table.status || 'unknown').replace(/_/g, ' ').toLowerCase();
			const errorCount = table.errorCount || 0;

			return `
				<tr class="table-result-${statusClass}">
					<td data-label="Table"><code>${ResultsRenderer.escape(table.name)}</code></td>
					<td data-label="Status">
						<span class="status-badge status-${statusClass}"><span aria-hidden="true">${statusIcon}</span> ${ResultsRenderer.escape(statusText)}</span>
					</td>
					<td class="num" data-label="Rows">${ResultsRenderer.formatNumber(table.rowsMigrated || 0)}</td>
					<td class="num" data-label="Duration">${ResultsRenderer.formatDuration(table.duration)}</td>
					<td class="num${errorCount ? ' has-errors' : ''}" data-label="Errors">${ResultsRenderer.formatNumber(errorCount)}</td>
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
		const hasWarnings = (summary?.warnings || []).length > 0;
		const tone = isFailed ? 'error' : isSuccess && !hasWarnings ? 'success' : 'warning';
		const tableCount = summary?.tableCount || 0;
		const successCount = summary?.successCount || 0;
		const runId = encodeURIComponent(run.id || run.runId);
		const tableRows = summary?.tableDetails?.length || 0;
		const stats = [
			['Tables migrated', `${successCount} <small>of ${tableCount}</small>`, successCount < tableCount ? 'warning' : ''],
			['Rows migrated', ResultsRenderer.formatNumber(summary?.totalRows || summary?.rows?.migrated || 0), ''],
			['Duration', ResultsRenderer.formatDuration(summary?.duration || summary?.durationMs), ''],
			[summary?.rowErrorCount ? 'Row errors' : 'Errors', ResultsRenderer.formatNumber(errorCount), errorCount > 0 ? 'error' : '']
		];
		const title = isSuccess ? (hasWarnings ? 'Migration completed with warnings' : 'Migration completed successfully')
			: isFailed ? 'Migration failed — review and retry' : 'Migration results';
		const subtitle = [
			summary?.completedAt ? 'Finished ' + new Date(summary.completedAt).toLocaleString() : '',
			isFailed ? 'Resolve the failures before Step 5: Convert Account Numbers.'
				: hasWarnings ? `${summary.warnings.length === 1 ? '1 item needs' : `${summary.warnings.length} items need`} a manual check.` : ''
		].filter(Boolean).join(' · ');

		container.innerHTML = `
			<div class="results-viewer">
				<div class="results-banner is-${tone}">
					<span class="results-banner-icon" aria-hidden="true">${tone === 'success' ? '✓' : tone === 'error' ? '✕' : '!'}</span>
					<div>
						<h2>${title}</h2>
						${subtitle ? `<p>${subtitle}</p>` : ''}
					</div>
				</div>

				${isFailed && handlers.onEdit ? `<div class="recovery-actions">
					<button class="btn btn-primary" data-results-action="edit-plan">Amend Plan</button>
					<button class="btn btn-secondary" data-results-action="edit-mapping">Amend Mapping</button>
					<button class="btn btn-secondary" data-results-action="retry">Retry Failed / Unattempted Tables</button>
				</div>` : ''}
				${ResultsRenderer.renderFailureSummary(summary)}

				<dl class="results-stats">
					${stats.map(([label, value, cls]) => `<div${cls ? ` class="is-${cls}"` : ''}><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
				</dl>

				${ResultsRenderer.renderWarnings(summary)}

				${handlers.onDownload || handlers.onStartNew ? `<div class="results-actions">
					${handlers.onDownload ? `<div class="results-actions-group" role="group" aria-label="Reports">
						<a class="btn btn-secondary" href="/api/runs/${runId}/data-quality">Data quality report</a>
						<a class="btn btn-secondary" href="/api/runs/${runId}/data-quality?download=quarantine">Quarantined &amp; review records</a>
						<button class="btn btn-secondary" data-results-action="download-json">JSON report</button>
						<button class="btn btn-secondary" data-results-action="download-csv">CSV report</button>
						<button class="btn btn-secondary" data-results-action="view-logs">View logs</button>
					</div>` : ''}
					${handlers.onStartNew ? '<button class="btn btn-primary" data-results-action="start-new">Start new migration</button>' : ''}
				</div>` : ''}

				<section class="table-results" aria-labelledby="results-table-heading">
					<div class="table-results-head">
						<h3 id="results-table-heading">Table details</h3>
						<span class="results-count">${tableRows} ${tableRows === 1 ? 'table' : 'tables'}</span>
					</div>
					<div class="results-table-wrap">
						<table class="results-table">
							<thead>
								<tr>
									<th scope="col">Table</th>
									<th scope="col">Status</th>
									<th scope="col" class="num">Rows</th>
									<th scope="col" class="num">Duration</th>
									<th scope="col" class="num">Errors</th>
								</tr>
							</thead>
							<tbody>
								${ResultsRenderer.renderTableResults(summary)}
							</tbody>
						</table>
					</div>
				</section>

				${ResultsRenderer.renderErrors(errors || [])}
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

/**
 * LogViewer - Readable, filterable view of a run's structured log events.
 * Most events carry no message, so each line is summarised from its fields.
 */
const LogViewer = {
	LEVELS: [
		{ key: 'error', label: 'Errors' },
		{ key: 'warn', label: 'Warnings' },
		{ key: 'info', label: 'Info' },
		{ key: 'debug', label: 'Debug' }
	],
	// High-volume ticks that only report scan or batch progress.
	PROGRESS_PHASES: new Set(['reading', 'checking_relationships', 'saving_quarantine', 'counting', 'validating_definition',
		'target_keys', 'parent_keys', 'table_metadata', 'keepalive', 'write']),
	level(entry) {
		const level = String(entry?.level || 'info').toLowerCase();
		if (level === 'warning') return 'warn';
		if (level === 'fatal') return 'error';
		return LogViewer.LEVELS.some(l => l.key === level) ? level : 'info';
	},
	isProgress(entry) {
		return LogViewer.PROGRESS_PHASES.has(entry?.phase) && !['error', 'warn'].includes(LogViewer.level(entry));
	},
	humanize(value) {
		return String(value ?? '').replace(/_/g, ' ').trim();
	},
	formatTime(timestamp) {
		const date = timestamp ? new Date(timestamp) : null;
		return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour12: false }) : '--:--:--';
	},
	describe(e) {
		const n = ResultsRenderer.formatNumber;
		const h = LogViewer.humanize;
		const error = typeof e.error === 'string' ? e.error : e.error?.message || null;
		const counts = ['inserted', 'updated', 'skipped', 'errors'].filter(k => e[k] != null).map(k => `${n(e[k])} ${k}`);
		const duration = e.durationMs != null ? `${n(e.durationMs)} ms` : null;
		const progress = e.scanned != null ? (e.total != null ? `${n(e.scanned)} / ${n(e.total)} rows` : `${n(e.scanned)} rows`) : null;
		let summary;
		if (e.message) {
			summary = e.message;
		} else if (e.phase === 'run_start') {
			summary = [`Run started · ${n(e.tables?.length)} tables · batch size ${n(e.batchSize)}`,
				e.dryRun ? 'dry run' : null, e.retryOfRunId ? `retry of run #${e.retryOfRunId}` : null].filter(Boolean).join(' · ');
		} else if (e.phase === 'run_finalize') {
			summary = `Run finished: ${h(e.status)}${e.warnings ? ` · ${n(e.warnings)} ${e.warnings === 1 ? 'warning' : 'warnings'}` : ''}`;
		} else if (e.phase === 'table_start') {
			summary = ['Table started', e.mode, e.keyStrategy ? `${e.keyStrategy} keys` : null].filter(Boolean).join(' · ');
		} else if (e.phase === 'fetch') {
			summary = `${n(e.sourceRows)} source rows to migrate`;
		} else if (e.phase === 'write' && e.status === 'start') {
			summary = `Writing batch of ${n(e.batchSize)} rows`;
		} else if (e.phase === 'write' || e.phase === 'table_finalize') {
			summary = [e.phase === 'write' ? 'Batch written' : `Table ${h(e.status)}`, ...counts, duration].filter(Boolean).join(' · ');
		} else if (e.phase === 'scan_complete') {
			summary = `Scan complete · ${n(e.scanned)} rows · ${n(e.flagged)} flagged`;
		} else if (e.check) {
			summary = `Check ${e.check} — ${e.name || ''}: ${e.passed ? 'passed' : `failed (${n(e.errorCount)} errors)`}`;
		} else {
			summary = [h(e.action), h(e.step), h(e.validation), h(e.status), progress,
				e.flagged ? `${n(e.flagged)} flagged` : null, ...counts,
				e.totals ? Object.entries(e.totals).map(([k, v]) => `${n(v)} ${k}`).join(', ') : null,
				duration].filter(Boolean).join(' · ');
		}
		return [summary, error].filter(Boolean).join(' — ');
	},
	toRow(entry) {
		const level = LogViewer.level(entry);
		const phase = LogViewer.humanize(entry.phase || entry.type || '');
		const table = entry.table || entry.tableName || '';
		const summary = LogViewer.describe(entry);
		const time = LogViewer.formatTime(entry.timestamp);
		return { entry, level, phase, table, summary, time, progress: LogViewer.isProgress(entry),
			text: `[${time}] ${level.toUpperCase().padEnd(5)} ${phase}${table ? ` [${table}]` : ''} ${summary}`.trim() };
	},
	renderRow(row, index) {
		const esc = ResultsRenderer.escape;
		return `<details class="log-row log-${row.level}" data-index="${index}">
			<summary>
				<time title="${esc(row.entry.timestamp || '')}">${esc(row.time)}</time>
				<span class="log-level">${row.level.toUpperCase()}</span>
				<span class="log-phase">${esc(row.phase)}</span>
				<span class="log-summary">${row.table ? `<code class="log-table">${esc(row.table)}</code>` : ''}${esc(row.summary)}</span>
			</summary>
			<pre class="log-detail"></pre>
		</details>`;
	},
	render(rows, { total } = {}) {
		const n = ResultsRenderer.formatNumber;
		const levelCounts = Object.fromEntries(LogViewer.LEVELS.map(l => [l.key, rows.filter(r => r.level === l.key).length]));
		const progressCount = rows.filter(r => r.progress).length;
		const truncated = total > rows.length ? ` · newest ${n(rows.length)} of ${n(total)}` : '';
		return `<div class="log-viewer">
			<div class="log-toolbar">
				<div class="log-levels" role="group" aria-label="Filter by level">
					<button type="button" data-level="all" aria-pressed="true">All <span>${n(rows.length)}</span></button>
					${LogViewer.LEVELS.map(l => `<button type="button" data-level="${l.key}" aria-pressed="false" class="log-chip-${l.key}"${levelCounts[l.key] ? '' : ' disabled'}>${l.label} <span>${n(levelCounts[l.key])}</span></button>`).join('')}
				</div>
				<input type="search" class="log-search" placeholder="Search messages, tables, values…" aria-label="Search logs">
				<label class="log-toggle"${progressCount ? '' : ' hidden'}><input type="checkbox" class="log-hide-progress" checked> Hide progress updates (${n(progressCount)})</label>
			</div>
			<div class="log-list">${rows.map(LogViewer.renderRow).join('')}</div>
			<p class="log-empty" hidden>${rows.length ? 'No entries match these filters.' : 'No log entries were recorded for this run.'}</p>
			<p class="log-status" aria-live="polite"><span class="log-status-count"></span>${truncated}</p>
		</div>`;
	},
	bind(root, rows) {
		const n = ResultsRenderer.formatNumber;
		const elements = Array.from(root.querySelectorAll('.log-row'));
		const search = root.querySelector('.log-search');
		const hideProgress = root.querySelector('.log-hide-progress');
		const levelButtons = Array.from(root.querySelectorAll('.log-levels button'));
		const haystacks = rows.map(r => `${r.text} ${JSON.stringify(r.entry)}`.toLowerCase());
		let level = 'all';
		let timer = null;
		const apply = () => {
			const terms = String(search.value || '').toLowerCase().split(/\s+/).filter(Boolean);
			let shown = 0;
			rows.forEach((row, i) => {
				const visible = (level === 'all' || row.level === level)
					// A specific level or a search shows every match, progress ticks included.
					&& (!hideProgress.checked || !row.progress || level !== 'all' || terms.length > 0)
					&& terms.every(t => haystacks[i].includes(t));
				elements[i].hidden = !visible;
				if (visible) shown++;
			});
			root.querySelector('.log-empty').hidden = shown > 0;
			root.querySelector('.log-status-count').textContent = `Showing ${n(shown)} of ${n(rows.length)} entries`;
		};
		levelButtons.forEach(btn => btn.addEventListener('click', () => {
			level = btn.dataset.level;
			levelButtons.forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
			apply();
		}));
		search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 120); });
		hideProgress.addEventListener('change', apply);
		// Detail JSON is rendered on first expand to keep large logs fast to open.
		root.querySelector('.log-list').addEventListener('toggle', (event) => {
			const row = event.target;
			const detail = row.querySelector?.('.log-detail');
			if (!row.open || !detail || detail.textContent) return;
			detail.textContent = JSON.stringify(rows[Number(row.dataset.index)].entry, null, 2);
		}, true);
		apply();
		return { visibleText: () => rows.filter((_, i) => !elements[i].hidden).map(r => r.text).join('\n') };
	},
	/**
	 * Open the log viewer in a modal
	 * @param {Array} logs - Log entries, oldest first
	 * @param {Object} options - { runId, total }
	 */
	open(logs, { runId, total } = {}) {
		const rows = (Array.isArray(logs) ? logs : []).map(LogViewer.toRow);
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `
			<div class="modal-dialog modal-xl log-modal" role="dialog" aria-modal="true" aria-labelledby="log-modal-title">
				<div class="modal-header">
					<h3 id="log-modal-title">Migration log${runId != null ? ` <small>Run #${ResultsRenderer.escape(runId)}</small>` : ''}</h3>
					<button class="modal-close" type="button" aria-label="Close">×</button>
				</div>
				<div class="modal-body">${LogViewer.render(rows, { total })}</div>
				<div class="modal-footer">
					<span class="log-copy-status" aria-live="polite"></span>
					<button class="btn btn-outline" type="button" data-log-action="copy">Copy visible</button>
					<button class="btn btn-outline" type="button" data-log-action="download"${rows.length ? '' : ' disabled'}>Download log</button>
					<button class="btn btn-secondary" type="button" data-log-action="close">Close</button>
				</div>
			</div>`;
		const viewer = LogViewer.bind(overlay, rows);
		const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
		const onKey = (event) => { if (event.key === 'Escape') close(); };
		document.addEventListener('keydown', onKey);
		overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
		overlay.querySelector('.modal-close').addEventListener('click', close);
		overlay.querySelector('[data-log-action="close"]').addEventListener('click', close);
		overlay.querySelector('[data-log-action="copy"]').addEventListener('click', async () => {
			const status = overlay.querySelector('.log-copy-status');
			try {
				await navigator.clipboard.writeText(viewer.visibleText());
				status.textContent = 'Copied';
			} catch (err) {
				status.textContent = 'Copy failed';
			}
			setTimeout(() => { status.textContent = ''; }, 2000);
		});
		overlay.querySelector('[data-log-action="download"]').addEventListener('click', () => {
			const blob = new Blob([rows.map(r => JSON.stringify(r.entry)).join('\n')], { type: 'application/x-ndjson' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `migration-log-${runId ?? 'run'}.jsonl`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		});
		document.body.appendChild(overlay);
		overlay.querySelector('.log-search').focus();
		return overlay;
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
			// No onStartNew: in the wizard, "Start new migration" lives in the Next button slot
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

			const { logs, total } = await this.api.getFullLog(this.run.id);
			this.wizard.hideLoading();
			LogViewer.open(logs, { runId: this.run.id, total });

		} catch (err) {
			this.wizard.hideLoading();
			this.wizard.showError(`Failed to load logs: ${err.message}`);
		}
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
window.LogViewer = LogViewer;
