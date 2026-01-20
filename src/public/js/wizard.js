/**
 * MigrationWizard - Main controller for migration wizard UI
 * 
 * Orchestrates the 4-step linear wizard flow:
 * 1. Schema Discovery
 * 2. Mapping Builder
 * 3. Plan Creator
 * 4. Execution Monitor
 * 5. Results Viewer
 */
class MigrationWizard {
	constructor() {
		this.state = window.WizardState;
		this.storage = window.WizardStorage;
		this.currentStep = 1;
		this.steps = [
			{ number: 1, name: 'schema', title: 'Discover Schemas', component: null },
			{ number: 2, name: 'mapping', title: 'Build Mapping', component: null },
			{ number: 3, name: 'plan', title: 'Create Plan', component: null },
			{ number: 4, name: 'run', title: 'Execute Migration', component: null },
			{ number: 5, name: 'results', title: 'View Results', component: null }
		];
		this.initialized = false;
	}

	/**
	 * Initialize wizard on page load
	 */
	async initialize() {
		if (this.initialized) return;

		console.log('Initializing Migration Wizard...');

		try {
			// Initialize state from localStorage
			this.state.initialize();

			// Get current step from state
			this.currentStep = this.state.get('currentStep') || 1;

			// Set up UI elements
			this.setupUI();

			// Load step components
			await this.loadStepComponents();

			// Show initial step
			await this.showStep(this.currentStep);

			// Set up event listeners
			this.setupEventListeners();

			this.initialized = true;
			console.log(`✓ Wizard initialized successfully at step ${this.currentStep}`);

			// Show success notification
			this.showSuccess('Wizard loaded successfully! Ready to start migration.');
		} catch (err) {
			console.error('Wizard initialization failed:', err);
			this.renderInitError(err);
		}
	}

	/**
	 * Set up wizard UI structure
	 */
	setupUI() {
		// Create progress bar
		this.renderProgressBar();

		// Create step navigation
		this.renderNavigation();

		// Create step container
		const container = document.getElementById('wizard-container');
		if (!container) {
			console.error('Wizard container not found');
			return;
		}
	}

	/**
	 * Load step component modules
	 */
	async loadStepComponents() {
		try {
			// Components are loaded via script tags in HTML
			// Just verify they're available
			if (window.SchemaUI) {
				this.steps[0].component = new window.SchemaUI(this);
			}
			if (window.MappingUI) {
				this.steps[1].component = new window.MappingUI(this);
			}
			if (window.PlanUI) {
				this.steps[2].component = new window.PlanUI(this);
			}
			if (window.RunUI) {
				this.steps[3].component = new window.RunUI(this);
			}
			if (window.ResultsUI) {
				this.steps[4].component = new window.ResultsUI(this);
			}
		} catch (err) {
			console.error('Failed to load step components:', err);
		}
	}

	/**
	 * Render progress bar
	 */
	renderProgressBar() {
		const progressBar = document.getElementById('wizard-progress');
		if (!progressBar) return;

		const progress = ((this.currentStep - 1) / (this.steps.length - 1)) * 100;

		progressBar.innerHTML = `
      <div class="progress-steps">
        ${this.steps.map((step, idx) => `
          <div class="progress-step ${step.number === this.currentStep ? 'active' : ''} ${step.number < this.currentStep ? 'completed' : ''}">
            <div class="step-number">${step.number}</div>
            <div class="step-title">${step.title}</div>
          </div>
        `).join('')}
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" style="width: ${progress}%"></div>
      </div>
    `;
	}

	/**
	 * Render navigation buttons
	 */
	renderNavigation() {
		const nav = document.getElementById('wizard-navigation');
		if (!nav) return;

		const canGoBack = this.currentStep > 1;
		const canGoNext = this.currentStep < this.steps.length;
		const validation = this.state.canProceed();

		nav.innerHTML = `
      <button 
        id="btn-prev" 
        class="btn btn-secondary" 
        ${!canGoBack ? 'disabled' : ''}
        ${!canGoBack ? 'style="visibility: hidden;"' : ''}
      >
        ← Previous
      </button>
      
      <div class="nav-center">
        <span class="step-indicator">Step ${this.currentStep} of ${this.steps.length}</span>
      </div>
      
      <button 
        id="btn-next" 
        class="btn btn-primary" 
        ${!canGoNext ? 'disabled' : ''}
        ${!validation.valid ? 'disabled title="' + validation.errors.join(', ') + '"' : ''}
      >
        ${this.currentStep === this.steps.length - 1 ? 'Finish' : 'Next →'}
      </button>
    `;

		// Attach event listeners
		const btnPrev = document.getElementById('btn-prev');
		const btnNext = document.getElementById('btn-next');

		if (btnPrev) {
			btnPrev.addEventListener('click', () => this.previousStep());
		}

		if (btnNext) {
			btnNext.addEventListener('click', () => this.nextStep());
		}
	}

