// The GL Backfill page's Opening Stock card: previews and posts the migration
// opening stock take (src/migrate/gl/glBackfill/openingStock.js), or undoes it.
(function () {
	const { escapeHtml, count, money, postJson, streamPost, table, section, statTiles, confirmList, alertError, setCardDone, announceChange, workingLine } = window.GlBackfill;
	const el = (id) => document.getElementById(id);
	// Post sits at the top of the card as well as the bottom.
	const POST_BUTTONS = ["btn-gl-opening-post", "btn-gl-opening-post-top"];
	let preview = null;
	let running = false;
	let loading = 0;
	let latest = 0;
	let reloadTimer = null;
	// A tick only refreshes the totals; any other change redraws the item lists too.
	let redrawLists = false;
	// Items the user moved out of, or into, the placeholder list.
	const keep = new Set();
	const zero = new Set();
	// Sections the user folded, by data-fold key; every preview reload redraws them.
	const folded = new Set();
	// The column each list is sorted by, by data-fold key: { col, desc }.
	const sorts = new Map();

	const blocked = (message) => `<p class="gl-backfill-blocked">${message}</p>`;
	const warning = (message) => `<p class="gl-backfill-warning">${message}</p>`;
	const qty = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

	function payload() {
		return {
			cutoverDate: el("gl-opening-date").value || null,
			placeholderMinQty: Number(el("gl-opening-min-qty").value) || null,
			keepStockIds: [...keep],
			zeroStockIds: [...zero]
		};
	}

	function controlLine(label, control) {
		if (control && control.status === "mapped") return `<p>${label}: <strong>${escapeHtml(control.accnr)}</strong> ${escapeHtml(control.name || "")}</p>`;
		return blocked(`${label}: ${escapeHtml(control && control.reason ? control.reason : "not mapped")}. Fix it in the Tenant Check.`);
	}

	function backfillLine(run) {
		if (!run) return warning("No live backfill has run yet.");
		return `<p>Last live backfill: run #${escapeHtml(run.id)} ${escapeHtml(run.status)}, ${escapeHtml(run.from_date)} to ${escapeHtml(run.to_date)}.</p>`;
	}

	// A section that folds to its title, as the user left it.
	function fold(key, title, body) {
		return `<details class="gl-backfill-section gl-backfill-fold" data-fold="${key}"${folded.has(key) ? "" : " open"}>` +
			`<summary><h4>${title}</h4></summary>${body}</details>`;
	}

	// Number cells carry their raw value in data-sort, so sorting ignores the locale's formatting.
	const numCell = (value, text) => `<td class="gl-backfill-num" data-sort="${Number(value) || 0}">${text}</td>`;

	function itemRows(rows, { toggle = null, showCounted = false } = {}) {
		return rows.map((row) => {
			const box = toggle
				? `<td><input type="checkbox" data-opening-toggle="${toggle}" data-stock-id="${row.stock_id}"${toggle === "placeholder" ? " checked" : ""} aria-label="Set ${escapeHtml(row.partnr || row.stock_id)} to 0" /></td>`
				: "";
			return `<tr>${box}<td>${escapeHtml(row.partnr || "")}</td><td>${escapeHtml(row.description || "")}</td>` +
				numCell(row.legacy_quantity, qty(row.legacy_quantity)) + (showCounted ? numCell(row.quantity, qty(row.quantity)) : "") +
				numCell(row.cost, money(row.cost)) + numCell(row.value, money(row.value)) + "</tr>";
		});
	}

	function itemTable(key, title, rows, total, options = {}) {
		if (!rows.length) return "";
		// [title, class, "desc" when a first click should put the largest or ticked rows on top]
		const columns = [...(options.toggle ? [["Set to 0", "", "desc"]] : []), ["Part"], ["Description"], ["Legacy qty", "gl-backfill-num", "desc"],
			...(options.showCounted ? [["Tenant qty", "gl-backfill-num", "desc"]] : []), ["Cost ex VAT", "gl-backfill-num", "desc"], ["Legacy value", "gl-backfill-num", "desc"]];
		const headers = columns.map(([label, cls, first], col) =>
			[`<button type="button" class="gl-sort" data-sort-col="${col}"${first ? ` data-sort-first="${first}"` : ""} title="Sort by ${label}">${label}</button>`, cls]);
		const note = total > rows.length ? `<p class="gl-tool-note">Showing the ${count(rows.length)} largest of ${count(total)}. Download CSV for all.</p>` : "";
		return fold(key, title, (options.intro || "") + `<div class="gl-backfill-table-wrap">${table(headers, itemRows(rows, options))}</div>` + note);
	}

	function sortValue(row, col) {
		const cell = row.cells[col];
		const box = cell.querySelector("input[type=checkbox]");
		if (box) return box.checked ? 1 : 0;
		return cell.dataset.sort !== undefined ? Number(cell.dataset.sort) : cell.textContent.trim();
	}

	// Reorders the rows in place, so ticks and the scroll box stay as they are.
	function sortTable(wrap, { col, desc }) {
		const body = wrap.querySelector("tbody");
		const rows = Array.from(body.rows).sort((a, b) => {
			const x = sortValue(a, col);
			const y = sortValue(b, col);
			const order = typeof x === "number" ? x - y : x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
			return desc ? -order : order;
		});
		body.append(...rows);
		for (const th of wrap.querySelectorAll("thead th")) {
			th.setAttribute("aria-sort", th.cellIndex === col ? (desc ? "descending" : "ascending") : "none");
		}
	}

	function onSort(event) {
		const button = event.target.closest("[data-sort-col]");
		if (!button) return;
		const key = button.closest("[data-fold]").dataset.fold;
		const col = Number(button.dataset.sortCol);
		const current = sorts.get(key);
		const desc = current && current.col === col ? !current.desc : button.dataset.sortFirst === "desc";
		sorts.set(key, { col, desc });
		sortTable(button.closest(".gl-backfill-table-wrap"), sorts.get(key));
	}

	function renderPosted(p) {
		const lines = [
			`<p class="gl-backfill-ok">Posted on ${escapeHtml(p.takedate)}: stock take ST-${escapeHtml(p.takeid)}, ${count(p.lines)} items worth ${money(p.value)}.</p>`,
			p.journal ? `<p>Journal ST-${escapeHtml(p.takeid)}: ${money(p.journal.total)} each side; Inventory ${money(p.journal.inventory)}.</p>` : warning("No journal was posted."),
			`<p>Inventory control at ${escapeHtml(p.takedate)}: <strong>${money(p.inventoryAtCutover)}</strong>. Now: ${money(p.inventoryNow)}; stock valuation now ${money(p.valuationNow)}.</p>`
		];
		if (String(p.status).toUpperCase() !== "FINALISED") lines.push(warning(`The session is ${escapeHtml(p.status)}: it was rolled back in AUTONEER-PWA. Undo removes what is left so it can be posted again.`));
		if (p.undoBlockers.length) lines.push(...p.undoBlockers.map((b) => warning(`Undo: ${escapeHtml(b)}`)));
		return section("Opening stock", lines.join(""));
	}

	function renderPreview(pv, keepLists) {
		const s = pv.summary;
		const left = [
			`<p>Legacy database <strong>${escapeHtml(pv.legacy.database)}</strong>: ${count(pv.legacy.withQuantity)} of ${count(pv.legacy.rows)} items have a quantity (${escapeHtml(pv.legacy.ids)}).</p>`,
			controlLine("Inventory", pv.controls.inventory),
			controlLine("Opening Stock", pv.controls.opening),
			backfillLine(pv.backfill),
			pv.latestDocument ? `<p>Last legacy document: ${escapeHtml(pv.latestDocument)}.</p>` : "",
			...pv.blockers.map((b) => blocked(escapeHtml(b))),
			...pv.warnings.map((w) => warning(escapeHtml(w)))
		];
		el("gl-opening-scope").innerHTML = section("In this schema", left.join(""));

		const journalRows = pv.journal.map((row) => `<tr><td>${escapeHtml(row.accnr)}</td><td>${escapeHtml(row.name || "")}</td>` +
			`<td class="gl-backfill-num">${money(row.debit)}</td><td class="gl-backfill-num">${money(row.credit)}</td></tr>`);
		const openRows = pv.openJobs.map((job) => `<tr><td>${escapeHtml(job.job_number)}</td><td class="gl-backfill-num">${count(job.parts)}</td>` +
			`<td class="gl-backfill-num">${money(job.cost)}</td><td class="gl-backfill-num">${money(job.wip)}</td>` +
			`<td>${job.accounts.map((a) => `${escapeHtml(a.accnr)} ${escapeHtml(a.name || "")}: ${money(a.amount)}`).join("<br>")}</td></tr>`);
		const parts = [
			`<div class="gl-opening-bar">` +
				statTiles([["Items counted", s.counted.items], ["Placeholders set to 0", s.placeholders.items], ["Negatives set to 0", s.negatives.items], ["Open jobs", s.openJobs.jobs]]) +
				`<button type="button" class="btn secondary" data-fold-all>Collapse all</button></div>`,
			fold("journal", `Journal on ${escapeHtml(pv.cutoverDate)}`,
				`<p>Counted stock <strong>${money(s.counted.value)}</strong> + stock on open jobs <strong>${money(s.openJobs.value)}</strong>. ` +
				`The backfill left Inventory at <strong>${money(s.inventoryBalance)}</strong> on this date; the journal reverses it, so Inventory ends at <strong>${money(s.inventoryAfter)}</strong>.</p>` +
				(journalRows.length ? `<div class="gl-backfill-table-wrap">${table([["Account"], ["Name"], ["Debit", "gl-backfill-num"], ["Credit", "gl-backfill-num"]], journalRows)}</div>` : "")),
			itemTable("placeholders", "Placeholders set to 0", pv.lists.placeholders, s.placeholders.items, {
				toggle: "placeholder",
				intro: `<p>Quantities of ${count(pv.placeholderMinQty)} or more, and items you set to 0. Legacy value ${money(s.placeholders.value)}. Untick an item that is real stock.</p>`
			}),
			itemTable("counted", "Counted items", pv.lists.counted, s.counted.items, {
				toggle: "counted", intro: "<p>Tick an item that is a service or a charge, not stock.</p>"
			}),
			itemTable("negatives", "Negative quantities set to 0", pv.lists.negatives, s.negatives.items, { intro: `<p>Legacy value ${money(s.negatives.value)}.</p>` }),
			openRows.length ? fold("openJobs", "Stock on open jobs", "<p>Legacy took these parts out of stock already. Finalising the job relieves this amount, after the job's supplier WIP.</p>" +
				`<div class="gl-backfill-table-wrap">${table([["Job"], ["Parts", "gl-backfill-num"], ["Cost", "gl-backfill-num"], ["Covered by WIP", "gl-backfill-num"], ["Relieved from"]], openRows)}</div>`) : "",
			itemTable("negativeCost", "Counted with a negative cost", pv.lists.negativeCost, s.negativeCost.items, { intro: "<p>Posted as they are, so Inventory matches the stock valuation. Correct their cost prices.</p>" }),
			itemTable("zeroCost", "Counted without a cost", pv.lists.zeroCost, s.zeroCost.items),
			itemTable("alreadyStocked", "Left as they are: already stocked in the tenant", pv.lists.alreadyStocked, s.alreadyStocked.items, { showCounted: true })
		];
		const details = el("gl-opening-details");
		// The tick lists keep their rows, ticks, scroll and focus, so nothing moves under the pointer.
		const kept = keepLists ? ["placeholders", "counted"].map((key) => {
			const wrap = details.querySelector(`[data-fold="${key}"] .gl-backfill-table-wrap`);
			return wrap && { key, wrap, top: wrap.scrollTop, focus: wrap.contains(document.activeElement) ? document.activeElement : null };
		}).filter(Boolean) : [];
		details.innerHTML = parts.join("");
		// Redrawn lists take the user's sort again; kept ones still have it, and re-sorting them would move rows.
		for (const [key, sort] of sorts) {
			if (kept.some((k) => k.key === key)) continue;
			const wrap = details.querySelector(`[data-fold="${key}"] .gl-backfill-table-wrap`);
			if (wrap) sortTable(wrap, sort);
		}
		for (const { key, wrap, top, focus } of kept) {
			const fresh = details.querySelector(`[data-fold="${key}"] .gl-backfill-table-wrap`);
			if (!fresh) continue;
			fresh.replaceWith(wrap);
			wrap.scrollTop = top;
			if (focus) focus.focus({ preventScroll: true });
		}
		syncFoldAll();
	}

	const foldSections = () => Array.from(el("gl-opening-details").querySelectorAll("details.gl-backfill-fold"));

	// "Collapse all" while any section is open, "Expand all" once every one is folded.
	function syncFoldAll() {
		const button = el("gl-opening-details").querySelector("[data-fold-all]");
		if (button) button.textContent = foldSections().some((section) => section.open) ? "Collapse all" : "Expand all";
	}

	function foldAll() {
		const sections = foldSections();
		const open = !sections.some((section) => section.open);
		for (const section of sections) {
			section.open = open;
			if (open) folded.delete(section.dataset.fold);
			else folded.add(section.dataset.fold);
		}
		syncFoldAll();
	}

	function sync() {
		const idle = !running && !loading && preview && !preview.busy;
		const posted = preview && preview.posted;
		for (const id of POST_BUTTONS) {
			el(id).hidden = Boolean(posted);
			el(id).disabled = !idle || posted || !preview.canPost;
		}
		el("btn-gl-opening-undo").hidden = !posted;
		el("btn-gl-opening-undo").disabled = !idle || !posted || !posted.canUndo;
		el("btn-gl-opening-csv").disabled = !idle || Boolean(posted) || !preview.lists;
		el("gl-opening-date").disabled = Boolean(posted) || running;
		el("gl-opening-min-qty").disabled = Boolean(posted) || running;
	}

	// While a post or an undo runs, the lists under the form make way for its progress, in view of the top Post button.
	function showWorking(title, detail) {
		el("gl-opening-details").innerHTML = workingLine(title, detail);
	}

	async function load({ keepLists = false } = {}) {
		const request = ++latest;
		loading++;
		sync();
		try {
			const response = await postJson("/api/tools/gl-backfill/opening-stock/preview", payload());
			// A newer preview is on its way; this one is already out of date.
			if (request !== latest) return;
			preview = response;
			if (preview.missingTables && preview.missingTables.length) {
				el("gl-opening-scope").innerHTML = section("In this schema", blocked(`Missing ${escapeHtml(preview.missingTables.join(", "))}. Use a tenant created by AUTONEER-PWA.`));
				el("gl-opening-details").innerHTML = "";
				preview = null;
			} else if (preview.posted) {
				el("gl-opening-scope").innerHTML = renderPosted(preview.posted);
				el("gl-opening-details").innerHTML = "";
				el("gl-opening-date").value = preview.posted.takedate;
			} else {
				if (!el("gl-opening-date").value) el("gl-opening-date").value = preview.cutoverDate;
				renderPreview(preview, keepLists);
			}
			if (preview && preview.busy) el("gl-opening-scope").insertAdjacentHTML("afterbegin", warning("Another task is running. Wait for it to finish."));
			setCardDone(el("gl-opening-scope"), Boolean(preview && preview.posted && String(preview.posted.status).toUpperCase() === "FINALISED"));
		} catch (err) {
			if (request !== latest) return;
			preview = null;
			el("gl-opening-scope").innerHTML = section("In this schema", blocked(escapeHtml(err.message)));
			el("gl-opening-details").innerHTML = "";
			setCardDone(el("gl-opening-scope"), false);
		} finally {
			loading--;
			// An overtaken preview can finish last; the buttons still wait for it.
			if (request !== latest && preview) sync();
		}
		if (preview) sync();
		else for (const id of [...POST_BUTTONS, "btn-gl-opening-undo", "btn-gl-opening-csv"]) el(id).disabled = true;
	}

	function reloadSoon() {
		redrawLists = true;
		refreshSoon();
	}

	function refreshSoon() {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => {
			const keepLists = !redrawLists;
			redrawLists = false;
			load({ keepLists });
		}, 500);
	}

	function onToggle(event) {
		const box = event.target.closest("[data-opening-toggle]");
		if (!box) return;
		const id = Number(box.dataset.stockId);
		const row = preview && preview.lists.placeholders.concat(preview.lists.counted).find((r) => r.stock_id === id);
		const candidate = Boolean(row && row.candidate);
		// Ticked means "set to 0": undo a keep for a candidate, or zero any other item.
		if (box.checked) {
			keep.delete(id);
			if (!candidate) zero.add(id);
		} else {
			zero.delete(id);
			if (candidate) keep.add(id);
		}
		refreshSoon();
	}

	function onFold(event) {
		const key = event.target.dataset && event.target.dataset.fold;
		if (!key) return;
		if (event.target.open) folded.delete(key);
		else folded.add(key);
		syncFoldAll();
	}

	function onDetailsClick(event) {
		if (event.target.closest("[data-fold-all]")) foldAll();
		else onSort(event);
	}

	function csvCell(value) {
		const text = value == null ? "" : String(value);
		return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	}

	function downloadCsv() {
		const groups = [["COUNTED", preview.lists.counted], ["PLACEHOLDER_ZEROED", preview.lists.placeholders], ["NEGATIVE_ZEROED", preview.lists.negatives], ["ALREADY_STOCKED", preview.lists.alreadyStocked]];
		const lines = [["category", "stock_id", "partnr", "description", "stocktype", "legacy_quantity", "opening_quantity", "cost_ex_vat", "value"].join(",")];
		for (const [category, rows] of groups) {
			for (const row of rows) {
				const opening = category === "COUNTED" ? row.quantity : category === "ALREADY_STOCKED" ? "" : 0;
				const value = category === "COUNTED" ? row.value : 0;
				lines.push([category, row.stock_id, row.partnr, row.description, row.stocktype, row.legacy_quantity, opening, row.cost, value].map(csvCell).join(","));
			}
		}
		const link = document.createElement("a");
		link.href = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }));
		link.download = `opening-stock-${preview.schema}-${preview.cutoverDate}.csv`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	}

	// The post dialog's figures: what the stock take counts, the journal, and how Inventory gets to its new balance.
	function postSummary(pv) {
		const s = pv.summary;
		const num = (value) => `<td class="gl-backfill-num">${value}</td>`;
		const clearing = -s.inventoryBalance;
		const stock = table([["Stock take"], ["Items", "gl-backfill-num"], ["Value ex VAT", "gl-backfill-num"]], [
			`<tr><td>Counted</td>${num(count(s.counted.items))}${num(money(s.counted.value))}</tr>`,
			`<tr><td>Placeholders set to 0</td>${num(count(s.placeholders.items))}${num("")}</tr>`,
			`<tr><td>Negative quantities set to 0</td>${num(count(s.negatives.items))}${num("")}</tr>`
		]);
		const journal = table([[`<code>STOCK_TAKE</code> journal`], ["Debit", "gl-backfill-num"], ["Credit", "gl-backfill-num"]],
			pv.journal.map((row) => `<tr><td>${escapeHtml(row.accnr)} ${escapeHtml(row.name || "")}</td>${num(row.debit ? money(row.debit) : "")}${num(row.credit ? money(row.credit) : "")}</tr>`));
		// Clearing nets the backfill balance to 0, so what Inventory gains past the counted stock is its share of the open-job stock.
		const inventory = table([[`Inventory on ${escapeHtml(pv.cutoverDate)}`], ["Amount", "gl-backfill-num"]], [
			`<tr><td>Left by the backfill</td>${num(money(s.inventoryBalance))}</tr>`,
			`<tr><td>Backfill clearing</td>${num(money(clearing))}</tr>`,
			`<tr><td>Counted stock</td>${num(money(s.counted.value))}</tr>`,
			`<tr><td>Stock on open jobs</td>${num(money(s.inventoryAfter - s.counted.value))}</tr>`,
			`<tr class="gl-confirm-total"><td>Inventory after</td>${num(money(s.inventoryAfter))}</tr>`
		]);
		const opening = pv.controls.opening;
		const large = Math.abs(clearing) > Math.abs(s.counted.value)
			? `<p class="gl-backfill-warning">The backfill clearing (${money(clearing)}) is larger than the stock counted. It goes to ` +
				`${escapeHtml(opening.accnr)} ${escapeHtml(opening.name || "")}, so check the backfill's cost of sales before posting.</p>`
			: "";
		const box = (html) => `<div class="gl-confirm-table">${html}</div>`;
		return large + box(stock) + box(journal) + box(inventory);
	}

	async function post() {
		const ok = await confirmList({
			title: "Post Opening Stock",
			intro: `Posts the opening stock of <strong>${escapeHtml(preview.schema)}</strong> on <strong>${escapeHtml(preview.cutoverDate)}</strong>.`,
			summary: postSummary(preview),
			wide: true,
			items: [
				"Adds a finalised opening stock take, valued at ex-VAT cost",
				"Sets the counted quantities, recorded in the stock movement ledger as <code>OPENING_STOCK_IMPORT</code>",
				"Afterwards a live backfill on or before that date is refused until the opening stock is undone"
			],
			confirmText: "Post Opening Stock"
		});
		if (!ok) return;
		running = true;
		sync();
		const resultEl = el("gl-opening-result");
		const phases = { read: "Reading the legacy stock", lines: "Writing the stock take", stock: "Setting quantities", journal: "Posting the journal" };
		resultEl.innerHTML = "";
		showWorking("Posting the opening stock…", "Starting");
		try {
			const result = await streamPost("/api/tools/gl-backfill/opening-stock/post", { ...payload(), confirm: true }, (p) => {
				showWorking("Posting the opening stock…", `${phases[p.phase] || "Working"}${p.total ? `: ${count(p.processed)} of ${count(p.total)}` : ""}`);
			});
			resultEl.innerHTML = section("Result", `<p class="gl-backfill-ok">Posted stock take ST-${escapeHtml(result.takeid)} on ${escapeHtml(result.takedate)}: ` +
				`${count(result.lines)} items worth ${money(result.value)}. Inventory at cut-over is ${money(result.inventoryAtCutover)}.</p>`);
			announceChange("repaired");
		} catch (err) {
			resultEl.innerHTML = section("Result", blocked(escapeHtml(err.message)));
			// The lists come back above the result, so the error also gets a dialog.
			await alertError("Post Opening Stock", err);
		} finally {
			running = false;
			showWorking("Refreshing the card…");
			await load();
		}
	}

	async function undo() {
		const p = preview.posted;
		const ok = await confirmList({
			title: "Undo Opening Stock",
			intro: `Undoes the opening stock take of ${escapeHtml(p.takedate)}.`,
			items: [
				`Sets the ${count(p.lines)} counted items back to quantity 0, recorded in the stock movement ledger`,
				`Deletes its stock adjustments and journal ST-${escapeHtml(p.takeid)}`,
				"Deletes the stock take session, so it can be posted again"
			],
			confirmText: "Undo",
			danger: true
		});
		if (!ok) return;
		running = true;
		sync();
		el("gl-opening-result").innerHTML = "";
		showWorking("Undoing the opening stock…", `Setting ${count(p.lines)} items back to 0 and deleting journal ST-${escapeHtml(p.takeid)}`);
		try {
			const result = await postJson("/api/tools/gl-backfill/opening-stock/undo", { confirm: true });
			el("gl-opening-result").innerHTML = section("Result", `<p class="gl-backfill-ok">Undone: ${count(result.restored)} items set back to 0${result.journalDeleted ? " and the journal deleted" : ""}.</p>`);
			announceChange("repaired");
		} catch (err) {
			await alertError("Undo Opening Stock", err);
		} finally {
			running = false;
			showWorking("Refreshing the card…");
			await load();
		}
	}

	function setup() {
		if (!el("btn-gl-opening-post")) return;
		el("gl-opening-date").addEventListener("change", reloadSoon);
		el("gl-opening-min-qty").addEventListener("change", reloadSoon);
		// A number field only fires change on leaving it; typing a threshold should show its effect too.
		el("gl-opening-min-qty").addEventListener("input", reloadSoon);
		el("gl-opening-details").addEventListener("change", onToggle);
		el("gl-opening-details").addEventListener("click", onDetailsClick);
		// toggle does not bubble, so listen in the capture phase.
		el("gl-opening-details").addEventListener("toggle", onFold, true);
		for (const id of POST_BUTTONS) el(id).addEventListener("click", post);
		el("btn-gl-opening-undo").addEventListener("click", undo);
		el("btn-gl-opening-csv").addEventListener("click", downloadCsv);
		// A backfill run, a repair or a control fix changes the opening journal.
		for (const kind of ["posted", "repaired", "controls"]) document.addEventListener(`glbackfill:${kind}`, reloadSoon);
		load();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", setup);
	} else {
		setup();
	}
})();
