/**
 * Modal - Reusable modal dialog utility
 * 
 * Provides Promise-based replacements for window.alert/confirm/prompt
 * with better UX and accessibility features.
 */
(function () {
	if (window.Modal) {
		// Already defined (script loaded more than once) - skip re-definition
		console.warn('Modal already defined; skipping re-definition.');
		return;
	}

	class ModalClass {
		/**
		 * Show an alert modal (OK button only)
		 * @param {Object} options
		 * @param {string} options.title - Modal title
		 * @param {string} options.message - Modal message
		 * @param {string} [options.type='info'] - Type: 'info', 'success', 'warning', 'error'
		 * @param {string} [options.confirmText='OK'] - Confirm button text
		 * @returns {Promise<void>}
		 */
		static alert({ title = 'Alert', message = '', type = 'info', confirmText = 'OK' }) {
			return new Promise((resolve) => {
				const modal = this._createModal({
					title,
					message,
					type,
					confirmText,
					showCancel: false,
					onConfirm: () => {
						this._closeModal(modal);
						resolve();
					}
				});
				this._showModal(modal);
			});
		}

		/**
		 * Show a confirm modal (OK/Cancel buttons)
		 * @param {Object} options
		 * @param {string} options.title - Modal title
		 * @param {string} options.message - Modal message
		 * @param {string} [options.type='warning'] - Type: 'info', 'success', 'warning', 'error'
		 * @param {string} [options.confirmText='Confirm'] - Confirm button text
		 * @param {string} [options.cancelText='Cancel'] - Cancel button text
		 * @returns {Promise<boolean>} - true if confirmed, false if cancelled
		 */
		static confirm({ title = 'Confirm', message = '', type = 'warning', confirmText = 'Confirm', cancelText = 'Cancel' }) {
			return new Promise((resolve) => {
				const modal = this._createModal({
					title,
					message,
					type,
					confirmText,
					cancelText,
					showCancel: true,
					onConfirm: () => {
						this._closeModal(modal);
						resolve(true);
					},
					onCancel: () => {
						this._closeModal(modal);
						resolve(false);
					}
				});
				this._showModal(modal);
			});
		}

		/**
		 * Show a prompt modal (text input + OK/Cancel buttons)
		 * @param {Object} options
		 * @param {string} options.title - Modal title
		 * @param {string} options.message - Modal message
		 * @param {string} [options.type='info'] - Type: 'info', 'success', 'warning', 'error'
		 * @param {string} [options.confirmText='OK'] - Confirm button text
		 * @param {string} [options.cancelText='Cancel'] - Cancel button text
		 * @param {string} [options.inputLabel=''] - Label for input field
		 * @param {string} [options.defaultValue=''] - Default input value
		 * @returns {Promise<{ok: boolean, value: string|null}>}
		 */
		static prompt({ title = 'Input', message = '', type = 'info', confirmText = 'OK', cancelText = 'Cancel', inputLabel = '', defaultValue = '' }) {
			return new Promise((resolve) => {
				const modal = this._createModal({
					title,
					message,
					type,
					confirmText,
					cancelText,
					showCancel: true,
					showInput: true,
					inputLabel,
					defaultValue,
					onConfirm: (value) => {
						this._closeModal(modal);
						resolve({ ok: true, value });
					},
					onCancel: () => {
						this._closeModal(modal);
						resolve({ ok: false, value: null });
					}
				});
				this._showModal(modal);
			});
		}

		/**
		 * Show a custom modal with arbitrary HTML content
		 * @param {Object} options
		 * @param {string} options.title - Modal title
		 * @param {string} options.contentHTML - HTML content for modal body
		 * @param {string} [options.type='info'] - Type: 'info', 'success', 'warning', 'error'
		 * @param {string} [options.size='lg'] - Size: 'lg', 'xl'
		 * @param {string} [options.confirmText='Save'] - Confirm button text
		 * @param {string} [options.cancelText='Cancel'] - Cancel button text
		 * @param {Function} [options.onMount] - Callback after modal inserted into DOM: (modalEl) => void
		 * @param {Function} [options.onConfirm] - Callback when confirm clicked: () => void
		 * @param {Function} [options.onCancel] - Callback when cancel clicked: () => void
		 * @returns {Promise<boolean>} - true if confirmed, false if cancelled
		 */
		static custom({ title = 'Dialog', contentHTML = '', type = 'info', size = 'lg', confirmText = 'Save', cancelText = 'Cancel', onMount, onConfirm, onCancel }) {
			return new Promise((resolve) => {
				const overlay = document.createElement('div');
				overlay.className = 'modal-overlay';
				overlay.setAttribute('role', 'dialog');
				overlay.setAttribute('aria-modal', 'true');
				overlay.setAttribute('aria-labelledby', 'modal-title');

				const dialog = document.createElement('div');
				dialog.className = `modal-dialog modal-${size} modal-${type}`;

				const header = document.createElement('div');
				header.className = 'modal-header';
				const titleEl = document.createElement('h2');
				titleEl.id = 'modal-title';
				titleEl.textContent = title;
				header.appendChild(titleEl);

				const body = document.createElement('div');
				body.className = 'modal-body modal-body-custom';
				body.innerHTML = contentHTML;

				const footer = document.createElement('div');
				footer.className = 'modal-footer';

				const cancelBtn = document.createElement('button');
				cancelBtn.className = 'btn btn-secondary modal-cancel';
				cancelBtn.textContent = cancelText;
				footer.appendChild(cancelBtn);

				const confirmBtn = document.createElement('button');
				confirmBtn.className = `btn ${type === 'error' || type === 'warning' ? 'btn-danger' : 'btn-primary'} modal-confirm`;
				confirmBtn.textContent = confirmText;
				footer.appendChild(confirmBtn);

				dialog.appendChild(header);
				dialog.appendChild(body);
				dialog.appendChild(footer);
				overlay.appendChild(dialog);

				// Event handlers
				const onConfirmClick = () => {
					// this._closeModal(overlay);
					// if (onConfirm) onConfirm();
					if (onConfirm) onConfirm(overlay);
					this._closeModal(overlay);
					resolve(true);
				};

				const onCancelClick = () => {
					this._closeModal(overlay);
					if (onCancel) onCancel();
					resolve(false);
				};

				confirmBtn.onclick = onConfirmClick;
				cancelBtn.onclick = onCancelClick;

				// Close on overlay click
				overlay.onclick = (e) => {
					if (e.target === overlay) {
						onCancelClick();
					}
				};

				// Keyboard shortcuts
				overlay.onkeydown = (e) => {
					if (e.key === 'Escape') {
						e.preventDefault();
						onCancelClick();
					}
				};

				// Show and mount
				this._showModal(overlay);

				// Call onMount callback after modal is in DOM
				if (onMount) {
					setTimeout(() => {
						onMount(overlay);
					}, 0);
				}
			});
		}

		/**
		 * Internal: Create modal DOM structure
		 * @private
		 */
		static _createModal({
			title,
			message,
			type,
			confirmText,
			cancelText,
			showCancel,
			showInput = false,
			inputLabel = '',
			defaultValue = '',
			onConfirm,
			onCancel
		}) {
			const overlay = document.createElement('div');
			overlay.className = 'modal-overlay';
			overlay.setAttribute('role', 'dialog');
			overlay.setAttribute('aria-modal', 'true');
			overlay.setAttribute('aria-labelledby', 'modal-title');

			const dialog = document.createElement('div');
			dialog.className = `modal-dialog modal-${type}`;

			const header = document.createElement('div');
			header.className = 'modal-header';
			const titleEl = document.createElement('h2');
			titleEl.id = 'modal-title';
			titleEl.textContent = title;
			header.appendChild(titleEl);

			const body = document.createElement('div');
			body.className = 'modal-body';
			const messageEl = document.createElement('p');
			messageEl.textContent = message;
			body.appendChild(messageEl);

			let inputEl = null;
			if (showInput) {
				if (inputLabel) {
					const label = document.createElement('label');
					label.textContent = inputLabel;
					label.className = 'modal-input-label';
					body.appendChild(label);
				}
				inputEl = document.createElement('input');
				inputEl.type = 'text';
				inputEl.className = 'modal-input';
				inputEl.value = defaultValue;
				body.appendChild(inputEl);
			}

			const footer = document.createElement('div');
			footer.className = 'modal-footer';

			if (showCancel) {
				const cancelBtn = document.createElement('button');
				cancelBtn.className = 'btn btn-secondary modal-cancel';
				cancelBtn.textContent = cancelText;
				cancelBtn.onclick = () => onCancel && onCancel();
				footer.appendChild(cancelBtn);
			}

			const confirmBtn = document.createElement('button');
			confirmBtn.className = `btn ${type === 'error' || type === 'warning' ? 'btn-danger' : 'btn-primary'} modal-confirm`;
			confirmBtn.textContent = confirmText;
			confirmBtn.onclick = () => {
				const value = inputEl ? inputEl.value : null;
				onConfirm && onConfirm(value);
			};
			footer.appendChild(confirmBtn);

			dialog.appendChild(header);
			dialog.appendChild(body);
			dialog.appendChild(footer);
			overlay.appendChild(dialog);

			// Close on overlay click (treat as cancel)
			overlay.onclick = (e) => {
				if (e.target === overlay && onCancel) {
					onCancel();
				}
			};

			// Keyboard shortcuts
			overlay.onkeydown = (e) => {
				if (e.key === 'Escape' && onCancel) {
					e.preventDefault();
					onCancel();
				}
				if (e.key === 'Enter' && !showInput) {
					e.preventDefault();
					const value = inputEl ? inputEl.value : null;
					onConfirm && onConfirm(value);
				}
			};

			// Handle Enter in input field for prompt
			if (inputEl) {
				inputEl.onkeydown = (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						onConfirm && onConfirm(inputEl.value);
					}
				};
			}

			return overlay;
		}

		/**
		 * Internal: Show modal and focus
		 * @private
		 */
		static _showModal(modal) {
			// Remove any existing modals
			document.querySelectorAll('.modal-overlay').forEach(m => m.remove());

			document.body.appendChild(modal);
			modal.style.display = 'flex';

			// Focus input if present, otherwise focus confirm button
			setTimeout(() => {
				const input = modal.querySelector('.modal-input');
				const confirm = modal.querySelector('.modal-confirm');
				if (input) {
					input.focus();
					input.select();
				} else if (confirm) {
					confirm.focus();
				}
			}, 100);
		}

		/**
		 * Internal: Close and remove modal
		 * @private
		 */
		static _closeModal(modal) {
			if (modal && modal.parentNode) {
				modal.style.display = 'none';
				modal.remove();
			}
		}
	}

	// Export to window
	window.Modal = ModalClass;
})();
