const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { state } = require('../../config/state');
const mysql = require('../../db/mysql');
const runStore = require('../../migrate/runStore');
const auditService = require('../../migrate/dataQuality/service');
const { createStore, auditPath, ROOT, scopeKey } = require('../../migrate/dataQuality/store');
const { evidence, renderReview } = require('../../migrate/dataQuality/review');
const { fingerprint, readCorrections, saveCorrection, saveCorrections } = require('../../migrate/dataQuality/corrections');
const { loadGroups, planBulkDecisions, renderGroups } = require('../../migrate/dataQuality/groups');
const { readDecisions, saveDecision } = require('../../migrate/dataQuality/decisions');
const { keySuggestion, keyProblem } = require('../../migrate/dataQuality/keySuggestions');
// Destination lookups for ID suggestions are best effort; the scan data alone still gives a safe suggestion.
async function withDestination(work) {
	let pool;
	try { pool = await mysql.connectToSchema(state.mysql, state.schemaName); } catch { pool = null; }
	try { return await work(pool); } finally { if (pool) await pool.end().catch(() => {}); }
}

const router = express.Router();
const jobs = new Map();
const scope = () => ({ mysqlConfig: state.mysql, schemaName: state.schemaName });

async function startAuditJob(options) {
	const key = scopeKey(options);
	const existing = [...jobs.entries()].find(([, job]) => job.scope === key && job.running);
	if (existing) throw Object.assign(new Error('A data quality audit is already running for this tenant'), { auditId: existing[0] });
	const store = await createStore(options);
	const job = { scope: key, running: true, progress: null };
	jobs.set(store.id, job);
	try { await store.save({ id: store.id, status: 'running', createdAt: new Date().toISOString(), tables: [] }); }
	catch (err) { jobs.delete(store.id); throw err; }
	// Own the pool until background scanning and persistence finish.
	setImmediate(async () => {
		try { await auditService.createAudit({ ...options, auditStore: store, onProgress: progress => { job.progress = progress; }, checkAbort: () => {
			if (job.stopRequested) { const err = new Error('Scan stopped by user'); err.code = 'AUDIT_CANCELLED'; throw err; }
			options.checkAbort?.();
		} }); }
		catch { /* createAudit persisted the error; polling exposes it. */ }
		finally { await options.pool.end().catch(() => {}); job.running = false; jobs.delete(store.id); }
	});
	return store.id;
}

async function readReport(id) {
	const dir = auditPath(id, scope());
	const report = JSON.parse(await fs.promises.readFile(path.join(dir, 'report.json'), 'utf8'));
	const activeJob = jobs.get(id);
	if (activeJob?.stopRequested && activeJob.running && ['running', 'cancelled'].includes(report.status)) {
		report.status = 'stopping'; report.progress = activeJob.progress;
	}
	if (report.status === 'running') {
		const job = jobs.get(id);
		if (job) report.progress = job.progress;
		// Runner audits are not background preview jobs. Their run state owns them.
		else if (!report.runId || !require('../../migrate/runner').isRunActive(report.runId)) {
			report.status = 'failed'; report.error = 'The audit was interrupted. Run a new audit.';
		}
	}
	return { dir, report };
}

