/**
 * WizardStorage - Persistent localStorage manager for migration wizard
 * 
 * Manages session state across page reloads, providing persistent storage
 * for schema, mappings, plans, and progress information.
 */
class WizardStorage {
	constructor() {
		this.prefix = 'autoneer_wizard_';
		this.keys = {
			SCHEMA: `${this.prefix}schema`,
			MAPPING: `${this.prefix}mapping`,
			PLAN: `${this.prefix}plan`,
			PROGRESS: `${this.prefix}progress`,
			CURRENT_STEP: `${this.prefix}current_step`,
			RUN_ID: `${this.prefix}run_id`
		};
	}

	/**
	 * Save schema data to localStorage
	 * @param {Object} schema - Schema object from /api/schemas
	 */
	saveSchema(schema) {
		try {
			localStorage.setItem(this.keys.SCHEMA, JSON.stringify({
				data: schema,
				timestamp: Date.now()
			}));
			return true;
		} catch (err) {
			console.error('Failed to save schema:', err);
			return false;
		}
	}

	/**
	 * Get cached schema data
	 * @param {number} maxAge - Maximum age in milliseconds (default 1 hour)
	 * @returns {Object|null} Schema object or null if expired/missing
	 */
	getSchema(maxAge = 3600000) {
		try {
			const stored = localStorage.getItem(this.keys.SCHEMA);
			if (!stored) return null;

			const { data, timestamp } = JSON.parse(stored);
			const age = Date.now() - timestamp;

			if (age > maxAge) {
				this.clearSchema();
				return null;
			}

			return data;
		} catch (err) {
			console.error('Failed to get schema:', err);
			return null;
		}
	}

	/**
	 * Clear cached schema
	 */
	clearSchema() {
		localStorage.removeItem(this.keys.SCHEMA);
	}

	/**
	 * Save mapping configuration
	 * @param {Object} mapping - Mapping object with table/field configs
	 */
	saveMapping(mapping) {
		try {
			localStorage.setItem(this.keys.MAPPING, JSON.stringify({
				data: mapping,
				timestamp: Date.now()
			}));
			return true;
		} catch (err) {
			console.error('Failed to save mapping:', err);
			return false;
		}
	}

	/**
	 * Get cached mapping configuration
	 * @returns {Object|null} Mapping object or null
	 */
	getMapping() {
		try {
			const stored = localStorage.getItem(this.keys.MAPPING);
			if (!stored) return null;

			const { data } = JSON.parse(stored);
			return data;
		} catch (err) {
			console.error('Failed to get mapping:', err);
			return null;
		}
	}

	/**
	 * Clear cached mapping
	 */
	clearMapping() {
		localStorage.removeItem(this.keys.MAPPING);
	}

	/**
	 * Save migration plan
	 * @param {Object} plan - Plan object from /api/plans
	 */
	savePlan(plan) {
		try {
			localStorage.setItem(this.keys.PLAN, JSON.stringify({
				data: plan,
				timestamp: Date.now()
			}));
			return true;
		} catch (err) {
			console.error('Failed to save plan:', err);
			return false;
		}
	}

	/**
	 * Get cached migration plan
	 * @returns {Object|null} Plan object or null
	 */
	getPlan() {
		try {
			const stored = localStorage.getItem(this.keys.PLAN);
			if (!stored) return null;

			const { data } = JSON.parse(stored);
			return data;
		} catch (err) {
			console.error('Failed to get plan:', err);
			return null;
		}
	}

	/**
	 * Clear cached plan
	 */
	clearPlan() {
		localStorage.removeItem(this.keys.PLAN);
	}

	/**
	 * Save wizard progress (current step, completion status)
	 * @param {Object} progress - { currentStep, completedSteps, runId }
	 */
	saveProgress(progress) {
		try {
			localStorage.setItem(this.keys.PROGRESS, JSON.stringify({
				data: progress,
				timestamp: Date.now()
			}));
			return true;
		} catch (err) {
			console.error('Failed to save progress:', err);
			return false;
		}
	}

