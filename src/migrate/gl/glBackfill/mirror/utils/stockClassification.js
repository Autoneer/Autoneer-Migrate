'use strict';

const WORKSHOP_ASSET_TYPES = new Set(['ASSET', 'TOOL']);

function normalizeStockType(value) {
	const raw = value && typeof value === 'object'
		? (value.stocktype ?? value.STOCKTYPE)
		: value;
	return String(raw == null ? '' : raw).trim().toUpperCase();
}

function isAssetStock(value) {
	return normalizeStockType(value) === 'ASSET';
}

function isToolStock(value) {
	return normalizeStockType(value) === 'TOOL';
}

function isWorkshopAsset(value) {
	return WORKSHOP_ASSET_TYPES.has(normalizeStockType(value));
}

const isNonInventoryWorkshopAsset = isWorkshopAsset;

function workshopAssetSql(column = 'stocktype') {
	return `UPPER(TRIM(COALESCE(${column}, ''))) IN ('ASSET','TOOL')`;
}

function excludeWorkshopAssetsSql(column = 'stocktype') {
	return `UPPER(TRIM(COALESCE(${column}, ''))) NOT IN ('ASSET','TOOL')`;
}

module.exports = {
	WORKSHOP_ASSET_TYPES,
	normalizeStockType,
	isAssetStock,
	isToolStock,
	isWorkshopAsset,
	isNonInventoryWorkshopAsset,
	workshopAssetSql,
	excludeWorkshopAssetsSql
};
