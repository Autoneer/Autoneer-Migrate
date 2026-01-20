const express = require("express");
const firebird = require("../db/firebird");
const mysql = require("../db/mysql");
const schemaLoader = require("../config/schemaLoader");
const { state } = require("../config/state");
const { updateSettings } = require("../config/settings");

const router = express.Router();

function normalizeString(value) {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : "";
}

function updateStateFromBody(body) {
	const fbHost = normalizeString(body.fb_host) || state.firebird.host;
	const fbPort = normalizeString(body.fb_port) || state.firebird.port;
	const fbDatabase = normalizeString(body.fb_database) || state.firebird.database;
	const fbUser = normalizeString(body.fb_user) || state.firebird.user;
	const fbRole = normalizeString(body.fb_role) || state.firebird.role;
	const fbPassword = normalizeString(body.fb_password);
	const useDefaultSysdbaMasterkey = body.fb_use_default === "on";

	state.firebird = {
		...state.firebird,
		host: fbHost,
		port: fbPort,
		database: fbDatabase,
		user: fbUser,
		role: fbRole,
		password: fbPassword ? fbPassword : state.firebird.password,
		useDefaultSysdbaMasterkey
	};

	const myHost = normalizeString(body.my_host) || state.mysql.host;
	const myPort = normalizeString(body.my_port) || state.mysql.port;
	const myUser = normalizeString(body.my_user) || state.mysql.user;
	const myPassword = normalizeString(body.my_password);

	state.mysql = {
		...state.mysql,
		host: myHost,
		port: myPort,
		user: myUser,
		password: myPassword ? myPassword : state.mysql.password
	};

	state.schemaName = normalizeString(body.my_schema) || state.schemaName;

	state.settings.defaultMappingProfileId = state.settings.defaultMappingProfileId || null;
	updateSettings({
		useDefaultSysdbaMasterkey
	});
}

function buildDiagnostics() {
	const resolvedFirebird = firebird.resolveFirebirdConfig(state.firebird, process.env);
	const fbMasked = firebird.maskFirebirdConfig(resolvedFirebird);
	return {
		firebird: {
			...fbMasked,
			passwordSet: !!resolvedFirebird.password
		},
		mysql: {
			host: state.mysql.host,
			port: state.mysql.port,
			user: state.mysql.user,
			passwordSet: !!state.mysql.password,
			schemaName: state.schemaName
		}
	};
}

router.get("/setup", async (req, res) => {
	const diagnostics = buildDiagnostics();
	res.render("setup", {
		firebird: { ...state.firebird, password: "" },
		mysql: { ...state.mysql, password: "" },
		schemaName: state.schemaName,
		ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
		firebirdPasswordSet: !!state.firebird.password,
		firebirdUser: state.firebird.user,
		useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
		diagnostics,
		currentStep: "setup"
	});
});

router.post("/setup/save", async (req, res) => {
	updateStateFromBody(req.body);
	// Invalidate health caches after config changes
	const { mysqlPoolCache, healthCache } = require('./health');
	mysqlPoolCache.clear();
	healthCache.mysql.clear();
	healthCache.firebird = { ts: 0, data: null };

	const resolved = firebird.resolveFirebirdConfig(state.firebird, process.env);
	const validationError = firebird.validateFirebirdConfig(resolved);
	if (validationError) {
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			error: validationError,
			currentStep: "setup"
		});
		return;
	}
	res.redirect("/plan");
});

router.post("/setup/test-firebird", async (req, res) => {
	updateStateFromBody(req.body);
	// Invalidate health caches after config changes
	const { mysqlPoolCache, healthCache } = require('./health');
	mysqlPoolCache.clear();
	healthCache.mysql.clear();
	healthCache.firebird = { ts: 0, data: null };

	const resolved = firebird.resolveFirebirdConfig(state.firebird, process.env);
	const validationError = firebird.validateFirebirdConfig(resolved);
	console.log("Firebird test config:", firebird.maskFirebirdConfig(resolved));
	try {
		if (validationError) {
			throw new Error(validationError);
		}
		await firebird.testConnection(state.firebird);
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: {
				status: "success",
				title: "Connection successful",
				message: "Firebird connected successfully.",
				details: resolved.database ? `Database: ${resolved.database}` : ""
			},
			currentStep: "setup"
		});
	} catch (err) {
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: {
				status: "error",
				title: "Connection failed",
				message: "Could not connect to Firebird.",
				details: String(err?.message || err)
			},
			currentStep: "setup"
		});
	}
});

