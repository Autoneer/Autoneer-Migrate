if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/public/service-worker.js");
}

const progressEl = document.getElementById("progress");
if (progressEl) {
	const runId = progressEl.getAttribute("data-run-id");
	if (runId) {
		const logEl = document.getElementById("progress-log");
		const tableProgressEl = document.getElementById("table-progress");
		const summaryTablesEl = document.getElementById("summary-tables");
		const summaryRowsEl = document.getElementById("summary-rows");
		const summaryDuplicatesEl = document.getElementById("summary-duplicates");
		const summaryErrorsEl = document.getElementById("summary-errors");
		const tableState = new Map();
		let tablesTotal = 0;

		const formatNumber = (value) => {
			if (value === null || value === undefined) return "0";
			return Number(value).toLocaleString();
		};

		const formatPercent = (value) => {
			if (!Number.isFinite(value)) return "0%";
			return `${value.toFixed(1)}%`;
		};

		const ensureTableRow = (table) => {
			let row = document.getElementById(`table-${table}`);
			if (!row && tableProgressEl) {
				row = document.createElement("div");
				row.className = "table-progress-row";
				row.id = `table-${table}`;
				row.innerHTML = `
					<div class="table-progress-header">
						<strong class="table-name"></strong>
						<span class="table-stats"></span>
					</div>
					<div class="progress-bar">
						<div class="progress-bar-fill"></div>
					</div>
					<div class="table-meta">
						<span class="table-errors"></span>
						<span class="table-duplicates"></span>
						<span class="table-last-error"></span>
					</div>
				`;
				tableProgressEl.appendChild(row);
			}
			return row;
		};

		const renderTableRow = (table, data) => {
			const row = ensureTableRow(table);
			if (!row) return;
			row.querySelector(".table-name").textContent = table;
			row.querySelector(".table-stats").textContent = `${formatNumber(data.rows_migrated)}/${formatNumber(
				data.rows_source
			)} (${formatPercent(data.percent)})`;
			row.querySelector(".progress-bar-fill").style.width = `${Math.min(data.percent || 0, 100)}%`;
			row.querySelector(".table-errors").textContent = `Errors: ${formatNumber(data.rows_error)}`;
			row.querySelector(".table-duplicates").textContent = `Duplicates: ${formatNumber(
				data.rows_skipped_duplicates
			)}`;
			row.querySelector(".table-last-error").textContent = data.last_error
				? `Last error: ${data.last_error}`
				: "";
			row.dataset.status = data.status || "running";
		};

		const updateSummary = () => {
			if (!summaryTablesEl || !summaryRowsEl || !summaryErrorsEl || !summaryDuplicatesEl) return;
			let tablesDone = 0;
			let rowsMigrated = 0;
			let rowsError = 0;
			let rowsSkippedDuplicates = 0;
			for (const [, data] of tableState) {
				rowsMigrated += data.rows_migrated || 0;
				rowsError += data.rows_error || 0;
				rowsSkippedDuplicates += data.rows_skipped_duplicates || 0;
				if (data.status === "finished" || data.status === "failed" || data.status === "warning") {
					tablesDone += 1;
				}
			}
			summaryTablesEl.textContent = `${tablesDone}/${tablesTotal}`;
			summaryRowsEl.textContent = formatNumber(rowsMigrated);
			summaryDuplicatesEl.textContent = formatNumber(rowsSkippedDuplicates);
			summaryErrorsEl.textContent = formatNumber(rowsError);
		};

		const source = new EventSource(`/events?runId=${runId}`);
		source.onmessage = (event) => {
			const data = JSON.parse(event.data);
			if (data.type === "run_started" && typeof data.tables_total === "number") {
				tablesTotal = data.tables_total;
			}

			if (data.type === "table_started") {
				const entry = {
					rows_source: data.rows_source || 0,
					rows_migrated: 0,
					rows_error: 0,
					rows_skipped_duplicates: 0,
					percent: 0,
					status: "running",
					last_error: ""
				};
				tableState.set(data.table, entry);
				renderTableRow(data.table, entry);
			}

			if (data.type === "table_progress") {
				const entry = tableState.get(data.table) || {
					rows_source: data.rows_source || 0,
					rows_migrated: 0,
					rows_error: 0,
					rows_skipped_duplicates: 0,
					percent: 0,
					status: "running",
					last_error: ""
				};
				entry.rows_source = data.rows_source || entry.rows_source;
				entry.rows_migrated = data.rows_migrated || 0;
				entry.rows_error = data.rows_error || 0;
				entry.rows_skipped_duplicates = data.rows_skipped_duplicates || 0;
				entry.percent = data.percent || 0;
				tableState.set(data.table, entry);
				renderTableRow(data.table, entry);
			}

			if (data.type === "table_failed") {
				const entry = tableState.get(data.table) || {
					rows_source: data.rows_source || 0,
					rows_migrated: data.rows_migrated || 0,
					rows_error: data.rows_error || 0,
					rows_skipped_duplicates: data.rows_skipped_duplicates || 0,
					percent: data.percent || 0,
					status: "failed",
					last_error: data.error || ""
				};
				entry.status = "failed";
				entry.last_error = data.error || entry.last_error;
				tableState.set(data.table, entry);
				renderTableRow(data.table, entry);
			}

			if (data.type === "table_finished") {
				const entry = tableState.get(data.table) || {
					rows_source: data.rows_source || 0,
					rows_migrated: data.rows_migrated || 0,
					rows_error: data.rows_error || 0,
					rows_skipped_duplicates: data.rows_skipped_duplicates || 0,
					percent: data.percent || 0,
					status: "finished",
					last_error: ""
				};
				entry.rows_source = data.rows_source || entry.rows_source;
				entry.rows_migrated = data.rows_migrated || entry.rows_migrated;
				entry.rows_error = data.rows_error || entry.rows_error;
				entry.rows_skipped_duplicates =
					data.rows_skipped_duplicates || entry.rows_skipped_duplicates;
				entry.percent = data.percent || entry.percent;
				entry.status = entry.rows_error > 0 ? "warning" : "finished";
				tableState.set(data.table, entry);
				renderTableRow(data.table, entry);
			}

			updateSummary();

			const linePrefix = `[${new Date().toLocaleTimeString()}]`;
			let line = `${linePrefix} ${data.type} ${data.table || ""}`;
			if (data.type === "table_progress") {
				line = `${linePrefix} ${data.table}: ${formatNumber(data.rows_migrated)}/${formatNumber(
					data.rows_source
				)} (${formatPercent(data.percent)}) errors: ${formatNumber(
					data.rows_error
				)} duplicates: ${formatNumber(data.rows_skipped_duplicates)}`;
			}
			if (data.type === "table_failed") {
				line = `${linePrefix} ${data.table} failed: ${data.error} ${data.hint ? `• ${data.hint}` : ""}`;
			}
			if (data.type === "run_failed") {
				line = `${linePrefix} Run failed: ${data.error} ${data.hint ? `• ${data.hint}` : ""}`;
			}
			if (logEl) {
				logEl.textContent = `${line}\n${logEl.textContent}`;
			}

			if (data.type === "run_finished" || data.type === "run_failed") {
				source.close();
			}
		};
	}
}

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
