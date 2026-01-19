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
	const runFailureModal = document.getElementById("failure-modal");
	const runFailureMessage = document.getElementById("failure-message");
	const progressEl = document.getElementById("progress");

	let lastDisconnectHandled = false;
	let pollTimer = null;

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

	const handleRunDisconnect = async (data) => {
		const runId = currentRunId();
		if (!runId) return;
		if (lastDisconnectHandled) return;

		const firebirdDown = data.firebird?.status !== "CONNECTED";
		const mysqlDown = data.mysql?.status !== "CONNECTED";
		const reason = firebirdDown && mysqlDown
			? "Connection lost: Firebird and MySQL"
			: firebirdDown
				? "Connection lost: Firebird"
				: "Connection lost: MySQL";

		lastDisconnectHandled = true;
		if (runFailureMessage) {
			runFailureMessage.textContent = reason;
		}
		if (runFailureModal) {
			openModal(runFailureModal);
		}

		try {
			await fetch("/run/abort", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ runId, reason })
			});
		} catch (e) {
			// ignore
		}
	};

	const applyStatus = (data) => {
		setBadge(firebirdBadge, "Firebird", data.firebird?.status || "");
		setBadge(mysqlBadge, "MySQL", data.mysql?.status || "");
		updateModal(data, data.ts ? new Date(data.ts).toLocaleString() : null);

		if (isRunActive()) {
			if (data.firebird?.status !== "CONNECTED" || data.mysql?.status !== "CONNECTED") {
				handleRunDisconnect(data);
			} else {
				lastDisconnectHandled = false;
			}
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
	};

	const fetchConnections = async () => {
		try {
			const response = await fetch("/health/connections", { cache: "no-store" });
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
