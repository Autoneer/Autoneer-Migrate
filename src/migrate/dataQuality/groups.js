const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { RELATIONSHIPS } = require('./rules');
const { navStyles, renderPageNav } = require('./pageNav');
const { fingerprint } = require('./corrections');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rowKey = row => row.table + ':' + row.ordinal;
const groupId = (table, code, column, original) => createHash('sha256').update(JSON.stringify([table, code, column, original])).digest('hex').slice(0, 24);
const labels = { DUPLICATE_KEY: 'Conflicting duplicate keys', INVALID_PRIMARY_KEY: 'Invalid internal IDs', TARGET_KEY_CONFLICT: 'Existing destination records', INVALID_VALUE: 'Shared invalid value', MISSING_IDENTITY: 'Missing business identifiers', MISSING_PARENT: 'Missing related records', REDO_INVOICE: 'REDO invoice history', PARENT_ORDER: 'Parent tables must migrate first' };

async function loadGroups(dir, report) {
	const rows = [];
	const stream = fs.createReadStream(path.join(dir, 'quarantine.ndjson'));
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let readError;
	stream.on('error', err => { readError = err; lines.close(); });
	try { for await (const line of lines) if (line) rows.push(JSON.parse(line)); if (readError) throw readError; }
	finally { lines.close(); stream.destroy(); }
	const records = new Map(rows.map(row => [rowKey(row), row]));
	const children = new Map();
	const indexes = new Map();
	const tuple = (row, columns) => columns.some(col => row?.[col] == null) ? null : JSON.stringify(columns.map(col => String(row[col]).trimEnd()));
	for (const row of rows) for (const reason of row.reasons.filter(reason => reason.code === 'MISSING_PARENT')) {
		let parentTable = reason.parentTable;
		let ordinals = reason.parentOrdinals;
		// Older reports have enough business-key evidence to link the common relationships.
		if (!parentTable) {
			parentTable = /^No accepted ([a-z0-9_]+) parent/.exec(reason.message)?.[1];
			const relation = RELATIONSHIPS.find(rel => rel.table === row.table && rel.parent === parentTable && rel.columns.join(',') === reason.column);
			if (relation) {
				const signature = parentTable + ':' + relation.parentColumns.join(',');
				if (!indexes.has(signature)) {
					const index = new Map();
					for (const parent of rows.filter(item => item.table === parentTable)) {
						const key = tuple(parent.mapped, relation.parentColumns);
						if (key != null) { if (!index.has(key)) index.set(key, []); index.get(key).push(parent.ordinal); }
					}
					indexes.set(signature, index);
				}
				ordinals = indexes.get(signature).get(tuple(row.mapped, relation.columns)) || [];
			}
		}
		if (parentTable && ordinals?.length) {
			reason.parentTable = parentTable; reason.parentOrdinals = ordinals;
			for (const ordinal of ordinals) {
				const parent = parentTable + ':' + ordinal;
				if (!children.has(parent)) children.set(parent, new Set());
				children.get(parent).add(rowKey(row));
			}
		}
	}
	const groups = new Map();
	for (const row of rows) {
		if (row.reasons.some(reason => ['EXCLUDED_BY_DECISION', 'EXCLUDED_WITH_PARENT', 'EXCLUDED_BY_POLICY'].includes(reason.code))) continue;
		for (const reason of row.reasons) {
			if (row.action !== 'review' && reason.code !== 'REDO_INVOICE') continue;
			if (reason.code === 'MISSING_PARENT' && reason.parentOrdinals?.length) continue;
			const pair = Object.entries(report.mapping?.[row.sourceTable]?.columns || {}).find(([, rule]) => !rule.omit && String(rule.target ?? rule.targetColumn).toLowerCase() === reason.column);
			const field = pair && Object.keys(row.source).find(name => name.toLowerCase() === pair[0].toLowerCase());
			const editable = reason.code === 'INVALID_VALUE' && field && (row.source[field] == null || typeof row.source[field] !== 'object');
			const original = editable ? row.source[field] : undefined;
			const id = groupId(row.table, reason.code, reason.column, original);
			if (!groups.has(id)) groups.set(id, { id, table: row.table, code: reason.code, column: reason.column, field: editable ? field : null, original, title: labels[reason.code] || reason.code, roots: new Set(), message: reason.message });
			groups.get(id).roots.add(rowKey(row));
		}
	}
	for (const group of groups.values()) {
		group.affected = new Set(group.roots);
		const queue = [...group.roots];
		for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) || []) if (!group.affected.has(child)) { group.affected.add(child); queue.push(child); }
		group.rows = [...group.roots].map(key => records.get(key));
		group.impactedTables = [...new Set([...group.affected].map(key => records.get(key)?.table).filter(Boolean))];
	}
	// Cycles or relationships absent from older reports may have no visible root.
	// Keep those records reachable rather than presenting an empty decision list.
	const covered = new Set([...groups.values()].flatMap(group => [...group.affected]));
	for (const row of rows.filter(row => row.action === 'review' && !covered.has(rowKey(row)))) {
		const reason = row.reasons.find(item => item.code === 'MISSING_PARENT');
		if (!reason) continue;
		const id = createHash('sha256').update(row.table + ':unresolved-links').digest('hex').slice(0, 24);
		if (!groups.has(id)) groups.set(id, { id, table: row.table, code: 'MISSING_PARENT', title: 'Related records need a joint decision', message: reason.message, roots: new Set(), affected: new Set(), rows: [], impactedTables: [row.table] });
		const group = groups.get(id); group.roots.add(rowKey(row)); group.affected.add(rowKey(row)); group.rows.push(row);
	}
	return { groups: [...groups.values()].sort((a, b) => a.table.localeCompare(b.table) || b.affected.size - a.affected.size), records };
}

