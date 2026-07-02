/**
 * WizardState - In-memory session state manager
 * 
 * Manages the current state of the migration wizard including
 * schema data, mapping configuration, migration plan, and UI state.
 * Works in conjunction with WizardStorage for persistence.
 */
class WizardState {
	constructor() {
		this.state = {
			// Current step (1-6)
			currentStep: 1,

			// Schema data from discovery
			schema: null,

			// Mapping configuration
			mapping: {
				id: null,
				mappingProfileId: null,
				name: '',
				tables: {}
			},

			// Migration plan
			plan: {
				id: null,
				name: '',
				tables: [],
				config: {}
			},

			// Execution state
			run: {
				id: null,
				status: 'pending', // pending, running, completed, failed
				progress: 0,
				tableResults: []
			},

			// UI state
			ui: {
				loading: false,
				errors: [],
				warnings: [],
				selectedTable: null,
				expandedSections: []
			}
		};

		// Event listeners for state changes
		this.listeners = new Map();
	}

	/**
	 * Normalize a plan object with defaults and mapping context
	 * @param {Object} plan - Plan to normalize
	 * @param {Object} mapping - Mapping object for defaults
	 * @returns {{ plan: Object, changed: boolean, before: Object }}
	 */
	normalizePlan(plan, mapping) {
		const DEFAULT_PLAN_CONFIG = {
			batchSize: 1000,
			continueOnError: false,
			validateData: true
		};

		const before = JSON.parse(JSON.stringify(plan || {}));
		const normalized = (plan && typeof plan === 'object') ? { ...plan } : {};

		if (!Array.isArray(normalized.tables)) {
			normalized.tables = [];
		}

		normalized.config = {
			...DEFAULT_PLAN_CONFIG,
			...(normalized.config || {})
		};

		if ((!normalized.tables || normalized.tables.length === 0) && mapping && mapping.tables) {
			normalized.tables = Object.keys(mapping.tables || {});
		}

		if (!normalized.name || typeof normalized.name !== 'string' || normalized.name.trim() === '') {
			const baseName = (mapping && mapping.name) ? mapping.name : 'Plan';
			normalized.name = `${baseName} ${new Date().toLocaleDateString()}`;
		}

		if (!normalized.mappingProfileId) {
			if (normalized.mappingId) {
				normalized.mappingProfileId = normalized.mappingId;
				delete normalized.mappingId;
			} else if (mapping && (mapping.mappingProfileId || mapping.id)) {
				normalized.mappingProfileId = mapping.mappingProfileId || mapping.id;
			}
		}

		const changed = JSON.stringify(before) !== JSON.stringify(normalized);
		return { plan: normalized, changed, before };
	}

	/**
	 * Normalize plan in state and persist if changes found
	 * @param {Object} mappingOverride - Optional mapping for defaults
	 * @returns {Object} Normalized plan
	 */
	normalizePlanInState(mappingOverride) {
		const mapping = mappingOverride || this.state.mapping;
		const { plan, changed, before } = this.normalizePlan(this.state.plan, mapping);
		if (changed) {
			this.state.plan = plan;
			this.persistState('plan');
			this.emit('change:plan', this.state.plan);
			console.info('[WizardState] Normalized plan from storage', { before, after: plan });
		}
		return plan;
	}

	/**
	 * Initialize state from localStorage
	 */
	initialize() {
		const storage = window.WizardStorage;

		// Load persisted data
		this.state.schema = storage.getSchema();
		this.state.mapping = storage.getMapping() || this.state.mapping;
		this.state.plan = storage.getPlan() || this.state.plan;
		this.state.currentStep = storage.getCurrentStep();
		this.state.run.id = storage.getRunId();

		const progress = storage.getProgress();
		if (progress) {
			this.state.run.status = progress.status || 'pending';
			this.state.run.progress = progress.progress || 0;
		}

		if (this.state.mapping && !this.state.mapping.mappingProfileId) {
			this.state.mapping.mappingProfileId = this.state.mapping.mappingProfileId || this.state.mapping.profileId || this.state.mapping.id || null;
		}

		this.normalizePlanInState(this.state.mapping);
		this.emit('initialized', this.state);
	}

	/**
	 * Get entire state object
	 * @returns {Object} Current state
	 */
	getState() {
		return { ...this.state };
	}

	/**
	 * Get specific state property
	 * @param {string} path - Dot-notation path (e.g., 'mapping.tables')
	 * @returns {any} Value at path
	 */
	get(path) {
		return path.split('.').reduce((obj, key) => obj?.[key], this.state);
	}

