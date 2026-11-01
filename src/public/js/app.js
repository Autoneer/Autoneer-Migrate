if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/public/service-worker.js");
}

// App menu fold: the round button at the bottom of the sidebar folds/unfolds it on every page, and the choice is remembered.
// The wizard folds it for a session without remembering (see MigrationWizard.updateSidebar).
const appShell = document.querySelector(".app");
const sidebarToggle = document.querySelector(".sidebar-toggle");
const storedSidebarCollapsed = () => {
	try {
		return localStorage.getItem("sidebarCollapsed") === "1";
	} catch {
		return false;
	}
};
window.setSidebarCollapsed = (collapsed, remember = true) => {
	if (!appShell || !sidebarToggle) return;
	appShell.classList.toggle("sidebar-collapsed", collapsed);
	sidebarToggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
	sidebarToggle.setAttribute("aria-label", sidebarToggle.title);
	sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
	if (!remember) return;
	try {
		localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
	} catch {}
};
window.restoreSidebar = () => window.setSidebarCollapsed(storedSidebarCollapsed(), false);
if (appShell && sidebarToggle) {
	sidebarToggle.addEventListener("click", () => window.setSidebarCollapsed(!appShell.classList.contains("sidebar-collapsed")));
	window.restoreSidebar();
}

const progressEl = document.getElementById("progress");
if (progressEl) {
	const runId = progressEl.getAttribute("data-run-id");
	const runForm = document.getElementById("run-form");
	const runButton = document.getElementById("run-migration-btn");
	const tableBody = document.getElementById("table-progress-body");
	const overallFill = document.getElementById("overall-progress-fill");
	const overallText = document.getElementById("overall-progress-text");
	const currentStepEl = document.getElementById("current-step");
	const statusLineEl = document.getElementById("run-status-line");
	const disconnectedEl = document.getElementById("progress-disconnected");
	const failureHintEl = document.getElementById("run-failure-hint");
	const failureModal = document.getElementById("failure-modal");
	const failureMessage = document.getElementById("failure-message");
	const failureDetailsBtn = document.getElementById("failure-details-btn");
	const fixModal = document.getElementById("fix-modal");
	const fixTableEl = document.getElementById("fix-table");
	const fixStepEl = document.getElementById("fix-step");
	const fixCauseEl = document.getElementById("fix-cause");
	const fixErrorEl = document.getElementById("fix-error");
	const fixStepsEl = document.getElementById("fix-steps");
	const fixDetailsToggle = document.getElementById("fix-details-toggle");
	const fixDetailsPanel = document.getElementById("fix-details");
	const successModal = document.getElementById("success-modal");
	const successSummary = document.getElementById("success-summary");
	const stopRunBtn = document.getElementById("stop-run-btn");
	const logPanel = document.getElementById("run-log");
	const tableSuccessModal = document.getElementById("table-success-modal");
	const tableSuccessName = document.getElementById("table-success-name");
	const tableSuccessMode = document.getElementById("table-success-mode");
	const tableSuccessCleaned = document.getElementById("table-success-cleaned");
	const tableSuccessSource = document.getElementById("table-success-source");
	const tableSuccessInserted = document.getElementById("table-success-inserted");
	const tableSuccessUpdated = document.getElementById("table-success-updated");
	const tableSuccessSkipped = document.getElementById("table-success-skipped");
	const tableSuccessErrors = document.getElementById("table-success-errors");
	const tableSuccessDuration = document.getElementById("table-success-duration");
	const cleanAllToggle = document.getElementById("clean-all-toggle");
	const cleanTableList = document.getElementById("clean-table-list");
	let lastStatus = null;
	let latestRunState = null;
	let source = null;
	let reconnectTimer = null;
	let reconnectDelay = 1000;
	let shouldReconnect = true;
	const tableStatusCache = new Map();

	const formatNumber = (value) => {
		if (value === null || value === undefined) return "0";
		return Number(value).toLocaleString();
	};

	const formatDuration = (ms) => {
		if (!ms || Number.isNaN(Number(ms))) return "-";
		const seconds = Math.round(Number(ms) / 1000);
		return `${seconds}s`;
	};

	const openModal = (modal) => {
		if (!modal) return;
		modal.classList.add("show");
		modal.setAttribute("aria-hidden", "false");
	};

	const closeModal = (modal) => {
		if (!modal) return;
		modal.classList.remove("show");
		modal.setAttribute("aria-hidden", "true");
	};

	// Modal close handlers for run-related modals are registered here when the run UI is present.
	// (A global handler is also added outside this block for pages without the run UI.)

	const buildLikelyCause = (message) => {
		const lower = String(message || "").toLowerCase();
		if (lower.includes("connection lost")) {
			return {
				cause: "The connection to the database was interrupted.",
				steps: [
					"Confirm the database service is running.",
					"Confirm the host, port, and credentials are correct.",
					"Confirm network connectivity, then recheck connections."
				]
			};
		}
		if (lower.includes("access denied")) {
			return {
				cause: "Your MySQL user does not have permission to write to this table.",
				steps: [
					"Confirm the MySQL user has INSERT/UPDATE privileges.",
					"Re-run the migration after permissions are fixed."
				]
			};
		}
		if (lower.includes("unknown column")) {
			return {
				cause: "A required column is missing from the target table.",
				steps: [
					"Verify the column exists in MySQL.",
					"Update the mapping or adjust the schema, then try again."
				]
			};
		}
		if (lower.includes("login failed") || lower.includes("user name and password")) {
			return {
				cause: "Login failed. The credentials or connection details are incorrect.",
				steps: [
					"Check the Firebird/MySQL credentials in Setup.",
					"Confirm the server and port are correct, then try again."
				]
			};
		}
		if (lower.includes("etimedout") || lower.includes("econnreset") || lower.includes("timeout")) {
			return {
				cause: "Network or timeout issue while communicating with the database.",
				steps: [
					"Confirm the database server is reachable.",
					"Retry once connectivity is stable."
				]
			};
		}
		return {
			cause: "Unexpected error. Review the message below for more context.",
			steps: [
				"Review the error message and confirm the mapping and schema.",
				"Fix the issue and try again."
			]
		};
	};

	const renderTableRow = (table) => {
		if (!tableBody) return;
		let row = document.getElementById(`table-row-${table.name}`);
		if (!row) {
			row = document.createElement("tr");
			row.id = `table-row-${table.name}`;
			row.innerHTML = `
				<td class="table-label"></td>
				<td class="table-status"></td>
				<td class="table-progress"></td>
				<td class="table-duplicates"></td>
				<td class="table-errors"></td>
			`;
			tableBody.appendChild(row);
		}
		const label = table.label || table.name;
		row.querySelector(".table-label").textContent = label;
		const statusEl = row.querySelector(".table-status");
		const status = (table.status || "QUEUED").toLowerCase();
		const statusTextMap = {
			queued: "Queued",
			running: "Migrating",
			success: "Completed",
			failed: "Failed",
			skipped: "Skipped",
			not_run: "Not run"
		};
		statusEl.innerHTML = `<span class="status-badge ${status}">${statusTextMap[status] || "Queued"}${status === "running" ? " <span class=\"spinner\"></span>" : ""
			}</span>`;
		const progressEl = row.querySelector(".table-progress");
		if (table.total) {
			const read = table.migrated || 0;
			const inserted = table.inserted || 0;
			const updated = table.updated || 0;
			// Show detailed breakdown: read / total (inserted+updated breakdown)
			if (inserted > 0 || updated > 0) {
				const parts = [];
				if (inserted > 0) parts.push(`${formatNumber(inserted)} ins`);
				if (updated > 0) parts.push(`${formatNumber(updated)} upd`);
				progressEl.textContent = `${formatNumber(read)} / ${formatNumber(table.total)} (${parts.join(', ')})`;
			} else {
				progressEl.textContent = `${formatNumber(read)} / ${formatNumber(table.total)}`;
			}
		} else {
			const inserted = table.inserted || 0;
			const updated = table.updated || 0;
			const parts = [];
			if (inserted > 0) parts.push(`${formatNumber(inserted)} ins`);
			if (updated > 0) parts.push(`${formatNumber(updated)} upd`);
			const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
			progressEl.innerHTML = `<span class="row-progress">${formatNumber(
				table.migrated
			)} rows${detail} ${status === "running" ? "<span class=\"spinner\"></span>" : ""}</span>`;
		}
		row.querySelector(".table-errors").textContent = formatNumber(table.errors || 0);
		const duplicatesEl = row.querySelector(".table-duplicates");
		if (duplicatesEl) {
			duplicatesEl.textContent = formatNumber(table.skippedDuplicates || 0);
		}
	};

	const renderRunState = (runState) => {
		if (!runState) return;
		latestRunState = runState;
		if (disconnectedEl) disconnectedEl.hidden = true;
		const tables = runState.tables || [];
		if (tableBody) {
			tableBody.innerHTML = "";
			tables.forEach(renderTableRow);
		}

		tables.forEach((table) => {
			const prev = tableStatusCache.get(table.name) || null;
			if (table.status === "SUCCESS" && (table.errors || 0) === 0 && prev && prev !== "SUCCESS" && runState.status === "RUNNING") {
				if (tableSuccessName) tableSuccessName.textContent = table.label || table.name;
				if (tableSuccessMode) tableSuccessMode.textContent = table.mode || "";
				if (tableSuccessCleaned) tableSuccessCleaned.textContent = table.cleaned ? "Yes" : "No";
				if (tableSuccessSource) tableSuccessSource.textContent = formatNumber(table.total || 0);
				if (tableSuccessInserted) tableSuccessInserted.textContent = formatNumber(table.inserted || 0);
				if (tableSuccessUpdated) tableSuccessUpdated.textContent = formatNumber(table.updated || 0);
				if (tableSuccessSkipped) tableSuccessSkipped.textContent = formatNumber(table.skippedDuplicates || 0);
				if (tableSuccessErrors) tableSuccessErrors.textContent = formatNumber(table.errors || 0);
				if (tableSuccessDuration) tableSuccessDuration.textContent = formatDuration(table.durationMs || 0);
				openModal(tableSuccessModal);
			}
			tableStatusCache.set(table.name, table.status);
		});
		const doneCount = tables.filter((table) => ["SUCCESS", "FAILED", "SKIPPED"].includes(table.status)).length;
		const totalCount = tables.length;
		const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
		if (overallFill) overallFill.style.width = `${percent}%`;
		if (overallText) overallText.textContent = `${doneCount} of ${totalCount} tables completed`;
		const currentTable = runState.currentTable ? tables.find((t) => t.name === runState.currentTable) : null;
		if (currentStepEl) {
			if (runState.status === "RUNNING" && currentTable) {
				const read = currentTable.migrated || 0;
				const inserted = currentTable.inserted || 0;
				const updated = currentTable.updated || 0;
				const parts = [];
				if (inserted > 0) parts.push(`${formatNumber(inserted)} inserted`);
				if (updated > 0) parts.push(`${formatNumber(updated)} updated`);
				const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
				currentStepEl.textContent = `Current step: Migrating ${currentTable.label || currentTable.name}... ${formatNumber(
					read
				)} rows read${detail}`;
			} else if (runState.status === "FAILED" && currentTable) {
				currentStepEl.textContent = `Current step: Stopped due to error on ${currentTable.label || currentTable.name}`;
			} else if (runState.status === "SUCCESS") {
				currentStepEl.textContent = "Current step: Completed";
			} else {
				currentStepEl.textContent = "Current step: Not started";
			}
		}
		if (statusLineEl) {
			statusLineEl.textContent = `Status: ${runState.status}`;
		}
		if (runButton) {
			runButton.disabled = runState.status === "RUNNING";
		}
		if (stopRunBtn) {
			stopRunBtn.disabled = runState.status !== "RUNNING";
		}
		if (failureHintEl) {
			failureHintEl.hidden = runState.status !== "FAILED";
		}

		if (runState.status !== lastStatus) {
			if (runState.status === "FAILED") {
				const failedTable = tables.find((table) => table.status === "FAILED") || currentTable;
				const tableLabel = failedTable?.label || failedTable?.name || (runState.lastError ? "preflight" : "the current table");
				if (failureMessage) {
					const baseMessage = runState.lastError?.message || null;
					failureMessage.textContent = baseMessage || `The migration stopped while migrating ${tableLabel}.`;
				}
				openModal(failureModal);
				shouldReconnect = false;
			} else if (runState.status === "SUCCESS") {
				const succeeded = tables.filter((table) => table.status === "SUCCESS").length;
				const totalRead = tables.reduce((sum, table) => sum + (table.migrated || 0), 0);
				const totalInserted = tables.reduce((sum, table) => sum + (table.inserted || 0), 0);
				const totalUpdated = tables.reduce((sum, table) => sum + (table.updated || 0), 0);
				const totalSkipped = tables.reduce((sum, table) => sum + (table.skippedDuplicates || 0), 0);
				const totalErrors = tables.reduce((sum, table) => sum + (table.errors || 0), 0);
				if (successSummary) {
					const parts = [
						`${succeeded} tables migrated successfully`,
						`${formatNumber(totalRead)} rows read`,
						`${formatNumber(totalInserted)} inserted`,
						`${formatNumber(totalUpdated)} updated`,
						`${formatNumber(totalSkipped)} skipped (duplicates)`,
						`${formatNumber(totalErrors)} errors`
					];
					successSummary.textContent = parts.join(' • ');
				}
				openModal(successModal);
				shouldReconnect = false;
			}
			lastStatus = runState.status;
		}
	};

	if (failureDetailsBtn) {
		failureDetailsBtn.addEventListener("click", () => {
			closeModal(failureModal);
			const tables = latestRunState?.tables || [];
			const failedTable = tables.find((table) => table.status === "FAILED") || null;
			const fallbackMessage = failureMessage?.textContent || "Unknown error";
			const message = failedTable?.lastError?.message || latestRunState?.lastError?.message || fallbackMessage;
			const step = failedTable?.lastError?.phase || latestRunState?.lastError?.phase || "unknown";
			const { cause, steps } = buildLikelyCause(message);
			if (fixTableEl) {
				fixTableEl.textContent = failedTable?.label || failedTable?.name || (step === "preflight" ? "Connections" : "Unknown");
			}
			if (fixStepEl) fixStepEl.textContent = step;
			if (fixCauseEl) fixCauseEl.textContent = cause;
			if (fixErrorEl) fixErrorEl.value = message;
			if (fixStepsEl) {
				fixStepsEl.innerHTML = "";
				steps.forEach((step) => {
					const li = document.createElement("li");
					li.textContent = step;
					fixStepsEl.appendChild(li);
				});
			}
			if (fixDetailsPanel) {
				fixDetailsPanel.hidden = true;
			}
			if (fixDetailsToggle) {
				fixDetailsToggle.textContent = "Show debug details";
			}
			openModal(fixModal);
		});
	}

	if (fixDetailsToggle && fixDetailsPanel) {
		fixDetailsToggle.addEventListener("click", () => {
			const isHidden = fixDetailsPanel.hidden;
			fixDetailsPanel.hidden = !isHidden;
			fixDetailsToggle.textContent = isHidden ? "Hide debug details" : "Show debug details";
		});
	}

	if (stopRunBtn) {
		stopRunBtn.addEventListener("click", async () => {
			if (!runId) return;
			const confirmed = await Modal.confirm({
				title: 'Stop Migration',
				message: 'Stop this migration run?',
				type: 'warning',
				confirmText: 'Stop',
				cancelText: 'Cancel'
			});
			if (!confirmed) return;
			stopRunBtn.disabled = true;
			try {
				await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
					method: "POST",
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				// ignore
			}
		});
	}

	const connectEventSource = () => {
		if (!runId || !shouldReconnect) return;
		if (source) {
			source.close();
			source = null;
		}
		source = new EventSource(`/run/progress?runId=${runId}`);
		source.addEventListener("runState", (event) => {
			const runState = JSON.parse(event.data);
			renderRunState(runState);
			if (runState.status === "FAILED" || runState.status === "SUCCESS") {
				shouldReconnect = false;
				source.close();
			}
		});
		source.addEventListener("log", (event) => {
			if (!logPanel) return;
			try {
				const entry = JSON.parse(event.data);
				logPanel.textContent += `${JSON.stringify(entry)}\n`;
				logPanel.scrollTop = logPanel.scrollHeight;
			} catch (e) {
				// ignore
			}
		});
		source.onopen = () => {
			if (disconnectedEl) disconnectedEl.hidden = true;
			reconnectDelay = 1000;
			if (runId) {
				fetch(`/migrate/run/${runId}/status`, { cache: "no-store" })
					.then((res) => res.ok ? res.json() : null)
					.then((data) => {
						if (data?.tables && data.status) {
							renderRunState({
								...latestRunState,
								status: data.status.toUpperCase(),
								tables: data.tables
							});
						}
					});
			}
		};
		source.onerror = () => {
			if (!shouldReconnect) return;
			if (disconnectedEl) disconnectedEl.hidden = false;
			if (source) {
				source.close();
				source = null;
			}
			if (reconnectTimer) return;
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = null;
				reconnectDelay = Math.min(reconnectDelay * 2, 10000);
				connectEventSource();
			}, reconnectDelay);
		};
	};

	if (runId) {
		connectEventSource();
	}

	if (cleanAllToggle && cleanTableList) {
		cleanAllToggle.addEventListener("change", () => {
			const checkboxes = cleanTableList.querySelectorAll(".clean-table-checkbox");
			checkboxes.forEach((box) => {
				box.checked = cleanAllToggle.checked;
			});
		});
	}
}