// Plain-language problem and ranked options for a group. Options are either a decision this page can save
// ('exclude' or 'correct') or a link to where the fix is made. The first option is the suggested default.
const IDENTIFIER_COLUMN = /(^id$|_id$|nr$|_no$|number$|code$)/i;
const FINANCIAL_TABLE = /invoice|payment|credit|journal|spares|work_done/i;
function advise(group, links) {
	const n = group.roots.size.toLocaleString();
	const linked = Math.max(0, group.affected.size - group.roots.size);
	const plusLinked = linked ? ` and ${linked.toLocaleString()} linked records` : '';
	const table = group.table;
	const column = group.column || 'key';
	// When no whole-group action is safe, the advice is to review the records (always listed below) one by one.
	const review = 'Review the records one by one';
	const exclude = { kind: 'exclude', title: 'Leave these records out', text: `${n} ${table} records${plusLinked} are not migrated.`, cta: 'Leave them out' };
	switch (group.code) {
		case 'TARGET_KEY_CONFLICT':
			return { problem: `${n} ${table} records already exist in the destination with the same ${column}.`, options: [
				{ ...exclude, title: 'Keep the destination records', text: `The ${table} records already in the destination stay as they are. These ${n} legacy copies are not migrated.`, cta: 'Keep destination records' },
				{ kind: 'link', title: 'Replace them with the legacy data', text: `Turn on “Truncate first” for ${table} in Step 3. Every ${table} record in the destination is deleted and reloaded from the legacy database.`, href: links.plan, cta: 'Go to Step 3' }] };
		case 'INVALID_VALUE': {
			if (!group.field) break;
			const identifier = IDENTIFIER_COLUMN.test(group.field) || IDENTIFIER_COLUMN.test(column);
			// Only a non-identifier numeric field has a safe default; never invent identifiers or invoice numbers.
			const suggestion = !identifier && /numeric/i.test(group.message || '') && (group.original == null || String(group.original).trim() === '') ? '0' : '';
			const correct = { kind: 'correct', title: 'Correct the value', text: `Enter the right ${group.field} once; it is applied to all ${n} records.`, suggestion, cta: 'Save correction' };
			return { problem: `${n} ${table} records have ${group.field} = ${group.original == null || group.original === '' ? '(empty)' : group.original}, which the destination does not accept.`,
				options: [correct, exclude], review: suggestion ? null : review,
				note: suggestion ? '' : `No default is suggested because ${group.field} looks like an identifier. Enter the real value only if you know it.` };
		}
		case 'MISSING_PARENT': {
			// Name the related table. If it was not checked it is missing from the plan; if it was, the referenced record was not found or not accepted.
			const parent = group.rows.flatMap(row => row.reasons).map(reason => reason.code === 'MISSING_PARENT' && (reason.parentTable || /^No accepted ([a-z0-9_]+) parent/i.exec(reason.message || '')?.[1])).find(Boolean);
			if (!parent) return { problem: `${n} ${table} records point to related records that are not being migrated.`, options: [
				{ kind: 'link', title: 'Add the missing related table', text: `Include the related table in Step 2 and place it before ${table} in Step 3, then run the check again.`, href: links.mapping, cta: 'Go to Step 2' }, exclude] };
			if (!links.scanned.has(parent)) return { problem: `${n} ${table} records point to ${parent} records, but ${parent} is not part of this migration.`, options: [
				{ kind: 'link', title: `Add ${parent} to the migration`, text: `Select ${parent} in Step 2 and place it before ${table} in Step 3, then run the check again.`, href: links.mapping, cta: 'Go to Step 2' }, exclude] };
			// Parents that exist but are blocked are linked into the parent's own group, so these records have no parent in the checked data at all.
			return { problem: `${n} ${table} records point to ${parent} records (by ${column}) that do not exist in the checked ${parent} data.`,
				options: [
					{ ...exclude, text: `${n} ${table} records${plusLinked} are not migrated because they have no ${parent} record to belong to.` }],
				note: `${parent} is already part of this migration, so adding it in Step 2 will not help. Usually the ${parent} record was deleted in the legacy system, or it falls outside the transactional date filter.` };
		}
		case 'REDO_INVOICE':
			return { problem: `${n} REDO invoices were excluded automatically${linked ? `, and ${linked.toLocaleString()} linked records belong to them` : ''}.`, options: [
				{ ...exclude, title: 'Leave the linked history out too', text: `The REDO invoices${plusLinked} are not migrated, so their history stays together.` }] };
		case 'PARENT_ORDER':
			return { problem: `${table} must migrate after the tables it depends on.`, options: [
				{ kind: 'link', title: 'Fix the table order', text: `Move ${table} below its parent tables in Step 3, then run the check again.`, href: links.plan, cta: 'Go to Step 3' }, exclude] };
		case 'DUPLICATE_KEY':
			return { problem: `${n} ${table} records share the same ${column}, so they cannot all be migrated.`, options: [exclude], review };
		case 'INVALID_PRIMARY_KEY':
			return { problem: `${n} ${table} records have an internal ID the destination cannot use.`, options: [exclude], review };
		case 'MISSING_IDENTITY':
			return { problem: `${n} ${table} records have no ${column}.`, options: [exclude], review };
	}
	return { problem: group.message || `${n} ${table} records need a decision.`, options: [exclude], review };
}

