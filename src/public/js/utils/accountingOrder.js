(function () {
	const ACCOUNTING_TABLE_SEQUENCE = [
		'ACCOUNTS',
		'ACC_CLASS',
		'ACC_DEPARTMENT',
		'ACCOUNT_LINKS',
		'ACC_RANGE',
		'GL_ACCOUNT_TYPES',
		'GL_ACCOUNTS',
		'GL_PERIODS',
		'TAX_CODES',
		'JOURNAL',
		'JOURNAL_ENTRY',
		'JOURNAL_TEMP',
		'LEDGER',
		'GL_JOURNAL_HEADERS',
		'GL_JOURNAL_LINES'
	];

	const ACCOUNTING_POSITION_MAP = new Map(
		ACCOUNTING_TABLE_SEQUENCE.map((tableName, index) => [tableName, index])
	);

	function normalizeTableName(tableName) {
		return String(tableName || '').trim().toUpperCase();
	}

	function reorderPlanTables(tables) {
		const entries = (tables || []).map((tableName) => ({
			original: tableName,
			normalized: normalizeTableName(tableName)
		}));

		const accountingEntries = entries
			.filter((entry) => ACCOUNTING_POSITION_MAP.has(entry.normalized))
			.sort((a, b) => ACCOUNTING_POSITION_MAP.get(a.normalized) - ACCOUNTING_POSITION_MAP.get(b.normalized));

		let accountingIndex = 0;
		return entries.map((entry) => {
			if (!ACCOUNTING_POSITION_MAP.has(entry.normalized)) return entry.original;
			const nextEntry = accountingEntries[accountingIndex];
			accountingIndex += 1;
			return nextEntry.original;
		});
	}

	function findOrderIssues(tables) {
		const accountingOnly = (tables || [])
			.map(normalizeTableName)
			.filter((tableName) => ACCOUNTING_POSITION_MAP.has(tableName));
		const issues = [];

		for (let index = 1; index < accountingOnly.length; index += 1) {
			const previous = accountingOnly[index - 1];
			const current = accountingOnly[index];
			if (ACCOUNTING_POSITION_MAP.get(previous) > ACCOUNTING_POSITION_MAP.get(current)) {
				issues.push(`Move ${current} before ${previous}.`);
			}
		}

		return issues;
	}

	function requiresGlRebuild(tables) {
		const normalized = (tables || []).map(normalizeTableName);
		return normalized.includes('GL_JOURNAL_HEADERS') || normalized.includes('GL_JOURNAL_LINES');
	}

	window.AccountingOrderUtils = {
		ACCOUNTING_TABLE_SEQUENCE,
		reorderPlanTables,
		findOrderIssues,
		requiresGlRebuild
	};
})();