	/**
	 * Set state property and trigger listeners
	 * @param {string} path - Dot-notation path
	 * @param {any} value - New value
	 * @param {boolean} persist - Save to localStorage (default true)
	 */
	set(path, value, persist = true) {
		// Update state
		const keys = path.split('.');
		const lastKey = keys.pop();
		const target = keys.reduce((obj, key) => obj[key], this.state);
		target[lastKey] = value;

		// Persist to localStorage if requested
		if (persist) {
			this.persistState(keys[0]);
		}

		// Notify listeners
		this.emit('change', { path, value });
		this.emit(`change:${path}`, value);
	}

	/**
	 * Persist state section to localStorage
	 * @param {string} section - State section (schema, mapping, plan, run)
	 */
	persistState(section) {
		const storage = window.WizardStorage;

		switch (section) {
			case 'schema':
				storage.saveSchema(this.state.schema);
				break;
			case 'mapping':
				storage.saveMapping(this.state.mapping);
				break;
			case 'plan':
				storage.savePlan(this.state.plan);
				break;
			case 'run':
				if (this.state.run.id) {
					storage.saveRunId(this.state.run.id);
				}
				storage.saveProgress({
					currentStep: this.state.currentStep,
					status: this.state.run.status,
					progress: this.state.run.progress
				});
				break;
			case 'currentStep':
				storage.setCurrentStep(this.state.currentStep);
				break;
		}
	}

	/**
	 * Set current step
	 * @param {number} step - Step number (1-5)
	 */
	setCurrentStep(step) {
		if (step < 1 || step > 6) {
			throw new Error(`Invalid step: ${step}. Must be 1-6.`);
		}

		this.state.currentStep = step;
		window.WizardStorage.setCurrentStep(step);
		this.emit('step:change', step);
	}

	/**
	 * Go to next step
	 */
	nextStep() {
		if (this.state.currentStep < 6) {
			this.setCurrentStep(this.state.currentStep + 1);
		}
	}

	/**
	 * Go to previous step
	 */
	prevStep() {
		if (this.state.currentStep > 1) {
			this.setCurrentStep(this.state.currentStep - 1);
		}
	}