// A group is decided when its exclusion is saved, every record has the same saved correction for the group field,
// or every record has its own correction or exclusion.
const changedCorrection = (row, corrections) => Object.entries(corrections[row.table + ':' + fingerprint(row.source)]?.fields || {}).some(([field, value]) => String(value) !== String(row.source[field] ?? ''));
const recordHandled = (report, group, row, decisions, corrections) => Object.hasOwn(decisions, `${report.id}:${group.id}:${row.table}:${row.ordinal}`) || changedCorrection(row, corrections);
function savedStateFor(report, group, decisions, corrections) {
	const decisionKey = report.id + ':' + group.id;
	if (Object.hasOwn(decisions, decisionKey)) return { action: 'exclude', decisionKey };
	if (!group.rows.length) return null;
	if (group.field) {
		const values = group.rows.map(row => corrections[row.table + ':' + fingerprint(row.source)]?.fields?.[group.field]);
		if (values.every(value => value != null && value === values[0])) return { action: 'correct', value: values[0] };
	}
	return group.rows.every(row => recordHandled(report, group, row, decisions, corrections)) ? { action: 'records' } : null;
}

// What "save the suggested decisions" would do for every undecided group. Shared by the page summary and the save route.
function planBulkDecisions(report, data, decisions = {}, corrections = {}) {
	const scanned = new Set((report.tables || []).map(item => item.table));
	const plan = { exclude: [], correct: [], review: [], manual: [] };
	for (const group of data.groups) {
		if (savedStateFor(report, group, decisions, corrections)) continue;
		const advice = advise(group, { records: '', plan: '', mapping: '', scanned });
		const first = advice.options[0];
		// Groups already started record by record are left for the user to finish.
		if (group.rows.some(row => recordHandled(report, group, row, decisions, corrections))) plan.manual.push(group);
		else if (advice.review) plan.review.push(group);
		else if (first?.kind === 'exclude') plan.exclude.push(group);
		else if (first?.kind === 'correct' && first.suggestion) plan.correct.push({ group, value: first.suggestion });
		else plan.manual.push(group);
	}
	return plan;
}

