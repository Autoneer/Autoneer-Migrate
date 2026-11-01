'use strict';

/**
 * Quick Quote line money, computed exactly in integers.
 *
 * Inputs are decimal STRINGS (a JSON number is accepted only when its plain
 * decimal spelling matches the same pattern). They are converted to scaled
 * BigInts, never to binary floating point:
 *
 *   quantity          -> thousandths (qtyMilli)   0.001 .. 999999.999
 *   unit price excl   -> cents       (priceCents) 0.00  .. 13 integer digits
 *   VAT rate percent  -> basis points (rateBp)    15.00% -> 1500 (0 .. 99.99%)
 *
 *   netCents  = roundHalfUp(qtyMilli * priceCents / 1000)
 *   vatCents  = roundHalfUp(netCents * rateBp / 10000)      (per line)
 *   inclCents = netCents + vatCents
 *
 * This is the same net -> per-line VAT -> incl convention, with the same
 * half-up rounding, as lib/finance/quoteLineMoney.js#calculateQuoteLineMoney
 * (which takes an already-multiplied gross and must not change). Totals are
 * always sums of the stored, rounded line cents, never recomputed from
 * unrounded values. MySQL ROUND() on DECIMAL is half-away-from-zero, which is
 * identical to half-up here because every amount is non-negative.
 */

const QUANTITY_PATTERN = /^\d{1,6}(?:\.\d{1,3})?$/;
const PRICE_PATTERN = /^\d{1,13}(?:\.\d{1,2})?$/;
const RATE_PATTERN = /^\d{1,2}(?:\.\d{1,2})?$/;

// Upper bound for any single line or quote total: R 9,999,999,999.99. Far
// above any workshop quotation, and well inside DECIMAL(18,2) even when a
// quote carries the maximum number of lines.
const MAX_AMOUNT_CENTS = 999999999999n;

function toDecimalString(value) {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

// '12.5' with scale 3 -> 12500n. The caller has already matched the pattern.
function scaleDecimal(text, scale) {
	const [whole, fraction = ''] = text.split('.');
	return BigInt(whole + fraction.padEnd(scale, '0'));
}

function parseScaled(value, pattern, scale) {
	const text = toDecimalString(value);
	if (text === null || !pattern.test(text)) return null;
	return scaleDecimal(text, scale);
}

/** @returns {bigint|null} thousandths; null when invalid or not > 0 */
function parseQuantity(value) {
	const milli = parseScaled(value, QUANTITY_PATTERN, 3);
	return milli !== null && milli > 0n ? milli : null;
}

/** @returns {bigint|null} cents; null when invalid (zero is allowed) */
function parseUnitPrice(value) {
	return parseScaled(value, PRICE_PATTERN, 2);
}

/** @returns {bigint|null} basis points; null unless 0.00 .. 99.99 with at most 2 dp */
function parseRatePercent(value) {
	return parseScaled(value, RATE_PATTERN, 2);
}

function roundHalfUpDivide(numerator, denominator) {
	const quotient = numerator / denominator;
	const remainder = numerator % denominator;
	return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function formatScaled(amount, scale) {
	const negative = amount < 0n;
	const digits = (negative ? -amount : amount).toString().padStart(scale + 1, '0');
	const text = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
	return negative ? `-${text}` : text;
}

const formatCents = (cents) => formatScaled(cents, 2);
const formatQuantity = (milli) => formatScaled(milli, 3);
const formatRate = (basisPoints) => formatScaled(basisPoints, 2);

/**
 * @param {{qtyMilli: bigint, priceCents: bigint, rateBp: bigint}} line
 * @returns {{netCents: bigint, vatCents: bigint, inclCents: bigint}}
 */
function calculateLineCents({ qtyMilli, priceCents, rateBp }) {
	const netCents = roundHalfUpDivide(qtyMilli * priceCents, 1000n);
	const vatCents = roundHalfUpDivide(netCents * rateBp, 10000n);
	return { netCents, vatCents, inclCents: netCents + vatCents };
}

/**
 * Stored DECIMAL strings for one line, ready for SQL. Values are never passed
 * to MySQL as floats.
 */
function buildStoredLine({ qtyMilli, priceCents, rateBp }) {
	const { netCents, vatCents, inclCents } = calculateLineCents({ qtyMilli, priceCents, rateBp });
	return {
		quantity: formatQuantity(qtyMilli),
		unit_price_excl: formatCents(priceCents),
		vat_rate_percent: formatRate(rateBp),
		line_net_excl: formatCents(netCents),
		line_vat: formatCents(vatCents),
		line_total_incl: formatCents(inclCents),
		cents: { netCents, vatCents, inclCents }
	};
}

/** Sums of already-rounded line cents. */
function sumLineCents(lines) {
	return (lines || []).reduce((totals, line) => ({
		netCents: totals.netCents + line.netCents,
		vatCents: totals.vatCents + line.vatCents,
		inclCents: totals.inclCents + line.inclCents
	}), { netCents: 0n, vatCents: 0n, inclCents: 0n });
}

function formatTotals(totals) {
	return {
		subtotal_excl: formatCents(totals.netCents),
		vat_total: formatCents(totals.vatCents),
		total_incl: formatCents(totals.inclCents)
	};
}

// DECIMAL values from mysql2 arrive as strings ('1.500', '100.00'). Parse them
// back to scaled integers for exact re-verification of stored lines.
function parseStoredDecimal(value, scale) {
	const text = toDecimalString(value);
	if (text === null || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
	const negative = text.startsWith('-');
	const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
	if (fraction.length > scale) return null;
	const scaled = BigInt(whole + fraction.padEnd(scale, '0'));
	return negative ? -scaled : scaled;
}

module.exports = {
	MAX_AMOUNT_CENTS,
	parseQuantity,
	parseUnitPrice,
	parseRatePercent,
	parseStoredDecimal,
	calculateLineCents,
	buildStoredLine,
	sumLineCents,
	formatTotals,
	formatCents,
	formatQuantity,
	formatRate
};
