const Firebird = require("node-firebird");

function normalizeString(value) {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : "";
}

function resolveFirebirdConfig(stateFirebird = {}, env = process.env) {
	const host = normalizeString(stateFirebird.host) || normalizeString(env.FIREBIRD_HOST) || "localhost";
	const port = Number(normalizeString(stateFirebird.port) || normalizeString(env.FIREBIRD_PORT) || 3050);
	const database = normalizeString(stateFirebird.database) || normalizeString(env.FIREBIRD_DATABASE) || "";
	const user = normalizeString(stateFirebird.user) || normalizeString(env.FIREBIRD_USER) || "";
	const role = normalizeString(stateFirebird.role) || normalizeString(env.FIREBIRD_ROLE) || "";
	const useDefaultSysdbaMasterkey =
		stateFirebird.useDefaultSysdbaMasterkey === true ||
		String(env.FIREBIRD_USE_DEFAULT_SYSDBA || "").toLowerCase() === "true";

	const statePassword = normalizeString(stateFirebird.password) || "";
	const envPassword = normalizeString(env.FIREBIRD_PASSWORD) || "";
	let password = "";
	let passwordSource = "";
	if (statePassword) {
		password = statePassword;
		passwordSource = "state";
	} else if (envPassword) {
		password = envPassword;
		passwordSource = "env";
	} else if (useDefaultSysdbaMasterkey && user.toUpperCase() === "SYSDBA") {
		password = "masterkey";
		passwordSource = "default";
	}

	return {
		host,
		port,
		database,
		user,
		password,
		role,
		useDefaultSysdbaMasterkey,
		passwordSource
	};
}

function validateFirebirdConfig(config) {
	if (!config.database) return "Firebird database path is required.";
	if (!config.user) return "Firebird user is required.";
	if (!config.password) return "Firebird password is required.";
	return null;
}

function maskFirebirdConfig(config) {
	return {
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		role: config.role || "",
		useDefaultSysdbaMasterkey: !!config.useDefaultSysdbaMasterkey,
		passwordSet: !!config.password,
		passwordSource: config.passwordSource || ""
	};
}

function quoteIdentifier(name) {
	if (!name) return name;
	return `"${String(name).replace(/"/g, '""')}"`;
}

function buildOptions(config) {
	return {
		host: config.host,
		port: Number(config.port || 3050),
		database: config.database,
		user: config.user,
		password: config.password,
		role: config.role || undefined,
		lowercase_keys: true,
		pageSize: 4096
	};
}

function attach(config) {
	return new Promise((resolve, reject) => {
		const resolved = resolveFirebirdConfig(config);
		const validationError = validateFirebirdConfig(resolved);
		if (validationError) {
			return reject(new Error(validationError));
		}
		if (!resolved.password || !String(resolved.password).trim()) {
			return reject(new Error("Firebird password is empty. Please provide a valid password."));
		}

		Firebird.attach(buildOptions(resolved), (err, db) => {
			if (err) return reject(err);
			resolve(db);
		});
	});
}

async function testConnection(config) {
	const db = await attach(config);
	return new Promise((resolve, reject) => {
		db.query("select 1 from rdb$database", (err, result) => {
			db.detach();
			if (err) return reject(err);
			resolve(result);
		});
	});
}

async function query(config, sql, params = []) {
	const db = await attach(config);
	return new Promise((resolve, reject) => {
		db.query(sql, params, (err, result) => {
			db.detach();
			if (err) return reject(err);
			resolve(result);
		});
	});
}

async function listTables(config) {
	const sql = `
    select trim(rdb$relation_name) as name
    from rdb$relations
    where rdb$view_blr is null and rdb$system_flag = 0
    order by rdb$relation_name
  `;
	const rows = await query(config, sql);
	return rows.map((row) => row.name);
}

async function listColumns(config, tableName) {
	const sql = `
    select trim(rf.rdb$field_name) as name
    from rdb$relation_fields rf
    where rf.rdb$relation_name = ?
    order by rf.rdb$field_position
  `;
	const rows = await query(config, sql, [tableName]);
	return rows.map((row) => row.name);
}

async function countRows(config, tableName) {
	const sql = `select count(*) as cnt from ${quoteIdentifier(tableName)}`;
	const rows = await query(config, sql);
	return rows?.[0]?.cnt || 0;
}

async function fetchBatch(config, tableName, columns, offset, limit, orderBy) {
	const cols = columns.length ? columns.map(quoteIdentifier).join(", ") : "*";
	const order = orderBy ? ` order by ${quoteIdentifier(orderBy)}` : "";
	const sql = `select first ${limit} skip ${offset} ${cols} from ${quoteIdentifier(tableName)}${order}`;
	return query(config, sql);
}

module.exports = {
	resolveFirebirdConfig,
	validateFirebirdConfig,
	maskFirebirdConfig,
	attach,
	testConnection,
	query,
	listTables,
	listColumns,
	countRows,
	fetchBatch
};
