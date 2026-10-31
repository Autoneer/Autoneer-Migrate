const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ROOT, scopeKey } = require('./store');
const { normalizePlanSteps } = require('../planNormalize');

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
	return value;
}
function inputFingerprint(plan, mapping, source, corrections = {}) {
	return createHash('sha256').update(JSON.stringify(stable({ tables: normalizePlanSteps(plan, mapping), config: plan.config || {}, mapping, source: { host: source.host, database: source.database }, corrections }))).digest('hex');
}
function matchesLegacyReport(report, context) {
	if (!context || report.planId != null || report.runId || !report.plan || !report.mapping) return false;
	if (report.source?.host !== context.source.host || report.source?.database !== context.source.database) return false;
	if (JSON.stringify(stable(report.plan)) !== JSON.stringify(stable({ tables: normalizePlanSteps(context.plan, context.mapping).filter(step => step.include), config: context.plan.config || {} }))) return false;
	const mapping = structuredClone(context.mapping);
	require('../prepareLegacyMapping').prepareLegacyMapping(mapping);
	const selected = new Set(report.plan.tables.map(step => String(step.table).toLowerCase()));
	const expected = Object.fromEntries(Object.entries(mapping.tables || {}).filter(([, entry]) => selected.has(String(entry.target ?? entry.targetTable).toLowerCase())).map(([name, entry]) => [name.toUpperCase(), { target: String(entry.target ?? entry.targetTable).toLowerCase(), columns: entry.columns }]));
	const actual = Object.fromEntries(Object.entries(report.mapping).map(([name, entry]) => [name.toUpperCase(), entry]));
	return JSON.stringify(stable(expected)) === JSON.stringify(stable(actual));
}
async function latestReport(scope, planId, root = ROOT, legacyContext) {
	const base = path.join(root, scopeKey(scope));
	const dirs = await fs.readdir(base).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
	let latest = null;
	for (const id of dirs) {
		if (!/^[a-f0-9-]{36}$/.test(id)) continue;
		const report = await fs.readFile(path.join(base, id, 'report.json'), 'utf8').then(JSON.parse).catch(err => { if (err.code === 'ENOENT') return null; throw err; });
		if (!report || !['ready', 'blocked'].includes(report.status)) continue;
		if (String(report.planId) !== String(planId) && !matchesLegacyReport(report, legacyContext)) continue;
		if (!latest || report.createdAt > latest.createdAt) latest = report;
	}
	return latest;
}
module.exports = { inputFingerprint, latestReport, matchesLegacyReport };