	/**
	 * Check if can proceed to next step (validation)
	 * @returns {Object} { valid: boolean, errors: string[] }
	 */
	canProceed() {
		const step = this.state.currentStep;
		const errors = [];

		switch (step) {
			case 1: // Schema
				if (!this.state.schema) {
					errors.push('Schema not discovered');
				}
				break;

			case 2: // Mapping
				if (!this.state.mapping.name) {
					errors.push('You must supply a Profile Name');
				}
				const tables = this.state.mapping.tables || {};
				if (Object.keys(tables).length === 0) {
					errors.push('You must map at least one table');
				}
				break;

			case 3: // Plan
				if (!this.state.plan?.name || this.state.plan.name.trim() === '') {
					errors.push('You must supply a Plan Name');
				}
				if (!Array.isArray(this.state.plan?.tables) || this.state.plan.tables.length === 0) {
					errors.push('You must select at least one table for migration');
				}
				if (typeof this.state.plan?.config?.batchSize !== 'number' || Number.isNaN(this.state.plan.config.batchSize)) {
					errors.push('You must specify a Plan batch size');
				}
				break;

			case 4: // Run
				if (!this.state.run.id) {
					errors.push('Click "Start Migration" to begin the migration run');
				}
				break;

			case 5: // Convert Acc Numbers — always allow proceeding
				break;
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}

	/**
	 * Set schema data
	 * @param {Object} schema - Schema object
	 */
	setSchema(schema) {
		this.set('schema', schema);
		window.WizardStorage.markStepComplete(1);
	}

	/**
	 * Update mapping configuration
	 * @param {Object} updates - Partial mapping updates
	 */
	updateMapping(updates) {
		// A supplied tables collection is a complete selection. Replacing it is
		// required so deleted/unchecked table keys do not survive in state.
		if (Object.prototype.hasOwnProperty.call(updates, 'tables')) {
			this.state.mapping = {
				...this.state.mapping,
				...updates,
				tables: { ...(updates.tables || {}) }
			};
		} else {
			this.state.mapping = { ...this.state.mapping, ...updates };
		}
		this.persistState('mapping');
		this.emit('change:mapping', this.state.mapping);
	}

	/**
	 * Add table to mapping
	 * @param {string} sourceTable - Source table name
	 * @param {Object} config - Table mapping config
	 */
	addTableMapping(sourceTable, config) {
		this.state.mapping.tables[sourceTable] = config;
		this.persistState('mapping');
		this.emit('mapping:table:add', { sourceTable, config });
	}

	/**
	 * Remove table from mapping
	 * @param {string} sourceTable - Source table name
	 */
	removeTableMapping(sourceTable) {
		delete this.state.mapping.tables[sourceTable];
		this.persistState('mapping');
		this.emit('mapping:table:remove', sourceTable);
	}

	/**
	 * Set migration plan
	 * @param {Object} plan - Plan object
	 */
	setPlan(plan) {
		// Ensure plan.tables is an array of canonical string table names
		if (plan && Array.isArray(plan.tables)) {
			plan.tables = plan.tables.map(t => {
				if (typeof t === 'string') return t.toUpperCase();
				if (t && typeof t === 'object') {
					// Common UI select shapes: { value: 'NAME' } or { targetTable: 'NAME' }
					if (t.value) return String(t.value).toUpperCase();
					if (t.targetTable) return String(t.targetTable).toUpperCase();
					if (t.table) return String(t.table).toUpperCase();
					return JSON.stringify(t).toUpperCase();
				}
				return String(t || '').toUpperCase();
			});
		}
		this.set('plan', plan);
		window.WizardStorage.markStepComplete(3);
	}

	/**
	 * Set run status
	 * @param {string} status - Run status
	 */
	setRunStatus(status) {
		this.state.run.status = status;
		this.persistState('run');
		this.emit('run:status', status);
	}

	/**
	 * Update run progress
	 * @param {number} progress - Progress percentage (0-100)
	 */
	setRunProgress(progress) {
		this.state.run.progress = Math.min(100, Math.max(0, progress));
		this.persistState('run');
		this.emit('run:progress', this.state.run.progress);
	}

	/**
	 * Add UI error
	 * @param {string} message - Error message
	 */
	addError(message) {
		this.state.ui.errors.push({
			message,
			timestamp: Date.now()
		});
		this.emit('ui:error', message);
	}

	/**
	 * Clear UI errors
	 */
	clearErrors() {
		this.state.ui.errors = [];
		this.emit('ui:errors:clear');
	}

	/**
	 * Add UI warning
	 * @param {string} message - Warning message
	 */
	addWarning(message) {
		this.state.ui.warnings.push({
			message,
			timestamp: Date.now()
		});
		this.emit('ui:warning', message);
	}

	/**
	 * Clear UI warnings
	 */
	clearWarnings() {
		this.state.ui.warnings = [];
		this.emit('ui:warnings:clear');
	}

	/**
	 * Set loading state
	 * @param {boolean} loading - Loading state
	 */
	setLoading(loading) {
		this.state.ui.loading = loading;
		this.emit('ui:loading', loading);
	}

	/**
	 * Reset state to initial (clear all data)
	 */
	reset() {
		// Stop any event loops that might read stale data
		this.state.run.id = null;
		this.state.run.status = 'pending';
		this.state.run.progress = 0;
		this.state.run.tableResults = [];

		this.state = {
			currentStep: 1,
			schema: null,
			mapping: { id: null, mappingProfileId: null, name: '', tables: {} },
			plan: { id: null, name: '', tables: [], config: {} },
			run: { id: null, status: 'pending', progress: 0, tableResults: [] },
			ui: { loading: false, errors: [], warnings: [], selectedTable: null, expandedSections: [] }
		};

		window.WizardStorage.clearAll();
		this.emit('reset');
	}

	/**
	 * Subscribe to state changes
	 * @param {string} event - Event name
	 * @param {Function} callback - Callback function
	 * @returns {Function} Unsubscribe function
	 */
	on(event, callback) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, []);
		}
		this.listeners.get(event).push(callback);

		// Return unsubscribe function
		return () => this.off(event, callback);
	}

	/**
	 * Unsubscribe from state changes
	 * @param {string} event - Event name
	 * @param {Function} callback - Callback to remove
	 */
	off(event, callback) {
		const callbacks = this.listeners.get(event);
		if (callbacks) {
			const index = callbacks.indexOf(callback);
			if (index > -1) {
				callbacks.splice(index, 1);
			}
		}
	}

	/**
	 * Emit event to listeners
	 * @param {string} event - Event name
	 * @param {any} data - Event data
	 */
	emit(event, data) {
		const callbacks = this.listeners.get(event);
		if (callbacks) {
			callbacks.forEach(cb => {
				try {
					cb(data);
				} catch (err) {
					console.error(`Error in event listener for ${event}:`, err);
				}
			});
		}
	}
}

// Export as singleton instance
window.WizardState = new WizardState();
