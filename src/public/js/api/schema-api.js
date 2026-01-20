/**
 * SchemaAPI - Wrapper for /api/schemas endpoints
 * 
 * Provides methods for schema discovery, caching, and retrieval.
 */
class SchemaAPI {
	constructor(client) {
		this.client = client || window.apiClient;
	}

	/**
	 * Get cached schema data
	 * @param {number} maxAge - Maximum cache age in ms (default 1 hour)
	 * @returns {Promise<Object>} Cached schema or null
	 */
	async getCached(maxAge = 3600000) {
		try {
			const response = await this.client.get('/schemas/cached', { maxAge });
			return response.schema || null;
		} catch (err) {
			console.error('Failed to get cached schema:', err);
			return null;
		}
	}

	/**
	 * Discover schemas from connected databases
	 * @returns {Promise<Object>} Discovered schema data
	 */
	async discover() {
		const response = await this.client.post('/schemas/discover');

		// Cache in localStorage
		if (response.schema) {
			window.WizardStorage.saveSchema(response.schema);
		}

		return response.schema;
	}

	/**
	 * Refresh schema discovery (force re-scan)
	 * @returns {Promise<Object>} Fresh schema data
	 */
	async refresh() {
		const response = await this.client.post('/schemas/refresh');

		// Update cache
		if (response.schema) {
			window.WizardStorage.saveSchema(response.schema);
		}

		return response.schema;
	}

	/**
	 * Get schema for specific database type
	 * @param {string} dbType - Database type (firebird or mysql)
	 * @returns {Promise<Object>} Schema for specified database
	 */
	async getByType(dbType) {
		const response = await this.client.get(`/schemas/${dbType}`);
		return response.schema;
	}

	/**
	 * Get table metadata
	 * @param {string} dbType - Database type (firebird or mysql)
	 * @param {string} tableName - Table name
	 * @returns {Promise<Object>} Table metadata
	 */
	async getTable(dbType, tableName) {
		const response = await this.client.get(`/schemas/${dbType}/tables/${tableName}`);
		return response.table;
	}

	/**
	 * Get column metadata for a table
	 * @param {string} dbType - Database type
	 * @param {string} tableName - Table name
	 * @returns {Promise<Array>} Array of column metadata
	 */
	async getColumns(dbType, tableName) {
		const response = await this.client.get(`/schemas/${dbType}/tables/${tableName}/columns`);
		return response.columns || [];
	}

	/**
	 * Clear schema cache
	 * @returns {Promise<Object>} Success response
	 */
	async clearCache() {
		const response = await this.client.delete('/schemas/cache');

		// Also clear localStorage
		window.WizardStorage.clearSchema();

		return response;
	}

	/**
	 * Get schema statistics
	 * @returns {Promise<Object>} Schema statistics
	 */
	async getStats() {
		const response = await this.client.get('/schemas/stats');
		return response.stats;
	}

	/**
	 * Check if schema exists in cache
	 * @returns {Promise<boolean>} True if cached schema exists
	 */
	async hasCache() {
		try {
			const cached = await this.getCached();
			return cached !== null;
		} catch {
			return false;
		}
	}

	/**
	 * Get schema age (time since last discovery)
	 * @returns {Promise<number>} Age in milliseconds
	 */
	async getCacheAge() {
		try {
			const response = await this.client.get('/schemas/cache/age');
			return response.age || 0;
		} catch {
			return Infinity;
		}
	}

	/**
	 * Initialize schema (get cached or discover)
	 * @param {number} maxAge - Maximum cache age in ms
	 * @returns {Promise<Object>} Schema data
	 */
	async initialize(maxAge = 3600000) {
		// Try to get cached schema first
		let schema = await this.getCached(maxAge);

		// If no cache or too old, discover
		if (!schema) {
			schema = await this.discover();
		}

		return schema;
	}

	/**
	 * Run Firebird diagnostic to see what's in the database
	 * @returns {Promise<Object>} Diagnostic information
	 */
	async runFirebirdDiagnostic() {
		const response = await this.client.get('/schemas/firebird/diagnostic');
		return response;
	}

}

// Export to window
window.SchemaAPI = new SchemaAPI();
