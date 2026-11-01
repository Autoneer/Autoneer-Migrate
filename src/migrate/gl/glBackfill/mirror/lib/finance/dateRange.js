function toYmd(value) {
	if (!value && value !== 0) return null;
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function parseYmd(value, fallback = null) {
	const parsed = toYmd(value);
	return parsed || fallback;
}

function getLast30DayRange(baseDate = new Date()) {
	const end = baseDate instanceof Date ? baseDate : new Date(baseDate);
	const start = new Date(end);
	start.setDate(start.getDate() - 29);
	return { from: toYmd(start), to: toYmd(end) };
}

function normalizeYmdRange(from, to, fallback = getLast30DayRange()) {
	const safeFrom = parseYmd(from, fallback.from);
	const safeTo = parseYmd(to, fallback.to);
	if (!safeFrom || !safeTo) return { ...fallback };
	if (safeFrom > safeTo) return { from: safeTo, to: safeFrom };
	return { from: safeFrom, to: safeTo };
}

function getCompareRange(from, to) {
	const fromDate = new Date(`${from}T00:00:00`);
	const toDate = new Date(`${to}T00:00:00`);
	if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
		const fallback = getLast30DayRange();
		return { from: fallback.from, to: fallback.to };
	}
	const days = Math.floor((toDate - fromDate) / 86400000) + 1;
	const compareTo = new Date(fromDate);
	compareTo.setDate(compareTo.getDate() - 1);
	const compareFrom = new Date(compareTo);
	compareFrom.setDate(compareFrom.getDate() - (days - 1));
	return { from: toYmd(compareFrom), to: toYmd(compareTo) };
}

module.exports = {
	toYmd,
	parseYmd,
	getLast30DayRange,
	normalizeYmdRange,
	getCompareRange
};
