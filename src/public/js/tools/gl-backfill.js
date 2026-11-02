(function () {
	const TYPES = {
		CREDITOR_INVOICE: "Supplier invoices",
		REBUILD_STOCK: "Stocked rebuilds",
		DEBTOR_INVOICE: "Customer invoices",
		DEBTOR_PAYMENT: "Customer payments",
		CREDITOR_PAYMENT: "Supplier payments"
	};
	const RUN_STATES = { RUNNING: "Running", DONE: "Done", FAILED: "Failed", CANCELLED: "Cancelled" };
	const { escapeHtml, count, money, localDate, getJson, postJson, table, section, statTiles, setCardDone, setCardChecking, announceChange, timeLeft, formatTimeLeft, workingLine } = window.GlBackfill;

	// " · about 12 min left, done around 14:35" while a stage works; null rate means too early to tell.
	function etaText(key, done, total) {
		const left = timeLeft(key, done, total);
		return left == null ? " · working out the time left" : ` · ${formatTimeLeft(left)}`;
	}

	function accountText(accnr, name) {
		return accnr ? `${accnr}${name ? ` ${escapeHtml(name)}` : ""}` : "-";
	}

	function renderScope(scope, notice) {
		if (!scope.ready) {
			const missing = [...scope.missingTables, ...scope.missingColumns].join(", ");
			return `<p class="gl-backfill-blocked">Schema <strong>${escapeHtml(scope.schema)}</strong> cannot run the backfill. ` +
				`Missing: ${escapeHtml(missing)}. Import into a tenant created by AUTONEER-PWA.</p>`;
		}
		const posted = scope.journals.reduce((sum, row) => sum + row.headers, 0);
		const parts = [
			notice ? `<p class="gl-backfill-ok">${notice}</p>` : "",
			`<p>Schema <strong>${escapeHtml(scope.schema)}</strong>. Documents dated ${escapeHtml(scope.from || "-")} to ` +
			`${escapeHtml(scope.to || "-")}. ${posted ? `${count(posted)} journals already posted.` : "No journals posted yet."}</p>`
		];

		const left = [section("Documents", table(
			[["Type"], ["Rows", "gl-backfill-num"], ["First"], ["Last"]],
			Object.keys(TYPES).map((type) => {
				const dates = scope.dates[type];
				const skipped = scope.skippedTypes[type];
				return `<tr><td>${TYPES[type]}</td><td class="gl-backfill-num">${dates ? count(dates.rows) : "-"}</td>` +
					(skipped
						? `<td colspan="2" class="gl-backfill-warning">Skipped: ${escapeHtml(skipped)}</td>`
						: `<td>${escapeHtml(dates?.from || "-")}</td><td>${escapeHtml(dates?.to || "-")}</td>`) + "</tr>";
			})
		))];
		left.push(section("Closed periods", scope.closedPeriods.length
			? `<p class="gl-backfill-warning">Documents dated in these periods fail: ` +
				`${escapeHtml(scope.closedPeriods.map((p) => `${p.start_date} to ${p.end_date}`).join(", "))}.</p>`
			: "<p>None.</p>"));
		if (scope.journals.length) {
			left.push(section("Journals already posted", table(
				[["Source"], ["Journals", "gl-backfill-num"]],
				scope.journals.map((row) => `<tr><td>${escapeHtml(row.source)}</td><td class="gl-backfill-num">${count(row.headers)}</td></tr>`)
			)));
		}

		// Only the controls that need attention.
		const problems = scope.controls.filter((control) => control.status !== "mapped");
		const controlsBody = !problems.length
			? `<p class="gl-backfill-ok">All ${scope.controls.length} control accounts are mapped.</p>`
			: `<p>${scope.controls.length - problems.length} of ${scope.controls.length} mapped. Fix previews changes first.</p>` + table(
				[["Control"], ["Account"], ["Status"], [""]],
				problems.map((control) => `<tr><td>${escapeHtml(control.label)}</td>` +
					`<td>${accountText(control.accnr, control.name)}</td>` +
					`<td class="gl-backfill-${control.severity}">${escapeHtml(control.reason)}</td>` +
					`<td><button class="btn secondary gl-backfill-fix" type="button" data-fix="${control.key}">Fix</button></td></tr>`)
			);

		parts.push(`<div class="gl-backfill-scope-cols"><div>${left.join("")}</div><div>${section("Control accounts", controlsBody)}</div></div>`);

		const unpaired = scope.unpairedRfcOriginals || [];
		if (unpaired.length) {
			parts.push(section("Supplier invoices that will not post", `<p class="gl-backfill-warning">${count(unpaired.length)} marked RFC-ORIGINAL ` +
				`with no matching -RFC return. RFC migration and the backfill skip them, so fix each one first.</p>` + table(
				[["ID", "gl-backfill-num"], ["Supplier"], ["Invoice"], ["Date"], ["Amount", "gl-backfill-num"], ["Paid", "gl-backfill-num"],
					["Return recorded", "gl-backfill-num"], ["Unpaired return"], [""]],
				unpaired.map((row) => `<tr><td class="gl-backfill-num">${row.sinvid}</td><td>${escapeHtml(row.supplier)}</td>` +
					`<td>${escapeHtml(row.invoiceNr)}</td><td>${escapeHtml(row.date || "-")}</td><td class="gl-backfill-num">${money(row.amount)}</td>` +
					`<td class="gl-backfill-num">${money(row.paid)}</td>` +
					`<td class="gl-backfill-num">${row.returnRecorded ? money(row.returnRecorded) : "-"}</td><td>${escapeHtml(row.unpairedReturns || "-")}</td>` +
					`<td><button class="btn secondary gl-backfill-fix" type="button" data-rfc-fix="${row.sinvid}">Fix</button></td></tr>`)
			) + (unpaired.length >= 200 ? "<p>First 200 shown.</p>" : "")));
		}
		return parts.join("");
	}

	// Each redraw slides a bar from its last width in this run, and the shine keeps
	// its phase, as on the migration scan.
	const barWidths = {};
	function qbar(key, label, value, max, { tone = "", moving = false } = {}) {
		const to = max ? Math.min(100, value / max * 100) : 100;
		const from = key in barWidths ? Math.min(barWidths[key], to) : 0;
		barWidths[key] = to;
		return `<div class="qbar${tone ? ` ${tone}` : ""}${moving ? "" : " still"}" role="progressbar" aria-label="${escapeHtml(label)}" ` +
			`aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}">` +
			`<span style="--from:${from.toFixed(2)}%;--to:${to.toFixed(2)}%;--shine-delay:-${Date.now() % 1800}ms"></span></div>`;
	}

	// Seven dots bouncing in turn. Their phase follows the clock, so the redraw on each poll does not restart them.
	// A live run deleting the journals it replaces, before it posts.
	function renderClearing(clearing, runId) {
		const detail = clearing.total == null ? "Finding them"
			: `${count(clearing.deleted)} of ${count(clearing.total)} journals${etaText(`${runId}:clearing`, clearing.deleted, clearing.total)}`;
		return workingLine("Deleting existing journals…", detail);
	}

	function barHead(title, detail, value, max) {
		const percent = max ? Math.min(100, Math.floor(value / max * 100)) : 100;
		return `<div class="gl-backfill-bar-head"><span><strong>${title}</strong> · ${detail}</span><strong>${percent}%</strong></div>`;
	}

	// The overall bar, then one per selected document type in posting order.
	function renderBars(run, summary, running) {
		const finished = run.status === "DONE";
		const processed = Number(summary.processedDocs || 0);
		const total = Number(summary.totalDocs || 0);
		const overall = total ? [processed, total] : [finished ? 1 : 0, 1];
		const parts = [`<div class="gl-backfill-overall">${barHead("Overall progress", `${count(processed)} of ${count(total)} documents`, ...overall)}` +
			`${qbar(`${run.id}:overall`, "Overall progress", ...overall, { tone: "overall", moving: running && !finished })}</div>`];
		const order = Object.keys(TYPES);
		const current = order.indexOf(summary.currentType);
		for (const type of order.filter((key) => summary.byType && summary.byType[key])) {
			const { total: typeTotal, processed: typeProcessed } = summary.byType[type];
			const index = order.indexOf(type);
			const state = finished || (current >= 0 && index < current) ? "Done"
				: index === current ? (running ? "Working" : "Stopped")
					: (running ? "Waiting" : "Not started");
			const bar = typeTotal ? [typeProcessed, typeTotal] : [state === "Done" ? 1 : 0, 1];
			const eta = state === "Working" && typeTotal ? etaText(`${run.id}:${type}`, typeProcessed, typeTotal) : "";
			parts.push(barHead(TYPES[type], `${state} · ${count(typeProcessed)} of ${count(typeTotal)}${eta}`, ...bar) +
				qbar(`${run.id}:${type}`, `${TYPES[type]} progress`, ...bar, { moving: running && state === "Working" }));
		}
		return `<div class="gl-backfill-bars">${parts.join("")}</div>`;
	}

	function renderRun(status) {
		const run = status.run;
		const summary = status.summary || {};
		const dryRun = Number(run.dry_run) === 1;
		const running = status.active;
		const state = running && status.stopping ? "Stopping"
			: status.stopped ? "Stopped"
				: run.status === "DONE" && status.active ? "Updating customer and supplier balances"
					: (RUN_STATES[run.status] || run.status);
		const stats = dryRun
			? [["Would post or nothing to post", summary.skipped], ["Already posted", summary.exists], ["Failed", summary.failed]]
			: [["Posted", summary.posted], ["Already posted", summary.exists], ["Nothing to post", summary.skipped], ["Failed", summary.failed]];
		const parts = [
			`<p><strong>Run #${run.id}${dryRun ? ", dry run" : ""}</strong>: ${escapeHtml(state)}. ` +
			`${localDate(run.from_date)} to ${localDate(run.to_date)}.</p>`,
			status.clearing ? renderClearing(status.clearing, run.id) : renderBars(run, summary, running),
			status.clearing ? "" : statTiles(stats)
		];
		if (summary.lastError) parts.push(`<p class="gl-backfill-blocked">Run stopped: ${escapeHtml(summary.lastError)}</p>`);
		if (status.stopped) {
			parts.push('<p class="gl-backfill-blocked">Stopped before finishing, for example when Migrate restarted. Start it again; nothing is posted twice.</p>');
		}
		if (!running && run.status === "DONE") {
			parts.push(`<p>${dryRun
				? (Number(summary.failed) ? "Fix the failures, then dry run again." : "No failures. Turn off Dry run to post.")
				: 'Next: Post-Backfill Repair, then Validate GL on <a href="/tools/gl">GL Maintenance</a>.'}</p>`);
		}
		return parts.join("");
	}

	const EMPTY_ITEMS = {
		FAILED: "No failed documents.",
		SKIPPED: "No skipped documents.",
		EXISTS: "No documents were already posted.",
		POSTED: "No documents posted."
	};

	function renderItems(items, filter) {
		if (!items.length) return `<p class="hint">${EMPTY_ITEMS[filter]}</p>`;
		return table(
			[["Type"], ["Reference"], ["Date"], ["Message"]],
			items.map((item) => `<tr><td>${TYPES[item.doc_type] || escapeHtml(item.doc_type)}</td><td>${escapeHtml(item.source_ref)}</td>` +
				`<td>${localDate(item.doc_date)}</td><td>${escapeHtml(item.message || "")}</td></tr>`)
		);
	}

	// What a fix adds or changes, matching the server's own account of it.
	function describeFix(options, choice) {
		const typeLabel = (code) => options.typeLabels[code] || code;
		const current = options.control.status === "unmapped" ? null : options.control.accnr;
		const mapLine = (accnr) => current === accnr
			? `Keep ${options.label} mapped to ${accnr}`
			: `Map ${options.label} to ${accnr}${current ? ` instead of ${current}` : ""}`;
		if (choice.action === "recreate") return [`Add account ${choice.accnr} ${choice.name} (${typeLabel(choice.type)})`, mapLine(choice.accnr)];
		if (choice.action === "reactivate") return [`Reactivate account ${choice.accnr} ${choice.name}`, mapLine(choice.accnr)];
		if (choice.action === "map") return [mapLine(choice.accnr)];
		return [`Add account ${choice.accnr ?? "?"} ${choice.name || "?"} (${typeLabel(choice.type)})`, mapLine(choice.accnr ?? "?")];
	}

	function fixChoiceHtml(action, title, hint, fields) {
		return `<div class="gl-control-fix-choice"><label><input type="radio" name="gl-control-fix" value="${action}" /><span>${title}</span></label>` +
			(hint ? `<p class="hint">${hint}</p>` : "") +
			(fields ? `<div class="gl-control-fix-fields">${fields}</div>` : "") + "</div>";
	}

	function fixDialogHtml(options) {
		const typeLabel = (code) => escapeHtml(options.typeLabels[code] || code);
		const choices = [];
		if (options.recreate) {
			const r = options.recreate;
			choices.push(fixChoiceHtml("recreate", `Recreate account ${r.accnr} ${escapeHtml(r.name)} (${typeLabel(r.type)})`,
				"The control still points at this number."));
		}
		if (options.reactivate) {
			const r = options.reactivate;
			choices.push(fixChoiceHtml("reactivate", `Reactivate account ${r.accnr} ${escapeHtml(r.name)}`, ""));
		}
		if (options.candidates.length) {
			const list = options.candidates.map((a) => `<option value="${a.accnr}">${a.accnr} ${escapeHtml(a.name)} (${typeLabel(a.type)})</option>`).join("");
			choices.push(fixChoiceHtml("map", "Map to an existing account", "", `<select data-field="map-accnr" aria-label="Existing account">${list}</select>`));
		}
		const types = options.types.map((code) => `<option value="${code}">${typeLabel(code)}</option>`).join("");
		choices.push(fixChoiceHtml("create", "Create a new account", "",
			`<label>Type <select data-field="type">${types}</select></label>` +
			'<label>Number <input data-field="accnr" type="number" step="1" /></label>' +
			'<label>Name <input data-field="name" type="text" maxlength="150" /></label>'));
		return '<div class="gl-control-fix">' +
			`<p><strong>${escapeHtml(options.label)}</strong>: ${escapeHtml(options.control.reason)}.</p>` +
			(options.explicit ? '<p class="gl-backfill-warning">You must choose this account yourself.</p>' : "") +
			choices.join("") +
			'<div class="gl-control-fix-preview"><strong>What will be added</strong><ul data-field="preview"></ul></div></div>';
	}

	// Keeps the preview and the Apply button in step with the choice; state.choice holds a valid choice or null.
	function wireFixDialog(overlay, options, state) {
		const field = (name) => overlay.querySelector(`[data-field="${name}"]`);
		const radios = Array.from(overlay.querySelectorAll('input[name="gl-control-fix"]'));
		const confirmBtn = overlay.querySelector(".modal-confirm");
		const typeEl = field("type");
		const accnrEl = field("accnr");
		const nameEl = field("name");
		const mapEl = field("map-accnr");
		const previewEl = field("preview");
		let accnrEdited = false;

		const suggest = () => {
			const suggestion = options.newAccounts[typeEl.value];
			if (!accnrEdited) accnrEl.value = suggestion.accnr ?? "";
			if (!nameEl.value) nameEl.value = suggestion.name;
		};
		const read = () => {
			const action = (radios.find((radio) => radio.checked) || {}).value;
			if (action === "recreate") return { action, ...options.recreate };
			if (action === "reactivate") return { action, ...options.reactivate };
			if (action === "map") return { action, accnr: Number(mapEl.value) };
			if (action === "create") {
				return { action, type: typeEl.value, accnr: accnrEl.value === "" ? null : Number(accnrEl.value), name: nameEl.value.trim() };
			}
			return null;
		};
		const update = () => {
			const choice = read();
			const lines = choice ? describeFix(options, choice).map((line) => `<li>${escapeHtml(line)}</li>`) : ["<li>Choose how to fix it.</li>"];
			let valid = Boolean(choice);
			if (choice && choice.action === "create") {
				const [from, to] = options.ranges[choice.type];
				valid = Number.isInteger(choice.accnr) && choice.accnr >= from && choice.accnr <= to && choice.name.length > 0;
				if (!valid) lines.push(`<li class="gl-backfill-blocked">${escapeHtml(options.typeLabels[choice.type])} accounts are numbered ${from} to ${to}. Enter a free number and a name.</li>`);
			}
			previewEl.innerHTML = lines.join("");
			state.choice = valid ? choice : null;
			confirmBtn.disabled = !valid;
		};

		accnrEl.addEventListener("input", () => { accnrEdited = true; });
		typeEl.addEventListener("change", () => { accnrEdited = false; suggest(); });
		// Using a choice's fields selects that choice.
		for (const box of overlay.querySelectorAll(".gl-control-fix-choice")) {
			box.addEventListener("focusin", (event) => {
				if (event.target.name !== "gl-control-fix") box.querySelector('input[type="radio"]').checked = true;
				update();
			});
		}
		overlay.addEventListener("input", update);
		overlay.addEventListener("change", update);
		suggest();
		// Restoring the control's own account is the safe default; nothing is preselected for controls the tenant must choose.
		const preselect = !options.explicit && radios.find((radio) => radio.value === "recreate" || radio.value === "reactivate");
		if (preselect) preselect.checked = true;
		update();
	}

	function invoiceFixHtml(options) {
		const facts = [`Amount ${money(options.amount)}`, `paid ${money(options.paid)}`, `owing ${money(options.payable)}`,
			options.returnRecorded ? `return of ${money(options.returnRecorded)} recorded on the invoice` : "no return recorded",
			`${count(options.payments.count)} supplier ${options.payments.count === 1 ? "payment" : "payments"}`];
		const choices = options.actions.map((item) => fixChoiceHtml(item.action,
			`${escapeHtml(item.title)}${item.recommended ? " (suggested)" : ""}`, escapeHtml(item.hint || "")));
		return '<div class="gl-control-fix">' +
			`<p><strong>${escapeHtml(options.supplier)} invoice ${escapeHtml(options.invoiceNr)}</strong>: ${escapeHtml(facts.join(", "))}.</p>` +
			choices.join("") +
			'<div class="gl-control-fix-preview"><strong>What will change</strong><ul data-field="preview"></ul></div></div>';
	}

	// Keeps the preview and the Apply button in step with the chosen fix.
	function wireInvoiceFixDialog(overlay, options, state) {
		const radios = Array.from(overlay.querySelectorAll('input[name="gl-control-fix"]'));
		const confirmBtn = overlay.querySelector(".modal-confirm");
		const previewEl = overlay.querySelector('[data-field="preview"]');
		const update = () => {
			const action = (radios.find((radio) => radio.checked) || {}).value;
			const chosen = options.actions.find((item) => item.action === action);
			previewEl.innerHTML = chosen ? chosen.changes.map((line) => `<li>${escapeHtml(line)}</li>`).join("") : "<li>Choose how to fix it.</li>";
			state.choice = chosen ? { action: chosen.action } : null;
			confirmBtn.disabled = !chosen;
		};
		overlay.addEventListener("change", update);
		const suggested = options.actions.find((item) => item.recommended);
		if (suggested) radios.find((radio) => radio.value === suggested.action).checked = true;
		update();
	}

	function setup() {
		const button = document.getElementById("btn-gl-backfill");
		if (!button) return;
		const checkBtn = document.getElementById("btn-gl-backfill-check");
		const scopeEl = document.getElementById("gl-backfill-scope");
		const resultEl = document.getElementById("gl-backfill-result");
		const runEl = document.getElementById("gl-backfill-run");
		const itemsEl = document.getElementById("gl-backfill-items");
		const filterEl = document.getElementById("gl-backfill-item-status");
		const fromEl = document.getElementById("gl-backfill-from");
		const toEl = document.getElementById("gl-backfill-to");
		const dryRunEl = document.getElementById("gl-backfill-dry-run");
		const clearEl = document.getElementById("gl-backfill-clear");
		const stopBtn = document.getElementById("btn-gl-backfill-stop");
		const typeEls = Array.from(document.querySelectorAll('input[name="gl-backfill-type"]'));
		let ready = false;
		let runId = null;
		let following = false;
		let lastScope = null;
		let lastStatus = null;
		// True while the first look at a run is on its way, so card 4 cannot tell yet.
		let checkingRun = false;

		// Green checks. Card 1: usable schema, every control mapped, no closed period.
		// Card 4: the latest run posted the tenant's whole date range without a failure.
		const updateDone = () => {
			const sc = lastScope;
			const s = lastStatus;
			setCardDone(scopeEl, Boolean(sc && sc.ready && sc.controls.every((c) => c.status === "mapped") && !sc.closedPeriods.length && !sc.unpairedRfcOriginals?.length));
			setCardDone(button, Boolean(sc && sc.ready && sc.from && s && !s.active && !s.stopped &&
				Number(s.run.dry_run) === 0 && s.run.status === "DONE" && Number(s.summary.failed) === 0 &&
				localDate(s.run.from_date) <= sc.from && localDate(s.run.to_date) >= sc.to));
			if (checkingRun) setCardChecking(button);
		};

		// Card 4 shows its Result box only once there is a run to show.
		const setRun = (html) => {
			runEl.innerHTML = html;
			resultEl.hidden = false;
		};

		const syncControls = () => {
			if (dryRunEl.checked) clearEl.checked = false;
			clearEl.disabled = dryRunEl.checked;
			button.textContent = dryRunEl.checked ? "Start Dry Run" : "Post Journals";
			button.disabled = !ready || following;
			// Stop shows while the shown run is working here; once asked, it waits for the run to stop.
			const working = Boolean(lastStatus && lastStatus.active && Number(lastStatus.run.id) === Number(runId));
			stopBtn.hidden = !working;
			stopBtn.disabled = !working || Boolean(lastStatus.stopping);
		};

		async function loadScope(notice) {
			checkBtn.disabled = true;
			setCardChecking(scopeEl);
			setCardChecking(button);
			try {
				const scope = await getJson("/api/tools/gl-backfill/scope");
				scopeEl.innerHTML = renderScope(scope, notice);
				ready = scope.ready;
				lastScope = scope;
				if (scope.from && !fromEl.value) fromEl.value = scope.from;
				if (scope.to && !toEl.value) toEl.value = scope.to;
				if (scope.latestRun && runId === null) showRun(scope.latestRun.id);
				if (!scope.latestRun && runId !== null && !following) {
					// The run history was cleared.
					runId = null;
					lastStatus = null;
					resultEl.hidden = true;
				}
			} catch (err) {
				ready = false;
				lastScope = null;
				scopeEl.innerHTML = `<p class="gl-backfill-blocked">${escapeHtml(err.message)}</p>`;
			} finally {
				checkBtn.disabled = false;
				syncControls();
				updateDone();
			}
		}

		// Shows a run and, while it is still working, keeps refreshing it.
		async function showRun(id) {
			runId = id;
			if (!lastStatus || Number(lastStatus.run.id) !== Number(id)) checkingRun = true;
			try {
				const filter = filterEl.value;
				const status = await getJson(`/api/tools/gl-backfill/status/${id}?itemStatus=${filter}&itemLimit=500`);
				if (runId !== id) return;
				lastStatus = status;
				checkingRun = false;
				updateDone();
				setRun(renderRun(status));
				itemsEl.innerHTML = renderItems(status.items, filter);
				const running = status.active;
				if (running) {
					following = true;
					setTimeout(() => showRun(id), 2000);
				} else if (following) {
					following = false;
					loadScope();
					announceChange("posted");
				}
			} catch (err) {
				if (runId === id && checkingRun) {
					checkingRun = false;
					updateDone();
				}
				setRun(`<p class="gl-backfill-blocked">Could not read run #${id}: ${escapeHtml(err.message)}${following ? " Retrying..." : ""}</p>`);
				if (following) setTimeout(() => showRun(id), 2000);
			}
			syncControls();
		}

		async function fixControl(key) {
			const url = `/api/tools/gl-backfill/controls/${encodeURIComponent(key)}`;
			let options;
			try {
				options = await getJson(url);
			} catch (err) {
				await window.Modal.alert({ title: "Fix control account", message: err.message, type: "error" });
				return;
			}
			const state = { choice: null };
			const ok = await window.Modal.custom({
				title: `Fix ${options.label}`,
				contentHTML: fixDialogHtml(options),
				type: "info",
				confirmText: "Apply",
				cancelText: "Cancel",
				onMount: (overlay) => wireFixDialog(overlay, options, state)
			});
			if (!ok || !state.choice) return;
			try {
				const result = await postJson(url, state.choice);
				await loadScope(`${escapeHtml(options.label)} fixed: ${result.applied.map(escapeHtml).join("; ")}.`);
				announceChange("controls");
			} catch (err) {
				await window.Modal.alert({ title: `Fix ${options.label}`, message: err.message, type: "error" });
			}
		}

		async function fixInvoice(sinvid) {
			const url = `/api/tools/gl-backfill/rfc-originals/${encodeURIComponent(sinvid)}`;
			let options;
			try {
				options = await getJson(url);
			} catch (err) {
				await window.Modal.alert({ title: "Fix supplier invoice", message: err.message, type: "error" });
				return;
			}
			const title = `Fix invoice ${options.invoiceNr}`;
			if (!options.actions.length) {
				await window.Modal.alert({ title, type: "warning",
					message: "None of the automatic fixes fits this invoice: it was part paid or a return was recorded against it. Correct it in the legacy data, then import it again." });
				return;
			}
			const state = { choice: null };
			const ok = await window.Modal.custom({
				title,
				contentHTML: invoiceFixHtml(options),
				type: "info",
				confirmText: "Apply",
				cancelText: "Cancel",
				onMount: (overlay) => wireInvoiceFixDialog(overlay, options, state)
			});
			if (!ok || !state.choice) return;
			try {
				const result = await postJson(url, state.choice);
				await loadScope(`Invoice ${escapeHtml(options.invoiceNr)} fixed: ${result.applied.map(escapeHtml).join("; ")}.`);
				announceChange("invoices");
			} catch (err) {
				await window.Modal.alert({ title, message: err.message, type: "error" });
			}
		}

		stopBtn.addEventListener("click", async () => {
			const id = runId;
			const message = "The run stops after the current batch of deletions, or after the document it is posting. " +
				"What it has deleted or posted so far stays that way. Start it again to finish; nothing is posted twice.";
			const ok = window.Modal && typeof window.Modal.confirm === "function"
				? await window.Modal.confirm({ title: "Stop GL Backfill", message, type: "warning", confirmText: "Stop", cancelText: "Keep Running" })
				: window.confirm(message);
			if (!ok || id !== runId) return;
			stopBtn.disabled = true;
			try {
				await postJson(`/api/tools/gl-backfill/stop/${id}`, {});
			} catch (err) {
				await window.Modal.alert({ title: "Stop GL Backfill", message: err.message, type: "error" });
				syncControls();
			}
		});
		dryRunEl.addEventListener("change", syncControls);
		checkBtn.addEventListener("click", () => loadScope());
		document.addEventListener("glbackfill:repaired", () => loadScope());
		scopeEl.addEventListener("click", (event) => {
			const fix = event.target.closest("[data-fix]");
			if (fix) fixControl(fix.dataset.fix);
			const invoiceFix = event.target.closest("[data-rfc-fix]");
			if (invoiceFix) fixInvoice(invoiceFix.dataset.rfcFix);
		});
		filterEl.addEventListener("change", () => {
			if (runId !== null && !following) showRun(runId);
		});

		button.addEventListener("click", async function () {
			const types = typeEls.filter((el) => el.checked).map((el) => el.value);
			if (!types.length) {
				setRun('<p class="gl-backfill-blocked">Choose at least one document type.</p>');
				return;
			}
			const dryRun = dryRunEl.checked;
			const clearPrevious = !dryRun && clearEl.checked;
			if (!dryRun) {
				const confirmMsg =
					`Post GL journals for ${types.map((type) => TYPES[type].toLowerCase()).join(", ")} ` +
					`dated ${fromEl.value} to ${toEl.value}?` +
					(clearPrevious ? "\n\nJournals already posted for these documents and dates are deleted first." : "") +
					"\n\nRun a dry run first and resolve its failures.";
				const ok = window.Modal && typeof window.Modal.confirm === "function"
					? await window.Modal.confirm({
						title: "Post GL Journals",
						message: confirmMsg,
						type: "warning",
						confirmText: "Post Journals",
						cancelText: "Cancel"
					})
					: window.confirm(confirmMsg);
				if (!ok) return;
			}
			button.disabled = true;
			setRun(`<p>${dryRun ? "Starting dry run..." : "Starting GL backfill..."}</p>`);
			try {
				const started = await postJson("/api/tools/gl-backfill/run", {
					fromDate: fromEl.value,
					toDate: toEl.value,
					types,
					dryRun,
					clearPrevious,
					confirm: !dryRun
				});
				filterEl.value = "FAILED";
				following = true;
				showRun(started.runId);
			} catch (err) {
				setRun(`<p class="gl-backfill-blocked">GL backfill did not start: ${escapeHtml(err.message)}</p>`);
				syncControls();
			}
		});

		syncControls();
		loadScope();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", setup);
	} else {
		setup();
	}
})();