// Declare before /:id so "active" cannot be interpreted as an audit ID.
router.get('/quality-audits/active', async (_req, res) => {
	try {
		const active = [...jobs.entries()].find(([, job]) => job.scope === scopeKey(scope()) && job.running);
		const report = active ? (await readReport(active[0])).report : null;
		res.set?.('Cache-Control', 'no-store');
		res.json({ success: true, report });
	} catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.post('/quality-audits/:id/stop', async (req, res) => {
	try {
		// Resolve within the currently selected tenant before touching the job.
		const { report } = await readReport(req.params.id);
		if (!['running', 'stopping'].includes(report.status)) return res.json({ success: true, status: report.status });
		const job = jobs.get(req.params.id);
		if (!job || job.scope !== scopeKey(scope())) return res.status(409).json({ success: false, error: 'Use the migration Stop control for an audit owned by a migration run.' });
		job.stopRequested = true;
		res.status(202).json({ success: true, status: 'stopping' });
	} catch (err) {
		res.status(err.code === 'ENOENT' ? 404 : 400).json({ success: false, error: err.code === 'ENOENT' ? 'Audit not found for the selected tenant' : err.message });
	}
});

router.get('/quality-audits/:id/view', async (req, res) => {
	try {
		const { dir, report } = await readReport(req.params.id);
		if (!['ready', 'blocked'].includes(report.status)) return res.status(409).send('The scan must complete before records can be reviewed.');
		if (req.query.download === 'html') res.attachment('migration-data-review.html');
		res.type('html').send(await renderReview(dir, report, req.query, await readCorrections(scope())));
	} catch (err) { res.status(400).send(err.message); }
});

async function groupContext(id) {
	const { dir, report } = await readReport(id);
	if (!['ready', 'blocked'].includes(report.status)) throw new Error('Complete the scan before reviewing repair decisions');
	return { dir, report, data: await loadGroups(dir, report) };
}
router.get('/quality-audits/:id/groups', async (req, res) => {
	try {
		const { dir, report, data } = await groupContext(req.params.id);
		const notice = req.query.saved ? 'saved' : req.query.undone ? 'undone' : null;
		// Invalid internal IDs get a suggested free ID for each record.
		const selected = data.groups.find(group => group.id === req.query.group);
		const suggestion = selected?.code === 'INVALID_PRIMARY_KEY' && selected.column ? await withDestination(pool => keySuggestion({ dir, report, table: selected.table, column: selected.column, pool })) : null;
		const bulkSaved = Math.max(0, Math.floor(Number(req.query.bulk) || 0));
		res.type('html').send(renderGroups(report, data, req.query.group, null, await readDecisions(scope()), { corrections: await readCorrections(scope()), notice, bulkSaved, suggestion }));
	} catch (err) { res.status(400).send(err.message); }
});
// Save the suggested decision for every undecided group; groups without a safe suggestion are only left out when asked.
router.post('/quality-audits/:id/groups/apply-all', async (req, res) => {
	try {
		const { report, data } = await groupContext(req.params.id);
		const plan = planBulkDecisions(report, data, await readDecisions(scope()), await readCorrections(scope()));
		const excluded = [...plan.exclude, ...(req.body?.includeReview === '1' ? plan.review : [])];
		for (const group of excluded) await saveDecision(scope(), report.id + ':' + group.id, group.rows, `${group.table}: ${group.title} — source group and affected dependants excluded; destination retained`);
		for (const { group, value } of plan.correct) await saveCorrections(scope(), group.rows.map(row => ({ table: row.table, source: row.source, field: group.field, value })));
		res.redirect(`/api/quality-audits/${encodeURIComponent(report.id)}/groups?bulk=${excluded.length + plan.correct.length}`);
	} catch (err) { res.status(400).send(err.message); }
});
for (const operation of ['preview', 'apply']) router.post(`/quality-audits/:id/groups/${operation}`, async (req, res) => {
	try {
		const { report, data } = await groupContext(req.params.id);
		const { group: id, action, value } = req.body || {};
		const group = data.groups.find(item => item.id === id);
		if (!group || !['correct', 'exclude'].includes(action)) throw new Error('Select an available repair group');
		if (action === 'correct' && (!group.field || typeof value !== 'string' || !value.trim() || value.length > 10000)) throw new Error('Enter a valid correction for this group');
		if (action === 'correct' && value === String(group.original ?? '')) throw new Error('The corrected value is the same as the current value. Enter a different value, or leave the records out instead.');
		if (operation === 'preview') return res.type('html').send(renderGroups(report, data, id, { action, value }, await readDecisions(scope()), { corrections: await readCorrections(scope()) }));
		if (action === 'correct') await saveCorrections(scope(), group.rows.map(row => ({ table: row.table, source: row.source, field: group.field, value })));
		else await saveDecision(scope(), report.id + ':' + group.id, group.rows, `${group.table}: ${group.title} — source group and affected dependants excluded; destination retained`);
		// Stay on the group so the next one can be decided; the page shows the saved state and the next group.
		res.redirect(`/api/quality-audits/${encodeURIComponent(report.id)}/groups?group=${encodeURIComponent(group.id)}&saved=1`);
	} catch (err) { res.status(400).send(err.message); }
});
// Leave a single record of a group out (for example one copy of a true duplicate), or undo that.
router.post('/quality-audits/:id/groups/exclude-record', async (req, res) => {
	try {
		const { report, data } = await groupContext(req.params.id);
		const { group: id, table, ordinal, undo } = req.body || {};
		const group = data.groups.find(item => item.id === id);
		const row = group?.rows.find(item => item.table === table && item.ordinal === Number(ordinal));
		if (!row) throw new Error('Select a record from an available repair group');
		await saveDecision(scope(), `${report.id}:${group.id}:${row.table}:${row.ordinal}`, [row], `${row.table} source row ${row.ordinal + 1}: left out by record decision`, undo === '1');
		res.redirect(`/api/quality-audits/${encodeURIComponent(report.id)}/groups?group=${encodeURIComponent(group.id)}#records`);
	} catch (err) { res.status(400).send(err.message); }
});
router.post('/quality-audits/:id/groups/undo', async (req, res) => {
	try {
		await readReport(req.params.id);
		const decisions = await readDecisions(scope());
		if (!Object.hasOwn(decisions, req.body?.decision)) throw new Error('Saved decision not found');
		await saveDecision(scope(), req.body.decision, [], '', true);
		// Decision keys are "<audit id>:<group id>[:<table>:<ordinal>]"; return to that group when it belongs to this audit.
		const prefix = req.params.id + ':';
		// Undo pressed on the group list returns to the list.
		const group = req.body.from !== 'list' && req.body.decision.startsWith(prefix) ? req.body.decision.slice(prefix.length).split(':')[0] : '';
		res.redirect(`/api/quality-audits/${encodeURIComponent(req.params.id)}/groups?${group ? `group=${encodeURIComponent(group)}&` : ''}undone=1`);
	} catch (err) { res.status(400).send(err.message); }
});

router.post('/quality-audits/:id/correct', async (req, res) => {
	try {
		const { dir, report } = await readReport(req.params.id);
		if (!['ready', 'blocked'].includes(report.status)) throw new Error('Complete the scan before saving corrections');
		const { table, ordinal, field, value, reset, returnTo } = req.body || {};
		if (typeof value !== 'string' || value.length > 10000 || typeof field !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(field)) throw new Error('Enter a valid corrected value');
		let found;
		for await (const row of evidence(dir)) if (row.table === table && row.ordinal === Number(ordinal)) { found = row; break; }
		const mapping = Object.entries(report.mapping?.[found?.sourceTable]?.columns || {}).find(([name]) => name.toLowerCase() === String(field).toLowerCase())?.[1];
		if (!found || found.action !== 'review' || !Object.hasOwn(found.source, field) || !mapping || mapping.omit || (found.source[field] != null && typeof found.source[field] === 'object')) throw new Error('This field is not available for correction');
		// Saving the original value again would change nothing and the record would keep failing.
		if (reset !== '1' && value === String(found.source[field] ?? '')) throw new Error('The corrected value is the same as the current value. Enter a different value, or leave the record out instead.');
		// A new internal ID must not already be used by the scan, the destination or another saved correction.
		const target = String(mapping.target ?? mapping.targetColumn ?? '').toLowerCase();
		if (reset !== '1' && found.reasons.some(reason => reason.code === 'INVALID_PRIMARY_KEY' && reason.column === target)) {
			const corrections = await readCorrections(scope());
			const others = Object.entries(corrections).filter(([key]) => key.startsWith(table + ':') && key !== table + ':' + fingerprint(found.source)).map(([, item]) => item.fields?.[field]).filter(item => item != null);
			const problem = await withDestination(pool => keyProblem({ dir, report, table, column: target, value, pool, otherCorrections: others }));
			if (problem) throw new Error(`${problem} Use the suggested value or another unused number.`);
		}
		await saveCorrection(scope(), table, found.source, field, value, reset === '1');
		// Corrections made from a repair group return to that group; only this audit's group pages are accepted.
		const groupsPage = `/api/quality-audits/${encodeURIComponent(report.id)}/groups?`;
		if (typeof returnTo === 'string' && returnTo.startsWith(groupsPage) && !/[\r\n]/.test(returnTo)) return res.redirect(returnTo);
		res.redirect(`/api/quality-audits/${encodeURIComponent(report.id)}/view?table=${encodeURIComponent(table)}&saved=1`);
	} catch (err) { res.status(400).send(err.message); }
});

router.get('/quality-audits/:id', async (req, res) => {
	try {
		const { dir, report } = await readReport(req.params.id);
		if (req.query.download === 'quarantine') {
			if (!['ready', 'blocked'].includes(report.status)) return res.status(409).json({ success: false, error: 'Audit has not completed' });
			return res.download(path.join(dir, 'quarantine.ndjson'), `data-quality-${report.id}-quarantine.ndjson`);
		}
		if (req.query.download === 'report') {
			res.attachment(`data-quality-${report.id}.json`);
			return res.json(report);
		}
		res.json({ success: true, report });
	} catch (err) {
		res.status(err.code === 'ENOENT' ? 404 : 400).json({ success: false, error: err.code === 'ENOENT' ? 'Audit not found for the selected tenant' : err.message });
	}
});

router.get('/runs/:id/data-quality', async (req, res) => {
	let pool;
	try {
		pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		const run = await runStore.getRun(pool, req.params.id);
		if (!run) return res.status(404).json({ success: false, error: 'Run not found' });
		const base = path.join(ROOT, scopeKey(scope()));
		const dirs = await fs.promises.readdir(base).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
		const matches = [];
		for (const id of dirs) {
			if (!/^[a-f0-9-]{36}$/.test(id)) continue;
			const { report } = await readReport(id);
			if (String(report.runId) === String(req.params.id) && (!run.started_at || new Date(report.createdAt).getTime() >= new Date(run.started_at).getTime() - 2000)) matches.push(report);
		}
		matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		if (!matches.length) return res.status(404).json({ success: false, error: 'This run has no data quality report' });
		const suffix = req.query.download === 'quarantine' ? 'quarantine' : 'report';
		res.redirect(`/api/quality-audits/${matches[0].id}?download=${suffix}`);
	} catch (err) { res.status(500).json({ success: false, error: err.message }); }
	finally { if (pool) await pool.end(); }
});

module.exports = { router, startAuditJob };
