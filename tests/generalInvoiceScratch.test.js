"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { copySqlMode, sameFingerprint } = require("../scripts/general_invoice_scratch");

test("scratch copy permits legacy zero dates but retains strict data checks", () => {
	const modes = copySqlMode("STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION").split(",");
	assert.deepEqual(modes, ["STRICT_TRANS_TABLES", "ERROR_FOR_DIVISION_BY_ZERO", "NO_ENGINE_SUBSTITUTION", "NO_AUTO_VALUE_ON_ZERO"]);
	assert.equal(copySqlMode(modes.join(",")), modes.join(","));
});

test("resuming requires both the row count and full-row fingerprint to match", () => {
	const baseline = { count: 10, checksum: "abc" };
	assert.equal(sameFingerprint(baseline, { ...baseline }), true);
	assert.equal(sameFingerprint(baseline, { count: 9, checksum: "abc" }), false);
	assert.equal(sameFingerprint(baseline, { count: 10, checksum: "changed" }), false);
});