router.post("/setup/test-mysql", async (req, res) => {
	updateStateFromBody(req.body);
	// Invalidate health caches after config changes
	const { mysqlPoolCache, healthCache } = require('./health');
	mysqlPoolCache.clear();
	healthCache.mysql.clear();
	healthCache.firebird = { ts: 0, data: null };

	try {
		await mysql.testConnection(state.mysql);
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: {
				status: "success",
				title: "Connection successful",
				message: "MySQL connected successfully.",
				details: `Schema: ${state.schemaName}${state.mysql?.host ? ` • Host: ${state.mysql.host}` : ""}`
			},
			currentStep: "setup"
		});
	} catch (err) {
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: {
				status: "error",
				title: "Connection failed",
				message: "Could not connect to MySQL.",
				details: String(err?.message || err)
			},
			currentStep: "setup"
		});
	}
});

router.post("/setup/check-schema", async (req, res) => {
	updateStateFromBody(req.body);
	// Invalidate health caches after config changes
	const { mysqlPoolCache, healthCache } = require('./health');
	mysqlPoolCache.clear();
	healthCache.mysql.clear();
	healthCache.firebird = { ts: 0, data: null };

	try {
		const exists = await mysql.schemaExists(state.mysql, state.schemaName);
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: exists
				? {
					status: "success",
					title: "Connection successful",
					message: "MySQL schema is available.",
					details: `Schema: ${state.schemaName}`
				}
				: {
					status: "error",
					title: "Connection failed",
					message: "MySQL schema was not found.",
					details: `Schema: ${state.schemaName}`
				},
			schemaExists: exists,
			currentStep: "setup"
		});
	} catch (err) {
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: schemaLoader.getSchemaNameFromDDL(),
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: {
				status: "error",
				title: "Connection failed",
				message: "Could not check the MySQL schema.",
				details: String(err?.message || err)
			},
			currentStep: "setup"
		});
	}
});

router.post("/setup/create-schema", async (req, res) => {
	updateStateFromBody(req.body);
	// Invalidate health caches after config changes
	const { mysqlPoolCache, healthCache } = require('./health');
	mysqlPoolCache.clear();
	healthCache.mysql.clear();
	healthCache.firebird = { ts: 0, data: null };

	const ddlSchema = schemaLoader.getSchemaNameFromDDL();
	if (ddlSchema && ddlSchema !== state.schemaName) {
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: ddlSchema,
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			error: `DDL schema name is ${ddlSchema}. Please use this schema name to create the database.`,
			currentStep: "setup"
		});
		return;
	}
	try {
		await mysql.createSchema(state.mysql, schemaLoader.getSchemaSql());
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: ddlSchema,
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: {
				status: "success",
				title: "Connection successful",
				message: "MySQL schema created successfully.",
				details: `Schema: ${ddlSchema || state.schemaName}`
			},
			currentStep: "setup"
		});
	} catch (err) {
		res.render("setup", {
			firebird: { ...state.firebird, password: "" },
			mysql: { ...state.mysql, password: "" },
			schemaName: state.schemaName,
			ddlSchemaName: ddlSchema,
			firebirdPasswordSet: !!state.firebird.password,
			firebirdUser: state.firebird.user,
			useDefaultSysdbaMasterkey: state.firebird.useDefaultSysdbaMasterkey,
			diagnostics: buildDiagnostics(),
			testResult: {
				status: "error",
				title: "Connection failed",
				message: "Could not create the MySQL schema.",
				details: String(err?.message || err)
			},
			currentStep: "setup"
		});
	}
});

module.exports = router;
