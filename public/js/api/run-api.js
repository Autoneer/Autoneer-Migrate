/**
 * RunAPI - Wrapper for /api/runs endpoints
 * 
 * Provides methods for executing migrations and tracking progress.
 */
class RunAPI {
	constructor(client) {
		this.client = client || window.apiClient;
		this.activeRuns = new Map(); // Track active run polling
	}

	/**
	 * List all migration runs
	 * @param {Object} options - Query options
	 * @param {number} options.page - Page number
	 * @param {number} options.limit - Items per page
	 * @param {string} options.planId - Filter by plan ID
	 * @param {string} options.status - Filter by status
	 * @returns {Promise<Object>} { runs: Array, total: number, page: number }
	 */
	async list(options = {}) {
		const response = await this.client.get('/runs', options);
		return response;
	}

	/**
	 * Get run by ID
	 * @param {string} id - Run ID
	 * @returns {Promise<Object>} Run object with detailed information
	 */
	async getById(id) {
		const response = await this.client.get(`/runs/${id}`);
		return response.run;
	}

	/**
	 * Get latest run
	 * @returns {Promise<Object|null>} Most recent run or null
	 */
	async getLatest() {
		try {
			const response = await this.client.get('/runs/latest');
			return response.run || null;
		} catch (err) {
			if (err.status === 404) return null;
			throw err;
		}
	}

	/**
	 * Start new migration run
	 * @param {string} planId - Plan ID to execute
	 * @param {Object} options - Execution options
	 * @param {boolean} options.dryRun - Dry run mode
	 * @param {Array} options.tables - Specific tables to migrate (optional)
	 * @returns {Promise<Object>} Started run object
	 */
	async start(planId, options = {}) {
		const response = await this.client.post('/runs', {
			planId,
			...options
		});

		// Save run ID
		if (response.run?.id) {
			window.WizardStorage.saveRunId(response.run.id);
		}

		return response.run;
	}

	/**
	 * Get real-time progress for a run
	 * @param {string} id - Run ID
	 * @returns {Promise<Object>} Progress data
	 */
	async getProgress(id) {
		const response = await this.client.get(`/runs/${id}/progress`);
		return response.progress;
	}

	/**
	 * Get table-level results for a run
	 * @param {string} id - Run ID
	 * @returns {Promise<Array>} Array of table results
	 */
	async getTableResults(id) {
		const response = await this.client.get(`/runs/${id}/tables`);
		return response.tables || [];
	}

	/**
	 * Get summary statistics for a run
	 * @param {string} id - Run ID
	 * @returns {Promise<Object>} Summary statistics
	 */
	async getSummary(id) {
		const response = await this.client.get(`/runs/${id}/summary`);
		return response.summary;
	}

	/**
	 * Stop a running migration
	 * @param {string} id - Run ID
	 * @returns {Promise<Object>} Stop response
	 */
	async stop(id) {
		const response = await this.client.post(`/runs/${id}/stop`);

		// Stop polling if active
		if (this.activeRuns.has(id)) {
			this.stopPolling(id);
		}

		return response;
	}

	/**
	 * Retry failed tables in a run
	 * @param {string} id - Run ID
	 * @param {Array} tables - Table names to retry (optional, retries all failed if omitted)
	 * @returns {Promise<Object>} Retry response
	 */
	async retry(id, tables = null) {
		const response = await this.client.post(`/runs/${id}/retry`, { tables });
		return response;
	}

	/**
	 * Delete migration run
	 * @param {string} id - Run ID
	 * @returns {Promise<Object>} Success response
	 */
	async delete(id) {
		const response = await this.client.delete(`/runs/${id}`);

		// Clear from cache if it's the current one
		const cachedId = window.WizardStorage.getRunId();
		if (cachedId === id) {
			window.WizardStorage.clearAll();
		}

		return response;
	}

