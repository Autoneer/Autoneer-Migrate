const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const v8 = require('node:v8');
const { randomUUID, createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '../../../data/quality-audits');
const scopeKey = ({ mysqlConfig = {}, schemaName }) => createHash('sha256')
	.update(JSON.stringify([String(mysqlConfig.host || '').trim().toLowerCase(), Number(mysqlConfig.port || 3306), schemaName || ''])).digest('hex');

function auditPath(id, scope, root = ROOT) {
	if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('Invalid audit identifier');
	return path.join(root, scopeKey(scope), id);
}

async function createStore(scope, root = ROOT) {
	const id = randomUUID();
	const dir = auditPath(id, scope, root);
	await fs.promises.mkdir(dir, { recursive: true });
	return { id, dir, async save(report) {
		const temp = path.join(dir, 'report.tmp');
		await fs.promises.writeFile(temp, JSON.stringify(report, null, 2), { mode: 0o600 });
		await fs.promises.rename(temp, path.join(dir, 'report.json'));
	} };
}

// V8 serialization preserves Firebird dates, buffers, bigints and NULLs. JSON
// downloads are separate, human-readable evidence, never the import payload.
async function writeRecord(handle, value) {
	await handle.write(`${v8.serialize(value).toString('base64')}\n`);
}

async function* readRecords(filename) {
	const stream = fs.createReadStream(filename);
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let readError;
	stream.on('error', err => { readError = err; lines.close(); });
	try {
		for await (const line of lines) if (line) yield v8.deserialize(Buffer.from(line, 'base64'));
		if (readError) throw readError;
	} finally { lines.close(); stream.destroy(); }
}

async function openBatchReader(filename, startOffset = 0) {
	const iterator = readRecords(filename)[Symbol.asyncIterator]();
	let position = 0;
	return {
		async next(limit) {
			while (position < startOffset) {
				if ((await iterator.next()).done) throw new Error('Audited snapshot is shorter than the resume offset');
				position++;
			}
			const rows = [];
			while (rows.length < limit) {
				const item = await iterator.next();
				if (item.done) break;
				rows.push(item.value); position++;
			}
			return rows;
		},
		async close() { await iterator.return?.(); }
	};
}

const jsonEvidence = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

module.exports = { ROOT, scopeKey, auditPath, createStore, writeRecord, readRecords, openBatchReader, jsonEvidence };
