const fs = require('fs');
const vm = require('vm');
try {
	const files = ['src/migrate/runner.js', 'src/db/firebird.js'];
	for (const f of files) {
		const code = fs.readFileSync(f, 'utf8');
		new vm.Script(code, { filename: f });
		console.log('PARSE_OK', f);
	}
} catch (e) {
	console.error(e && e.stack ? e.stack : e);
	process.exit(1);
}
