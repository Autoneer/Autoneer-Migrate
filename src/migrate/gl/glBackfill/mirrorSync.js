"use strict";

// Keeps the GL backfill mirror in step with AUTONEER-PWA.
//
// mirror/ follows the PWA's src/ layout, so the copied modules keep their
// relative requires. Each manifest entry is a whole file copied verbatim, or a
// file holding selected top-level declarations copied verbatim from the PWA
// file of the same path. mirror/database/database.js is Migrate's own.
// Nothing here writes to the PWA checkout; it is only read.

const fs = require("fs");
const path = require("path");

const MIRROR_DIR = path.join(__dirname, "mirror");
const MANIFEST_PATH = path.join(__dirname, "manifest.json");

function loadManifest() {
	return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function findPwaSrc() {
	const checkout = path.resolve(process.env.AUTONEER_PWA_PATH || path.join(__dirname, "..", "..", "..", "..", "..", "autoneer-PWA"));
	const src = path.join(checkout, "src");
	return fs.existsSync(path.join(src, "lib", "finance", "glBackfill.js")) ? { checkout, src } : null;
}

function readNormalized(file) {
	return fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/**
 * Line range [start, end] of a top-level `function name(` or `const name =`.
 * A declaration whose first line opens a bracket ends at the first closing
 * bracket in column 0; any other ends at the first line ending in `;`.
 */
function declarationRange(lines, name) {
	const head = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(|^const\\s+${name}\\s*=`);
	const start = lines.findIndex((line) => head.test(line));
	if (start < 0) return null;
	const first = lines[start].trimEnd();
	if (first.endsWith(";")) return [start, start];
	const closes = /[{[(]$/.test(first)
		? (line) => /^[}\])]/.test(line)
		: (line) => line.trimEnd().endsWith(";");
	for (let end = start + 1; end < lines.length; end++) {
		if (closes(lines[end])) return [start, end];
	}
	return null;
}

function extractDeclaration(source, name) {
	const lines = source.split("\n");
	const range = declarationRange(lines, name);
	return range ? lines.slice(range[0], range[1] + 1).join("\n") : null;
}

/** One row per verbatim file or extracted declaration: same, changed or missing. */
function compareMirror(pwaSrc) {
	const results = [];
	for (const entry of loadManifest().files) {
		if (entry.mode === "migrate") continue;
		const pwaFile = path.join(pwaSrc, entry.path);
		const ourFile = path.join(MIRROR_DIR, entry.path);
		if (!fs.existsSync(pwaFile)) {
			results.push({ file: entry.path, status: "missing-in-pwa" });
			continue;
		}
		if (!fs.existsSync(ourFile)) {
			results.push({ file: entry.path, status: "missing-in-mirror" });
			continue;
		}
		const pwa = readNormalized(pwaFile);
		const ours = readNormalized(ourFile);
		if (entry.mode === "verbatim") {
			results.push({ file: entry.path, status: pwa === ours ? "same" : "changed" });
			continue;
		}
		for (const name of entry.declarations) {
			const theirs = extractDeclaration(pwa, name);
			const mine = extractDeclaration(ours, name);
			const status = theirs == null ? "missing-in-pwa" : mine == null ? "missing-in-mirror" : theirs === mine ? "same" : "changed";
			results.push({ file: entry.path, name, status });
		}
	}
	return results;
}

/** Copies PWA changes into the mirror. Returns the rows that changed. */
function syncMirror(pwaSrc) {
	const changed = compareMirror(pwaSrc).filter((row) => row.status === "changed" || row.status === "missing-in-mirror");
	const entries = new Map(loadManifest().files.map((entry) => [entry.path, entry]));
	for (const row of changed) {
		const entry = entries.get(row.file);
		const pwa = readNormalized(path.join(pwaSrc, row.file));
		const ourFile = path.join(MIRROR_DIR, row.file);
		if (entry.mode === "verbatim") {
			fs.mkdirSync(path.dirname(ourFile), { recursive: true });
			fs.writeFileSync(ourFile, pwa);
			continue;
		}
		if (row.status === "missing-in-mirror") continue; // A new declaration needs its requires and export added by hand.
		const lines = readNormalized(ourFile).split("\n");
		const [start, end] = declarationRange(lines, row.name);
		lines.splice(start, end - start + 1, extractDeclaration(pwa, row.name));
		fs.writeFileSync(ourFile, lines.join("\n"));
	}
	return changed;
}

/** Relative requires in mirror files that do not resolve to a mirror file. */
function unresolvedRequires() {
	const missing = [];
	for (const entry of loadManifest().files) {
		const file = path.join(MIRROR_DIR, entry.path);
		if (!fs.existsSync(file)) continue;
		for (const match of readNormalized(file).matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
			const target = path.resolve(path.dirname(file), match[1]);
			if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`)) missing.push({ file: entry.path, require: match[1] });
		}
	}
	return missing;
}

module.exports = {
	MIRROR_DIR,
	loadManifest,
	findPwaSrc,
	extractDeclaration,
	compareMirror,
	syncMirror,
	unresolvedRequires
};
