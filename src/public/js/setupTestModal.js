(() => {
	const dataEl = document.getElementById("test-result-data");
	const modal = document.getElementById("testResultModal");
	if (!dataEl || !modal) return;

	let payload = null;
	try {
		payload = JSON.parse(dataEl.textContent);
	} catch (err) {
		return;
	}

	const titleEl = document.getElementById("test-result-title");
	const messageEl = document.getElementById("test-result-message");
	const toggleBtn = document.getElementById("test-result-toggle");
	const detailsPanel = document.getElementById("test-result-details");
	const detailsText = document.getElementById("test-result-details-text");

	if (titleEl) titleEl.textContent = payload.title || "Connection result";
	if (messageEl) messageEl.textContent = payload.message || "";
	if (detailsText) detailsText.value = payload.details || "";

	const hasDetails = Boolean(payload.details);
	if (!hasDetails && toggleBtn) {
		toggleBtn.setAttribute("hidden", "true");
	}

	if (toggleBtn && detailsPanel) {
		toggleBtn.addEventListener("click", () => {
			const isHidden = detailsPanel.hasAttribute("hidden");
			if (isHidden) {
				detailsPanel.removeAttribute("hidden");
				toggleBtn.textContent = "Hide details";
			} else {
				detailsPanel.setAttribute("hidden", "true");
				toggleBtn.textContent = "Show details";
			}
		});
	}

	modal.classList.add("show");
	modal.setAttribute("aria-hidden", "false");
})();
