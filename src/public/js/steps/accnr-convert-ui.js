/**
 * AccnrConvertUI - Step 5: Convert Account Numbers
 *
 * Converts legacy Firebird accnr values to the new 4-digit GL account numbers
 * across all transactional tables (acc, accnr, accasset, siid fields).
 *
 * Must run after:
 *   Step 4 (Execute Migration) — all tables migrated
 *   Rebuild GL Accounts        — gl_accounts populated with new accnr values
 *
 * Proceeding without converting is allowed (idempotent, can be run later via GL Tools).
 */
class AccnrConvertUI {
	constructor(wizard) {
		this.wizard = wizard;
		this._converted = false;
	}

	async initialize() {
		this._render('idle');
	}

	_render(state, detail) {
		const container = document.getElementById('accnr-convert-content');
		if (!container) return;

		const statusHtml = state === 'success'
			? `<div class="step-status-banner step-status-success">
				<span class="status-icon">✓</span>
				<span class="status-message">Conversion complete. ${detail || ''}</span>
			</div>`
			: state === 'error'
				? `<div class="step-status-banner step-status-error">
				<span class="status-icon">⚠</span>
				<span class="status-message">Conversion failed: ${detail || 'Unknown error'}</span>
			</div>`
				: '';

		container.innerHTML = `
			<div class="step-header">
				<h2>Step 5: Convert Account Numbers</h2>
				<p class="hint">
					During migration, transactional tables were written with the original Firebird account numbers.
					This step updates <code>acc</code>, <code>accnr</code>, <code>accasset</code>, and <code>siid</code>
					fields across all affected tables to match the new 4-digit GL account numbers created by Rebuild GL Accounts.
				</p>
				<p class="hint">
					<strong>Prerequisite:</strong> Rebuild GL Accounts must have been run before this step.
					You can run Rebuild GL Accounts from the <a href="/gl-tools" target="_blank">GL Tools</a> page if needed.
				</p>
			</div>

			${statusHtml}

			<div class="step-section">
				<h3>Tables affected</h3>
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
					${state === 'running' ? 'disabled' : ''}>
					${state === 'running' ? 'Converting...' : 'Convert Account Numbers'}
				</button>
				<p class="hint" style="margin-top: 0.5rem;">
					This operation is idempotent — safe to run more than once.
					Click <strong>Next</strong> to skip if already done or not required.
				</p>
			</div>
		`;

		const btn = container.querySelector('#btn-convert-accnr');
		if (btn) {
			btn.addEventListener('click', () => this._runConversion());
		}
	}

	async _runConversion() {
		this._render('running');

		try {
			const response = await fetch('/api/tools/convert-transactional-accnr', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});

			const data = await response.json().catch(() => ({}));

			if (!response.ok || data.success === false) {
				const msg = data?.message || `Request failed (${response.status})`;
				this._render('error', msg);
				return;
			}

			this._converted = true;
			this._render('success', 'All transactional account number fields have been updated.');
		} catch (err) {
			this._render('error', err.message || String(err));
		}
	}

	async onNext() {
		// Always allow proceeding — conversion is recommended but not blocking
		return true;
	}

	async onPrevious() {
		return true;
	}
}

window.AccnrConvertUI = AccnrConvertUI;
