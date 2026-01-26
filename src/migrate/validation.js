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
	// If nothing selected, no confirmation required
	if (!selectedCount || Number(selectedCount) === 0) return null;

	// Require explicit 'DELETE' confirmation when items are selected
	if (String(confirmValue) === "DELETE") return null;

	return "Confirmation required: type DELETE to confirm cleaning selected tables.";
}

module.exports = {
	buildCleanTableSelection,
	validateCleanConfirm
};
