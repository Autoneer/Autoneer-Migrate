(function () {
	const buttons = document.querySelectorAll('[data-action="view-results"]');
	if (!buttons || !buttons.length) return;

	const apiClient = window.apiClient || new APIClient();
	if (!window.apiClient) window.apiClient = apiClient;
	const runApi = window.RunAPI || new RunAPI(apiClient);

	const modal = document.getElementById('results-modal');
	const modalContent = document.getElementById('results-modal-content');

	const setLoading = (btn, loading) => {
		if (!btn) return;
		btn.disabled = loading;
		btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
		btn.textContent = loading ? 'Loading…' : btn.dataset.originalText;
	};

	const openModal = () => {
		if (window.ResultsModal && typeof window.ResultsModal.open === 'function') {
			window.ResultsModal.open();
			return;
		}
		if (!modal) return;
		modal.style.display = 'flex';
		modal.setAttribute('aria-hidden', 'false');
	};

	const createLogModal = (title, content) => {
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `
			<div class="modal-dialog">
				<div class="modal-header">
					<h3>${title}</h3>
					<button class="modal-close" type="button">×</button>
				</div>
				<div class="modal-body">${content}</div>
				<div class="modal-footer">
					<button class="btn btn-secondary" type="button">Close</button>
				</div>
			</div>
		`;
		const close = () => overlay.remove();
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) close();
		});
		const closeBtn = overlay.querySelector('.modal-close');
		if (closeBtn) closeBtn.addEventListener('click', close);
		const footerBtn = overlay.querySelector('.modal-footer .btn');
		if (footerBtn) footerBtn.addEventListener('click', close);
		return overlay;
	};

	const downloadReport = async (runId, format) => {
		const data = await runApi.export(runId, format);
		const blob = new Blob(
			[format === 'json' ? JSON.stringify(data, null, 2) : data],
			{ type: format === 'json' ? 'application/json' : 'text/csv' }
		);
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `migration-report-${runId}.${format}`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const viewLogs = async (runId) => {
		const logs = await runApi.getLogs(runId);
		const content = `
			<div class="log-viewer">
				<pre class="log-content">${(logs || []).map(log => {
			const timestamp = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '--:--:--';
			const level = String(log.level || 'info').toUpperCase().padEnd(7);
			return `[${timestamp}] ${level} ${log.message || log.status || ''}`;
		}).join('\n')}</pre>
			</div>
		`;
		const overlay = createLogModal('Migration Logs', content);
		document.body.appendChild(overlay);
	};

	buttons.forEach((btn) => {
		btn.addEventListener('click', async () => {
			const runId = btn.getAttribute('data-run-id');
			if (!runId) return;
			setLoading(btn, true);
			try {
				const run = await runApi.getById(runId);
				const summary = await runApi.getSummary(runId);
				let errors = [];
				if (String(run.status || '').toUpperCase() === 'FAILED' || (summary?.errorCount || 0) > 0) {
					errors = await runApi.getErrors(runId);
				}

				if (window.ResultsRenderer && typeof window.ResultsRenderer.render === 'function' && modalContent) {
					window.ResultsRenderer.render(modalContent, { run, summary, errors }, {
						onDownload: (format) => downloadReport(runId, format),
						onViewLogs: () => viewLogs(runId),
						onStartNew: () => { window.location.href = '/wizard'; }
					});
				}

				openModal();
			} catch (err) {
				console.error('Failed to load results:', err);
				alert(`Failed to load results: ${err.message || err}`);
			} finally {
				setLoading(btn, false);
			}
		});
	});
})();
