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
				await showResult("GL rebuild complete.", false);
				console.log("Rebuild response:", resp);
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
