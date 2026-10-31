(function () {
	const buttons = document.querySelectorAll('[data-action="view-results"]');
	const logButtons = document.querySelectorAll('[data-action="view-log"]');
	if (!buttons.length && !logButtons.length) return;

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

	const viewLogs = async (runId) => {
		const { logs, total } = await runApi.getFullLog(runId);
		window.LogViewer.open(logs, { runId, total });
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
					// No handlers: the history modal is summary-only (logs open from the row's "View log" button)
					window.ResultsRenderer.render(modalContent, { run, summary, errors }, {});
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

	logButtons.forEach((btn) => {
		btn.addEventListener('click', async () => {
			const runId = btn.getAttribute('data-run-id');
			if (!runId) return;
			setLoading(btn, true);
			try {
				await viewLogs(runId);
			} catch (err) {
				console.error('Failed to load log:', err);
				alert(`Failed to load log: ${err.message || err}`);
			} finally {
				setLoading(btn, false);
			}
		});
	});
})();
