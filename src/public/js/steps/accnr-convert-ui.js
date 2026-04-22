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
	}

	async initialize() {
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
				message: 'Converting transactional account numbers...'
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
				<table class="info-table">
					<thead><tr><th>Table</th><th>Fields converted</th></tr></thead>
					<tbody>
						<tr><td>customers</td><td>acc</td></tr>
						<tr><td>suppliers</td><td>acc</td></tr>
						<tr><td>invoices</td><td>acc</td></tr>
						<tr><td>invoices_supplier</td><td>acc</td></tr>
						<tr><td>stock</td><td>siid, acc, accasset</td></tr>
						<tr><td>spares_used</td><td>siid, acc, accasset</td></tr>
						<tr><td>work_done</td><td>siid, acc</td></tr>
						<tr><td>payments</td><td>acc</td></tr>
						<tr><td>payments_suppliers</td><td>accnr, acc</td></tr>
						<tr><td>invoice_items</td><td>siid, acc</td></tr>
						<tr><td>labour_pricing</td><td>siid, acc</td></tr>
					</tbody>
				</table>
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
		const wipeJournals = !!document.getElementById('accnr-rebuild-wipe-journals')?.checked;
		const ok = await this._confirmRebuild();
		if (!ok) return;

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
		}
	}

	async _runConversion() {
		this._render('conversion-running');

		try {
			const response = await fetch('/api/tools/convert-transactional-accnr', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});

			const data = await response.json().catch(() => ({}));

			if (!response.ok || data.success === false) {
				const msg = data?.message || `Request failed (${response.status})`;
				this._render('conversion-error', msg);
				return;
			}

			this._converted = true;
			this._render('conversion-success', 'All transactional account number fields have been updated.');
		} catch (err) {
			this._render('conversion-error', err.message || String(err));
		}
	}

	async onNext() {
		// Always allow proceeding. Conversion is recommended but not blocking.
		return true;
	}

	async onPrevious() {
		return true;
	}
}

window.AccnrConvertUI = AccnrConvertUI;
