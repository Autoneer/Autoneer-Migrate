function buildCleanTableSelection({ includedTables, cleanAll, requestedTables }) {
	const allowed = new Set(includedTables || []);
	const selected = new Set();
	if (cleanAll) {
		allowed.forEach((table) => selected.add(table));
		return selected;
	}
	(requestedTables || []).forEach((table) => {
		if (allowed.has(table)) {
			selected.add(table);
		}
	});
	return selected;
}

function validateCleanConfirm(confirmValue, selectedCount) {
	return null;
}

module.exports = {
	buildCleanTableSelection,
	validateCleanConfirm
};
