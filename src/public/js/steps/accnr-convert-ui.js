/**
 * AccnrConvertUI - Step 5: Rebuild GL Accounts + Convert Account Numbers
 *
 * Rebuilds gl_accounts from migrated staging accounts, then converts legacy
 * Firebird accnr values to the new 4-digit GL account numbers across all
 * transactional tables (acc, accnr, accasset, siid fields).
 *
 * Proceeding without converting is allowed. The conversion is idempotent and
 * can be run later via GL Tools.
 */
class AccnrConvertUI {
	constructor(wizard) {
		this.wizard = wizard;
		this.state = window.WizardState;
		this._converted = false;
		this._glRebuilt = false;
		this._busy = false;
		this._conversionProgress = null;
		this._tables = [
			['customers', ['acc']], ['suppliers', ['acc']], ['invoices', ['acc']],
			['invoices_supplier', ['acc']], ['stock', ['siid', 'acc', 'accasset']],
			['spares_used', ['siid', 'acc', 'accasset']], ['work_done', ['siid', 'acc']],
			['payments', ['acc']], ['payments_suppliers', ['accnr', 'acc']],
			['invoice_items', ['siid', 'acc']], ['labour_pricing', ['siid', 'acc']]
		];
	}

	async initialize() {
		if (this._busy) return;
		const plan = this.state?.get('plan') || {};
		const rebuiltPlanId = this.state?.get('run.glRebuildPlanId');
		this._glRebuilt = !!(plan.id && rebuiltPlanId === plan.id);
		this._render('idle');
	}

	_escapeHtml(value) {
		const div = document.createElement('div');
		div.textContent = value == null ? '' : String(value);
		return div.innerHTML;
	}

	_getStatusHtml(state, detail) {
		const detailText = detail ? ` ${this._escapeHtml(detail)}` : '';
		const status = {
			'rebuild-running': {
				className: 'step-status-info',
				icon: '...',
				message: 'Rebuilding GL accounts...'
			},
			'rebuild-success': {
				className: 'step-status-success',
				icon: 'OK',
				message: `GL accounts rebuilt.${detailText || ' You can now convert account numbers.'}`
			},
			'rebuild-error': {
				className: 'step-status-error',
				icon: '!',
				message: `Rebuild failed:${detailText || ' Unknown error'}`
			},
			'conversion-running': {
				className: 'step-status-info',
				icon: '...',
				message: `Converting transactional account numbers...${detailText}`
			},
			'conversion-success': {
				className: 'step-status-success',
				icon: 'OK',
				message: `Conversion complete.${detailText}`
			},
			'conversion-error': {
				className: 'step-status-error',
				icon: '!',
				message: `Conversion failed:${detailText || ' Unknown error'}`
			}
		}[state];

		if (!status) return '';

		return `<div class="step-status-banner ${status.className}">
			<span class="status-icon">${status.icon}</span>
			<span class="status-message">${status.message}</span>
		</div>`;
	}

	_summarizeRebuild(response) {
		const summary = response?.accounts_summary;
		if (!summary) return 'You can now convert account numbers.';
		return `${summary.migrated} account(s) migrated to gl_accounts, ${summary.skipped} skipped.`;
	}

	_setBusy(busy) {
		this._busy = busy;
		// Keep the stage indicators visible while disabling wizard navigation.
		this.wizard._isBusy = busy;
		this.wizard.renderNavigation?.();
	}

	_getConversionProgressHtml() {
		const progress = this._conversionProgress;
		if (!progress) return '';
		const percent = progress.total ? Math.floor(progress.completed / progress.total * 100) : 0;
		const active = progress.stages.find(stage => stage.status === 'running');
		const failed = progress.stages.find(stage => stage.status === 'failed');
		const current = failed ? `Failed: ${failed.id}` : active ? `Stage ${progress.completed + 1} of ${progress.total}: Converting ${active.id}`
			: progress.completed === progress.total && progress.total > 0 ? 'All conversion stages completed.'
				: progress.interrupted ? 'Progress updates interrupted. The conversion may still be running on the server.'
					: 'Preparing account number conversion...';
		return `<div class="accnr-progress-summary" role="status" aria-live="polite">
			<strong>${progress.completed} of ${progress.total} field stages completed (${percent}%)</strong>
			<progress max="100" value="${percent}" aria-label="Account conversion stages completed"></progress>
			<p>${this._escapeHtml(current)}</p>
		</div>`;
	}

