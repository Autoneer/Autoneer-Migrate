// Compares the GL backfill mirror (src/migrate/gl/glBackfill/mirror) with the
// AUTONEER-PWA checkout, and with --write copies the PWA's changes across.
// The PWA checkout is only read.
//
//   node scripts/sync_pwa_gl_backfill.js           report drift
//   node scripts/sync_pwa_gl_backfill.js --write   update the mirror and record the PWA commit
//
// Set AUTONEER_PWA_PATH when the checkout is not ../autoneer-PWA.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sync = require("../src/migrate/gl/glBackfill/mirrorSync");

const write = process.argv.includes("--write");
const pwa = sync.findPwaSrc();
if (!pwa) {
	console.error("AUTONEER-PWA checkout not found. Set AUTONEER_PWA_PATH.");
	process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", pwa.checkout, ...args], { encoding: "utf8" }).trim();
const manifest = sync.loadManifest();
const mirrored = manifest.files.filter((entry) => entry.mode !== "migrate").map((entry) => `src/${entry.path}`);
const head = git("rev-parse", "--short", "HEAD");
const dirty = git("status", "--porcelain", "--", ...mirrored);

const label = (row) => (row.name ? `${row.file} :: ${row.name}` : row.file);
const rows = write ? sync.syncMirror(pwa.src) : sync.compareMirror(pwa.src).filter((row) => row.status !== "same");

console.log(`AUTONEER-PWA ${head}; mirror last synced from ${manifest.pwaCommit}.`);
if (dirty) console.log(`Warning: the PWA has uncommitted changes in mirrored files:\n${dirty}`);
if (!rows.length) console.log("Mirror matches the PWA.");
for (const row of rows) console.log(`  ${write ? "updated" : row.status.padEnd(17)} ${label(row)}`);

if (write) {
	manifest.pwaCommit = head;
	const manifestPath = path.join(sync.MIRROR_DIR, "..", "manifest.json");
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	const extracted = rows.filter((row) => row.name);
	if (extracted.some((row) => row.status === "missing-in-mirror")) {
		console.log("New extracted declarations need their requires and exports added by hand.");
	}
	if (extracted.length) console.log("Review changed extracted declarations for helpers they now call.");
}

const unresolved = sync.unresolvedRequires();
for (const miss of unresolved) console.log(`  unresolved require ${miss.require} in ${miss.file}: add it to manifest.json`);
if (!write && (rows.length || unresolved.length)) process.exitCode = 1;
