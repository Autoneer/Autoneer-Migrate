// Mapping engine helpers for client-side mapping operations
(function () {
	window.MappingEngine = window.MappingEngine || {};

	/**
	 * Apply forced field mappings to a mapping table config.
	 * Overrides any existing mappings for given source fields.
	 * @param {Object} tableConfig - mapping.tables[sourceTable]
	 * @param {Object} overrides - { SOURCE_FIELD: TARGET_FIELD, ... }
	 */
	window.MappingEngine.applyForcedFieldMappings = function (tableConfig, overrides) {
		if (!tableConfig) return;
		tableConfig.columns = tableConfig.columns || {};
		for (const [src, tgt] of Object.entries(overrides || {})) {
			// Ensure entry exists
			if (!tableConfig.columns[src]) tableConfig.columns[src] = {};
			// Force target column (override any auto-map)
			tableConfig.columns[src].targetColumn = tgt;
			// Remove omit if present
			if (tableConfig.columns[src].omit) delete tableConfig.columns[src].omit;
		}
	};
})();
