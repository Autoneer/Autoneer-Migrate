/**
 * PlanAPI - Wrapper for /api/plans endpoints
 * 
 * Provides methods for creating, retrieving, and managing migration plans.
 */
class PlanAPI {
	constructor(client) {
		this.client = client || window.apiClient;
	}

	/**
	 * List all migration plans
	 * @param {Object} options - Query options
	 * @param {number} options.page - Page number
	 * @param {number} options.limit - Items per page
	 * @param {string} options.mappingId - Filter by mapping ID
	 * @returns {Promise<Object>} { plans: Array, total: number, page: number }
	 */
	async list(options = {}) {
		const response = await this.client.get('/plans', options);
		return response;
	}

	/**
	 * Get plan by ID
	 * @param {string} id - Plan ID
	 * @returns {Promise<Object>} Plan object
	 */
	async getById(id) {
		const response = await this.client.get(`/plans/${id}`);
		return response.plan;
	}

	/**
	 * Get latest plan
	 * @returns {Promise<Object|null>} Most recent plan or null
	 */
	async getLatest() {
		try {
			const response = await this.client.get('/plans/latest');
			return response.plan || null;
		} catch (err) {
			if (err.status === 404) return null;
			throw err;
		}
	}

	/**
	 * Create new migration plan
	 * @param {Object} plan - Plan configuration
	 * @param {string} plan.name - Plan name
	 * @param {string} plan.mappingId - Associated mapping ID
	 * @param {Array} plan.tables - Tables to migrate
	 * @param {Object} plan.config - Migration configuration
	 * @returns {Promise<Object>} Created plan with ID
	 */
	async create(plan) {
		const response = await this.client.post('/plans', plan);

		// Cache in localStorage
		if (response.plan) {
			window.WizardStorage.savePlan(response.plan);
		}

		return response.plan;
	}

	/**
	 * Update existing plan
	 * @param {string} id - Plan ID
	 * @param {Object} updates - Partial plan updates
	 * @returns {Promise<Object>} Updated plan
	 */
	async update(id, updates) {
		const response = await this.client.put(`/plans/${id}`, updates);

		// Update cache
		if (response.plan) {
			window.WizardStorage.savePlan(response.plan);
		}

		return response.plan;
	}

	/**
	 * Delete migration plan
	 * @param {string} id - Plan ID
	 * @returns {Promise<Object>} Success response
	 */
	async delete(id) {
		const response = await this.client.delete(`/plans/${id}`);

		// Clear from cache if it's the current one
		const cached = window.WizardStorage.getPlan();
		if (cached?.id === id) {
			window.WizardStorage.clearPlan();
		}

		return response;
	}

	/**
	 * Validate migration plan
	 * @param {Object} plan - Plan to validate
	 * @returns {Promise<Object>} { valid: boolean, errors: Array, warnings: Array }
	 */
	async validate(plan) {
		const response = await this.client.post('/plans/validate', plan);
		return response.validation;
	}

	/**
	 * Generate plan from mapping
	 * @param {string} mappingId - Mapping ID
	 * @param {Object} options - Plan generation options
	 * @returns {Promise<Object>} Generated plan
	 */
	async generate(mappingId, options = {}) {
		const response = await this.client.post('/plans/generate', {
			mappingId,
			options
		});
		return response.plan;
	}

	/**
	 * Perform dry-run simulation of migration plan
	 * @param {string} id - Plan ID
	 * @param {Object} options - Dry-run options
	 * @returns {Promise<Object>} Simulation results
	 */
	async dryRun(id, options = {}) {
		const response = await this.client.post(`/plans/${id}/dry-run`, options);
		return response.results;
	}

	/**
	 * Get estimated migration time and resources
	 * @param {string} id - Plan ID
	 * @returns {Promise<Object>} Estimation data
	 */
	async estimate(id) {
		const response = await this.client.get(`/plans/${id}/estimate`);
		return response.estimate;
	}

	/**
	 * Clone existing plan
	 * @param {string} id - Plan ID to clone
	 * @param {string} newName - Name for cloned plan
	 * @returns {Promise<Object>} Cloned plan
	 */
	async clone(id, newName) {
		const response = await this.client.post(`/plans/${id}/clone`, { name: newName });
		return response.plan;
	}

	/**
	 * Get plan dependencies (required tables, mappings, etc.)
	 * @param {string} id - Plan ID
	 * @returns {Promise<Object>} Dependency information
	 */
	async getDependencies(id) {
		const response = await this.client.get(`/plans/${id}/dependencies`);
		return response.dependencies;
	}

	/**
	 * Get plan execution history
	 * @param {string} id - Plan ID
	 * @returns {Promise<Array>} Execution history
	 */
	async getHistory(id) {
		const response = await this.client.get(`/plans/${id}/history`);
		return response.history || [];
	}

	/**
	 * Export plan as JSON
	 * @param {string} id - Plan ID
	 * @returns {Promise<Object>} Plan JSON
	 */
	async export(id) {
		const response = await this.client.get(`/plans/${id}/export`);
		return response.plan;
	}

	/**
	 * Import plan from JSON
	 * @param {Object} planData - Plan JSON data
	 * @returns {Promise<Object>} Imported plan
	 */
	async import(planData) {
		const response = await this.client.post('/plans/import', planData);
		return response.plan;
	}

	/**
	 * Search plans
	 * @param {string} query - Search query
	 * @returns {Promise<Array>} Matching plans
	 */
	async search(query) {
		const response = await this.client.get('/plans/search', { q: query });
		return response.plans || [];
	}

	/**
	 * Get plan statistics
	 * @param {string} id - Plan ID
	 * @returns {Promise<Object>} Plan statistics
	 */
	async getStats(id) {
		const response = await this.client.get(`/plans/${id}/stats`);
		return response.stats;
	}
}

// Export to window
window.PlanAPI = new PlanAPI();