// Global modal-close handler for any modal on the page. This runs regardless of the run UI.
document.querySelectorAll("[data-modal-close]").forEach((btn) => {
	// Avoid attaching multiple handlers if a handler was already bound earlier
	if (btn.dataset.modalCloseBound) return;
	btn.addEventListener("click", () => {
		const target = btn.getAttribute("data-modal-close");
		const modal = document.getElementById(target);
		if (!modal) return;
		modal.classList.remove("show");
		modal.setAttribute("aria-hidden", "true");
	});
	btn.dataset.modalCloseBound = "1";
});

// Escape or a click on the backdrop closes the open status dialog.
const closeStatusDialog = (modal) => {
	modal.classList.remove("show");
	modal.setAttribute("aria-hidden", "true");
};
document.querySelectorAll(".modal").forEach((modal) => {
	if (!modal.querySelector(".status-dialog")) return;
	modal.addEventListener("click", (event) => {
		if (event.target === modal) closeStatusDialog(modal);
	});
});
document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	document.querySelectorAll(".modal.show").forEach((modal) => {
		if (modal.querySelector(".status-dialog")) closeStatusDialog(modal);
	});
});

document.querySelectorAll("[data-toggle]").forEach((button) => {
	button.addEventListener("click", () => {
		const targetId = button.getAttribute("data-toggle");
		const card = document.getElementById(targetId);
		if (!card) return;
		const body = card.querySelector(".card-body");
		if (!body) return;
		body.classList.toggle("collapsed");
		button.textContent = body.classList.contains("collapsed") ? "Expand" : "Collapse";
	});
});

