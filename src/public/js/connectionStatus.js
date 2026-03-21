(() => {
	const statusArea = document.getElementById("conn-status");
	if (!statusArea) return;

	const firebirdBadge = document.getElementById("conn-badge-firebird");
	const mysqlBadge = document.getElementById("conn-badge-mysql");
	const modal = document.getElementById("conn-modal");
	const firebirdStatusEl = document.getElementById("conn-modal-firebird-status");
	const firebirdDetailsEl = document.getElementById("conn-modal-firebird-details");
	const mysqlStatusEl = document.getElementById("conn-modal-mysql-status");
	const mysqlDetailsEl = document.getElementById("conn-modal-mysql-details");
	const lastCheckedEl = document.getElementById("conn-last-checked");
	const recheckBtn = document.getElementById("conn-recheck-btn");
	const runStatusLine = document.getElementById("run-status-line");
	const runWarning = document.getElementById("conn-warning");
	const runWarningText = document.getElementById("conn-warning-text");
	const progressEl = document.getElementById("progress");

	let consecutiveFailures = 0;
	let abortInProgress = false;
	let pollTimer = null;
	const MAX_FAILURES = 6;

	const formatStatusLabel = (status) => {
		switch (status) {
			case "CONNECTED":
				return "Connected";
			case "DISCONNECTED":
				return "Not connected";
			case "NOT_CONFIGURED":
				return "Not configured yet";
			default:
				return "Checking...";
		}
	};

	const setBadge = (el, name, status) => {
		if (!el) return;
		const lower = status ? status.toLowerCase() : "";
		el.classList.remove("connected", "disconnected", "not_configured");
		if (lower) {
			el.classList.add(lower);
		}
		el.textContent = `${name}: ${formatStatusLabel(status)}`;
	};

	const openModal = (target) => {
		if (!target) return;
		target.classList.add("show");
		target.setAttribute("aria-hidden", "false");
	};

	const showWarning = (message) => {
		if (!runWarning) return;
		if (runWarningText) runWarningText.textContent = message;
		runWarning.hidden = false;
	};

	const hideWarning = () => {
		if (!runWarning) return;
		runWarning.hidden = true;
		if (runWarningText) runWarningText.textContent = "";
	};

	const updateModal = (data, ts) => {
		if (firebirdStatusEl) firebirdStatusEl.textContent = formatStatusLabel(data.firebird?.status);
		if (firebirdDetailsEl) firebirdDetailsEl.textContent = data.firebird?.details || data.firebird?.message || "";
		if (mysqlStatusEl) mysqlStatusEl.textContent = formatStatusLabel(data.mysql?.status);
		if (mysqlDetailsEl) mysqlDetailsEl.textContent = data.mysql?.details || data.mysql?.message || "";
		if (lastCheckedEl) lastCheckedEl.textContent = ts || new Date().toLocaleString();
	};

	const isRunActive = () => {
		if (!progressEl) return false;
		if (!runStatusLine) return false;
		return runStatusLine.textContent.includes("RUNNING");
	};

	const currentRunId = () => {
		return progressEl?.getAttribute("data-run-id");
	};

	const confirmAndAbortIfNeeded = async () => {
		if (abortInProgress) return;
		if (!isRunActive()) return;
		abortInProgress = true;
		const runId = currentRunId();
		if (!runId) {
			abortInProgress = false;
			return;
		}
		try {
			const response = await fetch(`/health/connections?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
			if (!response.ok) throw new Error("Failed");
			const data = await response.json();
			const firebirdDown = data.firebird?.status !== "CONNECTED";
			const mysqlDown = data.mysql?.status !== "CONNECTED";
			if (!firebirdDown && !mysqlDown) {
				consecutiveFailures = 0;
				hideWarning();
				abortInProgress = false;
				return;
			}
		} catch (e) {
			// confirmation check failed
		}

		try {
			await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
				method: "POST",
				headers: { "Content-Type": "application/json" }
			});
		} catch (e) {
			// ignore
		}
		abortInProgress = false;
	};

	const handleRunConnectivityFailure = async () => {
		const runId = currentRunId();
		if (!runId) return;
		consecutiveFailures += 1;
		showWarning(`Connectivity check failed (attempt ${consecutiveFailures} of ${MAX_FAILURES}). Migration will continue unless the runner fails.`);
		if (consecutiveFailures >= MAX_FAILURES) {
			await confirmAndAbortIfNeeded();
		}
	};

	const applyStatus = (data) => {
		setBadge(firebirdBadge, "Firebird", data.firebird?.status || "");
		const mysqlLabel = data.mysql?.schemaName ? `MySQL (${data.mysql.schemaName})` : "MySQL";
		setBadge(mysqlBadge, mysqlLabel, data.mysql?.status || "");
		updateModal(data, data.ts ? new Date(data.ts).toLocaleString() : null);

		if (isRunActive()) {
			if (data.firebird?.status !== "CONNECTED" || data.mysql?.status !== "CONNECTED") {
				handleRunConnectivityFailure();
			} else {
				consecutiveFailures = 0;
				abortInProgress = false;
				hideWarning();
			}
		} else {
			consecutiveFailures = 0;
			abortInProgress = false;
			hideWarning();
		}
	};

	const applyFailure = () => {
		setBadge(firebirdBadge, "Firebird", "DISCONNECTED");
		setBadge(mysqlBadge, "MySQL", "DISCONNECTED");
		updateModal(
			{
				firebird: { status: "DISCONNECTED", message: "Unable to check status" },
				mysql: { status: "DISCONNECTED", message: "Unable to check status" }
			},
			new Date().toLocaleString()
		);
		if (isRunActive()) {
			handleRunConnectivityFailure();
		} else {
			consecutiveFailures = 0;
			abortInProgress = false;
			hideWarning();
		}
	};

	const fetchConnections = async () => {
		try {
			const runId = currentRunId();
			const url = runId ? `/health/connections?runId=${encodeURIComponent(runId)}` : "/health/connections";
			const response = await fetch(url, { cache: "no-store" });
			if (!response.ok) throw new Error("Failed");
			const data = await response.json();
			applyStatus(data);
		} catch (err) {
			applyFailure();
		}
	};

	const nextInterval = () => {
		if (document.body.dataset.page === "run" && isRunActive()) return 4000;
		return 60000;
	};

	const schedulePoll = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(async () => {
			await fetchConnections();
			schedulePoll();
		}, nextInterval());
	};

	statusArea.addEventListener("click", () => openModal(modal));
	statusArea.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			openModal(modal);
		}
	});

	if (recheckBtn) {
		recheckBtn.addEventListener("click", () => {
			fetchConnections();
		});
	}

	fetchConnections().then(schedulePoll);
})();
