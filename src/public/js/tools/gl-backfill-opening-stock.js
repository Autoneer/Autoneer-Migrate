// The GL Backfill page's Opening Stock card: previews and posts the migration
// opening stock take (src/migrate/gl/glBackfill/openingStock.js), or undoes it.
(function () {
	const { escapeHtml, count, money, postJson, streamPost, table, section, statTiles, confirmList, alertError, setCardDone, announceChange } = window.GlBackfill;
	const el = (id) => document.getElementById(id);
	const SHOWN = 50;
	let preview = null;
	let running = false;
	let loading = 0;
	let reloadTimer = null;
	// Items the user moved out of, or into, the placeholder list.
	const keep = new Set();
	const zero = new Set();

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

	function itemRows(rows, { toggle = null, limit = SHOWN, showCounted = false } = {}) {
		return rows.slice(0, limit).map((row) => {
			const box = toggle
				? `<td><input type="checkbox" data-opening-toggle="${toggle}" data-stock-id="${row.stock_id}"${toggle === "placeholder" ? " checked" : ""} aria-label="Set ${escapeHtml(row.partnr || row.stock_id)} to 0" /></td>`
				: "";
			return `<tr>${box}<td>${escapeHtml(row.partnr || "")}</td><td>${escapeHtml(row.description || "")}</td>` +
				`<td class="gl-backfill-num">${qty(row.legacy_quantity)}</td>${showCounted ? `<td class="gl-backfill-num">${qty(row.quantity)}</td>` : ""}` +
				`<td class="gl-backfill-num">${money(row.cost)}</td><td class="gl-backfill-num">${money(row.value)}</td></tr>`;
		});
	}

	function itemTable(title, rows, total, options = {}) {
		if (!rows.length) return "";
		const headers = [...(options.toggle ? [["Set to 0"]] : []), ["Part"], ["Description"], ["Legacy qty", "gl-backfill-num"],
			...(options.showCounted ? [["Tenant qty", "gl-backfill-num"]] : []), ["Cost ex VAT", "gl-backfill-num"], ["Legacy value", "gl-backfill-num"]];
		const shown = Math.min(rows.length, options.limit || SHOWN);
		const note = total > shown ? `<p class="gl-tool-note">Showing ${count(shown)} of ${count(total)}, largest value first. Download CSV for all.</p>` : "";
		return section(title, (options.intro || "") + `<div class="gl-backfill-table-wrap">${table(headers, itemRows(rows, options))}</div>` + note);
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

	function renderPreview(pv) {
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
			statTiles([["Items counted", s.counted.items], ["Placeholders set to 0", s.placeholders.items], ["Negatives set to 0", s.negatives.items], ["Open jobs", s.openJobs.jobs]]),
			section(`Journal on ${escapeHtml(pv.cutoverDate)}`,
				`<p>Counted stock <strong>${money(s.counted.value)}</strong> + stock on open jobs <strong>${money(s.openJobs.value)}</strong>. ` +
				`The backfill left Inventory at <strong>${money(s.inventoryBalance)}</strong> on this date; the journal reverses it, so Inventory ends at <strong>${money(s.inventoryAfter)}</strong>.</p>` +
				(journalRows.length ? `<div class="gl-backfill-table-wrap">${table([["Account"], ["Name"], ["Debit", "gl-backfill-num"], ["Credit", "gl-backfill-num"]], journalRows)}</div>` : "")),
			itemTable("Placeholders set to 0", pv.lists.placeholders, s.placeholders.items, {
				toggle: "placeholder", limit: pv.lists.placeholders.length,
				intro: `<p>Quantities of ${count(pv.placeholderMinQty)} or more, and items you set to 0. Legacy value ${money(s.placeholders.value)}. Untick an item that is real stock.</p>`
			}),
			itemTable("Largest counted items", pv.lists.counted, s.counted.items, {
				toggle: "counted", intro: "<p>Tick an item that is a service or a charge, not stock.</p>"
			}),
			itemTable("Negative quantities set to 0", pv.lists.negatives, s.negatives.items, { limit: 20, intro: `<p>Legacy value ${money(s.negatives.value)}.</p>` }),
			openRows.length ? section("Stock on open jobs", "<p>Legacy took these parts out of stock already. Finalising the job relieves this amount, after the job's supplier WIP.</p>" +
				`<div class="gl-backfill-table-wrap">${table([["Job"], ["Parts", "gl-backfill-num"], ["Cost", "gl-backfill-num"], ["Covered by WIP", "gl-backfill-num"], ["Relieved from"]], openRows)}</div>`) : "",
			itemTable("Counted with a negative cost", pv.lists.negativeCost, s.negativeCost.items, { limit: 20, intro: "<p>Posted as they are, so Inventory matches the stock valuation. Correct their cost prices.</p>" }),
			itemTable("Counted without a cost", pv.lists.zeroCost, s.zeroCost.items, { limit: 20 }),
			itemTable("Left as they are: already stocked in the tenant", pv.lists.alreadyStocked, s.alreadyStocked.items, { limit: 20, showCounted: true })
		];
		el("gl-opening-details").innerHTML = parts.join("");
	}

	function sync() {
		const idle = !running && !loading && preview && !preview.busy;
		const posted = preview && preview.posted;
		el("btn-gl-opening-post").hidden = Boolean(posted);
		el("btn-gl-opening-post").disabled = !idle || posted || !preview.canPost;
		el("btn-gl-opening-undo").hidden = !posted;
		el("btn-gl-opening-undo").disabled = !idle || !posted || !posted.canUndo;
		el("btn-gl-opening-csv").disabled = !idle || Boolean(posted) || !preview.lists;
		el("gl-opening-date").disabled = Boolean(posted);
		el("gl-opening-min-qty").disabled = Boolean(posted);
	}

	async function load() {
		loading++;
		sync();
		try {
			preview = await postJson("/api/tools/gl-backfill/opening-stock/preview", payload());
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
				renderPreview(preview);
			}
			if (preview && preview.busy) el("gl-opening-scope").insertAdjacentHTML("afterbegin", warning("Another task is running. Wait for it to finish."));
			setCardDone(el("gl-opening-scope"), Boolean(preview && preview.posted && String(preview.posted.status).toUpperCase() === "FINALISED"));
		} catch (err) {
			preview = null;
			el("gl-opening-scope").innerHTML = section("In this schema", blocked(escapeHtml(err.message)));
			el("gl-opening-details").innerHTML = "";
			setCardDone(el("gl-opening-scope"), false);
		} finally {
			loading--;
		}
		if (preview) sync();
		else for (const id of ["btn-gl-opening-post", "btn-gl-opening-undo", "btn-gl-opening-csv"]) el(id).disabled = true;
	}

	function reloadSoon() {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(load, 500);
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
		reloadSoon();
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

	async function post() {
		const s = preview.summary;
		const opening = preview.controls.opening;
		const ok = await confirmList({
			title: "Post Opening Stock",
			intro: `Posts the opening stock of ${escapeHtml(preview.schema)} on ${escapeHtml(preview.cutoverDate)}.`,
			items: [
				`Adds a finalised opening stock take with ${count(s.counted.items)} items, valued at ex-VAT cost`,
				"Sets their quantities, recorded in the stock movement ledger as <code>OPENING_STOCK_IMPORT</code>",
				`Leaves ${count(s.placeholders.items)} placeholders and ${count(s.negatives.items)} negative quantities at 0`,
				`Posts one <code>STOCK_TAKE</code> journal against ${escapeHtml(opening.accnr)} ${escapeHtml(opening.name || "")}: stock ${money(s.counted.value)}, open jobs ${money(s.openJobs.value)}, backfill clearing ${money(-s.inventoryBalance)}`,
				`Leaves Inventory at ${money(s.inventoryAfter)} on ${escapeHtml(preview.cutoverDate)}`,
				"Afterwards a live backfill on or before that date is refused until the opening stock is undone"
			],
			confirmText: "Post Opening Stock"
		});
		if (!ok) return;
		running = true;
		sync();
		const resultEl = el("gl-opening-result");
		const phases = { read: "Reading the legacy stock", lines: "Writing the stock take", stock: "Setting quantities", journal: "Posting the journal" };
		resultEl.innerHTML = section("Result", "<p>Starting...</p>");
		try {
			const result = await streamPost("/api/tools/gl-backfill/opening-stock/post", { ...payload(), confirm: true }, (p) => {
				resultEl.innerHTML = section("Result", `<p>${phases[p.phase] || "Working"}${p.total ? `: ${count(p.processed)} of ${count(p.total)}` : "..."}</p>`);
			});
			resultEl.innerHTML = section("Result", `<p class="gl-backfill-ok">Posted stock take ST-${escapeHtml(result.takeid)} on ${escapeHtml(result.takedate)}: ` +
				`${count(result.lines)} items worth ${money(result.value)}. Inventory at cut-over is ${money(result.inventoryAtCutover)}.</p>`);
			announceChange("repaired");
		} catch (err) {
			resultEl.innerHTML = section("Result", blocked(escapeHtml(err.message)));
		} finally {
			running = false;
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
		try {
			const result = await postJson("/api/tools/gl-backfill/opening-stock/undo", { confirm: true });
			el("gl-opening-result").innerHTML = section("Result", `<p class="gl-backfill-ok">Undone: ${count(result.restored)} items set back to 0${result.journalDeleted ? " and the journal deleted" : ""}.</p>`);
			announceChange("repaired");
		} catch (err) {
			await alertError("Undo Opening Stock", err);
		} finally {
			running = false;
			await load();
		}
	}

	function setup() {
		if (!el("btn-gl-opening-post")) return;
		el("gl-opening-date").addEventListener("change", reloadSoon);
		el("gl-opening-min-qty").addEventListener("change", reloadSoon);
		el("gl-opening-details").addEventListener("change", onToggle);
		el("btn-gl-opening-post").addEventListener("click", post);
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