// Collapsible cards: the header strip, or the chevron at a card's top right, folds it to its heading.
// A page can add a "Collapse all" button (#cards-collapse-all) and a remembered "One card only" switch (#cards-one-only):
// with the switch on, a card taking focus folds every other card.
const collapsibleCards = Array.from(document.querySelectorAll(".card.collapsible"));
const collapseAllButton = document.getElementById("cards-collapse-all");
const oneCardSwitch = document.getElementById("cards-one-only");
const syncCollapseAll = () => {
	if (collapseAllButton) collapseAllButton.textContent = collapsibleCards.some((card) => !card.classList.contains("is-collapsed")) ? "Collapse all" : "Expand all";
};
const setCardCollapsed = (card, collapsed) => {
	card.classList.toggle("is-collapsed", collapsed);
	const button = card.querySelector(":scope > .card-collapse");
	button.title = collapsed ? "Expand" : "Collapse";
	button.setAttribute("aria-expanded", String(!collapsed));
	syncCollapseAll();
};
const collapseOtherCards = (keep) => {
	if (!oneCardSwitch?.checked) return;
	collapsibleCards.forEach((card) => {
		if (card !== keep) setCardCollapsed(card, true);
	});
};
let lastFocusedCard = null;
let pointerDown = false;
let pendingFocusCard = null;
collapsibleCards.forEach((card) => {
	const toggle = () => setCardCollapsed(card, !card.classList.contains("is-collapsed"));
	card.querySelector(":scope > .card-collapse").addEventListener("click", toggle);
	card.querySelector(":scope > h3").addEventListener("click", toggle);
	card.addEventListener("focusin", () => {
		lastFocusedCard = card;
		// A mouse click folds the others once it has landed, so the cards don't shift under the pointer mid-click.
		if (pointerDown) pendingFocusCard = card;
		else collapseOtherCards(card);
	});
});
const endPointer = () => {
	pointerDown = false;
	const card = pendingFocusCard;
	pendingFocusCard = null;
	if (card) setTimeout(() => collapseOtherCards(card));
};
document.addEventListener("pointerdown", () => { pointerDown = true; });
document.addEventListener("pointerup", endPointer);
document.addEventListener("pointercancel", endPointer);
collapseAllButton?.addEventListener("click", () => {
	const collapse = collapsibleCards.some((card) => !card.classList.contains("is-collapsed"));
	collapsibleCards.forEach((card) => setCardCollapsed(card, collapse));
});
if (oneCardSwitch) {
	try {
		oneCardSwitch.checked = localStorage.getItem("cardsOneOnly") === "1";
	} catch {}
	// Switching on (or loading with it on) keeps the last focused card, else the first open one, and folds the rest.
	const keepOneCard = () => collapseOtherCards(lastFocusedCard ?? collapsibleCards.find((card) => !card.classList.contains("is-collapsed")));
	oneCardSwitch.addEventListener("change", () => {
		try {
			localStorage.setItem("cardsOneOnly", oneCardSwitch.checked ? "1" : "0");
		} catch {}
		keepOneCard();
	});
	keepOneCard();
}
syncCollapseAll();

const nextPlan = document.getElementById("next-plan");
const loadingModal = document.getElementById("loading-modal");
if (nextPlan && loadingModal) {
	nextPlan.addEventListener("click", () => {
		loadingModal.classList.add("show");
		loadingModal.setAttribute("aria-hidden", "false");
	});
}

const checkAllBtn = document.getElementById("check-all-tables");
const uncheckAllBtn = document.getElementById("uncheck-all-tables");

if (checkAllBtn || uncheckAllBtn) {
	const getIncludeCheckboxes = () =>
		Array.from(document.querySelectorAll('input[type="checkbox"][name^="include_"]'));

	if (checkAllBtn) {
		checkAllBtn.addEventListener("click", () => {
			getIncludeCheckboxes().forEach((cb) => {
				cb.checked = true;
			});
		});
	}

	if (uncheckAllBtn) {
		uncheckAllBtn.addEventListener("click", () => {
			getIncludeCheckboxes().forEach((cb) => {
				cb.checked = false;
			});
		});
	}
}
