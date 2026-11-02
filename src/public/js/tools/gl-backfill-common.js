// Helpers shared by the GL Backfill page scripts (gl-backfill.js, gl-backfill-repairs.js).
window.GlBackfill = (function () {
	function escapeHtml(value) {
		const div = document.createElement("div");
		div.textContent = value == null ? "" : String(value);
		return div.innerHTML;
	}

	function count(value) {
		return Number(value || 0).toLocaleString();
	}

	function money(value) {
		return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	}

	// Run dates arrive as the server's local midnight; show that calendar day.
	function localDate(value) {
		if (!value) return "-";
		if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return String(value);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	}

	async function getJson(url) {
		const response = await fetch(url, { cache: "no-store" });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data.success === false) throw new Error(data.message || `Request failed (${response.status})`);
		return data;
	}

	async function postJson(url, payload) {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload || {})
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data.success === false) throw new Error(data.message || `Request failed (${response.status})`);
		return data;
	}

	// Posts to an NDJSON task route; calls onProgress per progress event and resolves with the complete event.
	async function streamPost(url, payload, onProgress) {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson" },
			body: JSON.stringify(payload || {})
		});
		if (!response.ok || !(response.headers.get("Content-Type") || "").includes("application/x-ndjson")) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.message || `Request failed (${response.status})`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let result = null;
		const receive = (line) => {
			if (!line.trim()) return;
			const event = JSON.parse(line);
			if (event.type === "error") throw new Error(event.message || "The task failed");
			if (event.type === "progress" && onProgress) onProgress(event);
			if (event.type === "complete") result = event;
		};
		for (;;) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				receive(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
			if (done) break;
		}
		receive(buffer);
		if (!result) throw new Error("The connection closed before the task finished. It may still be running on the server.");
		return result;
	}

	function table(headers, rows) {
		const head = headers.map(([label, cls]) => `<th${cls ? ` class="${cls}"` : ""}>${label}</th>`).join("");
		return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
	}

	// A titled block with a faint border.
	function section(title, body) {
		return `<section class="gl-backfill-section"><h4>${title}</h4>${body}</section>`;
	}

	function progressBar(processed, total) {
		const percent = total ? Math.min(100, Math.round(Number(processed || 0) / total * 100)) : 0;
		return `<div class="gl-backfill-progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">` +
			`<span style="width: ${percent}%"></span></div>`;
	}

	// Seven dots bouncing in turn. The phase follows the clock, so a redraw doesn't restart the wave.
	function bouncingDots() {
		const dots = Array.from({ length: 7 }, (_, i) => `<span style="--i:${i}"></span>`).join("");
		return `<span class="gl-dots" aria-hidden="true" style="--dots-phase:-${Date.now() % 1400}ms">${dots}</span>`;
	}

	// A task at work: the dots, then "Title… detail".
	function workingLine(title, detail = "") {
		return `<div class="gl-backfill-working" role="status">${bouncingDots()}<span><strong>${title}</strong>${detail ? ` ${detail}` : ""}</span></div>`;
	}

	// stats: [[label, value], ...]
	function statTiles(stats) {
		return `<div class="gl-backfill-stats">${stats.map(([label, value]) =>
			`<div class="gl-backfill-stat"><strong>${count(value)}</strong><span>${label}</span></div>`).join("")}</div>`;
	}

	// A confirm modal whose body is a list of what will happen, after an optional summary. Resolves true on confirm.
	// wide: a broader dialog that sets the summary blocks and the list two to a row.
	function confirmList({ title, intro, summary = "", items, confirmText, danger = false, wide = false }) {
		const contentHTML = `<div class="gl-control-fix${wide ? " gl-confirm-grid" : ""}"><p>${intro}</p>${summary}` +
			`<div class="gl-control-fix-preview"><strong>What will happen</strong><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul></div></div>`;
		if (!window.Modal || typeof window.Modal.custom !== "function") {
			return Promise.resolve(window.confirm(`${title}\n\n${items.map((item) => `- ${item.replace(/<[^>]+>/g, "")}`).join("\n")}`));
		}
		return window.Modal.custom({ title, contentHTML, type: danger ? "warning" : "info", size: wide ? "xl" : "lg", confirmText, cancelText: "Cancel" });
	}

	function alertError(title, err) {
		if (window.Modal && typeof window.Modal.alert === "function") {
			return window.Modal.alert({ title, message: err.message || String(err), type: "error" });
		}
		window.alert(`${title}\n\n${err.message || err}`);
		return Promise.resolve();
	}

	// Shows or hides the green check on the card holding `inner`, which also ends its checking spinner.
	function setCardDone(inner, done) {
		const card = inner && inner.closest(".card");
		if (!card) return;
		card.classList.remove("is-checking");
		card.classList.toggle("is-done", Boolean(done));
		const check = card.querySelector(".gl-card-check");
		if (check) check.hidden = !done;
	}

	// Shows the spinner in the header of the card holding `inner` until setCardDone settles it.
	function setCardChecking(inner) {
		const card = inner && inner.closest(".card");
		if (card) card.classList.add("is-checking");
	}

	// Recent progress readings by key, for the time left at the recent rate.
	const ETA_WINDOW_MS = 2 * 60 * 1000;
	const ETA_MIN_SPAN_MS = 10 * 1000;
	const progressReadings = new Map();

	/**
	 * Records that `done` of `total` are finished and returns the milliseconds
	 * left at the rate of the last two minutes, or null until there are 10
	 * seconds of movement to go on.
	 */
	function timeLeft(key, done, total, now = Date.now()) {
		const readings = (progressReadings.get(key) || []).filter((r) => now - r.at <= ETA_WINDOW_MS && r.done <= done);
		readings.push({ at: now, done });
		progressReadings.set(key, readings);
		const span = now - readings[0].at;
		const moved = done - readings[0].done;
		if (done >= total || span < ETA_MIN_SPAN_MS || moved <= 0) return null;
		return (total - done) * span / moved;
	}

	function formatTimeLeft(ms, now = Date.now()) {
		if (ms < 60000) return "less than a minute left";
		const minutes = Math.round(ms / 60000);
		const span = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
		const at = new Date(now + ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return `about ${span} left, done around ${at}`;
	}

	// Tells the page's other scripts that the tenant changed: "posted" after a
	// backfill run, "repaired" after a repair task, "controls" after a control fix.
	function announceChange(kind) {
		document.dispatchEvent(new CustomEvent(`glbackfill:${kind}`));
	}

	return {
		escapeHtml, count, money, localDate, getJson, postJson, streamPost, table, section,
		progressBar, statTiles, confirmList, alertError, setCardDone, setCardChecking, announceChange, timeLeft, formatTimeLeft, workingLine
	};
})();
