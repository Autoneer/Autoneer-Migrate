(function () {
	function setBusy(button, busyText) {
		if (!button) return function noop() {};
		const oldText = button.textContent;
		button.disabled = true;
		button.textContent = busyText;
		return function restore() {
			button.disabled = false;
			button.textContent = oldText;
		};
	}

	function stringify(value) {
		try {
			return JSON.stringify(value, null, 2);
		} catch (err) {
			return String(value);
		}
	}

	function summarizeChecks(checks) {
		if (!Array.isArray(checks) || checks.length === 0) return "No checks returned.";
		const lines = [];
		for (const check of checks) {
			const count = typeof check.count === "number" ? check.count : 0;
			lines.push(`[${check.check}] ${check.name}: ${check.passed ? "PASS" : `FAIL (${count})`}`);
		}
		return lines.join("\n");
	}

	function buildValidationDetails(validation) {
		if (!validation || !Array.isArray(validation.checks)) return "No GL validation payload returned.";
		const blocks = [];
		for (const check of validation.checks) {
			if (check.passed) continue;
			blocks.push(`\n[${check.check}] ${check.name} (${check.count} error(s))`);
			if (Array.isArray(check.errors) && check.errors.length > 0) {
				for (const err of check.errors) {
					blocks.push(`- ${err.message || stringify(err)}`);
				}
			} else {
				blocks.push("- No detailed errors provided.");
			}
		}
		return blocks.length ? blocks.join("\n") : "All GL validation checks passed.";
	}

	async function postJson(url, payload) {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload || {})
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data.success === false) {
			const message = data && data.message ? data.message : `Request failed (${response.status})`;
			const error = new Error(message);
			error.payload = data;
			throw error;
		}
		return data;
	}

	async function run() {
		const resultEl = document.getElementById("gl-tools-result");
		const rebuildBtn = document.getElementById("btn-rebuild-gl-page");
		const validateBtn = document.getElementById("btn-gl-validate");
		const wipeJournals = document.getElementById("gl-wipe-journals");

		if (!resultEl) return;

		if (rebuildBtn) {
			rebuildBtn.addEventListener("click", async function () {
				const confirmMsg = "Rebuild GL accounts now? This will truncate and recreate gl_accounts.";
				const ok = window.Modal && typeof window.Modal.confirm === "function"
					? await window.Modal.confirm({
						title: "Rebuild GL Accounts",
						message: confirmMsg,
						type: "warning",
						confirmText: "Rebuild",
						cancelText: "Cancel"
					})
					: window.confirm(confirmMsg);
				if (!ok) return;

				const restore = setBusy(rebuildBtn, "Rebuilding...");
				resultEl.textContent = "Running rebuild...";
				try {
					const response = await postJson("/api/tools/rebuild-gl", {
						truncateJournals: !!(wipeJournals && wipeJournals.checked)
					});
					const validation = response.gl_validation || null;
					const summary = validation ? summarizeChecks(validation.checks) : "No GL validation returned.";
					const details = validation ? buildValidationDetails(validation) : "";
					resultEl.textContent =
						"Rebuild completed.\n\n" +
						"Check Summary:\n" + summary + "\n\n" +
						"Validation Details:\n" + details + "\n\n" +
						"Full Response:\n" + stringify(response);
				} catch (err) {
					resultEl.textContent = "Rebuild failed.\n\n" + (err.message || String(err));
				} finally {
					restore();
				}
			});
		}

		if (validateBtn) {
			validateBtn.addEventListener("click", async function () {
				const restore = setBusy(validateBtn, "Validating...");
				resultEl.textContent = "Running GL validation...";
				try {
					const response = await postJson("/api/tools/gl-validate", {});
					const validation = response.gl_validation || null;
					const summary = validation ? summarizeChecks(validation.checks) : "No GL validation returned.";
					const details = validation ? buildValidationDetails(validation) : "";
					resultEl.textContent =
						"Validation completed.\n\n" +
						"Check Summary:\n" + summary + "\n\n" +
						"Validation Details:\n" + details + "\n\n" +
						"Full Response:\n" + stringify(response);
				} catch (err) {
					resultEl.textContent = "Validation failed.\n\n" + (err.message || String(err));
				} finally {
					restore();
				}
			});
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", run);
	} else {
		run();
	}
})();
