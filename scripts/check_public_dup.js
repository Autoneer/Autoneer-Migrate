const fs = require('fs');
const path = require('path');

const repoRootPublic = path.join(process.cwd(), 'public');

function isDirNonEmpty(p) {
	try {
		const stat = fs.statSync(p);
		if (!stat.isDirectory()) return false;
		const entries = fs.readdirSync(p);
		return entries.length > 0;
	} catch (err) {
		return false;
	}
}

if (isDirNonEmpty(repoRootPublic)) {
	console.error('\nERROR: A repo-root `public/` directory exists at: %s', repoRootPublic);
	console.error('This project serves static assets from `src/public`.');
	console.error('Please remove the duplicate repo-root `public/` directory before committing.');
	console.error('If you intended to keep files, move them into `src/public/` and preserve paths.\n');
	process.exitCode = 2;
} else {
	console.log('OK: no repo-root public/ directory present (or it is empty).');
}
