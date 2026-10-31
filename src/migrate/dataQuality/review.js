const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { fingerprint } = require('./corrections');
const { navStyles, renderPageNav } = require('./pageNav');
const { groupId } = require('./groups');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const labels = { MISSING_PARENT: 'Related record is missing or excluded', MISSING_IDENTITY: 'Required identifier is missing', INVALID_PRIMARY_KEY: 'Invalid internal record ID', DUPLICATE_KEY: 'Conflicting records share a key', IDENTICAL_DUPLICATE: 'Repeated identical record automatically excluded', TARGET_KEY_CONFLICT: 'A record with this key already exists in the destination', INVALID_VALUE: 'A value does not meet the destination requirements', REDO_INVOICE: 'Legacy REDO invoice automatically excluded' };

async function* evidence(dir) {
	const input = fs.createReadStream(path.join(dir, 'quarantine.ndjson'));
	const lines = readline.createInterface({ input, crlfDelay: Infinity });
	let error;
	input.on('error', err => { error = err; lines.close(); });
	try { for await (const line of lines) if (line) yield JSON.parse(line); if (error) throw error; }
	finally { lines.close(); input.destroy(); }
}

async function renderReview(dir, report, query, corrections) {
	const table = String(query.table || '');
	const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
	const rows = []; let seen = 0;
	for await (const row of evidence(dir)) {
		if (table && row.table !== table) continue;
		if (seen++ < offset) continue;
		rows.push(row); if (rows.length === 26) break;
	}
	const base = '/api/quality-audits/' + encodeURIComponent(report.id);
	const link = (name, start = 0) => `${base}/view?table=${encodeURIComponent(name)}&offset=${start}`;
	const totals = report.totals || {};
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Migration data review</title><style>
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 48px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#24292f;background:#f6f8fa}
main{max-width:1150px;margin:0 auto}
h1{margin:0 0 8px;font-size:22px}
h2{margin:0;font-size:16px}
h3{margin:0;font-size:14px}
a{color:#0969da}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:0;list-style:none}
.stats li{padding:3px 10px;font-size:12px;color:#57606a;background:#fff;border:1px solid #d0d7de;border-radius:999px}
.stats strong{color:#24292f}
.stats .status{color:#fff;background:#57606a;border-color:#57606a;text-transform:capitalize}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}
.ghost{color:#24292f;background:#fff;border-color:#d0d7de}
.ghost:hover{background:#eef1f4}
.card{margin:0 0 16px;background:#fff;border:1px solid #d0d7de;border-radius:8px}
.card>summary{display:flex;align-items:center;gap:10px;padding:14px 20px;cursor:pointer;list-style:none;user-select:none}
.card>summary::-webkit-details-marker{display:none}
.card>summary::after{content:'';flex:0 0 auto;margin-left:auto;width:8px;height:8px;border-right:2px solid #57606a;border-bottom:2px solid #57606a;transform:rotate(-45deg);transition:transform .15s ease}
.card[open]>summary::after{transform:rotate(45deg) translate(-2px,-2px)}
.card>summary:hover::after{border-color:#24292f}
.card>summary:focus-visible{outline:2px solid #0969da;outline-offset:-2px;border-radius:8px}
.card>summary h2{font-size:15px}
.card-body{padding:0 20px 16px}
.card-body p{margin:0 0 8px;font-size:13px}
.card-body p:last-child{margin:0}
.count{padding:1px 8px;font-size:11px;font-weight:600;color:#57606a;background:#f6f8fa;border:1px solid #d0d7de;border-radius:999px}
.guidance p{color:#57606a}
.links{display:flex;flex-wrap:wrap;gap:6px}
.links a{padding:5px 12px;font-size:12px;text-decoration:none;color:#24292f;background:#fff;border:1px solid #d0d7de;border-radius:6px}
.links a.primary{color:#fff;background:#0969da;border-color:#0969da}
.links a:hover{background:#eef1f4}
.links a.primary:hover{background:#0860c5}
.notice{margin:0 0 16px;padding:10px 14px;font-size:13px;color:#1a7f37;background:#dafbe1;border:1px solid #4ac26b;border-left-width:3px;border-radius:8px}
.repairs ul{margin:0;padding-left:18px;font-size:13px}
@media (prefers-reduced-motion:reduce){.card>summary::after{transition:none}}
table{width:100%;border-collapse:collapse}
th,td{padding:7px 10px;text-align:left;vertical-align:middle;border-bottom:1px solid #e6edf3}
th{font-size:12px;font-weight:600;color:#57606a;background:#f6f8fa}
.summary td:not(:first-child),.summary th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
.summary tr:last-child td{border-bottom:0}
.section-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin:24px 0 12px}
.pager{display:flex;flex-wrap:wrap;gap:6px}
.pager a{padding:5px 12px;font-size:12px;text-decoration:none;color:#24292f;background:#fff;border:1px solid #d0d7de;border-radius:6px}
.pager a:hover{background:#eef1f4}${navStyles}
.record{margin-bottom:12px}
.record>summary{padding:12px 16px}
.record[open]>summary{border-bottom:1px solid #e6edf3}
.record>summary::after{margin-left:12px}
.record .row{font-weight:400;color:#57606a}
.badge{margin-left:auto;padding:2px 10px;font-size:11px;font-weight:600;border-radius:999px}
.badge.review{color:#6f4b00;background:#fff8e7;border:1px solid #ead195}
.badge.excluded{color:#57606a;background:#eef1f4;border:1px solid #d0d7de}
.reasons{margin:12px 16px;padding:8px 12px 8px 28px;font-size:13px;background:#fff8e7;border-left:3px solid #bf8700;border-radius:4px}
.reasons li{margin:2px 0}
.decide{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;margin:0 16px 12px;padding:10px 12px;font-size:13px;background:#f6fbff;border:1px solid #9cc9f5;border-radius:6px}
.decide a{padding:5px 12px;font-size:12px;text-decoration:none;white-space:nowrap;color:#fff;background:#0969da;border-radius:6px}
.decide a:hover{background:#0860c5}
.values{padding:0 16px 14px}
.values>summary{padding:4px 0 10px;font-size:13px;font-weight:600;cursor:pointer}
.fields{table-layout:fixed;font-size:13px;border:1px solid #e6edf3;border-radius:6px;overflow-wrap:anywhere}
.fields th:nth-child(1){width:22%}
.fields th:nth-child(2){width:33%}
.fields td:first-child{font-family:Consolas,ui-monospace,monospace;font-size:12px;color:#57606a}
.fields tr.editable td{background:#fffdf5}
.fields form{display:flex;flex-wrap:wrap;gap:6px;margin:0}
input{flex:1 1 140px;min-width:0;height:30px;padding:4px 8px;font:inherit;border:1px solid #d0d7de;border-radius:6px}
input:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.12)}
button{height:30px;padding:0 12px;font:inherit;font-size:12px;cursor:pointer;color:#fff;background:#0969da;border:1px solid #0969da;border-radius:6px}
button:hover{background:#0860c5}
button[name="reset"]{color:#24292f;background:#fff;border-color:#d0d7de}
button[name="reset"]:hover{background:#eef1f4}
.empty{padding:16px 20px;color:#57606a;background:#fff;border:1px dashed #d0d7de;border-radius:8px}
</style></head><body><main>
	${renderPageNav({ reportId: report.id, active: 'records', crumbs: table ? [{ label: 'All tables', href: link('') }, { label: table }] : [] })}
	<div class="page-head"><h1>Record details</h1><button type="button" class="ghost" id="toggle-all">Collapse all</button></div>
	<ul class="stats"><li class="status">${escape(report.status)}</li><li><strong>${escape(totals.scanned)}</strong> checked</li><li><strong>${escape(totals.accepted)}</strong> accepted</li><li><strong>${escape(totals.quarantined)}</strong> automatically excluded</li><li><strong>${escape(totals.review)}</strong> need a decision</li></ul>
	${query.saved ? '<p class="notice">Correction saved for the next scan. Return to Step 3 and run Check All Selected Tables to validate and apply it. The legacy database has not changed.</p>' : ''}
	<details class="card guidance"><summary><h2>How cleanup and corrections work</h2></summary><div class="card-body"><p>Automatic cleanup excludes confirmed junk and identical copies, and prepares safe internal line IDs. Use a corrected value below only when you know the right value. These changes apply to the migration copy. The next scan checks identifiers, duplicates and relationships again.</p>
	<p>For a missing related record, include its parent table in Step 2 and place it before the dependent table in Step 3. For existing-target conflicts, use the plan's table options only after deciding which destination data to retain. Do not invent invoice numbers or delete valid financial lines to clear an error.</p></div></details>
	${report.automaticRepairs?.length ? `<details class="card repairs"><summary><h2>Automatic repairs prepared</h2><span class="count">${report.automaticRepairs.length}</span></summary><div class="card-body"><ul>${report.automaticRepairs.map(item => `<li>${escape(item.table)}: ${escape(item.action)}. ${escape(item.explanation)}</li>`).join('')}</ul></div></details>` : ''}
	<details class="card"${table ? '' : ' open'}><summary><h2>Results by table</h2><span class="count">${(report.tables || []).length}</span></summary><div class="card-body"><table class="summary"><tr><th>Table</th><th>Accepted</th><th>Automatically excluded</th><th>Need a decision</th></tr>${(report.tables || []).map(item => `<tr><td><a href="${link(item.table)}">${escape(item.table)}</a></td><td>${escape(item.accepted)}</td><td>${escape(item.quarantined)}</td><td>${escape(item.review)}</td></tr>`).join('')}</table></div></details>
	<div class="section-head"><h2>${escape(table || 'All tables')} — affected records</h2><nav class="pager" aria-label="Record pages">${offset ? `<a href="${link(table, Math.max(0, offset - 25))}">← Previous records</a>` : ''}${rows.length > 25 ? `<a href="${link(table, offset + 25)}">Next records →</a>` : ''}</nav></div>
	${rows.slice(0, 25).map(row => {
		const pending = corrections[row.table + ':' + fingerprint(row.source)]?.fields || {};
		const columns = report.mapping?.[row.sourceTable]?.columns || {};
		// A key that already exists in the destination is decided for the whole group (keep destination or truncate), never by editing the key.
		const conflict = row.action === 'review' && row.reasons.find(reason => reason.code === 'TARGET_KEY_CONFLICT');
		const affected = new Set(row.reasons.filter(reason => !['MISSING_PARENT', 'TARGET_KEY_CONFLICT'].includes(reason.code)).flatMap(reason => String(reason.column || '').split(',')));
		const decide = conflict && query.download !== 'html' ? `<p class="decide"><span>Already in the destination. Decide this for the whole group instead of changing its key.</span><a class="primary" href="${base}/groups?group=${groupId(row.table, conflict.code, conflict.column)}">Decide in Repair groups</a></p>` : '';
		return `<details class="card record" open><summary><h3>${escape(row.table)} <span class="row">· Source row ${escape(row.ordinal + 1)}</span></h3><span class="badge ${row.action === 'quarantine' ? 'excluded' : 'review'}">${row.action === 'quarantine' ? 'Automatically excluded' : 'Needs a decision'}</span></summary><ul class="reasons">${row.reasons.map(reason => `<li><strong>${escape(labels[reason.code] || reason.code)}</strong>: ${escape(reason.message)}</li>`).join('')}</ul>${decide}<details class="values" open><summary>Source values and corrections</summary><table class="fields"><tr><th>Field</th><th>Original value</th><th>Correction for next scan</th></tr>${Object.entries(row.source).map(([field, value]) => {
			const mapping = Object.entries(columns).find(([source]) => source.toLowerCase() === field.toLowerCase())?.[1];
			const editable = query.download !== 'html' && row.action === 'review' && mapping && !mapping.omit && affected.has(String(mapping.target || mapping.targetColumn).toLowerCase()) && (value == null || typeof value !== 'object');
			const display = value == null ? '(empty)' : typeof value === 'object' ? '(binary or structured value)' : String(value);
			return `<tr${editable ? ' class="editable"' : ''}><td>${escape(field)}</td><td>${escape(display)}</td><td>${editable ? `<form method="post" action="${base}/correct"><input type="hidden" name="table" value="${escape(row.table)}"><input type="hidden" name="ordinal" value="${row.ordinal}"><input type="hidden" name="field" value="${escape(field)}"><input aria-label="Corrected ${escape(field)}" name="value" value="${escape(pending[field] ?? value ?? '')}" required><button type="submit">Save correction</button>${Object.hasOwn(pending, field) ? '<button name="reset" value="1">Undo saved correction</button>' : ''}</form>` : ''}</td></tr>`;
		}).join('')}</table></details></details>`;
	}).join('') || '<p class="empty">No affected records on this page.</p>'}</main>
	<script type="module">
	(() => {
		const cards = () => [...document.querySelectorAll('details.card')];
		const button = document.getElementById('toggle-all');
		const sync = () => { button.textContent = cards().some(card => card.open) ? 'Collapse all' : 'Expand all'; };
		button.addEventListener('click', () => { const open = !cards().some(card => card.open); cards().forEach(card => { card.open = open; }); sync(); });
		// toggle does not bubble, so listen in the capture phase.
		document.addEventListener('toggle', sync, true);
		sync();
	})();
	</script></body></html>`;
}
module.exports = { evidence, renderReview };
