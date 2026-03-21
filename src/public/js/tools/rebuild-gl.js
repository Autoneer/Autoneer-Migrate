(function () {
	async function showResult(message, isError) {
		if (window.Modal && typeof window.Modal.alert === "function") {
			await window.Modal.alert({
				title: isError ? "Rebuild Failed" : "Rebuild Complete",
				message,
				type: isError ? "error" : "success",
				confirmText: "OK"
			});
			return;
		}

		alert(message);
	}

	async function confirmRebuild() {
		if (window.Modal && typeof window.Modal.confirm === "function") {
			return window.Modal.confirm({
				title: "Rebuild GL Accounts",
				message:
					"This will TRUNCATE gl_accounts and rebuild it from staging accounts. If GL journals already exist, you must choose whether to wipe them too. Continue?",
				type: "warning",
				confirmText: "Continue",
				cancelText: "Cancel"
			});
		}

		return confirm(
			"This will TRUNCATE gl_accounts and rebuild it from staging accounts.\n\n" +
			"If GL journals already exist, you must choose whether to wipe them too.\n\n" +
			"Continue?"
		);
	}

	async function confirmJournalWipe() {
		if (window.Modal && typeof window.Modal.confirm === "function") {
			return window.Modal.confirm({
				title: "GL Journals",
				message:
					"Wipe GL journals too? Continue to truncate gl_journal_headers + gl_journal_lines, or cancel to keep journals (procedure will refuse if journals exist).",
				type: "warning",
				confirmText: "Wipe Journals",
				cancelText: "Keep Journals"
			});
		}

		return confirm(
			"Wipe GL journals too?\n\n" +
			"OK = truncate gl_journal_headers + gl_journal_lines as well.\n" +
			"Cancel = keep journals (procedure will refuse if journals exist)."
		);
	}

	function buildResultMessage(response) {
		let message = "GL rebuild complete.";

		if (response && response.gl_account_types_valid === false) {
			message += "\n\nWarning: gl_account_types validation failed.";
			if (Array.isArray(response.gl_account_types_errors) && response.gl_account_types_errors.length > 0) {
				message += "\n" + response.gl_account_types_errors.join("\n");
			}
		}

		if (response && response.gl_validation && !response.gl_validation.allPassed) {
			const checks = response.gl_validation.checks || [];
			const failed = checks.filter((check) => !check.passed);
			if (failed.length > 0) {
				message += `\n\nWarning: GL validation has ${failed.length} failed check(s):`;
				failed.forEach((check) => {
					message += `\n  - ${check.name}: ${check.summary || check.error || "FAIL"}`;
				});
			}
		}

		return message;
	}

	async function runRebuildFlow(triggerButton) {
		const proceed = await confirmRebuild();
		if (!proceed) return { cancelled: true };

		const truncateJournals = await confirmJournalWipe();
		const button = triggerButton || null;
		const previousText = button ? button.textContent : "";

		if (button) {
			button.disabled = true;
			button.textContent = "Rebuilding...";
		}

		try {
			const api = new APIClient("/api");
			const response = await api.post("/tools/rebuild-gl", { truncateJournals });
			const message = buildResultMessage(response);
			const hasWarnings = (response && response.gl_account_types_valid === false) ||
				(response && response.gl_validation && !response.gl_validation.allPassed);

			await showResult(message, false);
			if (hasWarnings) {
				console.warn("GL rebuild completed with validation warnings:", response);
			}

			return { success: true, response, hasWarnings };
		} catch (error) {
			await showResult(error && error.message ? error.message : "Rebuild failed", true);
			throw error;
		} finally {
			if (button) {
				button.disabled = false;
				button.textContent = previousText;
			}
		}
	}

	function bindButton(button) {
		if (!button || button.dataset.rebuildGlBound === "1") return;
		button.dataset.rebuildGlBound = "1";
		button.addEventListener("click", async (event) => {
			event.preventDefault();
			try {
				await runRebuildFlow(button);
			} catch (error) {
				// dialog already shown
			}
		});
	}

	function init() {
		bindButton(document.getElementById("btn-rebuild-gl"));
	}

	window.RebuildGLTool = {
		run: runRebuildFlow,
		bindButton
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
