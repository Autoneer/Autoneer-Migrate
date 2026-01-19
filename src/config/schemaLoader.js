const fs = require("fs");
const path = require("path");

const schemaPath = path.join(__dirname, "..", "..", "data", "database_schema.md");

function loadRawSchemaFile() {
	return fs.readFileSync(schemaPath, "utf8");
}

function stripMarkdownFences(text) {
	return text
		.split("\n")
		.filter((line) => !line.trim().startsWith("```"))
		.join("\n");
}

function getSchemaSql() {
	const raw = loadRawSchemaFile();
	return stripMarkdownFences(raw);
}

function getSchemaNameFromDDL() {
	const ddl = getSchemaSql();
	const match = ddl.match(/create\s+database\s+([a-zA-Z0-9_]+)/i);
	return match ? match[1] : null;
}

function listTablesFromDDL() {
	const ddl = getSchemaSql();
	const tables = [];
	const regex = /create\s+table\s+([a-zA-Z0-9_]+)/gi;
	let match;
	while ((match = regex.exec(ddl))) {
		tables.push(match[1]);
	}
	return tables;
}

async function applySchema(mysqlQuery) {
	const ddl = getSchemaSql();
	await mysqlQuery(ddl);
}

module.exports = {
	getSchemaSql,
	getSchemaNameFromDDL,
	listTablesFromDDL,
	applySchema
};
