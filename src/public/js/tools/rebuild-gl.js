(function () {
	async function showResult(msg, isErr) {
		if (window.Modal && typeof window.Modal.alert === "function") {
			await window.Modal.alert({
				title: isErr ? "Rebuild Failed" : "Rebuild Complete",
				message: msg,
				type: isErr ? "error" : "success",
				confirmText: "OK"
			});
			return;
		}

		alert(msg);
	}

	async function run() {
		const btn = document.getElementById("btn-rebuild-gl");
		if (!btn) return;

		btn.addEventListener("click", async (event) => {
			event.preventDefault();

			const ok = window.Modal && typeof window.Modal.confirm === "function"
				? await window.Modal.confirm({
					title: "Rebuild GL Accounts",
					message:
						"This will TRUNCATE gl_accounts and rebuild it from staging accounts. If GL journals already exist, you must choose whether to wipe them too. Continue?",
					type: "warning",
					confirmText: "Continue",
					cancelText: "Cancel"
				})
				: confirm(
					"This will TRUNCATE gl_accounts and rebuild it from staging accounts.\n\n" +
					"If gl journals already exist, you must choose whether to wipe them too.\n\n" +
					"Continue?"
				);
			if (!ok) return;

			const wipeJournals = window.Modal && typeof window.Modal.confirm === "function"
				? await window.Modal.confirm({
					title: "GL Journals",
					message:
						"Wipe GL journals too? Continue to truncate gl_journal_headers + gl_journal_lines, or cancel to keep journals (procedure will refuse if journals exist).",
					type: "warning",
					confirmText: "Wipe Journals",
					cancelText: "Keep Journals"
				})
				: confirm(
					"Wipe GL journals too?\n\n" +
					"OK = truncate gl_journal_headers + gl_journal_lines as well.\n" +
					"Cancel = keep journals (procedure will refuse if journals exist)."
				);

			btn.disabled = true;
			const oldText = btn.textContent;
			btn.textContent = "Rebuilding...";

			try {
				const api = new APIClient("/api");
				const resp = await api.post("/tools/rebuild-gl", { truncateJournals: wipeJournals });
				console.log("Rebuild response:", resp);

				// Build result message including GL validation summary
				let msg = "GL rebuild complete.";
				if (resp && resp.gl_account_types_valid === false) {
					msg += "\n\n⚠ gl_account_types validation failed.";
					if (Array.isArray(resp.gl_account_types_errors)) {
						msg += "\n" + resp.gl_account_types_errors.join("\n");
					}
				}
				if (resp && resp.gl_validation && !resp.gl_validation.allPassed) {
					const checks = resp.gl_validation.checks || [];
					const failed = checks.filter(function (c) { return !c.passed; });
					if (failed.length > 0) {
						msg += "\n\n⚠ GL Validation: " + failed.length + " check(s) failed:";
						failed.forEach(function (c) {
							msg += "\n  • " + c.name + ": " + (c.summary || c.error || "FAIL");
						});
					}
				}

				const hasWarnings = (resp && resp.gl_account_types_valid === false) ||
					(resp && resp.gl_validation && !resp.gl_validation.allPassed);
				await showResult(msg, false);
				if (hasWarnings) {
					console.warn("GL rebuild completed with validation warnings:", resp);
				}
			} catch (e) {
				await showResult(e && e.message ? e.message : "Rebuild failed", true);
			} finally {
				btn.disabled = false;
				btn.textContent = oldText;
			}
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", run);
	} else {
		run();
	}
})();
