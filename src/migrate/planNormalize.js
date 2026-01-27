/**
 * normalizePlanSteps(plan, mappingForLookup)
 * Shared normalization for converting various plan shapes into
 * an array of step objects with stable defaults.
 */

function normalizePlanSteps(plan, mappingForLookup) {
	const defaultBatchSize = plan?.config?.batchSize || 1000;
	const defaults = {
		mode: 'INSERT',
		keyStrategy: 'preserve',
		dedupeKeys: [],
		onDuplicate: 'SKIP',
		// Default MUST be false unless user explicitly checked the option
		cleanBefore: true,
		batchSize: defaultBatchSize
	};

	if (Array.isArray(plan)) {
		return plan.map((entry) => {
			if (typeof entry === 'string') return { table: entry, include: true, ...defaults };
			if (entry && typeof entry === 'object') return {
				include: entry.include !== false,
				table: entry.table || entry.name || entry.targetTable || entry.target || entry.tableName,
				mode: entry.mode || defaults.mode,
				keyStrategy: entry.keyStrategy || defaults.keyStrategy,
				dedupeKeys: entry.dedupeKeys || defaults.dedupeKeys,
				onDuplicate: entry.onDuplicate || defaults.onDuplicate,
				cleanBefore: (typeof entry.cleanBefore === 'boolean') ? entry.cleanBefore : defaults.cleanBefore,
				batchSize: entry.batchSize || defaults.batchSize
			};
			return null;
		}).filter(Boolean);
	}

	if (plan?.tables && Array.isArray(plan.tables)) {
		return plan.tables.map(entry => {
			if (typeof entry === 'string') return { table: entry, include: true, ...defaults };
			if (entry && typeof entry === 'object') return {
				include: entry.include !== false,
				table: entry.table || entry.name || entry.targetTable || entry.target || entry.tableName,
				mode: entry.mode || defaults.mode,
				keyStrategy: entry.keyStrategy || defaults.keyStrategy,
				dedupeKeys: entry.dedupeKeys || defaults.dedupeKeys,
				onDuplicate: entry.onDuplicate || defaults.onDuplicate,
				cleanBefore: (typeof entry.cleanBefore === 'boolean') ? entry.cleanBefore : defaults.cleanBefore,
				batchSize: entry.batchSize || defaults.batchSize
			};
			return null;
		}).filter(Boolean);
	}

	if (plan?.tables && typeof plan.tables === 'object') {
		return Object.entries(plan.tables).map(([tableName, config]) => {
			let resolvedTable = config?.target || config?.targetTable;
			if (!resolvedTable && mappingForLookup?.tables?.[tableName]) {
				resolvedTable = mappingForLookup.tables[tableName].target || mappingForLookup.tables[tableName].targetTable;
			}
			resolvedTable = resolvedTable || tableName;
			return {
				table: resolvedTable,
				include: config?.include !== false,
				mode: config?.mode || defaults.mode,
				keyStrategy: config?.keyStrategy || defaults.keyStrategy,
				dedupeKeys: config?.dedupeKeys || defaults.dedupeKeys,
				onDuplicate: config?.onDuplicate || defaults.onDuplicate,
				cleanBefore: (typeof config?.cleanBefore === 'boolean') ? config.cleanBefore : defaults.cleanBefore,
				batchSize: config?.batchSize || defaults.batchSize
			};
		});
	}

	return [];
}

module.exports = { normalizePlanSteps };