	/**
	 * Show specific step
	 * @param {number} stepNumber - Step to show (1-5)
	 */
	async showStep(stepNumber) {
		if (stepNumber < 1 || stepNumber > this.steps.length) {
			console.error(`Invalid step number: ${stepNumber}`);
			return;
		}

		// Prevent infinite loop - don't update if already at this step
		if (this.currentStep === stepNumber) {
			return;
		}

		// Hide all steps
		document.querySelectorAll('.wizard-step').forEach(el => {
			el.classList.remove('active');
			el.style.display = 'none';
		});

		// Show current step
		const stepElement = document.getElementById(`step-${stepNumber}`);
		if (stepElement) {
			stepElement.classList.add('active');
			stepElement.style.display = 'block';
		}

		// Update state
		this.currentStep = stepNumber;
		this.state.setCurrentStep(stepNumber);

		// Update UI
		this.renderProgressBar();
		this.renderNavigation();

		// Initialize step component
		const step = this.steps[stepNumber - 1];
		if (step.component && typeof step.component.initialize === 'function') {
			try {
				await step.component.initialize();
			} catch (err) {
				console.error(`Failed to initialize step ${stepNumber}:`, err);
				this.showError(`Failed to load ${step.title}: ${err.message}`);
			}
		}

		// Scroll to top
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	/**
	 * Go to next step
	 */
	async nextStep() {
		// Validate current step
		const validation = this.state.canProceed();
		if (!validation.valid) {
			this.showError(`Cannot proceed: ${validation.errors.join(', ')}`);
			return;
		}

		// Call onNext handler for current step component
		const currentStep = this.steps[this.currentStep - 1];
		if (currentStep.component && typeof currentStep.component.onNext === 'function') {
			try {
				const canProceed = await currentStep.component.onNext();
				if (canProceed === false) {
					return; // Component prevented navigation
				}
			} catch (err) {
				console.error('Error in onNext handler:', err);
				this.showError(err.message);
				return;
			}
		}

		// Mark step as complete
		this.storage.markStepComplete(this.currentStep);

		// Go to next step
		if (this.currentStep < this.steps.length) {
			await this.showStep(this.currentStep + 1);
		}
	}

	/**
	 * Go to previous step
	 */
	async previousStep() {
		// Call onPrevious handler for current step component
		const currentStep = this.steps[this.currentStep - 1];
		if (currentStep.component && typeof currentStep.component.onPrevious === 'function') {
			try {
				const canProceed = await currentStep.component.onPrevious();
				if (canProceed === false) {
					return; // Component prevented navigation
				}
			} catch (err) {
				console.error('Error in onPrevious handler:', err);
			}
		}

		// Go to previous step
		if (this.currentStep > 1) {
			await this.showStep(this.currentStep - 1);
		}
	}

	/**
	 * Jump to specific step (if valid)
	 * @param {number} stepNumber - Target step
	 */
	async goToStep(stepNumber) {
		// Check if step is accessible (must have completed previous steps)
		for (let i = 1; i < stepNumber; i++) {
			if (!this.storage.isStepComplete(i)) {
				this.showWarning(`You must complete Step ${i} first`);
				return;
			}
		}

		await this.showStep(stepNumber);
	}

	/**
	 * Set up global event listeners
	 */
	setupEventListeners() {
		// Listen for state changes
		this.state.on('step:change', (step) => {
			this.showStep(step);
		});

		this.state.on('ui:error', (message) => {
			this.showError(message);
		});

		this.state.on('ui:warning', (message) => {
			this.showWarning(message);
		});

		// Listen for keyboard shortcuts
		document.addEventListener('keydown', (e) => {
			// Ctrl/Cmd + Arrow Left/Right for navigation
			if (e.ctrlKey || e.metaKey) {
				if (e.key === 'ArrowLeft' && this.currentStep > 1) {
					e.preventDefault();
					this.previousStep();
				} else if (e.key === 'ArrowRight' && this.currentStep < this.steps.length) {
					e.preventDefault();
					this.nextStep();
				}
			}
		});

		// Listen for browser back button
		window.addEventListener('popstate', (e) => {
			if (e.state?.step) {
				this.showStep(e.state.step);
			}
		});
	}

	/**
	 * Show error message
	 * @param {string} message - Error message
	 */
	showError(message) {
		const errorContainer = document.getElementById('wizard-errors');
		if (!errorContainer) return;

		errorContainer.innerHTML = `
      <div class="alert alert-error" role="alert">
        <strong>⚠ Error:</strong> ${message}
        <button class="close-alert" onclick="this.parentElement.remove()">×</button>
      </div>
    `;
		errorContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	/**
	 * Show warning message
	 * @param {string} message - Warning message
	 */
	showWarning(message) {
		const errorContainer = document.getElementById('wizard-errors');
		if (!errorContainer) return;

		errorContainer.innerHTML = `
      <div class="alert alert-warning" role="alert">
        <strong>⚠ Warning:</strong> ${message}
        <button class="close-alert" onclick="this.parentElement.remove()">×</button>
      </div>
    `;
		errorContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	/**
	 * Show success message
	 * @param {string} message - Success message
	 */
	showSuccess(message) {
		const errorContainer = document.getElementById('wizard-errors');
		if (!errorContainer) return;

		errorContainer.innerHTML = `
      <div class="alert alert-success" role="alert">
        <strong>✓ Success:</strong> ${message}
        <button class="close-alert" onclick="this.parentElement.remove()">×</button>
      </div>
    `;

		// Auto-dismiss after 5 seconds
		setTimeout(() => {
			const alert = errorContainer.querySelector('.alert-success');
			if (alert) {
				alert.style.transition = 'opacity 0.3s ease-out';
				alert.style.opacity = '0';
				setTimeout(() => alert.remove(), 300);
			}
		}, 5000);
	}

	/**
	 * Show info message
	 * @param {string} message - Info message
	 */
	showInfo(message) {
		const errorContainer = document.getElementById('wizard-errors');
		if (!errorContainer) return;

		errorContainer.innerHTML = `
      <div class="alert alert-info" role="alert">
        <strong>ℹ Info:</strong> ${message}
        <button class="close-alert" onclick="this.parentElement.remove()">×</button>
      </div>
    `;
	}

	/**
	 * Clear error/warning messages
	 */
	clearMessages() {
		const errorContainer = document.getElementById('wizard-errors');
		if (errorContainer) {
			errorContainer.innerHTML = '';
		}
	}

	/**
	 * Show loading overlay
	 * @param {string} message - Loading message
	 */
	showLoading(message = 'Loading...') {
		this.state.setLoading(true);

		let overlay = document.getElementById('loading-overlay');
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = 'loading-overlay';
			overlay.className = 'loading-overlay';
			document.body.appendChild(overlay);
		}

		overlay.innerHTML = `
      <div class="loading-spinner">
        <div class="spinner"></div>
        <p>${message}</p>
      </div>
    `;
		overlay.style.display = 'flex';
	}

	/**
	 * Hide loading overlay
	 */
	hideLoading() {
		this.state.setLoading(false);

		const overlay = document.getElementById('loading-overlay');
		if (overlay) {
			overlay.style.display = 'none';
		}
	}

	/**
	 * Reset wizard to initial state
	 */
	async reset() {
		if (!confirm('Are you sure you want to reset the wizard? All progress will be lost.')) {
			return;
		}

		this.state.reset();
		this.currentStep = 1;
		await this.showStep(1);
	}

	/**
	 * Export wizard state for debugging
	 */
	exportState() {
		return {
			currentStep: this.currentStep,
			state: this.state.getState(),
			storage: this.storage.exportAll()
		};
	}

	/**
	 * Render initialization error
	 */
	renderInitError(error) {
		const container = document.getElementById('wizard-content');
		if (!container) {
			document.body.innerHTML = this.getInitErrorHTML(error);
			return;
		}

		container.innerHTML = this.getInitErrorHTML(error);
	}

	/**
	 * Get initialization error HTML
	 */
	getInitErrorHTML(error) {
		return `
			<div class="wizard-init-error">
				<div class="error-icon">⚠️</div>
				<h2>Wizard Initialization Failed</h2>
				<p class="error-message">${this.escapeHtml(error.message)}</p>
				
				<div class="error-actions">
					<button class="btn btn-primary" onclick="location.reload()">
						🔄 Reload Page
					</button>
					<button class="btn btn-secondary" onclick="location.href='/setup'">
						⚙️ Go to Setup
					</button>
				</div>
				
				<details class="error-details">
					<summary>Error Details</summary>
					<pre>${this.escapeHtml(error.stack || error.toString())}</pre>
				</details>
				
				<div class="troubleshooting">
					<h3>Troubleshooting Steps:</h3>
					<ol>
						<li>Check that database connections are configured in Setup</li>
						<li>Verify both Firebird and MySQL databases are running</li>
						<li>Ensure the server is running (check terminal for errors)</li>
						<li>Try clearing your browser cache and localStorage</li>
						<li>Check the browser console (F12) for additional errors</li>
					</ol>
				</div>
			</div>
		`;
	}

	/**
	 * Escape HTML to prevent XSS
	 */
	escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}
}

// Initialize wizard when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
	window.wizard = new MigrationWizard();
	await window.wizard.initialize();
});

// Export to window
window.MigrationWizard = MigrationWizard;
