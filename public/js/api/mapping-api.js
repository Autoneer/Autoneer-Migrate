/**
 * MappingAPI - Wrapper for /api/mappings endpoints
 * 
 * Provides methods for creating, retrieving, updating, and validating mapping profiles.
 */
class MappingAPI {
	constructor(client) {
		this.client = client || window.apiClient;
	}

	/**
	 * List all mapping profiles
	 * @param {Object} options - Query options
	 * @param {number} options.page - Page number
	 * @param {number} options.limit - Items per page
	 * @returns {Promise<Object>} { mappings: Array, total: number, page: number }
	 */
	async list(options = {}) {
		const response = await this.client.get('/mappings', options);
		return response;
	}

	/**
	 * Get mapping profile by ID
	 * @param {string} id - Mapping ID
	 * @returns {Promise<Object>} Mapping object
	 */
	async getById(id) {
		const response = await this.client.get(`/mappings/${id}`);
		return response.mapping;
	}

	/**
	 * Get latest mapping profile
	 * @returns {Promise<Object|null>} Most recent mapping or null
	 */
	async getLatest() {
		try {
			const response = await this.client.get('/mappings/latest');
			return response.mapping || null;
		} catch (err) {
			if (err.status === 404) return null;
			throw err;
		}
	}

	/**
	 * Create new mapping profile
	 * @param {Object} mapping - Mapping configuration
	 * @param {string} mapping.name - Profile name
	 * @param {Object} mapping.tables - Table mappings { sourceTable: { targetTable, columns: {} } }
	 * @returns {Promise<Object>} Created mapping with ID
	 */
	async create(mapping) {
		const response = await this.client.post('/mappings', mapping);

		// Cache in localStorage
		if (response.mapping) {
			window.WizardStorage.saveMapping(response.mapping);
		}

		return response.mapping;
	}

	/**
	 * Update existing mapping profile
	 * @param {string} id - Mapping ID
	 * @param {Object} updates - Partial mapping updates
	 * @returns {Promise<Object>} Updated mapping
	 */
	async update(id, updates) {
		const response = await this.client.put(`/mappings/${id}`, updates);

		// Update cache
		if (response.mapping) {
			window.WizardStorage.saveMapping(response.mapping);
		}

		return response.mapping;
	}

	/**
	 * Delete mapping profile
	 * @param {string} id - Mapping ID
	 * @returns {Promise<Object>} Success response
	 */
	async delete(id) {
		const response = await this.client.delete(`/mappings/${id}`);

		// Clear from cache if it's the current one
		const cached = window.WizardStorage.getMapping();
		if (cached?.id === id) {
			window.WizardStorage.clearMapping();
		}

		return response;
	}

	/**
	 * Validate mapping configuration
	 * @param {Object} mapping - Mapping to validate
	 * @returns {Promise<Object>} { valid: boolean, errors: Array, warnings: Array }
	 */
	async validate(mapping) {
		const response = await this.client.post('/mappings/validate', mapping);
		return response.validation;
	}

	/**
	 * Auto-generate mapping from schema
	 * @param {Object} schema - Schema object
	 * @param {Object} options - Generation options
	 * @returns {Promise<Object>} Auto-generated mapping
	 */
	async autoGenerate(schema, options = {}) {
		const response = await this.client.post('/mappings/auto-generate', {
			schema,
			options
		});
		return response.mapping;
	}

	/**
	 * Clone existing mapping profile
	 * @param {string} id - Mapping ID to clone
	 * @param {string} newName - Name for cloned mapping
	 * @returns {Promise<Object>} Cloned mapping
	 */
	async clone(id, newName) {
		const response = await this.client.post(`/mappings/${id}/clone`, { name: newName });
		return response.mapping;
	}

	/**
	 * Get mapping suggestions for a table
	 * @param {string} sourceTable - Source table name
	 * @param {Array} targetTables - Available target tables
	 * @returns {Promise<Object>} Mapping suggestions
	 */
	async getSuggestions(sourceTable, targetTables) {
		const response = await this.client.post('/mappings/suggestions', {
			sourceTable,
			targetTables
		});
		return response.suggestions;
	}

	/**
	 * Convert legacy mapping to new format
	 * @param {Object} legacyMapping - Old format mapping
	 * @returns {Promise<Object>} Converted mapping
	 */
	async convertLegacy(legacyMapping) {
		const response = await this.client.post('/mappings/convert-legacy', legacyMapping);
		return response.mapping;
	}

	/**
	 * Test mapping against sample data
	 * @param {Object} mapping - Mapping configuration
	 * @param {number} sampleSize - Number of rows to test
	 * @returns {Promise<Object>} Test results
	 */
	async test(mapping, sampleSize = 10) {
		const response = await this.client.post('/mappings/test', {
			mapping,
			sampleSize
		});
		return response.results;
	}

	/**
	 * Export mapping profile as JSON
	 * @param {string} id - Mapping ID
	 * @returns {Promise<Object>} Mapping JSON
	 */
	async export(id) {
		const response = await this.client.get(`/mappings/${id}/export`);
		return response.mapping;
	}

	/**
	 * Import mapping profile from JSON
	 * @param {Object} mappingData - Mapping JSON data
	 * @returns {Promise<Object>} Imported mapping
	 */
	async import(mappingData) {
		const response = await this.client.post('/mappings/import', mappingData);
		return response.mapping;
	}

	/**
	 * Search mapping profiles
	 * @param {string} query - Search query
	 * @returns {Promise<Array>} Matching mappings
	 */
	async search(query) {
		const response = await this.client.get('/mappings/search', { q: query });
		return response.mappings || [];
	}
}

// Export to window
window.MappingAPI = new MappingAPI();
