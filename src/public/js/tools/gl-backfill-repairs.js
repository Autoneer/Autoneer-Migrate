// The GL Backfill page's repair tools: legacy RFC migration, general invoice
// accounts, the post-backfill repair and clearing the run history.
(function () {
	const { escapeHtml, count, money, getJson, postJson, streamPost, table, section, progressBar, statTiles, confirmList, alertError, setCardDone, announceChange } = window.GlBackfill;
	const el = (id) => document.getElementById(id);
	let scope = null;
	let running = false;

	const blocked = (message) => `<p class="gl-backfill-blocked">${message}</p>`;
	const missingText = (missing) => blocked(`Missing ${escapeHtml(missing.join(", "))}. Use a tenant created by AUTONEER-PWA.`);

	function renderRfcScope(rfc) {
		if (rfc.missing.length) return section("In this schema", missingText(rfc.missing));
		return section("In this schema",
			(rfc.pairs
				? `<p><strong>${count(rfc.pairs)}</strong> pairs to migrate (returns ${money(rfc.returnsTotal)} incl. VAT).</p>`
				: '<p class="gl-backfill-ok">Nothing left to migrate.</p>') +
			`<p>${count(rfc.migrated)} already migrated.</p>`);
	}

	function renderGeneralScope(general) {
		if (general.missing.length) return section("In this schema", missingText(general.missing));
		if (!general.suppliers.length) return section("In this schema", '<p class="gl-backfill-ok">All GENERAL invoices have an account.</p>');
		const invoices = general.suppliers.reduce((sum, row) => sum + row.invoices, 0);
		return section("In this schema", `<p><strong>${count(invoices)}</strong> GENERAL invoices without an account.</p>` + table(
			[["Supplier"], ["Invoices", "gl-backfill-num"], ["Total incl. VAT", "gl-backfill-num"]],
			general.suppliers.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td class="gl-backfill-num">${count(row.invoices)}</td>` +
				`<td class="gl-backfill-num">${money(row.total)}</td></tr>`)
		));
	}

	function renderRepairScope(repair, rfc) {
		return section("In this schema",
			`<p><strong>${count(repair.journalsMissingRefs)}</strong> supplier journals missing references.</p>` +
			`<p><strong>${count(repair.legacyRfcJournals)}</strong> legacy RFC journals to renumber` +
			`${rfc.missing.length ? "" : ` (${count(rfc.migrated)} RFCs migrated)`}.</p>`);
	}

	function renderHistoryScope(history) {
		return section("In this schema", history.runs
			? `<p><strong>${count(history.runs)}</strong> runs, <strong>${count(history.items)}</strong> document results.</p>`
			: '<p class="gl-backfill-ok">No run history.</p>');
	}

	function fillSelect(select, firstOption, options) {
		const current = select.value;
		select.innerHTML = `<option value="">${firstOption}</option>` +
			options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
		if (options.some(([value]) => String(value) === current)) select.value = current;
	}

	function sync() {
		const idle = !running && scope && !scope.busy;
		const rfcDry = el("gl-rfc-dry-run").checked;
		el("btn-gl-rfc").textContent = rfcDry ? "Start Dry Run" : "Migrate RFCs";
		el("btn-gl-rfc").disabled = !idle || scope.rfc.missing.length > 0;
		el("btn-gl-general").textContent = el("gl-general-dry-run").checked ? "Start Dry Run" : "Add Lines";
		el("btn-gl-general").disabled = !idle || scope.general.missing.length > 0;
		el("btn-gl-repair").disabled = !idle;
		el("btn-gl-history").disabled = !idle || !el("gl-history-confirm").checked;
	}

	async function loadScope() {
		try {
			scope = await getJson("/api/tools/gl-backfill/repairs");
			el("gl-rfc-scope").innerHTML = renderRfcScope(scope.rfc);
			el("gl-general-scope").innerHTML = renderGeneralScope(scope.general);
			el("gl-repair-scope").innerHTML = renderRepairScope(scope.repair, scope.rfc);
			el("gl-history-scope").innerHTML = renderHistoryScope(scope.history);
			// Green checks: nothing left to migrate or assign; journals posted and nothing left to repair.
			setCardDone(el("gl-rfc-scope"), !scope.rfc.missing.length && scope.rfc.pairs === 0);
			setCardDone(el("gl-general-scope"), !scope.general.missing.length && !scope.general.suppliers.length);
			setCardDone(el("gl-repair-scope"), scope.repair.journals > 0 && !scope.repair.journalsMissingRefs && !scope.repair.legacyRfcJournals);
			fillSelect(el("gl-general-accnr"), "Choose an account",
				scope.general.accounts.map((a) => [a.accnr, `${a.accnr} ${a.name}${a.type ? ` (${a.type.charAt(0)}${a.type.slice(1).toLowerCase()})` : ""}`]));
			fillSelect(el("gl-general-suppid"), "All suppliers", scope.general.suppliers.map((row) => [row.suppid, row.name]));
			if (scope.busy) {
				for (const id of ["gl-rfc-scope", "gl-general-scope", "gl-repair-scope", "gl-history-scope"]) {
					el(id).insertAdjacentHTML("afterbegin", '<p class="gl-backfill-warning">Another task is running. Wait for it to finish.</p>');
				}
			}
		} catch (err) {
			scope = null;
			for (const id of ["gl-rfc-scope", "gl-general-scope", "gl-repair-scope", "gl-history-scope"]) {
				el(id).innerHTML = blocked(escapeHtml(err.message));
				setCardDone(el(id), false);
			}
		}
		if (scope) sync();
		else for (const id of ["btn-gl-rfc", "btn-gl-general", "btn-gl-repair", "btn-gl-history"]) el(id).disabled = true;
	}

	// Runs one streamed task, showing its progress and then its result in resultEl.
	async function runStreamed({ resultEl, url, payload, progressText, render }) {
		running = true;
		sync();
		resultEl.innerHTML = section("Result", "<p>Starting...</p>");
		try {
			const result = await streamPost(url, payload, (p) => {
				resultEl.innerHTML = section("Result", `<p>${progressText(p)}: ${count(p.processed)} of ${count(p.total)}</p>${progressBar(p.processed, p.total)}`);
			});
			resultEl.innerHTML = section("Result", render(result));
			announceChange("repaired");
		} catch (err) {
			resultEl.innerHTML = section("Result", blocked(escapeHtml(err.message)));
		} finally {
			running = false;
			await loadScope();
		}
	}

	function detailsTable(headers, rows) {
		return rows.length ? `<div class="gl-backfill-table-wrap">${table(headers, rows)}</div>` : "";
	}

	function renderRfcResult(r) {
		const tiles = r.dryRun
			? [["Would migrate", r.migrated], ["Would release", r.released], ["Skipped", r.skipped], ["Failed", r.failed]]
			: [["Migrated", r.migrated], ["Released", r.released], ["Skipped", r.skipped], ["Failed", r.failed], ["Warnings", r.warnings]];
		const rows = r.details.map((d) => `<tr><td>${escapeHtml(d.invoice_nr)}</td><td>${escapeHtml(d.status)}</td>` +
			`<td>${d.rfcNumber == null ? "-" : escapeHtml(d.rfcNumber)}</td><td>${escapeHtml(d.message || "")}</td></tr>`);
		return `<p>${r.dryRun ? "Dry run" : "Migration"}: ${count(r.checked)} pairs checked.` +
			`${r.dryRun && (r.migrated || r.released) ? " Turn off Dry run to migrate." : ""}</p>` + statTiles(tiles) +
			detailsTable([["Original invoice"], ["Status"], ["RFC number"], ["Message"]], rows);
	}

	function renderGeneralResult(r) {
		const tiles = r.dryRun
			? [["Would add", r.inserted], ["Skipped", r.skipped], ["Failed", r.failed]]
			: [["Added", r.inserted], ["Skipped", r.skipped], ["Failed", r.failed]];
		const rows = r.details.filter((d) => d.status !== "INSERTED" && d.status !== "DRY_RUN")
			.map((d) => `<tr><td>${escapeHtml(d.invoice_nr)}</td><td>${escapeHtml(d.status)}</td><td>${escapeHtml(d.message || "")}</td></tr>`);
		return `<p>${r.dryRun ? "Dry run" : "Added lines"} with account ${escapeHtml(r.accnr)}: ${count(r.checked)} invoices checked.</p>` +
			statTiles(tiles) + detailsTable([["Invoice"], ["Status"], ["Message"]], rows);
	}

	function renderRepairResult(r) {
		const rewrite = r.rewrite;
		const rows = rewrite.details.filter((d) => d.status !== "SKIPPED")
			.map((d) => `<tr><td>${escapeHtml(d.rfc_id)}</td><td>${escapeHtml(d.original_inv_nr)}</td><td>${escapeHtml(d.status)}</td><td>${escapeHtml(d.message || "")}</td></tr>`);
		return `<p>Repair finished${r.dryRun ? " (RFC renumbering was a dry run)" : ""}.</p>` + statTiles([
			["Journals checked", r.refs.checked],
			["References filled", r.refs.updated],
			[r.dryRun ? "RFC journals to renumber" : "RFC journals renumbered", rewrite.rewritten],
			["RFCs with no legacy journal", rewrite.skipped]
		]) + detailsTable([["RFC id"], ["Original invoice"], ["Status"], ["Message"]], rows);
	}

	async function runRfcMigration() {
		const payload = {
			limit: Number(el("gl-rfc-limit").value) || 500,
			dryRun: el("gl-rfc-dry-run").checked,
			rewriteGlSourceId: el("gl-rfc-rewrite").checked,
			parkLegacyRfcRow: el("gl-rfc-park").checked
		};
		if (!payload.dryRun) {
			const ok = await confirmList({
				title: "Migrate Legacy RFCs",
				intro: `Migrates up to ${count(payload.limit)} of the ${count(scope.rfc.pairs)} RFC pairs in ${escapeHtml(scope.schema)}.`,
				items: [
					"Adds a supplier RFC record, with its lines, for each pair",
					"Sets each original invoice to <code>DONE</code> with its return amount and reduced payable",
					payload.rewriteGlSourceId ? "Renumbers a matching <code>CREDITOR_RFC</code> journal to the new RFC number" : "Leaves <code>CREDITOR_RFC</code> journals as they are",
					payload.parkLegacyRfcRow ? "Sets each legacy <code>-RFC</code> invoice to <code>RFC-LEGACY</code>" : "Leaves the legacy <code>-RFC</code> invoices as they are",
					"Sets an original whose return is empty to <code>DONE</code>, so the backfill posts it",
					"Updates the balance of each supplier involved"
				],
				confirmText: "Migrate"
			});
			if (!ok) return;
			payload.confirm = true;
		}
		await runStreamed({
			resultEl: el("gl-rfc-result"), url: "/api/tools/gl-backfill/legacy-rfcs", payload,
			progressText: () => (payload.dryRun ? "Checking RFC pairs" : "Migrating RFC pairs"), render: renderRfcResult
		});
	}

	async function runGeneralAccounts() {
		const accnr = Number(el("gl-general-accnr").value);
		if (!accnr) {
			el("gl-general-result").innerHTML = section("Result", blocked("Choose the GL account to assign."));
			return;
		}
		const suppid = Number(el("gl-general-suppid").value) || null;
		const payload = { accnr, suppid, description: el("gl-general-description").value.trim() || null, dryRun: el("gl-general-dry-run").checked };
		if (!payload.dryRun) {
			const suppliers = scope.general.suppliers.filter((row) => !suppid || row.suppid === suppid);
			const invoices = suppliers.reduce((sum, row) => sum + row.invoices, 0);
			const account = el("gl-general-accnr").selectedOptions[0].textContent;
			const ok = await confirmList({
				title: "Add General Invoice Lines",
				intro: `Adds GL lines for ${count(invoices)} GENERAL invoices${suppid ? ` from ${escapeHtml(suppliers[0] ? suppliers[0].name : "this supplier")}` : ""}.`,
				items: [
					`Adds an <code>invoice_general</code> line with account ${escapeHtml(account)} to each invoice`,
					"Records each line as posted and paid in full, as AUTONEER-PWA does",
					`Uses ${payload.description ? `"${escapeHtml(payload.description)}"` : "the invoice number"} as the line description`
				],
				confirmText: "Add Lines"
			});
			if (!ok) return;
			payload.confirm = true;
		}
		await runStreamed({
			resultEl: el("gl-general-result"), url: "/api/tools/gl-backfill/general-invoices", payload,
			progressText: () => (payload.dryRun ? "Checking invoices" : "Adding lines"), render: renderGeneralResult
		});
	}

	async function runRepair() {
		const payload = { limit: Number(el("gl-repair-limit").value) || 1000, dryRun: el("gl-repair-dry-run").checked };
		const ok = await confirmList({
			title: "Post-Backfill Repair",
			intro: `Repairs supplier and RFC journals in ${escapeHtml(scope.schema)}.`,
			items: [
				`Fills in missing supplier and invoice references on up to ${count(payload.limit)} supplier journals (${count(scope.repair.journalsMissingRefs)} need it)`,
				payload.dryRun
					? `Reports, without changing them, which of the ${count(scope.repair.legacyRfcJournals)} legacy RFC journals would be renumbered`
					: `Renumbers the ${count(scope.repair.legacyRfcJournals)} legacy RFC journals to their RFC number, deleting a legacy journal whose renumbered journal already exists`
			],
			confirmText: "Run Repair"
		});
		if (!ok) return;
		await runStreamed({
			resultEl: el("gl-repair-result"), url: "/api/tools/gl-backfill/post-repair", payload: { ...payload, confirm: true },
			progressText: (p) => (p.phase === "rfc" ? "Renumbering legacy RFC journals" : "Filling supplier references"), render: renderRepairResult
		});
	}

	async function clearHistory() {
		const ok = await confirmList({
			title: "Clear Run History",
			intro: `Clears the GL backfill run history of ${escapeHtml(scope.schema)}. This cannot be undone.`,
			items: [
				`Deletes ${count(scope.history.runs)} runs and ${count(scope.history.items)} document results from every <code>gl_backfill*</code> table`,
				"Leaves posted journals and documents as they are"
			],
			confirmText: "Clear Run History",
			danger: true
		});
		if (!ok) return;
		running = true;
		sync();
		try {
			const result = await postJson("/api/tools/gl-backfill/history/clear", { confirm: true });
			el("gl-history-result").innerHTML = section("Result", `<p class="gl-backfill-ok">Cleared ${escapeHtml(result.truncated.join(", "))}.</p>`);
			el("gl-history-confirm").checked = false;
			announceChange("repaired");
		} catch (err) {
			await alertError("Clear Run History", err);
		} finally {
			running = false;
			await loadScope();
		}
	}

	function setup() {
		if (!el("btn-gl-rfc")) return;
		for (const id of ["gl-rfc-dry-run", "gl-general-dry-run", "gl-history-confirm"]) el(id).addEventListener("change", () => scope && sync());
		el("btn-gl-rfc").addEventListener("click", runRfcMigration);
		el("btn-gl-general").addEventListener("click", runGeneralAccounts);
		el("btn-gl-repair").addEventListener("click", runRepair);
		el("btn-gl-history").addEventListener("click", clearHistory);
		document.addEventListener("glbackfill:posted", loadScope);
		loadScope();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", setup);
	} else {
		setup();
	}
})();
