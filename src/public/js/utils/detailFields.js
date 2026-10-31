/**
 * DetailFields - renders "Label: value" detail strings as a definition list.
 *
 * Connection checks report details like "Schema: x • Host: y" or "DB: C:\path".
 * Segments are split on newlines or " • ". When every segment is a "Label: value"
 * pair they render as <dl>; anything else (e.g. an error message) renders as <pre>.
 */
(function () {
	if (window.DetailFields) return;

	const LABELS = { DB: "Database" };

	const parse = (text) => {
		const segments = String(text || "")
			.split(/\n| • /)
			.map((s) => s.trim())
			.filter(Boolean);
		if (!segments.length) return [];
		const fields = [];
		for (const segment of segments) {
			const match = segment.match(/^([A-Za-z][\w ]{0,30}):\s+(.+)$/);
			if (!match) return null;
			fields.push({ label: LABELS[match[1]] || match[1], value: match[2] });
		}
		return fields;
	};

	const render = (container, text, { variant = "" } = {}) => {
		if (!container) return;
		container.replaceChildren();
		const fields = parse(text);
		if (fields === null) {
			const pre = document.createElement("pre");
			pre.className = `detail-pre${variant ? ` ${variant}` : ""}`;
			pre.textContent = String(text);
			container.appendChild(pre);
			return;
		}
		if (!fields.length) return;
		const dl = document.createElement("dl");
		dl.className = "detail-fields";
		fields.forEach(({ label, value }) => {
			const dt = document.createElement("dt");
			dt.textContent = label;
			const dd = document.createElement("dd");
			dd.textContent = value;
			dl.append(dt, dd);
		});
		container.appendChild(dl);
	};

	window.DetailFields = { parse, render };
})();
