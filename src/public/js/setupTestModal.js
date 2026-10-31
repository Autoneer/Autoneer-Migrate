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

	const dialogEl = document.getElementById("test-result-dialog");
	const titleEl = document.getElementById("test-result-title");
	const messageEl = document.getElementById("test-result-message");
	const detailsEl = document.getElementById("test-result-details");
	const copyBtn = document.getElementById("test-result-copy");

	const isError = payload.status === "error";
	if (dialogEl) dialogEl.classList.add(isError ? "is-error" : "is-success");
	if (titleEl) titleEl.textContent = payload.title || "Connection result";
	if (messageEl) messageEl.textContent = payload.message || "";

	const details = payload.details || "";
	if (details && detailsEl) {
		window.DetailFields.render(detailsEl, details, { variant: isError ? "is-error" : "" });
		detailsEl.removeAttribute("hidden");
	}

	// Error output is worth copying into a support message; success details are short.
	if (copyBtn && details && isError && navigator.clipboard) {
		copyBtn.removeAttribute("hidden");
		copyBtn.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(details);
				copyBtn.textContent = "Copied";
			} catch (err) {
				copyBtn.textContent = "Copy failed";
			}
			setTimeout(() => {
				copyBtn.textContent = "Copy details";
			}, 1500);
		});
	}

	modal.classList.add("show");
	modal.setAttribute("aria-hidden", "false");
	modal.querySelector(".btn.primary")?.focus();
})();
