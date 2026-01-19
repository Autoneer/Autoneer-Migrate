const fs = require("fs");
const path = require("path");

const schemaPath = path.join(__dirname, "..", "..", "data", "autoneer-firebird.sql");

function loadFirebirdSchemaFromFile() {
	const sql = fs.readFileSync(schemaPath, "utf8");
	const tableMap = new Map();
	const regex = /CREATE\s+TABLE\s+([A-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
	let match;
	while ((match = regex.exec(sql))) {
		const tableName = match[1].toUpperCase();
		const body = match[2];
		const columns = [];
		body.split(/\r?\n/).forEach((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("--")) return;
			if (trimmed.startsWith("CONSTRAINT") || trimmed.startsWith("PRIMARY") || trimmed.startsWith("FOREIGN") || trimmed.startsWith("UNIQUE")) return;
			const token = trimmed.replace(/,$/, "").split(/\s+/)[0];
			if (!token || token === ")") return;
			columns.push(token.toUpperCase());
		});
		tableMap.set(tableName, columns);
	}
	return tableMap;
}

module.exports = {
	loadFirebirdSchemaFromFile
};
