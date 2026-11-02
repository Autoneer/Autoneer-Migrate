// The Clean Up page's WIP Cleanup card: previews the jobs the Pulse card counts
// as Ready for Collection, releases the settled ones completed on or before the
// cut-off (src/migrate/cleanup/wipCleanup.js), or undoes the last release.
(function () {
	const { escapeHtml, count, money, postJson, table, section, statTiles, confirmList, alertError, setCardDone, setCardChecking, announceChange, workingLine } = window.GlBackfill;
	const el = (id) => document.getElementById(id);
	const RELEASE_BUTTONS = ["btn-cleanup-wip-release", "btn-cleanup-wip-release-top"];
	// Rows the job list shows; the CSV has them all.
	const LIST_ROWS = 500;
	let preview = null;
	let running = false;
	let loading = 0;
	let latest = 0;
	// Until the user picks a cut-off, the default (30 days back) is used.
	let cutoffSet = false;
	// The form differs from the preview shown; Apply reloads it.
	let pending = false;
	// Sections the user folded, by data-fold key.
	const folded = new Set(["owingMonths", "zeroMonths", "jobs", "gl", "batches"]);

	const blocked = (message) => `<p class="gl-backfill-blocked">${message}</p>`;
	const warning = (message) => `<p class="gl-backfill-warning">${message}</p>`;
	const ok = (message) => `<p class="gl-backfill-ok">${message}</p>`;
	const num = (value) => `<td class="gl-backfill-num">${value}</td>`;
	const wrap = (html) => `<div class="gl-backfill-table-wrap">${html}</div>`;
	const dateRange = (sum) => (sum.oldest ? `${escapeHtml(sum.oldest)} to ${escapeHtml(sum.newest)}` : "-");

	function bucketBoxes() {
		return Array.from(document.querySelectorAll('input[name="cleanup-wip-bucket"]'));
	}

	function yearBoxes() {
		return Array.from(document.querySelectorAll('input[name="cleanup-wip-year"]'));
	}

	// The form as it stands. Years: null until the list exists or while every year is ticked.
	function payload() {
		const boxes = yearBoxes();
		const ticked = boxes.filter((box) => box.checked).map((box) => box.value);
		return {
			cutoffDate: cutoffSet ? el("cleanup-wip-cutoff").value || null : null,
			buckets: bucketBoxes().filter((box) => box.checked).map((box) => box.value),
			years: boxes.length && ticked.length < boxes.length ? ticked : null
		};
	}

	// The year ticks as the preview applied them, with what each year would release under its buckets and cut-off.
	function renderYears(pv) {
		const box = el("cleanup-wip-years");
		if (!pv.summary.years.length) {
			box.innerHTML = "<span>No completion dates.</span>";
			return;
		}
		const on = (period) => !pv.years || pv.years.includes(period);
		box.innerHTML = pv.summary.years.map((year) =>
			`<label class="inline-label" title="${count(year.candidates)} jobs a batch with this year would release"><input type="checkbox" name="cleanup-wip-year" value="${escapeHtml(year.period)}"${on(year.period) ? " checked" : ""} />` +
			`<span>${escapeHtml(year.period)} <small>${count(year.candidates)}</small></span></label>`).join("");
	}

	// A form change waits for Apply; the preview and the release buttons are stale until then.
	function markPending() {
		pending = true;
		sync();
	}

	function setAllYears(on) {
		yearBoxes().forEach((box) => { box.checked = on; });
		markPending();
	}

	function fold(key, title, body) {
		return `<details class="gl-backfill-section gl-backfill-fold" data-fold="${key}"${folded.has(key) ? "" : " open"}>` +
			`<summary><h4>${title}</h4></summary>${body}</details>`;
	}

	function backfillLine(run) {
		if (!run) return "<p>No live GL backfill has run on this tenant.</p>";
		return `<p>Backfill run ${count(run.id)} is <strong>${escapeHtml(run.status)}</strong>, ${escapeHtml(run.from_date || "-")} to ${escapeHtml(run.to_date || "-")}.</p>`;
	}

	// The right-hand column: what the Pulse card shows now and what has been released so far.
	function renderScope(pv) {
		const s = pv.summary;
		const released = pv.batches.reduce((sum, batch) => sum + batch.active, 0);
		const parts = [
			`<p>Schema <strong>${escapeHtml(pv.schema)}</strong>.</p>`,
			backfillLine(pv.backfill),
			`<p>Ready for Collection on the Pulse card: <strong>${count(s.awaiting.jobs)}</strong> jobs, completed ${dateRange(s.awaiting)}, ` +
			`with <strong>${money(s.awaiting.owing)}</strong> owing.</p>`,
			statTiles([["Settled", s.buckets.SETTLED.jobs], ["Balance owing", s.buckets.OWING.jobs], ["Zero amount", s.buckets.ZERO.jobs]]),
			released
				? `<p>Released from here so far: <strong>${count(released)}</strong> jobs in ${count(pv.batches.filter((batch) => batch.active).length)} ` +
					`${pv.batches.filter((batch) => batch.active).length === 1 ? "batch" : "batches"}, last on ${escapeHtml(pv.lastBatch.releasedAt)}.</p>`
				: "<p>Nothing has been released from here yet.</p>"
		];
		if (!s.awaiting.jobs) parts.push(ok("No job is waiting to be released."));
		return parts.join("");
	}

	function bucketTable(s, labels) {
		return wrap(table([["Bucket"], ["Jobs", "gl-backfill-num"], ["Balance owing", "gl-backfill-num"], ["Oldest"], ["Newest"]],
			Object.keys(labels).map((key) => {
				const b = s.buckets[key];
				return `<tr><td>${escapeHtml(labels[key])}</td>${num(count(b.jobs))}${num(money(b.owing))}<td>${escapeHtml(b.oldest || "-")}</td><td>${escapeHtml(b.newest || "-")}</td></tr>`;
			})));
	}

	function yearTable(rows) {
		return wrap(table([["Completion year"], ["Jobs", "gl-backfill-num"], ["Owing", "gl-backfill-num"], ["Released now", "gl-backfill-num"]],
			rows.map((row) => `<tr><td>${escapeHtml(row.period)}</td>${num(count(row.jobs))}${num(money(row.owing))}${num(count(row.released))}</tr>`)));
	}

	function monthTable(rows, withOwing) {
		const head = [["Completion month"], ["Jobs", "gl-backfill-num"]];
		if (withOwing) head.push(["Owing", "gl-backfill-num"]);
		else head.push(["Flagged unpaid", "gl-backfill-num"]);
		head.push(["Released now", "gl-backfill-num"]);
		return wrap(table(head, rows.map((row) =>
			`<tr><td>${escapeHtml(row.period)}</td>${num(count(row.jobs))}${num(withOwing ? money(row.owing) : count(row.unpaid))}${num(count(row.released))}</tr>`)));
	}

	function action(job, pv) {
		return job.release ? `<span class="gl-backfill-ok">Release</span>` : `Keep: ${escapeHtml(pv.keepReasons[job.keep])}`;
	}

	function jobTable(pv) {
		const rows = pv.jobs.slice(0, LIST_ROWS).map((job) =>
			`<tr><td>${count(job.job_number)}</td><td>${escapeHtml(job.regnr || "-")}</td><td>${escapeHtml(job.status)}</td><td>${escapeHtml(job.completed_on || "-")}</td>` +
			`${num(money(job.total))}${num(money(job.paid))}${num(money(job.owing))}<td>${action(job, pv)}</td></tr>`);
		const note = pv.jobs.length > LIST_ROWS ? `<p>The first ${count(LIST_ROWS)} of ${count(pv.jobs.length)} jobs, oldest first. The CSV has them all.</p>` : "";
		return note + wrap(table([["Job"], ["Reg"], ["Status"], ["Completed"], ["Invoice", "gl-backfill-num"], ["Paid", "gl-backfill-num"], ["Owing", "gl-backfill-num"], ["Action"]], rows));
	}

	function batchTable(batches) {
		return wrap(table([["Batch"], ["Released at"], ["Scope"], ["Jobs", "gl-backfill-num"], ["Still released", "gl-backfill-num"], ["Undone"]],
			batches.map((batch) => `<tr><td>${count(batch.batchId)}</td><td>${escapeHtml(batch.releasedAt)}</td><td>${escapeHtml(batch.scope || `completed on or before ${batch.cutoffDate}`)}</td>` +
				`${num(count(batch.jobs))}${num(count(batch.active))}<td>${batch.undoneAt ? `${escapeHtml(batch.undoneAt)}: ${count(batch.restored)} restored` +
					`${batch.skipped ? `, ${count(batch.skipped)} skipped` : ""}` : "-"}</td></tr>`)));
	}

	function glSection(gl) {
		if (!gl) return "";
		const c = gl.control;
		if (c.status !== "mapped") return fold("gl", "Work In Progress control", blocked(`WIP control: ${escapeHtml(c.reason || "not mapped")}. Fix it in the GL Backfill Tenant Check.`));
		const body = `<p>Account <strong>${escapeHtml(c.accnr)}</strong> ${escapeHtml(c.name || "")} holds <strong>${money(gl.balance)}</strong> on ${count(gl.wip.total.jobs)} jobs. ` +
			(gl.writeOffDate ? `The WIP write-off was posted on ${escapeHtml(gl.writeOffDate)}.` : "The WIP write-off has not been posted.") + "</p>" +
			(gl.wip.total.jobs ? wrap(table([["Job status"], ["Invoiced"], ["Jobs", "gl-backfill-num"], ["WIP", "gl-backfill-num"]],
				gl.wip.groups.map((group) => `<tr><td>${escapeHtml(group.status)}</td><td>${group.invoiced ? "Yes" : "No"}</td>${num(count(group.jobs))}${num(money(group.value))}</tr>`))) : "");
		return fold("gl", "Work In Progress control", body);
	}

	// The figures the cut-off changes: what this run releases and what stays on the Pulse card.
	function renderTotals(pv) {
		const s = pv.summary;
		const kept = s.keptByReason;
		return statTiles([["To release", s.release.jobs], ["Kept: owing", kept.OWING.jobs], ["Kept: other bucket", kept.BUCKET.jobs],
			["Kept: other years", kept.YEAR.jobs], ["Kept: after cut-off", kept.RECENT.jobs]]) +
			`<p>This batch: <strong>${escapeHtml(pv.scope)}</strong>.</p>` +
			(s.release.jobs
				? `<p>Releasing <strong>${count(s.release.jobs)}</strong> jobs completed ${dateRange(s.release)} leaves <strong>${count(s.kept.jobs)}</strong> on the Pulse card, ` +
					`${count(kept.OWING.jobs)} of them with <strong>${money(kept.OWING.owing)}</strong> owing.`
				: `<p class="gl-backfill-warning">Nothing to release in this batch. Pick a bucket and at least one year. ` +
					`<strong>${count(s.kept.jobs)}</strong> jobs stay on the Pulse card, ${count(kept.OWING.jobs)} of them with <strong>${money(kept.OWING.owing)}</strong> owing.`) +
			(kept.NO_DATE.jobs ? ` ${count(kept.NO_DATE.jobs)} jobs have no completion date and are never released from here.` : "") + "</p>";
	}

	function renderPreview(pv) {
		const s = pv.summary;
		el("cleanup-wip-scope").innerHTML = renderScope(pv);
		renderYears(pv);
		el("cleanup-wip-details").innerHTML =
			`<div id="cleanup-wip-totals">${renderTotals(pv)}</div>` +
			fold("buckets", "Buckets", bucketTable(s, pv.bucketLabels)) +
			fold("years", "Amount > 0, by completion year", yearTable(s.byYear)) +
			fold("owingMonths", `Where the balance owing sits, by month (${count(s.buckets.OWING.jobs)} jobs)`, s.owingByMonth.length ? monthTable(s.owingByMonth, true) : "<p>Nothing owing.</p>") +
			fold("zeroMonths", `Amount = 0, by month (${count(s.buckets.ZERO.jobs)} jobs)`, s.zeroByMonth.length ? monthTable(s.zeroByMonth, false) : "<p>None.</p>") +
			fold("jobs", `Jobs (${count(pv.jobs.length)})`, pv.jobs.length ? jobTable(pv) : "<p>None.</p>") +
			(pv.batches.length ? fold("batches", "Releases from here", batchTable(pv.batches)) : "") +
			glSection(pv.gl);
	}

	function canRelease() {
		return Boolean(preview && preview.ready && preview.summary.release.jobs > 0);
	}

	function sync() {
		const idle = !running && !loading && preview && !preview.busy;
		for (const id of RELEASE_BUTTONS) el(id).disabled = !idle || pending || !canRelease();
		el("btn-cleanup-wip-apply").disabled = !pending || running || loading > 0;
		el("cleanup-wip-pending").hidden = !pending;
		const undo = el("btn-cleanup-wip-undo");
		undo.hidden = !(preview && preview.lastBatch);
		undo.disabled = !idle || !(preview && preview.lastBatch);
		el("btn-cleanup-wip-csv").disabled = !idle || !(preview && preview.jobs && preview.jobs.length);
		el("cleanup-wip-cutoff").disabled = running;
		for (const box of [...bucketBoxes(), ...yearBoxes()]) box.disabled = running;
	}

	async function load() {
		const request = ++latest;
		loading++;
		setCardChecking(el("cleanup-wip-scope"));
		el("cleanup-wip-details").insertAdjacentHTML("afterbegin", workingLine("Working out the batch…"));
		sync();
		try {
			const response = await postJson("/api/tools/cleanup/wip/preview", payload());
			// A newer preview is on its way; this one is already out of date.
			if (request !== latest) return;
			preview = response;
			pending = false;
			if (!preview.ready) {
				el("cleanup-wip-scope").innerHTML = blocked(`Schema <strong>${escapeHtml(preview.schema)}</strong> is missing ${escapeHtml(preview.missingTables.join(", "))}. Use a tenant created by AUTONEER-PWA.`);
				el("cleanup-wip-details").innerHTML = "";
				preview = null;
			} else {
				el("cleanup-wip-cutoff").value = preview.cutoffDate;
				renderPreview(preview);
			}
			if (preview && preview.busy) el("cleanup-wip-scope").insertAdjacentHTML("afterbegin", warning("Another task is running. Wait for it to finish."));
			setCardDone(el("cleanup-wip-scope"), Boolean(preview && !preview.summary.awaiting.jobs));
		} catch (err) {
			if (request !== latest) return;
			preview = null;
			el("cleanup-wip-scope").innerHTML = blocked(escapeHtml(err.message));
			el("cleanup-wip-details").innerHTML = "";
			setCardDone(el("cleanup-wip-scope"), false);
		} finally {
			loading--;
			if (request !== latest && preview) sync();
		}
		if (preview) sync();
		else for (const id of [...RELEASE_BUTTONS, "btn-cleanup-wip-undo", "btn-cleanup-wip-csv"]) el(id).disabled = true;
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
		const lines = [["job_number", "regnr", "status", "completed_on", "invoices", "invoice_total", "paid", "owing", "bucket", "action"].join(",")];
		for (const job of preview.jobs) {
			lines.push([job.job_number, job.regnr, job.status, job.completed_on, job.invoices, job.total.toFixed(2), job.paid.toFixed(2), job.owing.toFixed(2),
				preview.bucketLabels[job.bucket], job.release ? "release" : `keep: ${preview.keepReasons[job.keep]}`].map(csvCell).join(","));
		}
		const link = document.createElement("a");
		link.href = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }));
		link.download = `ready-for-collection-${preview.schema}-${preview.cutoffDate}.csv`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	}

	// The confirm dialog's figures: the Pulse card before and after.
	function releaseSummary(pv) {
		const s = pv.summary;
		const kept = s.keptByReason;
		const rows = [
			`<tr><td>Ready for Collection now</td>${num(count(s.awaiting.jobs))}${num(money(s.awaiting.owing))}</tr>`,
			`<tr><td>Released now (completed ${dateRange(s.release)})</td>${num(count(s.release.jobs))}${num(money(0))}</tr>`,
			`<tr class="gl-confirm-total"><td>Left on the Pulse card</td>${num(count(s.kept.jobs))}${num(money(s.kept.owing))}</tr>`
		];
		const keptRows = Object.keys(pv.keepReasons).filter((reason) => kept[reason].jobs)
			.map((reason) => `<tr><td>${escapeHtml(pv.keepReasons[reason])}</td>${num(count(kept[reason].jobs))}${num(money(kept[reason].owing))}</tr>`);
		const box = (html) => `<div class="gl-confirm-table">${html}</div>`;
		return box(table([["Pulse card"], ["Jobs", "gl-backfill-num"], ["Owing", "gl-backfill-num"]], rows)) +
			box(table([["Kept, by reason"], ["Jobs", "gl-backfill-num"], ["Owing", "gl-backfill-num"]], keptRows));
	}

	async function release() {
		const s = preview.summary;
		const confirmed = await confirmList({
			title: "Release Completed Jobs",
			intro: `Releases this batch of <strong>${escapeHtml(preview.schema)}</strong>: <strong>${escapeHtml(preview.scope)}</strong>.`,
			summary: releaseSummary(preview),
			wide: true,
			items: [
				`Marks ${count(s.release.jobs)} jobs as <strong>Released</strong>. Job dates and balances stay as they are`,
				preview.auditTable
					? "Adds a <em>Vehicle released (migration clean-up)</em> entry to each job's history, dated on its status date"
					: "This tenant has no job history table, so no history entries are added",
				`${count(s.kept.jobs)} jobs stay on the Pulse card`,
				"<strong>Undo Last Release</strong> reverses this batch"
			],
			confirmText: `Release ${count(s.release.jobs)} Jobs`
		});
		if (!confirmed) return;
		running = true;
		sync();
		const resultEl = el("cleanup-wip-result");
		resultEl.innerHTML = "";
		el("cleanup-wip-details").innerHTML = workingLine("Releasing the jobs…", `${count(s.release.jobs)} jobs`);
		try {
			// The scope the user confirmed, as the server understood it.
			const result = await postJson("/api/tools/cleanup/wip/release", {
				cutoffDate: preview.cutoffDate, buckets: preview.buckets, years: preview.years, expectedJobs: s.release.jobs, confirm: true
			});
			resultEl.innerHTML = section("Result", ok(`Batch ${count(result.batchId)} (${escapeHtml(result.scope)}): released ${count(result.jobs)} jobs completed ` +
				`${escapeHtml(result.oldest || "-")} to ${escapeHtml(result.newest || "-")} (invoices ${money(result.total)}). ` +
				(result.auditTable ? `${count(result.auditRows)} timeline rows written, each dated on its job's status date.` : "No job audit log in this tenant.")));
			announceChange("repaired");
		} catch (err) {
			resultEl.innerHTML = section("Result", blocked(escapeHtml(err.message)));
			await alertError("Release Completed Jobs", err);
		} finally {
			running = false;
			el("cleanup-wip-details").innerHTML = workingLine("Refreshing the card…");
			await load();
		}
	}

	async function undo() {
		const batch = preview.lastBatch;
		const confirmed = await confirmList({
			title: "Undo Last Release",
			intro: `Undoes batch ${count(batch.batchId)}, released on ${escapeHtml(batch.releasedAt)}: ${escapeHtml(batch.scope || `completed on or before ${batch.cutoffDate}`)}.`,
			items: [
				`Puts ${count(batch.active)} jobs back to their old status, WIP status and location, so they return to the Pulse card`,
				"Removes the migration clean-up rows this batch wrote to the PWA job timeline",
				"A job the workshop has moved on since is skipped and keeps its history"
			],
			confirmText: "Undo",
			danger: true
		});
		if (!confirmed) return;
		running = true;
		sync();
		el("cleanup-wip-result").innerHTML = "";
		el("cleanup-wip-details").innerHTML = workingLine("Undoing the release…", `batch ${count(batch.batchId)}`);
		try {
			const result = await postJson("/api/tools/cleanup/wip/undo", { batchId: batch.batchId, confirm: true });
			el("cleanup-wip-result").innerHTML = section("Result", ok(`Batch ${count(result.batchId)} undone: ${count(result.restored)} jobs restored, ${count(result.auditRemoved)} timeline rows removed` +
				(result.skipped ? `, ${count(result.skipped)} skipped because the workshop moved them (${result.skippedJobs.map(count).join(", ")}${result.skipped > result.skippedJobs.length ? ", …" : ""})` : "") + "."));
			announceChange("repaired");
		} catch (err) {
			await alertError("Undo Last Release", err);
		} finally {
			running = false;
			el("cleanup-wip-details").innerHTML = workingLine("Refreshing the card…");
			await load();
		}
	}

	function setup() {
		if (!el("btn-cleanup-wip-release")) return;
		el("cleanup-wip-cutoff").addEventListener("change", () => {
			cutoffSet = true;
			markPending();
		});
		for (const box of bucketBoxes()) box.addEventListener("change", markPending);
		el("cleanup-wip-years").addEventListener("change", markPending);
		el("btn-cleanup-wip-years-all").addEventListener("click", () => setAllYears(true));
		el("btn-cleanup-wip-years-none").addEventListener("click", () => setAllYears(false));
		el("btn-cleanup-wip-apply").addEventListener("click", load);
		// toggle does not bubble, so listen in the capture phase.
		el("cleanup-wip-details").addEventListener("toggle", onFold, true);
		for (const id of RELEASE_BUTTONS) el(id).addEventListener("click", release);
		el("btn-cleanup-wip-undo").addEventListener("click", undo);
		el("btn-cleanup-wip-csv").addEventListener("click", downloadCsv);
		el("cleanup-wip-details").innerHTML = workingLine("Checking the tenant", "reading the jobs awaiting release");
		load();
	}

	setup();
})();
