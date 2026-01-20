const { listTablesFromDDL } = require("../config/schemaLoader");
const fs = require("fs");
const path = require("path");

const DEFAULT_ORDER = [
	"company",
	"customers",
	"suppliers",
	"stock",
	"staff",
	"accounts",
	"acc_class",
	"acc_department",
	"account_links",
	"acc_range",
	"job_information",
	"invoices",
	"invoice_items",
	"spares_used",
	"work_done",
	"payments",
	"gl_account_types",
	"gl_accounts",
	"gl_periods",
	"tax_codes",
	"gl_journal_headers",
	"gl_journal_lines"
];

const MASTER_TABLES = new Set(["company", "customers", "suppliers", "stock", "staff"]);

function loadDefaultMapping() {
	const mapPath = path.join(__dirname, "mapping.default.json");
	const raw = fs.readFileSync(mapPath, "utf8");
	return JSON.parse(raw);
}

function buildPlan({ firebirdTables, mysqlTables, mapping }) {
	const normalizedMysql = new Set(mysqlTables.map((t) => t.toLowerCase()));
	const tableSet = new Set();

	DEFAULT_ORDER.forEach((t) => {
		if (normalizedMysql.has(t.toLowerCase())) tableSet.add(t);
	});

	mysqlTables.forEach((t) => tableSet.add(t));

	const plan = Array.from(tableSet).map((table) => {
		const isMaster = MASTER_TABLES.has(table.toLowerCase());
		return {
			table,
			include: false,
			mode: "UPSERT",
			keyStrategy: isMaster ? "preserve" : "rekey",
			dedupeKeys: [],
			onDuplicate: "SKIP"
		};
	});

	return plan;
}

function getExpectedTablesFromDDL() {
	return listTablesFromDDL();
}

module.exports = {
	DEFAULT_ORDER,
	loadDefaultMapping,
	buildPlan,
	getExpectedTablesFromDDL
};
