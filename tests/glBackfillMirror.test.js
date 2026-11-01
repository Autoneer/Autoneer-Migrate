const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const sync = require("../src/migrate/gl/glBackfill/mirrorSync");

const pwa = sync.findPwaSrc();

test("GL backfill mirror matches the AUTONEER-PWA checkout", { skip: !pwa && "AUTONEER-PWA checkout not found" }, () => {
	const drift = sync.compareMirror(pwa.src).filter((row) => row.status !== "same");
	assert.deepEqual(drift, [], "The PWA GL backfill changed. Run node scripts/sync_pwa_gl_backfill.js --write and review the result.");
});

test("every require in the mirror resolves inside the mirror", () => {
	assert.deepEqual(sync.unresolvedRequires(), []);
});

test("every extracted declaration is present in its mirror file", () => {
	for (const entry of sync.loadManifest().files.filter((e) => e.mode === "extract")) {
		const source = fs.readFileSync(path.join(sync.MIRROR_DIR, entry.path), "utf8").replace(/\r\n/g, "\n");
		for (const name of entry.declarations) {
			assert.ok(sync.extractDeclaration(source, name), `${entry.path} is missing ${name}`);
		}
	}
});

test("declaration extraction covers functions, arrays and multi-line constants", () => {
	const source = [
		"const ONE = 'a';",
		"const TWO =",
		"\t`b`;",
		"const LIST = [",
		"\t'x'",
		"];",
		"async function work(a) {",
		"\tif (a) {",
		"\t}",
		"\treturn a;",
		"}",
		"function later() {}"
	].join("\n");
	assert.equal(sync.extractDeclaration(source, "ONE"), "const ONE = 'a';");
	assert.equal(sync.extractDeclaration(source, "TWO"), "const TWO =\n\t`b`;");
	assert.equal(sync.extractDeclaration(source, "LIST"), "const LIST = [\n\t'x'\n];");
	assert.equal(sync.extractDeclaration(source, "work"), "async function work(a) {\n\tif (a) {\n\t}\n\treturn a;\n}");
	assert.equal(sync.extractDeclaration(source, "missing"), null);
});

test("the mirrored backfill loads without any AUTONEER-PWA module", () => {
	const glBackfill = require("../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill");
	assert.deepEqual(glBackfill.BACKFILL_TYPE_ORDER, ["CREDITOR_INVOICE", "REBUILD_STOCK", "DEBTOR_INVOICE", "DEBTOR_PAYMENT", "CREDITOR_PAYMENT"]);
	const fromPwa = Object.keys(require.cache).filter((file) => /[\\/]autoneer-pwa[\\/]/i.test(file));
	assert.deepEqual(fromPwa, []);
});