	_getConversionRowsHtml() {
		const stages = this._conversionProgress?.stages;
		return this._tables.map(([table, fields]) => {
			const tableStages = fields.map(field => stages?.find(stage => stage.id === `${table}.${field}`));
			const completed = tableStages.filter(stage => stage?.status === 'completed').length;
			const active = tableStages.some(stage => stage?.status === 'running');
			const failed = tableStages.some(stage => stage?.status === 'failed');
			const interrupted = tableStages.some(stage => stage?.status === 'interrupted');
			const status = failed ? 'Failed' : interrupted ? 'Interrupted' : active ? 'Converting...' : completed === fields.length ? 'Completed' : stages ? 'Waiting' : 'Not started';
			const className = failed || interrupted ? 'failed' : active ? 'running' : completed === fields.length ? 'completed' : 'pending';
			const labels = { pending: 'Waiting', running: 'Converting', completed: 'Done', failed: 'Failed', interrupted: 'Interrupted' };
			const fieldHtml = stages ? fields.map((field, index) => {
				const stageStatus = tableStages[index]?.status || 'pending';
				return `<span class="accnr-field-status accnr-field-${stageStatus}"><code>${field}</code>: ${labels[stageStatus]}</span>`;
			}).join(' ') : fields.join(', ');
			return `<tr class="accnr-table-${className}"><td>${table}</td><td>${fieldHtml}</td>
				<td><span>${status}</span>${stages ? `<progress max="${fields.length}" value="${completed}" aria-label="${table} fields completed"></progress><small>${completed} / ${fields.length} fields</small>` : ''}</td></tr>`;
		}).join('');
	}

	_updateConversionProgress(event) {
		this._conversionProgress = { completed: event.completed, total: event.total, stages: event.stages };
		const summary = document.getElementById('accnr-conversion-progress');
		if (summary) summary.innerHTML = this._getConversionProgressHtml();
		const rows = document.getElementById('accnr-conversion-rows');
		if (rows) rows.innerHTML = this._getConversionRowsHtml();
	}

	_render(state, detail) {
		const container = document.getElementById('accnr-convert-content');
		if (!container) return;

		const statusHtml = this._getStatusHtml(state, detail);
		const isBusy = state === 'rebuild-running' || state === 'conversion-running';
		const isRebuilding = state === 'rebuild-running';
		const isConverting = state === 'conversion-running';
		const rebuildStatus = this._glRebuilt
			? 'Done for this plan.'
			: 'Not marked done in this wizard. Run it here if you have not already rebuilt GL accounts.';

		container.innerHTML = `
			<div class="step-header">
				<h2>Step 5: Convert Account Numbers</h2>
				<p class="hint">
					During migration, transactional tables were written with the original Firebird account numbers.
					This step updates <code>acc</code>, <code>accnr</code>, <code>accasset</code>, and <code>siid</code>
					fields across all affected tables to match the new 4-digit GL account numbers created by Rebuild GL Accounts.
				</p>
				<p class="hint">
					<strong>Prerequisite:</strong> Rebuild GL Accounts must have been run before conversion.
					Use the rebuild option below before converting account numbers.
				</p>
			</div>

			${statusHtml}

			<div class="step-section">
				<h3>1. Rebuild GL Accounts</h3>
				<p class="hint">
					Truncates and recreates <code>gl_accounts</code> from the migrated staging <code>accounts</code> table.
					Run this before converting transactional account numbers.
				</p>
				<p class="hint"><strong>Rebuild status:</strong> ${rebuildStatus}</p>
				<label class="inline-label">
					<input id="accnr-rebuild-wipe-journals" type="checkbox" ${isBusy ? 'disabled' : ''} />
					Also truncate <code>gl_journal_headers</code> and <code>gl_journal_lines</code>
				</label>
				<div class="step-actions">
					<button id="btn-rebuild-gl-before-convert" class="btn secondary" type="button"
						${isBusy ? 'disabled' : ''}>
						${isRebuilding ? 'Rebuilding...' : 'Rebuild GL Accounts'}
					</button>
				</div>
			</div>

			<div class="step-section">
				<h3>2. Convert Account Numbers</h3>
				<p class="hint">
					Updates transactional account references after <code>gl_accounts</code> has been rebuilt.
				</p>
				<div id="accnr-conversion-progress">${this._getConversionProgressHtml()}</div>
				<div class="accnr-table-scroll"><table class="info-table accnr-conversion-table">
					<thead><tr><th>Table</th><th>Fields converted</th><th>Progress</th></tr></thead>
					<tbody id="accnr-conversion-rows">${this._getConversionRowsHtml()}</tbody>
				</table></div>
			</div>

			<div class="step-actions">
				<button id="btn-convert-accnr" class="btn primary" type="button"
					${isBusy ? 'disabled' : ''}>
					${isConverting ? 'Converting...' : 'Convert Account Numbers'}
				</button>
				<p class="hint" style="margin-top: 0.5rem;">
					This operation is idempotent - safe to run more than once.
					Click <strong>Next</strong> to skip if already done or not required.
				</p>
			</div>
		`;

		const rebuildBtn = container.querySelector('#btn-rebuild-gl-before-convert');
		if (rebuildBtn) {
			rebuildBtn.addEventListener('click', () => this._runRebuild());
		}

		const convertBtn = container.querySelector('#btn-convert-accnr');
		if (convertBtn) {
			convertBtn.addEventListener('click', () => this._runConversion());
		}
	}