	/**
	 * Get wizard progress
	 * @returns {Object|null} Progress object or null
	 */
	getProgress() {
		try {
			const stored = localStorage.getItem(this.keys.PROGRESS);
			if (!stored) return null;

			const { data } = JSON.parse(stored);
			return data;
		} catch (err) {
			console.error('Failed to get progress:', err);
			return null;
		}
	}

	/**
	 * Update current step
	 * @param {number} stepNumber - Current step (1-5)
	 */
	setCurrentStep(stepNumber) {
		try {
			localStorage.setItem(this.keys.CURRENT_STEP, stepNumber.toString());

			// Also update progress object
			const progress = this.getProgress() || { completedSteps: [] };
			progress.currentStep = stepNumber;
			this.saveProgress(progress);

			return true;
		} catch (err) {
			console.error('Failed to save current step:', err);
			return false;
		}
	}

	/**
	 * Get current step
	 * @returns {number} Current step number (1-5)
	 */
	getCurrentStep() {
		try {
			const stored = localStorage.getItem(this.keys.CURRENT_STEP);
			return stored ? parseInt(stored, 10) : 1;
		} catch (err) {
			console.error('Failed to get current step:', err);
			return 1;
		}
	}

	/**
	 * Mark a step as completed
	 * @param {number} stepNumber - Step to mark complete
	 */
	markStepComplete(stepNumber) {
		try {
			const progress = this.getProgress() || { completedSteps: [] };

			if (!progress.completedSteps.includes(stepNumber)) {
				progress.completedSteps.push(stepNumber);
				progress.completedSteps.sort((a, b) => a - b);
			}

			this.saveProgress(progress);
			return true;
		} catch (err) {
			console.error('Failed to mark step complete:', err);
			return false;
		}
	}

	/**
	 * Check if a step is completed
	 * @param {number} stepNumber - Step to check
	 * @returns {boolean} True if step is completed
	 */
	isStepComplete(stepNumber) {
		try {
			const progress = this.getProgress();
			return progress?.completedSteps?.includes(stepNumber) || false;
		} catch (err) {
			return false;
		}
	}

	/**
	 * Save current run ID
	 * @param {string} runId - Run identifier
	 */
	saveRunId(runId) {
		try {
			localStorage.setItem(this.keys.RUN_ID, runId);

			// Also update progress
			const progress = this.getProgress() || {};
			progress.runId = runId;
			this.saveProgress(progress);

			return true;
		} catch (err) {
			console.error('Failed to save run ID:', err);
			return false;
		}
	}

	/**
	 * Get current run ID
	 * @returns {string|null} Run ID or null
	 */
	getRunId() {
		try {
			return localStorage.getItem(this.keys.RUN_ID);
		} catch (err) {
			console.error('Failed to get run ID:', err);
			return null;
		}
	}

	/**
	 * Clear all wizard data (reset to initial state)
	 */
	clearAll() {
		Object.values(this.keys).forEach(key => {
			localStorage.removeItem(key);
		});
	}

	/**
	 * Export all wizard data as JSON (for debugging/backup)
	 * @returns {Object} All stored data
	 */
	exportAll() {
		return {
			schema: this.getSchema(Infinity), // No age limit
			mapping: this.getMapping(),
			plan: this.getPlan(),
			progress: this.getProgress(),
			currentStep: this.getCurrentStep(),
			runId: this.getRunId()
		};
	}

	/**
	 * Import wizard data from JSON (restore from backup)
	 * @param {Object} data - Exported data object
	 */
	importAll(data) {
		if (data.schema) this.saveSchema(data.schema);
		if (data.mapping) this.saveMapping(data.mapping);
		if (data.plan) this.savePlan(data.plan);
		if (data.progress) this.saveProgress(data.progress);
		if (data.currentStep) this.setCurrentStep(data.currentStep);
		if (data.runId) this.saveRunId(data.runId);
	}
}

// Export as singleton instance
window.WizardStorage = new WizardStorage();
