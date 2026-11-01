// utils/schemaHelper.js
// Centralized helper to resolve workshop schema from session or company_data

/**
 * Extracts the workshop schema name from request session or company_data object
 * @param {object} req - Express request object with session
 * @returns {string} Schema name (defaults to 'DEMO' if not found)
 */
function getSchema(req) {
	// Impersonation overlay: route all schema lookups through the target tenant.
	if (req && req.session && req.session.impersonation && req.session.impersonation.active) {
		const targetSchema = String(req.session.impersonation.targetSchema || '').trim();
		if (/^[A-Za-z0-9_]+$/.test(targetSchema)) return targetSchema;
	}

	const cdRaw = req && req.session && req.session.company_data;

	if (!cdRaw) {
		return undefined; // no session company_data available
	}

	// If it's already a plain schema string, validate and return
	if (typeof cdRaw === 'string') {
		const trimmed = cdRaw.trim();
		// Commonly, this is set to the schema name directly (e.g., 'pwa_service')
		if (/^[A-Za-z0-9_]+$/.test(trimmed)) return trimmed;
		// Some stores keep JSON in company_data; try to parse
		if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || trimmed.startsWith('"')) {
			try {
				const parsed = JSON.parse(trimmed);
				return getSchemaFromObject(parsed);
			} catch (_) {
				return undefined;
			}
		}
		return undefined;
	}

	// If it's an object (e.g., parsed JSON already), extract from known keys
	if (typeof cdRaw === 'object') {
		return getSchemaFromObject(cdRaw);
	}

	return undefined;
}

// Internal: picks a schema-like value from an object using known keys
function getSchemaFromObject(obj) {
	if (!obj || typeof obj !== 'object') return undefined;
	const candidates = [
		obj.schema,
		obj.SCHEMA,
		obj.schema_name,
		obj.company_schema,
		obj.workshop_schema,
		obj.service_schema,
		obj.database_schema,
		obj.database
	].filter(Boolean);

	for (const v of candidates) {
		if (typeof v === 'string' && /^[A-Za-z0-9_]+$/.test(v)) return v;
	}

	// Sometimes schema is nested under another object, try shallow nested objects
	for (const key of Object.keys(obj)) {
		const val = obj[key];
		if (val && typeof val === 'object') {
			const nested = getSchemaFromObject(val);
			if (nested) return nested;
		}
	}

	return undefined;
}

/**
 * Resolves schema for companyDb object (used in database layer)
 * @param {object|string} companyDb - Company database connection or config object
 * @returns {string} Schema name (defaults to )
 */
function resolveSchema(companyDb) {
	if (companyDb && typeof companyDb === 'object') {
		const candidates = [
			companyDb.schema,
			companyDb.SCHEMA,
			companyDb.schema_name,
			companyDb.company_schema,
			companyDb.workshop_schema,
			companyDb.service_schema,
			companyDb.database_schema,
			companyDb.database
		].filter(Boolean);

		for (const val of candidates) {
			if (typeof val === 'string' && /^[A-Za-z0-9_]+$/.test(val)) {
				return val;
			}
		}
	}

	if (typeof companyDb === 'string' && /^[A-Za-z0-9_]+$/.test(companyDb)) {
		return companyDb; // treat plain schema name
	}

	// return 'pwa_service'; // fallback
	// return 'DEMO'; // fallback
}

module.exports = {
	getSchema,
	resolveSchema
};
