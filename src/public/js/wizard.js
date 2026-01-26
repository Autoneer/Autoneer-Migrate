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
		this.currentStep = 0; // Start at 0 so first showStep always renders
		this.steps = [
			{ number: 1, name: 'schema', title: 'Discover Schemas', component: null },
			{ number: 2, name: 'mapping', title: 'Build Mapping', component: null },
			{ number: 3, name: 'plan', title: 'Create Plan', component: null },
			{ number: 4, name: 'run', title: 'Execute Migration', component: null },
			{ number: 5, name: 'results', title: 'View Results', component: null }
		];
		this.initialized = false;
		this._isShowingStep = false; // Re-entrancy guard
		this._isBusy = false; // Busy state for async operations
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

			// Check for reusePlanId query param
			const urlParams = new URLSearchParams(window.location.search);
			const reusePlanId = urlParams.get('reusePlanId');
			const stepParam = urlParams.get('step');

			let initialStep = this.state.get('currentStep') || 1;
			if (stepParam) {
				initialStep = parseInt(stepParam, 10);
			}

			// If reusePlanId provided, load plan and mapping before showing step 3
			if (reusePlanId) {
				console.log('[Wizard] Loading reused plan:', reusePlanId);
				try {
					// Fetch plan details using singleton API (not constructor)
					const planAPI = window.PlanAPI;
					const plan = await planAPI.getById(reusePlanId);
					if (plan && plan.mappingProfileId) {
						// Load mapping profile using singleton API (not constructor)
						const mappingAPI = window.MappingAPI;
						const mappingProfile = await mappingAPI.getById(plan.mappingProfileId);
						// API returns { id, name, tables } - no .mapping property
						if (mappingProfile?.tables) {
							// Normalize mapping object for wizard compatibility
							const normalizedMapping = {
								...mappingProfile,
								mappingProfileId: mappingProfile.id,
								id: mappingProfile.id
							};
							// Set state for wizard
							this.state.set('mapping', normalizedMapping);
							this.state.set('plan', plan);
							// Force step 3 when reusing plan (ignore localStorage)
							initialStep = 3;
							console.log('[Wizard] Loaded plan and mapping for reuse');
						} else {
							throw new Error('Mapping profile loaded but has no tables');
						}
					} else {
						throw new Error('Plan loaded but has no mappingProfileId');
					}
					// Clean up URL to avoid re-loading on refresh (after successful load)
					window.history.replaceState({}, document.title, '/wizard');
				} catch (err) {
					console.error('[Wizard] Failed to load reused plan:', err);
					this.wizard?.showError?.(`Failed to load plan: ${err.message}`);
					// Fall back to step 1
					initialStep = 1;
				}
			}

			// Set currentStep to 0 so first showStep() call always renders
			this.currentStep = 0;

			// Set up UI elements
			this.setupUI();

			// Load step components
			await this.loadStepComponents();

			// Show initial step (will always render since currentStep is 0)
			await this.showStep(initialStep);

			// Set up event listeners
			this.setupEventListeners();

			this.initialized = true;
			console.log(`✓ Wizard initialized successfully at step ${this.currentStep}`);

			// Show success notification
			// this.showSuccess('Wizard loaded successfully! Ready to start migration.');

			// Add diagnostics hook for debugging
			window.__wizardDebug = () => this.exportState();
			console.log('💡 Tip: Run __wizardDebug() in console to inspect wizard state');
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
          <div class="progress-step ${step.number === this.currentStep ? 'active' : ''} ${step.number < this.currentStep ? 'completed' : ''}" data-step="${step.number}">
            <div class="step-number">${step.number}</div>
            <div class="step-title">${step.title}</div>
          </div>
        `).join('')}
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" style="width: ${progress}%"></div>
      </div>
    `;

		// Attach click handlers to step numbers for enabled steps
		try {
			const stepEls = progressBar.querySelectorAll('.progress-step');
			stepEls.forEach(el => {
				const stepNum = parseInt(el.getAttribute('data-step'), 10);
				if (Number.isNaN(stepNum)) return;

				// Enabled if first step, step is at-or-before current, or previous step completed
				const enabled = (stepNum === 1) || (stepNum <= this.currentStep) || this.storage.isStepComplete(stepNum - 1);
				if (enabled) {
					el.classList.add('clickable');
					el.addEventListener('click', (e) => {
						if (this._isBusy) return;
						this.goToStep(stepNum);
					});
				}
			});
		} catch (err) {
			console.warn('Failed to attach step click handlers', err);
		}
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

		// Build validation feedback HTML
		let validationFeedback = '';
		if (!validation.valid && validation.errors && validation.errors.length > 0) {
			validationFeedback = `
				<div class="nav-validation" role="status" aria-live="polite">
					<strong>To continue:</strong>
					<ul>
						${validation.errors.map(err => `<li>${this.escapeHtml(err)}</li>`).join('')}
					</ul>
				</div>
			`;
		}

		nav.innerHTML = `
      ${validationFeedback}
      <div class="nav-buttons">
        <button 
          id="btn-prev" 
          class="btn btn-secondary" 
          ${!canGoBack || this._isBusy ? 'disabled' : ''}
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
          ${!canGoNext || !validation.valid || this._isBusy ? 'disabled' : ''}
          title="${!validation.valid ? validation.errors.join(', ') : ''}"
        >
          ${this.currentStep === this.steps.length - 1 ? 'Finish' : 'Next →'}
        </button>
      </div>
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

		// Re-entrancy guard: prevent recursive calls
		if (this._isShowingStep) {
			return;
		}

		try {
			this._isShowingStep = true;

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

			// Update state (only if changed to avoid event loop)
			if (this.currentStep !== stepNumber) {
				this.currentStep = stepNumber;
				this.state.setCurrentStep(stepNumber);
			}

			// Update UI
			this.renderProgressBar();
			this.renderNavigation();

			// Normalize plan state before initializing Step 3/4 components
			if (stepNumber === 3 || stepNumber === 4) {
				this.state.normalizePlanInState();
			}

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
		} finally {
			this._isShowingStep = false;
		}
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
		// Reset wizard button
		const resetBtn = document.getElementById('btn-wizard-reset');
		if (resetBtn) {
			resetBtn.addEventListener('click', () => this.reset());
		}

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

		this.state.on('change:mapping', () => {
			this.renderNavigation();
		});

		this.state.on('change:plan', () => {
			this.renderNavigation();
		});

		this.state.on('change:schema', () => {
			this.renderNavigation();
		});

		this.state.on('change:run', () => {
			this.renderNavigation();
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
		this.showFlash('error', message, { autoDismiss: 0 });
	}

	/**
	 * Show warning message
	 * @param {string} message - Warning message
	 */
	showWarning(message) {
		this.showFlash('warning', message, { autoDismiss: 0 });
	}

	/**
	 * Show success message
	 * @param {string} message - Success message
	 */
	showSuccess(message) {
		this.showFlash('success', message, { autoDismiss: 0 });
	}

	/**
	 * Show info message
	 * @param {string} message - Info message
	 */
	showInfo(message) {
		this.showFlash('info', message, { autoDismiss: 0 });
	}

	/**
	 * Show flash modal message
	 * @param {'error'|'warning'|'success'|'info'} type
	 * @param {string} message
	 * @param {{ autoDismiss?: number }} options
	 */
	showFlash(type, message, options = {}) {
		const existing = document.querySelector('.flash-modal-overlay');
		if (existing) {
			existing.remove();
		}

		const overlay = document.createElement('div');
		overlay.className = 'flash-modal-overlay';

		const titleMap = {
			error: 'Error',
			warning: 'Warning',
			success: 'Success',
			info: 'Info'
		};

		const iconMap = {
			error: '⚠',
			warning: '⚠',
			success: '✓',
			info: 'ℹ'
		};

		const safeMessage = this.escapeHtml(message);

		overlay.innerHTML = `
			<div class="flash-modal flash-${type}" role="alertdialog" aria-live="polite" aria-modal="true">
				<button class="flash-close" aria-label="Close">×</button>
				<div class="flash-title">${iconMap[type] || ''} ${titleMap[type] || 'Notice'}:</div>
				<div class="flash-message">${safeMessage}</div>
			</div>
		`;

		const close = () => overlay.remove();
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) close();
		});
		overlay.querySelector('.flash-close')?.addEventListener('click', close);

		document.body.appendChild(overlay);

		const autoDismiss = Number(options.autoDismiss || 0);
		if (autoDismiss > 0) {
			setTimeout(() => {
				if (document.body.contains(overlay)) {
					overlay.remove();
				}
			}, autoDismiss);
		}
	}

	/**
	 * Clear error/warning messages
	 */
	clearMessages() {
		const errorContainer = document.getElementById('wizard-errors');
		if (errorContainer) {
			errorContainer.innerHTML = '';
		}
		const flash = document.querySelector('.flash-modal-overlay');
		if (flash) {
			flash.remove();
		}
	}

	/**
	 * Show loading overlay
	 * @param {string} message - Loading message
	 */
	showLoading(message = 'Loading...') {
		this.state.setLoading(true);

		// Use the existing overlay in the template
		const overlay = document.querySelector('#wizard-container .loading-overlay');
		if (!overlay) {
			console.warn('Loading overlay not found in template');
			return;
		}

		// Update the message
		const messageEl = overlay.querySelector('p');
		if (messageEl) {
			messageEl.textContent = message;
		}

		overlay.style.display = 'flex';
	}

	/**
	 * Hide loading overlay
	 */
	hideLoading() {
		this.state.setLoading(false);

		const overlay = document.querySelector('#wizard-container .loading-overlay');
		if (overlay) {
			overlay.style.display = 'none';
		}
	}

	/**
	 * Set wizard busy state - disables navigation during async work
	 * @param {boolean} busy - Whether wizard is busy
	 * @param {string} message - Optional loading message
	 */
	setBusy(busy, message = 'Working...') {
		this._isBusy = busy;

		if (busy) {
			this.showLoading(message);
			// Disable navigation buttons
			const prevBtn = document.querySelector('#wizard-navigation .btn-prev');
			const nextBtn = document.querySelector('#wizard-navigation .btn-next');
			if (prevBtn) {
				prevBtn.disabled = true;
				prevBtn.classList.add('disabled');
			}
			if (nextBtn) {
				nextBtn.disabled = true;
				nextBtn.classList.add('disabled');
				nextBtn.textContent = 'Working...';
			}
		} else {
			this.hideLoading();
			// Re-render navigation to restore button states
			this.renderNavigation();
		}
	}

	/**
	 * Set status message for a specific step
	 * @param {number} stepNumber - Step number (1-5)
	 * @param {Object} status - Status object {type: 'info'|'success'|'warning'|'error', message: string}
	 */
	setStepStatus(stepNumber, status) {
		const stepEl = document.getElementById(`step-${stepNumber}`);
		if (!stepEl) return;

		// Remove existing status banner
		const existing = stepEl.querySelector('.step-status-banner');
		if (existing) {
			existing.remove();
		}

		// Add new status banner if message provided
		if (status && status.message) {
			const banner = document.createElement('div');
			banner.className = `step-status-banner step-status-${status.type || 'info'}`;
			banner.setAttribute('role', 'status');
			banner.setAttribute('aria-live', 'polite');

			const iconMap = {
				info: 'ℹ️',
				success: '✓',
				warning: '⚠️',
				error: '⚠️'
			};

			banner.innerHTML = `
				<span class="status-icon">${iconMap[status.type] || 'ℹ️'}</span>
				<span class="status-message">${this.escapeHtml(status.message)}</span>
			`;

			// Insert at the beginning of the step content
			const contentDiv = stepEl.querySelector('[id$="-content"]');
			if (contentDiv) {
				contentDiv.insertBefore(banner, contentDiv.firstChild);
			}
		}
	}

	/**
	 * Reset wizard to initial state
	 */
	async reset() {
		const confirmed = await Modal.confirm({
			title: 'Reset Wizard',
			message: 'Are you sure you want to reset the wizard? All progress will be lost.',
			type: 'warning',
			confirmText: 'Reset',
			cancelText: 'Cancel'
		});

		if (!confirmed) {
			return;
		}

		// Clear all storage
		this.storage.clearAll();
		this.state.reset();
		this.currentStep = 1;
		await this.showStep(1);

		// Show success message
		await Modal.alert({
			title: 'Wizard Reset',
			message: 'Wizard has been reset successfully. Starting from Step 1.',
			type: 'success'
		});
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
		const container = document.getElementById('wizard-container') || document.body;
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
