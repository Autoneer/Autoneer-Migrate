const MIGRATION_MARKERS = {
	job_information: {
		jnotes: { marker: "THIS IS A MIGRATED JOB", maxLength: 400 }
	},
	invoices: {
		comments: { marker: "MIGRATED INVOICE", maxLength: 800 }
	}
};

function applyMigrationMarker(targetTable, targetColumn, value) {
	const config = MIGRATION_MARKERS[String(targetTable || "").toLowerCase()]
		?.[String(targetColumn || "").toLowerCase()];
	if (!config) return value;

	const existing = value === null || value === undefined ? "" : String(value);
	const combined = existing.startsWith(config.marker)
		? existing
		: existing
			? `${config.marker}\n${existing}`
			: config.marker;

	return combined.slice(0, config.maxLength);
}

module.exports = { applyMigrationMarker };