function renderGroups(report, data, selectedId, preview, decisions = {}, { corrections = {}, notice = null, bulkSaved = 0, suggestion = null } = {}) {
	const base = `/api/quality-audits/${encodeURIComponent(report.id)}`;
	const selected = data.groups.find(group => group.id === selectedId);
	const link = group => `${base}/groups?group=${group.id}`;
	const savedState = group => savedStateFor(report, group, decisions, corrections);
	const groupIds = new Set(data.groups.map(group => group.id));
	const otherDecisions = Object.entries(decisions).filter(([id]) => !(id.startsWith(report.id + ':') && groupIds.has(id.slice(report.id.length + 1).split(':')[0])));
	const saved = new Map(data.groups.map(group => [group.id, savedState(group)]));
	const decidedCount = [...saved.values()].filter(Boolean).length;
	// Step 3 asks for a fresh check when it is opened with decisionSaved.
	const planLink = `/wizard?step=3&audit=${encodeURIComponent(report.id)}${decidedCount ? '&decisionSaved=1' : ''}`;
	const scanned = new Set((report.tables || []).map(item => item.table));
	const links = group => ({ records: `${base}/view?table=${encodeURIComponent(group.table)}`, plan: planLink, mapping: '/wizard?step=2', scanned });
	const summary = group => `<ul class="stats"><li><strong>${group.roots.size.toLocaleString()}</strong> source records</li><li><strong>${Math.max(0, group.affected.size - group.roots.size).toLocaleString()}</strong> linked affected records</li><li>${escape(group.impactedTables.join(', '))}</li></ul>`;
	const crumbs = !selected ? [] : [{ label: 'All groups', href: `${base}/groups` }, { label: `${selected.table} — ${selected.title}`, href: link(selected) }];
	const hidden = (group, action) => `<input type="hidden" name="group" value="${group.id}"><input type="hidden" name="action" value="${action}">`;
	let heading = 'Repair groups';
	let body;
	if (selected) {
		const advice = advise(selected, links(selected));
		heading = `${selected.table} — ${selected.title}`;
		// Options save directly (every decision can be undone); the consequences are listed on the card instead of a separate preview step.
		const applyAction = `${base}/groups/apply`;
		const consequences = item => {
			const notes = item.kind === 'correct'
				? [`Changes ${selected.field} from ${selected.original ?? '(empty)'} on ${selected.roots.size.toLocaleString()} records.`]
				: ['Records already in the destination are not changed.', ...(selected.impactedTables.some(name => FINANCIAL_TABLE.test(name)) ? ['Financial history or balances may be incomplete.'] : [])];
			return `<ul class="consequences">${[...notes, 'You can undo this afterwards.'].map(note => `<li>${escape(note)}</li>`).join('')}</ul>`;
		};
		const option = (item, index) => {
			const isChosen = preview?.action === item.kind;
			const suggested = index === 0 && !advice.review;
			const tag = isChosen ? '<span class="chosen-tag">Selected</span>' : suggested ? '<span class="suggested">Suggested</span>' : '';
			const classes = `option${suggested && !preview ? ' recommended' : ''}${isChosen ? ' chosen' : ''}`;
			// Option buttons are always the primary (blue) action of their card; the Suggested badge marks the recommendation.
			const style = '';
			const head = `<div class="option-head"><h3>${escape(item.title)}</h3>${tag}</div><p>${escape(item.text)}</p>`;
			if (item.kind === 'link') return `<div class="${classes}">${head}<a class="btn${style ? '' : ' primary'}" href="${item.href}">${escape(item.cta)}</a></div>`;
			const value = isChosen ? preview.value : item.suggestion;
			if (item.kind === 'correct') return `<form class="${classes}" method="post" action="${applyAction}">${hidden(selected, 'correct')}${head}${consequences(item)}<label>New value for ${escape(selected.field)} <span class="field-row"><input name="value" required maxlength="10000" value="${escape(value || '')}"${value ? '' : ' placeholder="Enter the correct value"'}> <button class="${style}">${escape(item.cta)}</button></span></label>${item.suggestion ? `<p class="muted small">Suggested value: <code>${escape(item.suggestion)}</code>. Change it if you know a better one.</p>` : ''}</form>`;
			if (isChosen) return `<div class="${classes}">${head}</div>`;
			return `<form class="${classes}" method="post" action="${applyAction}">${hidden(selected, 'exclude')}<input type="hidden" name="value" value="">${head}${consequences(item)}<button class="${style}">${escape(item.cta)}</button></form>`;
		};
		let confirm = '';
		if (preview) {
			const chosen = advice.options.find(option => option.kind === preview.action) || { title: preview.action === 'correct' ? 'Correct the value' : 'Leave these records out' };
			const linked = Math.max(0, selected.affected.size - selected.roots.size);
			const outcomes = preview.action === 'correct'
				? [`<strong>${escape(selected.field)}</strong> changes from <code>${escape(selected.original ?? '(empty)')}</code> to <code>${escape(preview.value)}</code> on ${selected.roots.size.toLocaleString()} matching source records.`, 'Linked records are checked again and may still need a decision.']
				: [`${selected.roots.size.toLocaleString()} ${escape(selected.table)} source records${linked ? ` and ${linked.toLocaleString()} linked records` : ''} are left out of the migration.`, 'Records already in the destination are not changed.', ...(selected.impactedTables.some(name => FINANCIAL_TABLE.test(name)) ? ['Financial history or balances may be incomplete because transactions are left out.'] : [])];
			confirm = `<section class="card confirm-panel" id="confirm" aria-labelledby="confirm-title"><h2 id="confirm-title">Confirm: ${escape(chosen.title)}</h2><h3>What will happen</h3><ul class="outcomes">${outcomes.map(item => `<li>${item}</li>`).join('')}</ul>
			<p class="muted small">Nothing is migrated yet. After saving you stay here and can move on to the next group. The next full check in Step 3 confirms the result.</p>
			<form class="actions" method="post" action="${base}/groups/apply">${hidden(selected, escape(preview.action))}<input type="hidden" name="value" value="${escape(preview.value || '')}"><button>Save this decision</button> <a class="btn" href="${link(selected)}">Cancel</a></form></section>`;
		}
		const state = saved.get(selected.id);
		const position = data.groups.indexOf(selected);
		const next = [...data.groups.slice(position + 1), ...data.groups.slice(0, position)].find(group => !saved.get(group.id));
		const nextLink = next ? `<a class="btn primary" href="${link(next)}">Next group: ${escape(next.table)} — ${escape(next.title)} →</a>` : `<a class="btn primary" href="${planLink}">All groups decided — back to the migration plan</a>`;
		const savedTitle = state && (advice.options.find(option => option.kind === state.action)?.title || (state.action === 'correct' ? 'Correct the value' : state.action === 'records' ? 'Each record decided individually' : 'Leave these records out'));
		const savedPanel = state ? `<section class="card saved-panel" role="status"><h2>✓ Decision saved: ${escape(savedTitle)}</h2>
			${state.action === 'correct' ? `<p><strong>${escape(selected.field)}</strong> becomes <code>${escape(state.value)}</code> on ${selected.roots.size.toLocaleString()} records. To use a different value, save a new one below.</p>` : state.action === 'records' ? `<p>Every record in this group has its own correction or exclusion. Change them in the records table below.</p>` : `<p>${selected.roots.size.toLocaleString()} ${escape(selected.table)} source records are left out at the next full check.</p>`}
			<div class="actions">${nextLink} <a class="btn" href="${base}/groups">All groups</a>${state.action === 'exclude' ? `<form method="post" action="${base}/groups/undo"><input type="hidden" name="decision" value="${escape(state.decisionKey)}"><button class="secondary">Undo this decision</button></form>` : ''}</div>
			<p class="muted small">${decidedCount.toLocaleString()} of ${data.groups.length.toLocaleString()} groups decided. Run Check All Selected Tables in Step 3 when you have finished.</p></section>` : '';
		const undoneNote = notice === 'undone' && !state ? '<p class="notice-info" role="status">Decision undone. Choose again below.</p>' : '';
		// A saved exclusion replaces the choices until it is undone; a saved correction can still be replaced with a new value.
		const choices = ['exclude', 'records'].includes(state?.action) ? '' : `<h2 class="section-title">${state ? 'Change the correction' : 'What would you like to do?'}</h2>
		${advice.review && !state ? `<p class="review-hint"><span class="suggested">Suggested</span> Review the records below and use <strong>Decide</strong> on each one. Use a whole-group option only if it applies to every record. <a href="#records">Go to the records ↓</a></p>` : ''}
		<div class="choices">${advice.options.filter(item => !state || item.kind === 'correct').map(option).join('')}</div>
		${advice.note && !state ? `<p class="muted small">${escape(advice.note)}</p>` : ''}
		${confirm || (state ? '' : '<p class="muted small">Nothing changes until you save a decision. Every choice is checked again by the next full scan.</p>')}`;
		// The group's own records, shown on this page so the user keeps their place while comparing them.
		const keys = String(selected.column || '').split(',').map(name => name.trim()).filter(Boolean);
		const values = row => row.mapped || row.source || {};
		const keyOf = row => keys.map(name => String(values(row)[name] ?? '')).join('|');
		const shown = selected.rows.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b), undefined, { numeric: true }) || a.ordinal - b.ordinal).slice(0, 50);
		const keyColumns = keys.filter(name => shown.some(row => Object.hasOwn(values(row), name)));
		// Readable columns (descriptions, names, part numbers, dates) help tell records apart, so they come first.
		const readable = name => /desc|name|partnr|part_no|date|comment|status/i.test(name) ? 0 : 1;
		const others = [...new Set(shown.flatMap(row => Object.keys(values(row))))].filter(name => !keyColumns.includes(name)).map((name, i) => [name, i]).sort((a, b) => readable(a[0]) - readable(b[0]) || a[1] - b[1]).map(([name]) => name);
		const columns = [...keyColumns, ...others.slice(0, Math.max(3, 8 - keyColumns.length))];
		const cell = value => value == null || value === '' ? '<span class="empty-value">(empty)</span>' : typeof value === 'object' ? '(binary or structured value)' : escape(value);
		// Per-record decisions: correct a flagged field or leave just this record out (e.g. one copy of a true duplicate).
		const groupPage = `${link(selected)}#records`;
		const recordDecision = row => `${report.id}:${selected.id}:${row.table}:${row.ordinal}`;
		// Invalid internal IDs: give each record its own free ID, skipping IDs other saved corrections already use.
		const suggestedIds = new Map();
		if (suggestion?.next) {
			const taken = new Set(Object.entries(corrections).filter(([key]) => key.startsWith(selected.table + ':')).flatMap(([, item]) => Object.values(item.fields || {})).map(Number));
			let candidate = suggestion.next;
			for (const row of shown) {
				if (changedCorrection(row, corrections)) continue;
				while (taken.has(candidate) || suggestion.used?.has(candidate)) candidate++;
				suggestedIds.set(row.ordinal, candidate++);
			}
		}
		const recordPanel = row => {
			const pending = corrections[row.table + ':' + fingerprint(row.source)]?.fields || {};
			const sourceColumns = report.mapping?.[row.sourceTable]?.columns || {};
			// Same rule as Record details: keys that already exist in the destination or point to missing parents are not edited per record.
			const affected = new Set(row.reasons.filter(reason => !['MISSING_PARENT', 'TARGET_KEY_CONFLICT'].includes(reason.code)).flatMap(reason => String(reason.column || '').split(',').map(name => name.trim())));
			const editable = row.action === 'review' ? Object.entries(row.source).filter(([field, value]) => {
				const rule = Object.entries(sourceColumns).find(([source]) => source.toLowerCase() === field.toLowerCase())?.[1];
				return rule && !rule.omit && affected.has(String(rule.target ?? rule.targetColumn).toLowerCase()) && (value == null || typeof value !== 'object');
			}) : [];
			const hiddenRecord = `<input type="hidden" name="table" value="${escape(row.table)}"><input type="hidden" name="ordinal" value="${row.ordinal}">`;
			const fieldForms = editable.map(([field, value]) => {
				const rule = Object.entries(sourceColumns).find(([source]) => source.toLowerCase() === field.toLowerCase())?.[1];
				const target = String(rule?.target ?? rule?.targetColumn ?? '').toLowerCase();
				const savedChange = Object.hasOwn(pending, field) && String(pending[field]) !== String(value ?? '') ? pending[field] : '';
				const suggested = !savedChange && target === suggestion?.column ? suggestedIds.get(row.ordinal) : undefined;
				const hint = suggested ? `<p class="muted small">Suggested <code>${suggested}</code>: the next ${escape(target)} not used by any ${escape(row.table)} record in the scan${suggestion.destinationChecked ? ' or the destination' : ''} (highest in use: ${Math.max(suggestion.scanMax, suggestion.destinationMax).toLocaleString()}).</p>` : '';
				return `<form class="record-fix" method="post" action="${base}/correct">${hiddenRecord}<input type="hidden" name="field" value="${escape(field)}"><input type="hidden" name="returnTo" value="${escape(groupPage)}"><label>${escape(field)} <span class="muted">currently</span> <code>${escape(value ?? '(empty)')}</code></label><span class="field-row"><input name="value" required maxlength="10000" aria-label="Corrected ${escape(field)}" value="${escape(savedChange || suggested || '')}" placeholder="Enter a new value"> <button>Save correction</button>${Object.hasOwn(pending, field) ? ' <button class="secondary" name="reset" value="1">Undo correction</button>' : ''}</span>${hint}</form>`;
			}).join('');
			if (state?.action === 'exclude') return `<div class="record-panel"><ul class="record-reasons">${row.reasons.map(reason => `<li><strong>${escape(labels[reason.code] || reason.code)}</strong>: ${escape(reason.message)}</li>`).join('')}</ul><p class="muted small">The whole group is left out. To decide record by record, use <strong>Undo this decision</strong> above first.</p></div>`;
			const excluded = Object.hasOwn(decisions, recordDecision(row));
			const leaveOut = `<form method="post" action="${base}/groups/exclude-record"><input type="hidden" name="group" value="${selected.id}">${hiddenRecord}${excluded ? '<input type="hidden" name="undo" value="1"><button class="secondary">Include this record again</button>' : '<button class="secondary">Leave this record out</button>'}</form>`;
			return `<div class="record-panel"><ul class="record-reasons">${row.reasons.map(reason => `<li><strong>${escape(labels[reason.code] || reason.code)}</strong>: ${escape(reason.message)}</li>`).join('')}</ul>
				${fieldForms || '<p class="muted small">No field on this record can be corrected here. Leave it out, or decide for the whole group above.</p>'}
				<div class="record-actions">${leaveOut}</div></div>`;
		};
		const status = row => {
			if (state?.action === 'exclude' || Object.hasOwn(decisions, recordDecision(row))) return '<span class="record-status out">Left out</span>';
			return changedCorrection(row, corrections) ? '<span class="record-status fixed">Corrected</span>' : '';
		};
		let band = false;
		const recordRows = shown.map((row, i) => {
			if (i && keyOf(row) !== keyOf(shown[i - 1])) band = !band;
			const panelId = `record-${row.ordinal}`;
			return `<tr${band ? ' class="band"' : ''}><td class="decide-cell"><button type="button" class="secondary small-btn" aria-expanded="false" aria-controls="${panelId}" data-toggle="${panelId}">Decide</button> ${status(row)}</td><td class="num">${row.ordinal + 1}</td>${columns.map(name => `<td${keyColumns.includes(name) ? ' class="key"' : ''}>${cell(values(row)[name])}</td>`).join('')}</tr>
			<tr class="record-detail" id="${panelId}" hidden><td colspan="${columns.length + 2}">${recordPanel(row)}</td></tr>`;
		}).join('');
		const records = selected.rows.length ? `<section class="card records-card" id="records"><div class="card-head"><h2>Records in this group</h2><span class="count">${selected.rows.length.toLocaleString()}</span></div>
			<p class="muted small">${keyColumns.length ? `Sorted by ${keyColumns.map(name => `<code>${escape(name)}</code>`).join(', ')}, so records with the same value sit together. ` : ''}Use <strong>Decide</strong> on a record to correct it or leave just that record out.</p>
			<div class="table-scroll"><table class="records"><tr><th></th><th class="num">Source row</th>${columns.map(name => `<th${keyColumns.includes(name) ? ' class="key"' : ''}>${escape(name)}</th>`).join('')}</tr>${recordRows}</table></div>
			${selected.rows.length > shown.length ? `<p class="muted small">Showing ${shown.length} of ${selected.rows.length.toLocaleString()}. <a href="${base}/view?table=${encodeURIComponent(selected.table)}">Open the rest in Record details</a>.</p>` : ''}</section>` : '';
		body = `<section class="card problem-card"><p class="problem-text">${escape(advice.problem)}</p>${summary(selected)}<p class="muted small">Details: ${escape(selected.message)}</p></section>
		${savedPanel}${undoneNote}${choices}${records}`;
	} else {
		// Bulk option: save every suggested decision at once instead of checking each group.
		const bulk = planBulkDecisions(report, data, decisions, corrections);
		const records = groups => groups.reduce((sum, group) => sum + group.roots.size, 0).toLocaleString();
		const names = groups => groups.map(group => `<li>${escape(group.table)} — ${escape(group.title)}${group.column ? ` · <code>${escape(group.column)}</code>` : ''} <span class="muted">(${group.roots.size.toLocaleString()})</span></li>`).join('');
		const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
		const bulkCard = bulk.exclude.length + bulk.correct.length + bulk.review.length ? `<form class="card bulk-card" method="post" action="${base}/groups/apply-all"><div class="card-head"><h2>Save the suggested decisions</h2></div>
			<p>Don't want to check each group? Save the suggested decision for every group that isn't decided yet. Each one can still be undone from its group page.</p>
			<ul class="bulk-summary">
				${bulk.exclude.length ? `<li><strong>${plural(bulk.exclude.length, 'group')}</strong> left out (${records(bulk.exclude)} records)<details><summary>Show groups</summary><ul>${names(bulk.exclude)}</ul></details></li>` : ''}
				${bulk.correct.length ? `<li><strong>${plural(bulk.correct.length, 'group')}</strong> corrected with the suggested value<details><summary>Show groups</summary><ul>${bulk.correct.map(item => `<li>${escape(item.group.table)} — ${escape(item.group.field)} → <code>${escape(item.value)}</code> <span class="muted">(${item.group.roots.size.toLocaleString()})</span></li>`).join('')}</ul></details></li>` : ''}
				${bulk.review.length ? `<li><strong>${plural(bulk.review.length, 'group')}</strong> have no safe suggestion (${records(bulk.review)} records) and are skipped. <label class="bulk-include"><input type="checkbox" name="includeReview" value="1"> Leave these out too</label><details><summary>Show groups</summary><ul>${names(bulk.review)}</ul></details></li>` : ''}
				${bulk.manual.length ? `<li class="muted"><strong>${plural(bulk.manual.length, 'group')}</strong> need a change in Step 2 or 3, or are partly decided record by record, so they are skipped.<details><summary>Show groups</summary><ul>${names(bulk.manual)}</ul></details></li>` : ''}
			</ul>
			<div class="bulk-actions"><button>Save suggested decisions</button></div></form>` : '';
		const bulkNote = bulkSaved ? `<p class="notice-saved" role="status">✓ Saved decisions for ${plural(bulkSaved, 'group')}. Run Check All Selected Tables in Step 3 to apply them.</p>` : '';
		body = `${notice === 'undone' ? '<p class="notice-info" role="status">Decision undone.</p>' : ''}${bulkNote}<p class="intro">Decide what to do with each group of blocked records. Nothing is migrated or changed until you save a decision and run the check again.</p>
		${bulkCard}
		<section class="card"><div class="card-head"><h2>Groups to resolve</h2><span class="count">${decidedCount.toLocaleString()} of ${data.groups.length.toLocaleString()} decided</span>${decidedCount ? `<a class="btn primary" href="${planLink}">Back to the plan to run the check</a>` : ''}</div><p class="muted">Sorted by table. Linked records are counted with the group that causes them, so fixing one group can clear many records.</p>
		${report.automaticRepairs?.length ? `<details class="repairs"><summary>Automatic repairs applied — view details <span class="count">${report.automaticRepairs.length}</span></summary><ul>${report.automaticRepairs.map(item => `<li>${escape(item.table)}: ${escape(item.action)}</li>`).join('')}</ul></details>` : ''}
		<table class="groups"><tr><th>Problem</th><th class="num">Records</th><th class="num">Linked records</th><th>Suggested next step</th><th></th></tr>${data.groups.map(group => `<tr${saved.get(group.id) ? ' class="decided"' : ''}><td><strong>${escape(group.table)}</strong><span class="problem">${escape(group.title)}${group.column ? ` · <code>${escape(group.column)}</code>` : ''}</span>${group.field ? `<span class="problem">Value <code>${escape(group.original ?? '(empty)')}</code></span>` : ''}</td><td class="num">${group.roots.size.toLocaleString()}</td><td class="num${group.affected.size - group.roots.size ? '' : ' zero'}">${(group.affected.size - group.roots.size).toLocaleString()}</td>${saved.get(group.id) ? '<td class="suggestion done">✓ Decision saved</td>' : `<td class="suggestion">${escape(advise(group, links(group)).review || advise(group, links(group)).options[0].title)}</td>`}<td class="next"><div class="row-actions"><a class="btn" href="${link(group)}">${saved.get(group.id) ? 'View' : 'Decide'}</a>${saved.get(group.id)?.action === 'exclude' ? `<form method="post" action="${base}/groups/undo"><input type="hidden" name="decision" value="${escape(saved.get(group.id).decisionKey)}"><input type="hidden" name="from" value="list"><button class="secondary small-btn">Undo</button></form>` : ''}</div></td></tr>`).join('')}</table>${!data.groups.length ? '<p class="empty">No unresolved groups in this report. Return to the plan to view the result.</p>' : ''}</section>`;
	}
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Migration repair decisions</title><style>
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 48px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#24292f;background:#f6f8fa}
main{max-width:1150px;margin:0 auto}
h1{margin:0 0 10px;font-size:22px}
h2{margin:0;font-size:16px}
h3{margin:0 0 4px;font-size:14px}
p{margin:0 0 10px;font-size:13px}
a{color:#0969da}
code{padding:1px 5px;font:12px Consolas,ui-monospace,monospace;background:#f6f8fa;border:1px solid #e6edf3;border-radius:4px}
.btn{display:inline-block;padding:5px 12px;font-size:12px;line-height:1.5;text-decoration:none;white-space:nowrap;color:#24292f;background:#fff;border:1px solid #d0d7de;border-radius:6px}
.btn:hover{background:#eef1f4}${navStyles}
.intro{margin-bottom:16px;padding:10px 14px;color:#0a3069;background:#ddf4ff;border:1px solid #54aeff;border-left-width:3px;border-radius:8px}
.card{margin:0 0 16px;padding:16px 20px;background:#fff;border:1px solid #d0d7de;border-radius:8px}
.card-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:10px}
.card-head .btn{margin-left:auto}
.eyebrow{padding:1px 8px;font-size:11px;font-weight:600;color:#0969da;background:#ddf4ff;border-radius:999px}
.count{padding:1px 8px;font-size:11px;font-weight:600;color:#57606a;background:#f6f8fa;border:1px solid #d0d7de;border-radius:999px}
.muted{color:#57606a}
.callout{padding:8px 12px;background:#fff8e7;border-left:3px solid #bf8700;border-radius:4px}
.stats{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}
.stats li{padding:2px 10px;font-size:12px;color:#57606a;background:#f6f8fa;border:1px solid #d0d7de;border-radius:999px}
.stats strong{color:#24292f}
.repairs{margin:0 0 12px;font-size:13px}
.repairs summary{cursor:pointer;font-weight:600}
.repairs ul{margin:8px 0 0;padding-left:18px;color:#57606a}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 10px;text-align:left;vertical-align:middle;border-bottom:1px solid #e6edf3}
th{font-size:12px;font-weight:600;color:#57606a;background:#f6f8fa}
tr:last-child td{border-bottom:0}
.groups tr:hover td{background:#fafbfc}
.records-card{margin-top:20px;scroll-margin-top:16px}
.table-scroll{overflow-x:auto;border:1px solid #e6edf3;border-radius:6px}
.records{font-size:12px;white-space:nowrap}
.records th.key,.records td.key{background:#fff8e7;font-weight:600}
.records tr.band td{background:#f6f8fa}
.records tr.band td.key{background:#fdf0d5}
.empty-value{color:#8c959f}
.records .decide-cell{text-align:left}
.record-status{margin:0 0 0 4px}
.small-btn{height:26px;padding:0 10px;font-size:12px}
.record-status{margin-right:6px;padding:1px 8px;font-size:11px;font-weight:600;border-radius:999px}
.record-status.out{color:#57606a;background:#eef1f4;border:1px solid #d0d7de}
.record-status.fixed{color:#1a7f37;background:#dafbe1;border:1px solid #4ac26b}
.records tr.record-detail td{padding:0;white-space:normal;background:#f6fbff}
.record-panel{padding:12px 16px;border-left:3px solid #0969da}
.record-reasons{margin:0 0 10px;padding-left:18px;font-size:12px}
.record-fix{margin:0 0 10px}
.record-fix label{margin-bottom:4px;font-weight:600}
.record-fix .field-row{max-width:560px}
.record-actions{display:flex;gap:8px}
.problem{display:block;margin-top:2px;font-size:12px;color:#57606a}
.num{text-align:right;font-variant-numeric:tabular-nums}
.zero{color:#8c959f}
.next{text-align:right}
.problem-card{border-left:3px solid #bf8700}
.problem-text{margin:0 0 10px;font-size:15px;font-weight:600}
.small{font-size:12px}
.lead{margin-bottom:12px}
.section-title{margin:24px 0 10px;font-size:15px}
.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:12px}
.option{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:0;padding:16px 18px;background:#fff;border:1px solid #d0d7de;border-radius:8px}
.option>button,.option>a.btn{align-self:flex-end;margin-top:auto}
.option p{flex:1}
.option label{align-self:stretch}
.option.recommended{background:#f6fbff;border:2px solid #0969da;padding:15px 17px}
.option-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.option-head h3{margin:0}
.suggested{padding:1px 8px;font-size:11px;font-weight:600;color:#fff;background:#0969da;border-radius:999px}
.option.chosen{background:#f0fbf3;border:2px solid #1a7f37;padding:15px 17px}
.chosen-tag{padding:1px 8px;font-size:11px;font-weight:600;color:#fff;background:#1a7f37;border-radius:999px}
.saved-panel{background:#f0fbf3;border:2px solid #1a7f37}
.saved-panel h2{margin-bottom:6px;color:#1a7f37}
.saved-panel .actions{margin-top:12px;padding-top:0;border-top:0}
.actions form{display:inline;margin:0}
.bulk-card{border-left:3px solid #0969da}
.bulk-card>p{margin:0 0 10px;font-size:13px}
.bulk-summary{margin:0 0 12px;padding-left:18px;font-size:13px}
.bulk-summary>li{margin:6px 0}
.bulk-summary details{margin-top:2px;font-size:12px}
.bulk-summary details summary{cursor:pointer;color:#0969da}
.bulk-summary details ul{margin:4px 0 0;padding-left:18px;color:#24292f}
.bulk-include{display:inline-flex;align-items:center;gap:6px;margin-left:6px;font-weight:600}
.bulk-include input{flex:none;width:auto;height:auto}
.bulk-actions{display:flex;justify-content:flex-end}
.notice-saved{margin:0 0 16px;padding:10px 14px;color:#1a7f37;background:#dafbe1;border:1px solid #4ac26b;border-left-width:3px;border-radius:8px}
.notice-info{margin:0 0 16px;padding:10px 14px;color:#0a3069;background:#ddf4ff;border:1px solid #54aeff;border-left-width:3px;border-radius:8px}
.groups tr.decided td{background:#f6fbf7}
.suggestion.done{color:#1a7f37}
.confirm-panel{margin-top:16px;border:2px solid #1a7f37;scroll-margin-top:16px}
.confirm-panel h2{margin-bottom:10px}
.btn.primary{color:#fff;background:#0969da;border-color:#0969da}
.btn.primary:hover{background:#0860c5}
.outcomes{margin:6px 0 14px;padding-left:20px;font-size:13px}
.review-hint{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:0 0 12px;padding:10px 14px;font-size:13px;background:#f6fbff;border:1px solid #9cc9f5;border-radius:8px}
.consequences{flex:1;margin:0 0 8px;padding-left:18px;font-size:12px;color:#57606a}
.option p:has(+ .consequences){flex:0}
.outcomes li{margin:4px 0}
.suggestion{font-size:12px;color:#0969da;font-weight:500}
label{display:block;font-size:12px;font-weight:600}
.field-row{display:flex;gap:6px;margin-top:4px}
input{flex:1;min-width:0;height:32px;padding:4px 8px;font:inherit;font-weight:400;border:1px solid #d0d7de;border-radius:6px}
input:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.12)}
button{height:32px;padding:0 14px;font:inherit;font-size:13px;white-space:nowrap;cursor:pointer;color:#fff;background:#0969da;border:1px solid #0969da;border-radius:6px}
button:hover{background:#0860c5}
button.secondary{color:#24292f;background:#fff;border-color:#d0d7de}
button.secondary:hover{background:#eef1f4}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid #e6edf3}
.row-actions{display:flex;justify-content:flex-end;gap:6px}
.row-actions form{margin:0}
.other-decisions>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}
.other-decisions>summary::-webkit-details-marker{display:none}
.other-decisions>summary h2{font-size:15px}
.other-decisions[open]>summary{margin-bottom:8px}
.decision{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;border-bottom:1px solid #e6edf3}
.decision:last-child{padding-bottom:0;border-bottom:0}
.decision p{margin:0}
.empty{padding:14px;color:#57606a;border:1px dashed #d0d7de;border-radius:8px}
@media (max-width:700px){.next{text-align:left}}
</style></head><body><main>${renderPageNav({ reportId: report.id, active: 'groups', crumbs, backHref: planLink })}<h1>${escape(heading)}</h1>${body}
	${!selected && otherDecisions.length ? `<details class="card other-decisions"><summary><h2>Other saved decisions</h2><span class="count">${otherDecisions.length}</span></summary><p class="muted small">Saved from earlier scans. They still apply at the next full check.</p>${otherDecisions.map(([id, decision]) => `<form class="decision" method="post" action="${base}/groups/undo"><input type="hidden" name="decision" value="${escape(id)}"><input type="hidden" name="from" value="list"><p>${escape(decision.description)} · ${decision.records.length} source records</p><button class="secondary">Undo</button></form>`).join('')}</details>` : ''}</main>
	<script type="module">
	// Show or hide the decision panel under a record row.
	document.addEventListener('click', event => {
		const button = event.target.closest('[data-toggle]');
		if (!button) return;
		const panel = document.getElementById(button.dataset.toggle);
		panel.hidden = !panel.hidden;
		button.setAttribute('aria-expanded', String(!panel.hidden));
		button.textContent = panel.hidden ? 'Decide' : 'Close';
	});
	</script></body></html>`;
}
module.exports = { groupId, loadGroups, planBulkDecisions, renderGroups };
