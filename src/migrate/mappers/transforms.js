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

module.exports = {
	trim,
	toDate,
	toDateTime,
	toBoolean,
	toNumber,
	zeroDateToNull
};
