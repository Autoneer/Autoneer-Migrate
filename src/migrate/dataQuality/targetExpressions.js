// Evaluate application-owned generated columns and CHECK expressions using the
// target server's SQL semantics, on parameterized derived rows only (no writes).
function quote(name) { return '`' + String(name).replace(/`/g, '``') + '`'; }

// SHOW CREATE contains executable SQL; INFORMATION_SCHEMA can escape literal
// delimiters (MySQL bug #104294). Do not blindly unescape actual string values.
function generatedExpressionFromDDL(ddl, name, noBackslashEscapes = false) {
	const line = ddl.split('\n').find(line => line.trimStart().startsWith(quote(name) + ' '));
	const marker = line && /\bGENERATED ALWAYS AS\s*\(/i.exec(line);
	if (!marker) throw new Error(`Cannot read generated expression for ${name}`);
	const start = marker.index + marker[0].length;
	let depth = 1, quoted = null;
	for (let i = start; i < line.length; i++) {
		const char = line[i];
		if (quoted) {
			if (char === '\\' && quoted !== '`' && !noBackslashEscapes) { i++; continue; }
			if (char === quoted) { if (line[i + 1] === quoted) i++; else quoted = null; }
		} else if (['\'', '"', '`'].includes(char)) quoted = char;
		else if (char === '(') depth++;
		else if (char === ')' && --depth === 0) return line.slice(start, i);
	}
	throw new Error(`Unbalanced generated expression for ${name}`);
}

function makeEvaluator(pool, table) {
	const generated = table.columns.filter(col => col.generated);
	const ordinary = table.columns.filter(col => !col.generated);
	return async function evaluate(records) {
		for (const record of records) for (const col of ordinary) {
			if (!Object.hasOwn(record.mapped, col.name) && !col.defaultExpression) record.mapped[col.name] = col.defaultValue;
		}
		if (!generated.length && !table.checks?.length && !ordinary.some(col => col.defaultExpression)) return;
		const params = [];
		const selects = records.map((record, index) => {
			const fields = [`${index} AS __dq_row`];
			for (const col of ordinary) {
				let expression = '?';
				if (!Object.hasOwn(record.mapped, col.name) && col.defaultExpression) expression = `(${col.defaultValue})`;
				else params.push(record.mapped[col.name] ?? null);
				if (/^(tinyint|smallint|mediumint|int|integer|bigint|bit)$/.test(col.type)) expression = `CAST(${expression} AS ${/unsigned/.test(col.columnType || '') ? 'UNSIGNED' : 'SIGNED'})`;
				else if (['decimal', 'numeric'].includes(col.type)) expression = `CAST(${expression} AS DECIMAL(${Number(col.precision)},${Number(col.scale)}))`;
				else if (col.collation && /^[a-z0-9_]+$/i.test(col.collation)) expression = `CAST(${expression} AS CHAR CHARACTER SET ${col.collation.split('_')[0]}) COLLATE ${col.collation}`;
				fields.push(`${expression} AS ${quote(col.name)}`);
			}
			return `SELECT ${fields.join(', ')}`;
		});
		let sql = selects.join(' UNION ALL ');
		for (const col of generated) {
			// The runner applies the matching schema correction after the gate.
			const expression = table.name === 'invoices' && col.name === 'job_number_active'
				? `CASE WHEN job_number = 0 THEN NULL ELSE (${col.expression}) END` : col.expression;
			sql = `SELECT dq.*, (${expression}) AS ${quote(col.name)} FROM (${sql}) dq`;
		}
		const checks = (table.checks || []).map((check, index) => `(${check.expression}) AS ${quote(`__dq_check_${index}`)}`);
		if (checks.length) sql = `SELECT dq.*, ${checks.join(', ')} FROM (${sql}) dq`;
		let rows;
		try { [rows] = await pool.query(sql, params); }
		catch (err) {
			if (['ER_PARSE_ERROR', 'ER_BAD_FIELD_ERROR'].includes(err.code)) {
				throw new Error(`Audit expression setup failed for ${table.name}: ${err.message}. This is a checker/schema issue, not evidence that the records are junk.`);
			}
			if (records.length > 1) { for (const record of records) await evaluate([record]); return; }
			records[0].reasons.push({ code: 'TARGET_EXPRESSION', column: null, message: `Target expression could not be evaluated: ${err.message}`, action: 'review' });
			return;
		}
		if (rows.length !== records.length) throw new Error(`Expression validation returned an unexpected row count for ${table.name}`);
		for (const row of rows) {
			const record = records[Number(row.__dq_row)];
			for (const col of [...generated, ...ordinary.filter(col => col.defaultExpression && !Object.hasOwn(record.mapped, col.name))]) record.mapped[col.name] = row[col.name];
			for (const [index, check] of (table.checks || []).entries()) {
				if (row[`__dq_check_${index}`] != null && Number(row[`__dq_check_${index}`]) === 0) record.reasons.push({ code: 'CHECK_CONSTRAINT', column: null, message: `Target CHECK ${check.name} failed`, action: 'review' });
			}
		}
	};
}

module.exports = { makeEvaluator, generatedExpressionFromDDL };
