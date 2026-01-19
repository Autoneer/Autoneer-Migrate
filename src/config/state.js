const { loadSettings } = require("./settings");

const settings = loadSettings();

const normalizeEnv = (value) => {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : "";
};

const state = {
	firebird: {
		host: normalizeEnv(process.env.FIREBIRD_HOST) || "localhost",
		port: normalizeEnv(process.env.FIREBIRD_PORT) || 3050,
		database: normalizeEnv(process.env.FIREBIRD_DATABASE) || "",
		user: normalizeEnv(process.env.FIREBIRD_USER) || "SYSDBA",
		password: normalizeEnv(process.env.FIREBIRD_PASSWORD) || "",
		role: normalizeEnv(process.env.FIREBIRD_ROLE) || "",
		useDefaultSysdbaMasterkey: settings.useDefaultSysdbaMasterkey === true
	},
	mysql: {
		host: normalizeEnv(process.env.MYSQL_HOST) || "localhost",
		port: normalizeEnv(process.env.MYSQL_PORT) || 3306,
		user: normalizeEnv(process.env.MYSQL_USER) || "root",
		password: normalizeEnv(process.env.MYSQL_PASSWORD) || ""
	},
	schemaName: normalizeEnv(process.env.MYSQL_DATABASE) || "autoneer",
	plan: [],
	mapping: null,
	settings: {
		defaultMappingProfileId: settings.defaultMappingProfileId || null
	}
};

module.exports = {
	state
};
