/**
 * FormValidator - Client-side validation utilities
 * 
 * Provides real-time form validation with user-friendly error messages
 * and inline field validation feedback.
 */
class FormValidator {
	constructor() {
		this.rules = new Map();
		this.errors = new Map();
	}

	/**
	 * Add validation rule for a field
	 * @param {string} fieldName - Field identifier
	 * @param {Object} rule - Validation rule
	 * @param {Function} rule.validate - Validation function (value) => boolean
	 * @param {string} rule.message - Error message
	 * @param {boolean} rule.required - Is field required
	 */
	addRule(fieldName, rule) {
		if (!this.rules.has(fieldName)) {
			this.rules.set(fieldName, []);
		}
		this.rules.get(fieldName).push(rule);
	}

	/**
	 * Validate a single field
	 * @param {string} fieldName - Field identifier
	 * @param {any} value - Field value
	 * @returns {Object} { valid: boolean, errors: string[] }
	 */
	validateField(fieldName, value) {
		const rules = this.rules.get(fieldName);
		if (!rules) {
			return { valid: true, errors: [] };
		}

		const errors = [];

		for (const rule of rules) {
			// Check if required
			if (rule.required && (value === null || value === undefined || value === '')) {
				errors.push(rule.message || `${fieldName} is required`);
				continue;
			}

			// Skip validation if field is empty and not required
			if (!rule.required && (value === null || value === undefined || value === '')) {
				continue;
			}

			// Run custom validation
			if (rule.validate && typeof rule.validate === 'function') {
				const isValid = rule.validate(value);
				if (!isValid) {
					errors.push(rule.message || `${fieldName} is invalid`);
				}
			}
		}

		if (errors.length > 0) {
			this.errors.set(fieldName, errors);
		} else {
			this.errors.delete(fieldName);
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}

	/**
	 * Validate all fields
	 * @param {Object} formData - Form data object { fieldName: value }
	 * @returns {Object} { valid: boolean, errors: Map<string, string[]> }
	 */
	validateAll(formData) {
		this.errors.clear();

		// Validate all registered fields
		for (const [fieldName, rules] of this.rules.entries()) {
			const value = formData[fieldName];
			this.validateField(fieldName, value);
		}

		return {
			valid: this.errors.size === 0,
			errors: new Map(this.errors)
		};
	}

	/**
	 * Get errors for a specific field
	 * @param {string} fieldName - Field identifier
	 * @returns {string[]} Array of error messages
	 */
	getErrors(fieldName) {
		return this.errors.get(fieldName) || [];
	}

	/**
	 * Check if field has errors
	 * @param {string} fieldName - Field identifier
	 * @returns {boolean} True if field has errors
	 */
	hasErrors(fieldName) {
		return this.errors.has(fieldName);
	}

	/**
	 * Clear errors for a specific field
	 * @param {string} fieldName - Field identifier
	 */
	clearErrors(fieldName) {
		this.errors.delete(fieldName);
	}

	/**
	 * Clear all errors
	 */
	clearAllErrors() {
		this.errors.clear();
	}

	/**
	 * Display inline error message for field
	 * @param {string} fieldName - Field identifier
	 * @param {HTMLElement} element - Input element
	 */
	displayFieldError(fieldName, element) {
		const errors = this.getErrors(fieldName);

		// Remove existing error display
		this.clearFieldError(element);

		if (errors.length === 0) {
			element.classList.remove('error', 'invalid');
			element.classList.add('valid');
			return;
		}

		// Add error class
		element.classList.add('error', 'invalid');
		element.classList.remove('valid');

		// Create error message element
		const errorDiv = document.createElement('div');
		errorDiv.className = 'field-error';
		errorDiv.setAttribute('role', 'alert');
		errorDiv.innerHTML = errors.map(err =>
			`<span class="error-message">⚠ ${err}</span>`
		).join('');

		// Insert after input
		element.parentNode.insertBefore(errorDiv, element.nextSibling);
	}

	/**
	 * Clear inline error display for field
	 * @param {HTMLElement} element - Input element
	 */
	clearFieldError(element) {
		element.classList.remove('error', 'invalid', 'valid');

		// Remove error message if exists
		const errorDiv = element.parentNode.querySelector('.field-error');
		if (errorDiv) {
			errorDiv.remove();
		}
	}

	/**
	 * Display all form errors in a summary
	 * @param {HTMLElement} container - Container element for error summary
	 */
	displayErrorSummary(container) {
		if (this.errors.size === 0) {
			container.innerHTML = '';
			container.style.display = 'none';
			return;
		}

		const errorList = [];
		for (const [fieldName, errors] of this.errors.entries()) {
			errorList.push(...errors.map(err => ({ field: fieldName, message: err })));
		}

		container.innerHTML = `
      <div class="error-summary" role="alert">
        <h3>⚠ Please fix the following errors:</h3>
        <ul>
          ${errorList.map(err =>
			`<li><strong>${err.field}:</strong> ${err.message}</li>`
		).join('')}
        </ul>
      </div>
    `;
		container.style.display = 'block';
	}

	/**
	 * Attach live validation to form inputs
	 * @param {HTMLFormElement} form - Form element
	 */
	attachLiveValidation(form) {
		const inputs = form.querySelectorAll('input, select, textarea');

		inputs.forEach(input => {
			const fieldName = input.name || input.id;
			if (!fieldName || !this.rules.has(fieldName)) return;

			// Validate on blur
			input.addEventListener('blur', () => {
				const value = input.type === 'checkbox' ? input.checked : input.value;
				this.validateField(fieldName, value);
				this.displayFieldError(fieldName, input);
			});

			// Clear error on input
			input.addEventListener('input', () => {
				if (this.hasErrors(fieldName)) {
					const value = input.type === 'checkbox' ? input.checked : input.value;
					const result = this.validateField(fieldName, value);
					if (result.valid) {
						this.clearFieldError(input);
					}
				}
			});
		});
	}

	/**
	 * Reset validator (clear rules and errors)
	 */
	reset() {
		this.rules.clear();
		this.errors.clear();
	}
}

/**
 * Common validation rules
 */
const ValidationRules = {
	required: (message = 'This field is required') => ({
		required: true,
		message
	}),

	minLength: (length, message) => ({
		validate: (value) => value && value.length >= length,
		message: message || `Must be at least ${length} characters`
	}),

	maxLength: (length, message) => ({
		validate: (value) => !value || value.length <= length,
		message: message || `Must be at most ${length} characters`
	}),

	pattern: (regex, message = 'Invalid format') => ({
		validate: (value) => !value || regex.test(value),
		message
	}),

	email: (message = 'Invalid email address') => ({
		validate: (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
		message
	}),

	number: (message = 'Must be a valid number') => ({
		validate: (value) => !value || !isNaN(value),
		message
	}),

	integer: (message = 'Must be a whole number') => ({
		validate: (value) => !value || Number.isInteger(Number(value)),
		message
	}),

	min: (minValue, message) => ({
		validate: (value) => !value || Number(value) >= minValue,
		message: message || `Must be at least ${minValue}`
	}),

	max: (maxValue, message) => ({
		validate: (value) => !value || Number(value) <= maxValue,
		message: message || `Must be at most ${maxValue}`
	}),

	url: (message = 'Invalid URL') => ({
		validate: (value) => {
			if (!value) return true;
			try {
				new URL(value);
				return true;
			} catch {
				return false;
			}
		},
		message
	}),

	custom: (validateFn, message = 'Invalid value') => ({
		validate: validateFn,
		message
	})
};

/**
 * Schema-specific validation helpers
 */
const SchemaValidation = {
	/**
	 * Validate table mapping has required fields
	 */
	tableMapping: (mapping) => {
		const errors = [];

		if (!mapping.sourceTable) {
			errors.push('Source table is required');
		}

		if (!mapping.targetTable) {
			errors.push('Target table is required');
		}

		if (!mapping.columns || Object.keys(mapping.columns).length === 0) {
			errors.push('At least one column mapping is required');
		}

		return {
			valid: errors.length === 0,
			errors
		};
	},

	/**
	 * Validate field mapping
	 */
	fieldMapping: (field) => {
		const errors = [];

		if (!field.sourceColumn) {
			errors.push('Source column is required');
		}

		if (!field.targetColumn) {
			errors.push('Target column is required');
		}

		return {
			valid: errors.length === 0,
			errors
		};
	},

	/**
	 * Validate migration plan
	 */
	migrationPlan: (plan) => {
		const errors = [];

		if (!plan.name || plan.name.trim() === '') {
			errors.push('Plan name is required');
		}

		if (!plan.tables || plan.tables.length === 0) {
			errors.push('At least one table must be selected');
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}
};

// Export to window
window.FormValidator = FormValidator;
window.ValidationRules = ValidationRules;
window.SchemaValidation = SchemaValidation;