	/**
	 * Get logs for a run
	 * @param {string} id - Run ID
	 * @param {Object} options - Log query options
	 * @returns {Promise<Array>} Log entries
	 */
	async getLogs(id, options = {}) {
		const response = await this.client.get(`/runs/${id}/logs`, options);
		return response.logs || [];
	}

	/**
	 * Get errors for a run
	 * @param {string} id - Run ID
	 * @returns {Promise<Array>} Error details
	 */
	async getErrors(id) {
		const response = await this.client.get(`/runs/${id}/errors`);
		return response.errors || [];
	}

	/**
	 * Export run results as JSON/CSV
	 * @param {string} id - Run ID
	 * @param {string} format - Export format (json or csv)
	 * @returns {Promise<Object>} Export data
	 */
	async export(id, format = 'json') {
		const response = await this.client.get(`/runs/${id}/export`, { format });
		return response;
	}

	/**
	 * Poll run progress at regular intervals
	 * @param {string} id - Run ID
	 * @param {Function} onProgress - Progress callback (progress) => void
	 * @param {number} interval - Poll interval in ms (default 2000)
	 * @returns {Object} { stop: Function } - Object with stop function
	 */
	pollProgress(id, onProgress, interval = 2000) {
		// Stop any existing polling for this run
		if (this.activeRuns.has(id)) {
			this.stopPolling(id);
		}

		const poll = async () => {
			try {
				const progress = await this.getProgress(id);
				onProgress(progress);

				// Stop polling if run is complete
				if (progress.status === 'completed' || progress.status === 'failed') {
					this.stopPolling(id);
				}
			} catch (err) {
				console.error('Poll error:', err);
				// Continue polling even on error
			}
		};

		// Initial poll
		poll();

		// Set up interval
		const timerId = setInterval(poll, interval);
		this.activeRuns.set(id, timerId);

		// Return stop function
		return {
			stop: () => this.stopPolling(id)
		};
	}

	/**
	 * Stop polling for a run
	 * @param {string} id - Run ID
	 */
	stopPolling(id) {
		const timerId = this.activeRuns.get(id);
		if (timerId) {
			clearInterval(timerId);
			this.activeRuns.delete(id);
		}
	}

	/**
	 * Stop all active polling
	 */
	stopAllPolling() {
		for (const timerId of this.activeRuns.values()) {
			clearInterval(timerId);
		}
		this.activeRuns.clear();
	}

	/**
	 * Stream run progress (SSE)
	 * @param {string} id - Run ID
	 * @param {Object} handlers - Event handlers
	 * @param {Function} handlers.onProgress - Progress event handler
	 * @param {Function} handlers.onComplete - Completion event handler
	 * @param {Function} handlers.onError - Error event handler
	 * @returns {Object} { stop: Function } - Object with stop function
	 */
	streamProgress(id, handlers = {}) {
		const eventSource = new EventSource(`/api/runs/${id}/stream`);

		eventSource.addEventListener('progress', (event) => {
			const data = JSON.parse(event.data);
			if (handlers.onProgress) handlers.onProgress(data);
		});

		eventSource.addEventListener('complete', (event) => {
			const data = JSON.parse(event.data);
			if (handlers.onComplete) handlers.onComplete(data);
			eventSource.close();
		});

		eventSource.addEventListener('error', (event) => {
			if (handlers.onError) handlers.onError(event);
			eventSource.close();
		});

		return {
			stop: () => eventSource.close()
		};
	}

	/**
	 * Get run statistics
	 * @param {string} id - Run ID
	 * @returns {Promise<Object>} Detailed statistics
	 */
	async getStats(id) {
		const response = await this.client.get(`/runs/${id}/stats`);
		return response.stats;
	}

	/**
	 * Search runs
	 * @param {string} query - Search query
	 * @returns {Promise<Array>} Matching runs
	 */
	async search(query) {
		const response = await this.client.get('/runs/search', { q: query });
		return response.runs || [];
	}
}

// Export to window
window.RunAPI = new RunAPI();
