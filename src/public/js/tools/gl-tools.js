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

	function buildSkippedLog(response) {
		const summary = response.accounts_summary;
		const skipped = response.skipped_accounts;
		if (!summary) return "";

		const lines = [
			`\nAccounts Summary:`,
			`  Total in staging : ${summary.total_staging}`,
			`  Migrated to GL   : ${summary.migrated}`,
			`  Skipped          : ${summary.skipped}`
		];

		if (Array.isArray(skipped) && skipped.length > 0) {
			lines.push(`\nSkipped Accounts (not included in gl_accounts):`);
			lines.push(`  ${"ACCNR".padEnd(12)} ${"ACCTYPE".padEnd(20)} ${"CLASS".padEnd(6)} SKIP REASON`);
			lines.push(`  ${"-".repeat(70)}`);
			for (const row of skipped) {
				const accnr = String(row.accnr ?? "").padEnd(12);
				const acctype = String(row.acctype ?? "").slice(0, 20).padEnd(20);
				const accclass = String(row.accclass ?? "").padEnd(6);
				lines.push(`  ${accnr} ${acctype} ${accclass} ${row.skip_reason}`);
			}
		}

		return lines.join("\n");
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
		const convertAccnrBtn = document.getElementById("btn-convert-transactional-accnr");
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
					const skippedLog = buildSkippedLog(response);
					resultEl.textContent =
						"Rebuild completed.\n\n" +
						"Check Summary:\n" + summary + "\n\n" +
						"Validation Details:\n" + details +
						skippedLog + "\n\n" +
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

		if (convertAccnrBtn) {
			convertAccnrBtn.addEventListener("click", async function () {
				const confirmMsg =
					"Convert transactional account numbers now?\n\n" +
					"This will update acc, accnr, accasset, and siid fields across all transactional " +
					"tables to match the new GL account numbers.\n\n" +
					"Run only after all tables have been migrated AND Rebuild GL Accounts has been run.";
				const ok = window.Modal && typeof window.Modal.confirm === "function"
					? await window.Modal.confirm({
						title: "Convert Transactional Acc Numbers",
						message: confirmMsg,
						type: "warning",
						confirmText: "Convert",
						cancelText: "Cancel"
					})
					: window.confirm(confirmMsg);
				if (!ok) return;

				const restore = setBusy(convertAccnrBtn, "Converting...");
				resultEl.textContent = "Running accnr conversion...";
				try {
					const response = await postJson("/api/tools/convert-transactional-accnr", {});
					resultEl.textContent =
						"Conversion completed.\n\n" +
						"Full Response:\n" + stringify(response);
				} catch (err) {
					resultEl.textContent = "Conversion failed.\n\n" + (err.message || String(err));
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
