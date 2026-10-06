const fs = require('node:fs/promises');
const path = require('node:path');

// Execute the version-controlled conversion SQL one field at a time so we can
// report actual database progress without maintaining a second conversion formula.
function parseStages(sql) {
	const body = sql.replace(/--[^\r\n]*/g, '').match(/\bBEGIN\b([\s\S]*?)\bEND\s*\$\$/i)?.[1];
	if (!body) throw new Error('Invalid transactional account conversion SQL');
	const statements = body.split(';').map(statement => statement.trim()).filter(Boolean);
	const summary = statements.pop();
	if (!/^SELECT\s+'OK'\s+AS\s+status\b/i.test(summary || '')) {
		throw new Error('Missing transactional account conversion summary');
	}
	const stages = statements.map(statement => {
		const match = statement.match(/^UPDATE\s+(\w+)\s+t\b[\s\S]*?\bSET\s+t\.(\w+)\s*=/i);
		if (!match) throw new Error('Unsupported transactional account conversion stage');
		return { id: `${match[1]}.${match[2]}`, table: match[1], field: match[2], sql: statement };
	});
	if (!stages.length) throw new Error('No transactional account conversion stages found');
	return { stages, summary };
}

async function runConversion(pool, onProgress) {
	const sqlPath = path.join(__dirname, '../../../data/sql/sp_convert_transactional_accnr.sql');
	const { stages, summary } = parseStages(await fs.readFile(sqlPath, 'utf8'));
	const progress = {
		completed: 0,
		total: stages.length,
		stages: stages.map(({ id, table, field }) => ({ id, table, field, status: 'pending' }))
	};
	const publish = type => onProgress({ type, ...progress });
	publish('progress');
	for (let index = 0; index < stages.length; index++) {
		const stage = progress.stages[index];
		stage.status = 'running';
		publish('progress');
		try {
			await pool.query(stages[index].sql);
		} catch (error) {
			stage.status = 'failed';
			publish('progress');
			throw new Error(`${stage.id}: ${error.message}`);
		}
		stage.status = 'completed';
		progress.completed++;
		publish('progress');
	}
	const [rows] = await pool.query(summary);
	return { success: true, result: [rows], ...progress };
}

module.exports = { parseStages, runConversion };