	async _confirmRebuild() {
		const message = 'This will truncate and recreate gl_accounts from staging accounts. Continue?';
		if (window.Modal && typeof window.Modal.confirm === 'function') {
			return window.Modal.confirm({
				title: 'Rebuild GL Accounts',
				message,
				type: 'warning',
				confirmText: 'Rebuild',
				cancelText: 'Cancel'
			});
		}

		return window.confirm(message);
	}

	async _runRebuild() {
		if (this._busy) return;
		const wipeJournals = !!document.getElementById('accnr-rebuild-wipe-journals')?.checked;
		const ok = await this._confirmRebuild();
		if (!ok || this._busy) return;

		this._setBusy(true);
		this._render('rebuild-running');

		try {
			const response = await fetch('/api/tools/rebuild-gl', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ truncateJournals: wipeJournals })
			});

			const data = await response.json().catch(() => ({}));

			if (!response.ok || data.success === false) {
				const msg = data?.message || `Request failed (${response.status})`;
				this._render('rebuild-error', msg);
				return;
			}

			this._glRebuilt = true;
			const plan = this.state?.get('plan') || {};
			if (plan.id) {
				this.state.set('run.glRebuildPlanId', plan.id);
			}
			this._render('rebuild-success', this._summarizeRebuild(data));
		} catch (err) {
			this._render('rebuild-error', err.message || String(err));
		} finally {
			this._setBusy(false);
		}
	}

	async _runConversion() {
		if (this._busy) return;
		this._setBusy(true);
		this._converted = false;
		this._conversionProgress = { completed: 0, total: this._tables.reduce((sum, [, fields]) => sum + fields.length, 0), stages: [] };
		this._render('conversion-running');

		try {
			const response = await fetch('/api/tools/convert-transactional-accnr', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/x-ndjson' },
				body: JSON.stringify({})
			});

			if (!response.ok || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
				const data = await response.json().catch(() => ({}));
				if (!response.ok || data.success !== true) throw new Error(data.message || `Request failed (${response.status})`);
				// Supports a server still returning the older JSON response during deployment.
				this._updateConversionProgress({ completed: this._conversionProgress.total, total: this._conversionProgress.total,
					stages: this._tables.flatMap(([table, fields]) => fields.map(field => ({ id: `${table}.${field}`, status: 'completed' }))) });
			} else {
				await this._readConversionStream(response);
			}

			this._converted = true;
			this._render('conversion-success', 'All transactional account number fields have been updated.');
		} catch (err) {
			this._conversionProgress.interrupted = true;
			for (const stage of this._conversionProgress.stages) {
				if (stage.status === 'running') stage.status = 'interrupted';
			}
			this._render('conversion-error', err.message || String(err));
		} finally {
			this._setBusy(false);
		}
	}

	async _readConversionStream(response) {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let complete = false;
		const receive = line => {
			if (!line.trim()) return;
			const event = JSON.parse(line);
			if (event.type === 'progress' || event.type === 'complete') this._updateConversionProgress(event);
			if (event.type === 'error') throw new Error(event.message || 'Account number conversion failed');
			if (event.type === 'complete') complete = true;
		};
		try {
			while (true) {
				const { done, value } = await reader.read();
				buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
				let newline;
				while ((newline = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					receive(line);
				}
				if (done) break;
			}
			receive(buffer);
			if (!complete) throw new Error('Progress connection ended before completion. The conversion may still be running on the server.');
		} finally {
			reader.releaseLock();
		}
	}

	async onNext() {
		// Conversion may be skipped when no operation is running.
		return !this._busy;
	}

	async onPrevious() {
		return !this._busy;
	}
}

window.AccnrConvertUI = AccnrConvertUI;
