function trim(value) {
	if (value === null || value === undefined) return value;
	return typeof value === "string" ? value.trim() : value;
}

function toDate(value) {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString().slice(0, 10);
}

function toDateTime(value) {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString().slice(0, 19).replace("T", " ");
}

function toBoolean(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return value ? 1 : 0;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (["y", "yes", "true", "1"].includes(v)) return 1;
		if (["n", "no", "false", "0"].includes(v)) return 0;
	}
	return null;
}

function toNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isNaN(n) ? null : n;
}

function zeroDateToNull(value) {
	if (!value) return null;
	const text = typeof value === "string" ? value.trim() : value;
	if (text === "0000-00-00" || text === "0000-00-00 00:00:00") return null;
	return value;
}

/**
 * Creates a decimal/numeric converter with precision and scale validation.
 * Precision = total digits, Scale = digits after decimal point.
 * Example: NUMERIC(18,2) has max 18 total digits, 2 after decimal.
 * 
 * @param {number} precision - Total number of digits
 * @param {number} scale - Number of digits after decimal point
 * @returns {Function} Transform function that validates and converts values
 */
function toDecimal(precision, scale) {
	return (value) => {
		if (value === null || value === undefined || value === "") return null;
		const n = Number(value);
		if (Number.isNaN(n)) return null;

		// Validate precision and scale
		const absValue = Math.abs(n);
		const parts = String(absValue).split('.');
		const wholeDigits = parts[0].length;
		const fractionalDigits = (parts[1] || '').length;

		if (wholeDigits > (precision - scale)) {
			console.warn(
				`Precision loss: ${value} exceeds DECIMAL(${precision},${scale}). ` +
				`Whole part has ${wholeDigits} digits but max is ${precision - scale}.`
			);
		}

		if (fractionalDigits > scale) {
			// Truncate to scale
			return parseFloat(n.toFixed(scale));
		}

		return n;
	};
}

/**
 * Handles Firebird timestamp formats and converts to MySQL DATETIME format.
 * Supports multiple Firebird timestamp representations:
 * - ISO 8601: 2024-01-15T10:30:45.123Z
 * - With timezone: 2024-01-15T10:30:45.123+02:00
 * - Legacy: 2024-01-15 10:30:45
 * 
 * @param {*} value - Timestamp value from Firebird
 * @returns {string|null} - MySQL DATETIME format (YYYY-MM-DD HH:MM:SS) or null
 */
function toFirebirdTimestamp(value) {
	if (!value) return null;
	const str = String(value).trim();

	try {
		const date = new Date(str);
		if (Number.isNaN(date.getTime())) return null;

		// Return DATETIME format for MySQL (YYYY-MM-DD HH:MM:SS)
		return date.toISOString().slice(0, 19).replace('T', ' ');
	} catch {
		return null;
	}
}

/**
 * Handles BLOB data conversion to various formats.
 * Used for binary data, images, or large text fields.
 * 
 * @param {*} value - BLOB data from Firebird
 * @param {string} format - Output format: 'base64', 'hex', or 'utf8'
 * @returns {string|null} - Converted blob data or null
 */
function handleBlobData(value, format = 'base64') {
	if (!value) return null;

	if (Buffer.isBuffer(value)) {
		return value.toString(format);
	}

	if (typeof value === 'string') {
		// Already string, assume it's hex or base64
		return value;
	}

	return null;
}

/**
 * Stricter boolean conversion with logging for ambiguous values.
 * Provides warnings when converting unexpected values to boolean.
 * 
 * @param {*} value - Value to convert to boolean
 * @returns {number|null} - 1 for true, 0 for false, null for invalid
 */
function cloneBoolean(value) {
	if (value === null || value === undefined) return null;

	if (typeof value === 'boolean') return value ? 1 : 0;

	if (typeof value === 'number') {
		if (![0, 1].includes(value)) {
			console.warn(`Boolean conversion warning: number ${value} mapped to ${value ? 1 : 0}`);
		}
		return value ? 1 : 0;
	}

	if (typeof value === 'string') {
		const v = value.trim().toUpperCase();
		if (['Y', 'YES', 'TRUE', 'T', '1'].includes(v)) return 1;
		if (['N', 'NO', 'FALSE', 'F', '0'].includes(v)) return 0;
		console.warn(`Boolean conversion warning: string "${value}" mapped to null`);
	}

	return null;
}

module.exports = {
	trim,
	toDate,
	toDateTime,
	toBoolean,
	toNumber,
	zeroDateToNull,
	toDecimal,
	toFirebirdTimestamp,
	handleBlobData,
	cloneBoolean
};
