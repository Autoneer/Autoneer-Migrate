const { applyTransform } = require('./mappers');
const { applyMigrationMarker } = require('./migrationMarkers');
const { hasMappingDefault, resolveMappingDefault } = require('./invoiceMigrationSafety');

const ACCNR_COLLISION_OVERRIDES = new Map([
	[1601200, 6200],
	[1601300, 6301],
	[6606300, 6302]
]);

function getRowValue(row, key) {
	if (!row || !key) return undefined;
	return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
}

function convertLegacyGroupAccnr(accnr) {
	const numeric = Number(accnr);
	if (!Number.isFinite(numeric)) return accnr;
	if (ACCNR_COLLISION_OVERRIDES.has(numeric)) {
		return ACCNR_COLLISION_OVERRIDES.get(numeric);
	}
	return ((numeric % 10000) + 10000) % 10000;
}

function shouldConvertAccnrReference(targetTable, targetColumn) {
	if (!targetTable || !targetColumn) return false;
	return targetColumn.toLowerCase() === "accnr" && targetTable.toLowerCase() !== "accounts";
}

function applyAccnrReferenceConversion(value, accnrConversionMap) {
	if (!accnrConversionMap || !accnrConversionMap.size) return value;
	if (value === null || value === undefined || value === "") return value;
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return value;
	return accnrConversionMap.get(numeric) ?? value;
}

async function mapRow(row, columnMap, lookupFn, options = {}) {
	const result = {};
	const targetTable = String(options.targetTable || "").toLowerCase();
	const accnrConversionMap = options.accnrConversionMap || null;
	const columnTypes = options.columnTypes || null;
	for (const [sourceCol, rule] of Object.entries(columnMap)) {
		if (rule.omit) continue;
		const value = getRowValue(row, sourceCol);
		let mappedValue = value;
		const outKey = rule.target ?? rule.targetColumn;
		if (rule.lookup) {
			mappedValue = await lookupFn(rule.lookup.table, value);
		}
		if (rule.transform) {
			mappedValue = applyTransform(rule.transform, mappedValue);
		}
		if ((mappedValue === undefined || mappedValue === null) && hasMappingDefault(rule)) {
			mappedValue = resolveMappingDefault(rule, {
				targetTable,
				targetColumn: outKey,
				dataType: columnTypes?.get(String(outKey || "").toLowerCase())
			});
		}
		mappedValue = applyMigrationMarker(targetTable, outKey, mappedValue);
		if (shouldConvertAccnrReference(targetTable, outKey)) {
			mappedValue = applyAccnrReferenceConversion(mappedValue, accnrConversionMap);
		}
		if (outKey) result[outKey] = mappedValue;
	}
	return result;
}

module.exports = { mapRow, convertLegacyGroupAccnr, getRowValue };
