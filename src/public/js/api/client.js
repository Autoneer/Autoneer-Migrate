/**
 * APIClient - Base HTTP client with retry logic and error handling
 * 
 * Provides a wrapper around fetch with automatic retry on failure,
 * request/response logging, and standardized error handling.
 */
class APIClient {
	constructor(baseURL = '/api') {
		this.baseURL = baseURL;
		this.defaultOptions = {
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			credentials: 'same-origin'
		};
		this.maxRetries = 3;
		this.retryDelay = 1000; // ms
		this.timeout = 30000; // 30 seconds
	}

	/**
	 * Make HTTP request with retry logic
	 * @param {string} endpoint - API endpoint path
	 * @param {Object} options - Fetch options
	 * @returns {Promise<Object>} Response data
	 */
	async request(endpoint, options = {}) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseURL}${endpoint}`;
		const requestTimeout = options.timeout ?? this.timeout;
		const maxRetries = options.maxRetries ?? this.maxRetries;
		const { timeout: _t, maxRetries: _r, ...fetchOptions } = options;
		const config = {
			...this.defaultOptions,
			...fetchOptions,
			headers: {
				...this.defaultOptions.headers,
				...(fetchOptions.headers || {})
			}
		};

		let lastError;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const response = await this._fetchWithTimeout(url, config, requestTimeout);
				return await this._handleResponse(response);
			} catch (err) {
				lastError = err;

				// Don't retry on client errors (4xx)
				if (err.status >= 400 && err.status < 500) {
					throw err;
				}

				// Retry on network errors or 5xx errors
				if (attempt < maxRetries) {
					console.warn(`Request failed (attempt ${attempt}/${maxRetries}), retrying...`, err);
					await this._delay(this.retryDelay * attempt);
				}
			}
		}

		throw lastError;
	}

	/**
	 * Fetch with timeout
	 * @private
	 */
	async _fetchWithTimeout(url, options, timeout = this.timeout) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(url, {
				...options,
				signal: controller.signal
			});
			clearTimeout(timeoutId);
			return response;
		} catch (err) {
			clearTimeout(timeoutId);
			if (err.name === 'AbortError') {
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			throw err;
		}
	}

	/**
	 * Handle HTTP response
	 * @private
	 */
	async _handleResponse(response) {
		const contentType = response.headers.get('content-type');
		const isJSON = contentType && contentType.includes('application/json');

		// Parse response body
		let data;
		try {
			data = isJSON ? await response.json() : await response.text();
		} catch (err) {
			console.warn('Failed to parse response body:', err);
			data = null;
		}

		// Handle HTTP errors
		if (!response.ok) {
			const error = new Error(data?.message || data?.error || `HTTP ${response.status}: ${response.statusText}`);
			error.status = response.status;
			error.statusText = response.statusText;
			error.data = data;
			throw error;
		}

		return data;
	}

	/**
	 * Delay utility for retry logic
	 * @private
	 */
	_delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * GET request
	 * @param {string} endpoint - API endpoint
	 * @param {Object} params - Query parameters
	 * @returns {Promise<Object>} Response data
	 */
	async get(endpoint, params = {}) {
		const queryString = new URLSearchParams(params).toString();
		const url = queryString ? `${endpoint}?${queryString}` : endpoint;

		return this.request(url, {
			method: 'GET'
		});
	}

	/**
	 * POST request
	 * @param {string} endpoint - API endpoint
	 * @param {Object} data - Request body
	 * @returns {Promise<Object>} Response data
	 */
	async post(endpoint, data = {}, options = {}) {
		return this.request(endpoint, {
			method: 'POST',
			body: JSON.stringify(data),
			...options
		});
	}

	/**
	 * PUT request
	 * @param {string} endpoint - API endpoint
	 * @param {Object} data - Request body
	 * @returns {Promise<Object>} Response data
	 */
	async put(endpoint, data = {}) {
		return this.request(endpoint, {
			method: 'PUT',
			body: JSON.stringify(data)
		});
	}

	/**
	 * PATCH request
	 * @param {string} endpoint - API endpoint
	 * @param {Object} data - Request body
	 * @returns {Promise<Object>} Response data
	 */
	async patch(endpoint, data = {}) {
		return this.request(endpoint, {
			method: 'PATCH',
			body: JSON.stringify(data)
		});
	}

	/**
	 * DELETE request
	 * @param {string} endpoint - API endpoint
	 * @returns {Promise<Object>} Response data
	 */
	async delete(endpoint) {
		return this.request(endpoint, {
			method: 'DELETE'
		});
	}

	/**
	 * Upload file (multipart/form-data)
	 * @param {string} endpoint - API endpoint
	 * @param {FormData} formData - Form data with files
	 * @returns {Promise<Object>} Response data
	 */
	async upload(endpoint, formData) {
		return this.request(endpoint, {
			method: 'POST',
			headers: {
				// Don't set Content-Type - browser will set it with boundary
			},
			body: formData
		});
	}

	/**
	 * Stream request with progress tracking
	 * @param {string} endpoint - API endpoint
	 * @param {Function} onProgress - Progress callback (loaded, total)
	 * @returns {Promise<Object>} Response data
	 */
	async stream(endpoint, onProgress) {
		const url = endpoint.startsWith('http') ? endpoint : `${this.baseURL}${endpoint}`;

		const response = await fetch(url, {
			...this.defaultOptions,
			method: 'GET'
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const contentLength = response.headers.get('content-length');
		const total = contentLength ? parseInt(contentLength, 10) : 0;

		const reader = response.body.getReader();
		const chunks = [];
		let loaded = 0;

		while (true) {
			const { done, value } = await reader.read();

			if (done) break;

			chunks.push(value);
			loaded += value.length;

			if (onProgress) {
				onProgress(loaded, total);
			}
		}

		const blob = new Blob(chunks);
		const text = await blob.text();

		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
}

/**
 * API Error class
 */
class APIError extends Error {
	constructor(message, status, data) {
		super(message);
		this.name = 'APIError';
		this.status = status;
		this.data = data;
	}

	/**
	 * Check if error is client error (4xx)
	 */
	isClientError() {
		return this.status >= 400 && this.status < 500;
	}

	/**
	 * Check if error is server error (5xx)
	 */
	isServerError() {
		return this.status >= 500;
	}

	/**
	 * Get user-friendly error message
	 */
	getUserMessage() {
		if (this.status === 400) return 'Invalid request. Please check your input.';
		if (this.status === 401) return 'Authentication required. Please log in.';
		if (this.status === 403) return 'You don\'t have permission to perform this action.';
		if (this.status === 404) return 'The requested resource was not found.';
		if (this.status === 409) return 'A conflict occurred. Please try again.';
		if (this.status === 422) return 'Validation failed. Please check your input.';
		if (this.status === 429) return 'Too many requests. Please slow down.';
		if (this.status >= 500) return 'Server error. Please try again later.';
		return this.message;
	}
}

// Export to window
window.APIClient = APIClient;
window.APIError = APIError;

// Create global instance
window.apiClient = new APIClient('/api');
