// The GL Backfill page's WIP Write-off card: previews and posts the cut-over
// write-off of the WIP the backfill leaves (src/migrate/gl/glBackfill/wipWriteOff.js), or undoes it.
(function () {
	const { escapeHtml, count, money, postJson, table, section, statTiles, confirmList, alertError, setCardDone, announceChange, workingLine } = window.GlBackfill;
	const el = (id) => document.getElementById(id);
	// Post sits at the top of the card as well as the bottom.
	const POST_BUTTONS = ["btn-gl-wip-post", "btn-gl-wip-post-top"];
	let preview = null;
	let running = false;
	let loading = 0;
	let latest = 0;
	let reloadTimer = null;
	// Until the user picks a keep-from date, it follows the cut-over.
	let keepFromSet = false;
	// Unfinished jobs the user ticked to write off, or unticked to keep.
	const keep = new Set();
	const writeOff = new Set();
	// Sections the user folded, by data-fold key; the long list of other jobs starts folded.
	const folded = new Set(["other"]);

	const blocked = (message) => `<p class="gl-backfill-blocked">${message}</p>`;
	const warning = (message) => `<p class="gl-backfill-warning">${message}</p>`;
	const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
	const num = (value) => `<td class="gl-backfill-num">${value}</td>`;

	function payload() {
		return {
			cutoverDate: el("gl-wip-date").value || null,
			keepFrom: keepFromSet ? el("gl-wip-keep-from").value || null : null,
			keepJobs: [...keep],
			writeOffJobs: [...writeOff]
		};
	}

	function controlLine(label, control) {
		if (control && control.status === "mapped") return `<p>${label}: <strong>${escapeHtml(control.accnr)}</strong> ${escapeHtml(control.name || "")}</p>`;
		return blocked(`${label}: ${escapeHtml(control && control.reason ? control.reason : "not mapped")}. Fix it in the Tenant Check.`);
	}

	function fold(key, title, body) {
		return `<details class="gl-backfill-section gl-backfill-fold" data-fold="${key}"${folded.has(key) ? "" : " open"}>` +
			`<summary><h4>${title}</h4></summary>${body}</details>`;
	}

	// The figures the ticks change, worked out from the jobs as they stand.
	function totals(pv) {
		const off = pv.jobs.filter((job) => job.writeOff);
		const sum = (jobs) => round2(jobs.reduce((total, job) => total + job.wip, 0));
		const debit = round2(off.reduce((total, job) => total + (job.wip < 0 ? -job.wip : 0), 0));
		const credit = round2(off.reduce((total, job) => total + (job.wip > 0 ? job.wip : 0), 0));
		const net = round2(credit - debit);
		const { wip, opening } = pv.controls;
		const journal = off.length ? [
			{ accnr: wip.accnr, name: wip.name, debit, credit },
			...(Math.abs(net) >= 0.005 ? [{ accnr: opening.accnr, name: opening.name, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }] : [])
		] : [];
		const byReason = Object.keys(pv.reasons).map((reason) => {
			const jobs = off.filter((job) => job.reason === reason);
			return { reason, jobs: jobs.length, value: sum(jobs) };
		}).filter((row) => row.jobs);
		const kept = pv.jobs.filter((job) => !job.writeOff);
		return { writtenOff: { jobs: off.length, value: sum(off) }, kept: { jobs: kept.length, value: sum(kept) }, wipAfter: round2(pv.summary.wipBalance - sum(off)), journal, byReason };
	}

	function journalTable(rows) {
		return table([["Account"], ["Name"], ["Debit", "gl-backfill-num"], ["Credit", "gl-backfill-num"]],
			rows.map((row) => `<tr><td>${escapeHtml(row.accnr)}</td><td>${escapeHtml(row.name || "")}</td>${num(row.debit ? money(row.debit) : "")}${num(row.credit ? money(row.credit) : "")}</tr>`));
	}

	function renderTotals(pv) {
		const t = totals(pv);
		const reasonRows = t.byReason.map((row) => `<tr><td>${escapeHtml(pv.reasons[row.reason])}</td>${num(count(row.jobs))}${num(money(row.value))}</tr>`);
		return statTiles([["Jobs written off", t.writtenOff.jobs], ["Jobs kept", t.kept.jobs], ["Unfinished jobs", pv.jobs.filter((job) => job.reason === "UNFINISHED").length]]) +
			fold("journal", `Journal on ${escapeHtml(pv.cutoverDate)}`,
				`<p>WIP at ${escapeHtml(pv.cutoverDate)} is <strong>${money(pv.summary.wipBalance)}</strong>. Writing off <strong>${money(t.writtenOff.value)}</strong> ` +
				`on ${count(t.writtenOff.jobs)} jobs leaves <strong>${money(t.wipAfter)}</strong> on ${count(t.kept.jobs)} jobs.</p>` +
				(t.journal.length ? `<div class="gl-backfill-table-wrap">${journalTable(t.journal)}</div>` : "")) +
			(reasonRows.length ? fold("reasons", "Written off, by reason",
				`<div class="gl-backfill-table-wrap">${table([["Reason"], ["Jobs", "gl-backfill-num"], ["WIP", "gl-backfill-num"]], reasonRows)}</div>`) : "");
	}

	// Why an unfinished job keeps its WIP or loses it.
	function why(job, pv) {
		if (job.locked) return "The opening stock counts on it";
		if (writeOff.has(job.job_number)) return "Ticked";
		if (keep.has(job.job_number)) return "Unticked";
		return job.recent ? `WIP moved since ${escapeHtml(pv.keepFrom)}` : `No WIP since ${escapeHtml(pv.keepFrom)}`;
	}

	function unfinishedTable(pv) {
		const jobs = pv.jobs.filter((job) => job.reason === "UNFINISHED");
		if (!jobs.length) return "";
		const rows = jobs.map((job) => `<tr><td><input type="checkbox" data-wip-job="${job.job_number}"${job.writeOff ? " checked" : ""}${job.locked ? " disabled" : ""} ` +
			`aria-label="Write off job ${job.job_number}" /></td><td>${job.job_number}</td><td>${escapeHtml(job.status || "-")}</td>` +
			`<td>${escapeHtml(job.last_moved || "-")}</td>${num(money(job.wip))}<td data-wip-why="${job.job_number}">${why(job, pv)}</td></tr>`);
		return fold("unfinished", "Unfinished jobs",
			`<p>In the tenant, not invoiced and not cancelled, quotes included. AUTONEER-PWA may still invoice these, and invoicing takes the job's supplier WIP off again, ` +
			`so untick a job that may still be invoiced.</p>` +
			`<div class="gl-backfill-table-wrap">${table([["Write off"], ["Job"], ["Status"], ["WIP last moved"], ["WIP", "gl-backfill-num"], ["Why"]], rows)}</div>`);
	}

	function otherTable(pv) {
		const jobs = pv.jobs.filter((job) => job.reason !== "UNFINISHED");
		if (!jobs.length) return "";
		const rows = jobs.map((job) => `<tr><td>${job.job_number || "-"}</td><td>${escapeHtml(pv.reasons[job.reason])}</td><td>${escapeHtml(job.status || "-")}</td>` +
			`<td>${escapeHtml(job.last_moved || "-")}</td>${num(money(job.wip))}</tr>`);
		return fold("other", `Other jobs written off (${count(jobs.length)})`,
			`<p>None of these can be invoiced in AUTONEER-PWA any more.</p>` +
			`<div class="gl-backfill-table-wrap">${table([["Job"], ["Reason"], ["Status"], ["WIP last moved"], ["WIP", "gl-backfill-num"]], rows)}</div>`);
	}

	function renderPreview(pv) {
		const left = [
			controlLine("WIP", pv.controls.wip),
			controlLine("Opening Stock", pv.controls.opening),
			pv.backfill ? `<p>Last live backfill: run #${escapeHtml(pv.backfill.id)} ${escapeHtml(pv.backfill.status)}, ${escapeHtml(pv.backfill.from_date)} to ${escapeHtml(pv.backfill.to_date)}.</p>` : "",
			pv.openingStockDate ? `<p>Opening stock posted on ${escapeHtml(pv.openingStockDate)}.</p>` : "",
			...pv.blockers.map((b) => blocked(escapeHtml(b))),
			...pv.warnings.map((w) => warning(escapeHtml(w)))
		];
		el("gl-wip-scope").innerHTML = section("In this schema", left.join(""));
		el("gl-wip-details").innerHTML = `<div id="gl-wip-totals">${renderTotals(pv)}</div>` + unfinishedTable(pv) + otherTable(pv);
	}

	function renderPosted(p) {
		const lines = [
			`<p class="gl-backfill-ok">Posted on ${escapeHtml(p.trxdate)}: journal ${escapeHtml(p.sourceId)}, ${count(p.jobs)} jobs, ${money(p.value)} written off.</p>`,
			`<p>WIP at ${escapeHtml(p.trxdate)}: <strong>${money(p.wipAtCutover)}</strong>. Now: ${money(p.wipNow)}.</p>`,
			...p.undoBlockers.map((b) => warning(`Undo: ${escapeHtml(b)}`))
		];
		return section("WIP write-off", lines.join(""));
	}

	function canPost() {
		return Boolean(preview && preview.canPost && preview.jobs && preview.jobs.some((job) => job.writeOff));
	}

	function sync() {
		const idle = !running && !loading && preview && !preview.busy;
		const posted = preview && preview.posted;
		for (const id of POST_BUTTONS) {
			el(id).hidden = Boolean(posted);
			el(id).disabled = !idle || Boolean(posted) || !canPost();
		}
		el("btn-gl-wip-undo").hidden = !posted;
		el("btn-gl-wip-undo").disabled = !idle || !posted || !posted.canUndo;
		el("btn-gl-wip-csv").disabled = !idle || Boolean(posted) || !preview.jobs;
		el("gl-wip-date").disabled = Boolean(posted) || running;
		el("gl-wip-keep-from").disabled = Boolean(posted) || running;
	}

	async function load() {
		const request = ++latest;
		loading++;
		sync();
		try {
			const response = await postJson("/api/tools/gl-backfill/wip-write-off/preview", payload());
			// A newer preview is on its way; this one is already out of date.
			if (request !== latest) return;
			preview = response;
			if (preview.missingTables && preview.missingTables.length) {
				el("gl-wip-scope").innerHTML = section("In this schema", blocked(`Missing ${escapeHtml(preview.missingTables.join(", "))}. Use a tenant created by AUTONEER-PWA.`));
				el("gl-wip-details").innerHTML = "";
				preview = null;
			} else if (preview.posted) {
				el("gl-wip-scope").innerHTML = renderPosted(preview.posted);
				el("gl-wip-details").innerHTML = "";
				el("gl-wip-date").value = preview.posted.trxdate;
			} else {
				el("gl-wip-date").value = preview.cutoverDate;
				el("gl-wip-keep-from").value = preview.keepFrom;
				renderPreview(preview);
			}
			if (preview && preview.busy) el("gl-wip-scope").insertAdjacentHTML("afterbegin", warning("Another task is running. Wait for it to finish."));
			setCardDone(el("gl-wip-scope"), Boolean(preview && preview.posted));
		} catch (err) {
			if (request !== latest) return;
			preview = null;
			el("gl-wip-scope").innerHTML = section("In this schema", blocked(escapeHtml(err.message)));
			el("gl-wip-details").innerHTML = "";
			setCardDone(el("gl-wip-scope"), false);
		} finally {
			loading--;
			// An overtaken preview can finish last; the buttons still wait for it.
			if (request !== latest && preview) sync();
		}
		if (preview) sync();
		else for (const id of [...POST_BUTTONS, "btn-gl-wip-undo", "btn-gl-wip-csv"]) el(id).disabled = true;
	}

	function reloadSoon() {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(load, 500);
	}

	// A tick only moves one job, so the totals are worked out here and the list stays as it is.
	function onTick(event) {
		const box = event.target.closest("[data-wip-job]");
		if (!box || !preview || !preview.jobs) return;
		const id = Number(box.dataset.wipJob);
		const job = preview.jobs.find((row) => row.job_number === id);
		if (!job || job.locked) return;
		job.writeOff = box.checked;
		// A tick that matches the keep-from rule is no choice to remember.
		keep.delete(id);
		writeOff.delete(id);
		if (box.checked && job.recent) writeOff.add(id);
		if (!box.checked && !job.recent) keep.add(id);
		el("gl-wip-totals").innerHTML = renderTotals(preview);
		const cell = el("gl-wip-details").querySelector(`[data-wip-why="${id}"]`);
		if (cell) cell.innerHTML = why(job, preview);
		sync();
	}

	function onFold(event) {
		const key = event.target.dataset && event.target.dataset.fold;
		if (!key) return;
		if (event.target.open) folded.delete(key);
		else folded.add(key);
	}

	function csvCell(value) {
		const text = value == null ? "" : String(value);
		return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	}

	function downloadCsv() {
		const lines = [["job_number", "reason", "status", "wip_last_moved", "wip", "write_off"].join(",")];
		for (const job of preview.jobs) {
			lines.push([job.job_number || "", preview.reasons[job.reason], job.status, job.last_moved, job.wip.toFixed(2), job.writeOff ? "yes" : "no"].map(csvCell).join(","));
		}
		const link = document.createElement("a");
		link.href = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }));
		link.download = `wip-write-off-${preview.schema}-${preview.cutoverDate}.csv`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	}

	// The post dialog's figures: WIP before and after, and the journal.
	function postSummary(pv) {
		const t = totals(pv);
		const wip = table([[`WIP on ${escapeHtml(pv.cutoverDate)}`], ["Jobs", "gl-backfill-num"], ["Amount", "gl-backfill-num"]], [
			`<tr><td>Left by the backfill</td>${num(count(pv.jobs.length))}${num(money(pv.summary.wipBalance))}</tr>`,
			`<tr><td>Written off</td>${num(count(t.writtenOff.jobs))}${num(money(-t.writtenOff.value))}</tr>`,
			`<tr class="gl-confirm-total"><td>WIP after</td>${num(count(t.kept.jobs))}${num(money(t.wipAfter))}</tr>`
		]);
		const journal = table([[`<code>WIP_WRITE_OFF</code> journal`], ["Debit", "gl-backfill-num"], ["Credit", "gl-backfill-num"]],
			t.journal.map((row) => `<tr><td>${escapeHtml(row.accnr)} ${escapeHtml(row.name || "")}</td>${num(row.debit ? money(row.debit) : "")}${num(row.credit ? money(row.credit) : "")}</tr>`));
		const box = (html) => `<div class="gl-confirm-table">${html}</div>`;
		return box(wip) + box(journal);
	}

	async function post() {
		const t = totals(preview);
		const opening = preview.controls.opening;
		const ok = await confirmList({
			title: "Post WIP Write-off",
			intro: `Writes off the WIP of <strong>${escapeHtml(preview.schema)}</strong> on <strong>${escapeHtml(preview.cutoverDate)}</strong>.`,
			summary: postSummary(preview),
			wide: true,
			items: [
				`Posts one <code>WIP_WRITE_OFF</code> journal: a WIP line for each of the ${count(t.writtenOff.jobs)} jobs, against ${escapeHtml(opening.accnr)} ${escapeHtml(opening.name || "")}`,
				`Keeps the WIP of ${count(t.kept.jobs)} jobs. Don't invoice a written-off job in AUTONEER-PWA: invoicing takes its WIP off again`,
				"Afterwards a live backfill on or before that date is refused until the write-off is undone"
			],
			confirmText: "Post WIP Write-off"
		});
		if (!ok) return;
		running = true;
		sync();
		const resultEl = el("gl-wip-result");
		resultEl.innerHTML = "";
		el("gl-wip-details").innerHTML = workingLine("Posting the WIP write-off…", `${count(t.writtenOff.jobs)} job lines`);
		try {
			const result = await postJson("/api/tools/gl-backfill/wip-write-off/post", { ...payload(), confirm: true });
			resultEl.innerHTML = section("Result", `<p class="gl-backfill-ok">Posted journal ${escapeHtml(result.sourceId)} on ${escapeHtml(result.cutoverDate)}: ` +
				`${count(result.jobs)} jobs, ${money(result.value)} written off. WIP at cut-over is ${money(result.wipAtCutover)}.</p>`);
			announceChange("repaired");
		} catch (err) {
			resultEl.innerHTML = section("Result", blocked(escapeHtml(err.message)));
			await alertError("Post WIP Write-off", err);
		} finally {
			running = false;
			el("gl-wip-details").innerHTML = workingLine("Refreshing the card…");
			await load();
		}
	}

	async function undo() {
		const p = preview.posted;
		const ok = await confirmList({
			title: "Undo WIP Write-off",
			intro: `Undoes the WIP write-off of ${escapeHtml(p.trxdate)}.`,
			items: [`Deletes journal ${escapeHtml(p.sourceId)}, which puts ${money(p.value)} back on WIP for its ${count(p.jobs)} jobs`],
			confirmText: "Undo",
			danger: true
		});
		if (!ok) return;
		running = true;
		sync();
		el("gl-wip-result").innerHTML = "";
		el("gl-wip-details").innerHTML = workingLine("Undoing the WIP write-off…", `Deleting journal ${escapeHtml(p.sourceId)}`);
		try {
			const result = await postJson("/api/tools/gl-backfill/wip-write-off/undo", { confirm: true });
			el("gl-wip-result").innerHTML = section("Result", `<p class="gl-backfill-ok">Undone: ${result.journalDeleted ? "the journal is deleted" : "there was no journal to delete"}.</p>`);
			announceChange("repaired");
		} catch (err) {
			await alertError("Undo WIP Write-off", err);
		} finally {
			running = false;
			el("gl-wip-details").innerHTML = workingLine("Refreshing the card…");
			await load();
		}
	}

	function setup() {
		if (!el("btn-gl-wip-post")) return;
		el("gl-wip-date").addEventListener("change", reloadSoon);
		el("gl-wip-keep-from").addEventListener("change", () => {
			keepFromSet = true;
			reloadSoon();
		});
		el("gl-wip-details").addEventListener("change", onTick);
		// toggle does not bubble, so listen in the capture phase.
		el("gl-wip-details").addEventListener("toggle", onFold, true);
		for (const id of POST_BUTTONS) el(id).addEventListener("click", post);
		el("btn-gl-wip-undo").addEventListener("click", undo);
		el("btn-gl-wip-csv").addEventListener("click", downloadCsv);
		// A backfill run, a repair, the opening stock or a control fix changes the WIP.
		for (const kind of ["posted", "repaired", "controls"]) document.addEventListener(`glbackfill:${kind}`, reloadSoon);
		load();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", setup);
	} else {
		setup();
	}
})();
