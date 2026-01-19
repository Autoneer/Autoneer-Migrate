const { state } = require("../config/state");
const firebird = require("../db/firebird");

function log(title, payload) {
	console.log(`\n${title}`);
	console.log(payload);
}

function main() {
	const fbResolved = firebird.resolveFirebirdConfig(state.firebird, process.env);
	const fbValidation = firebird.validateFirebirdConfig(fbResolved);
	log("Firebird (masked)", firebird.maskFirebirdConfig(fbResolved));
	if (fbValidation) {
		console.error(`Firebird validation failed: ${fbValidation}`);
		process.exitCode = 1;
	}
	if (!fbResolved.password) {
		console.error("Firebird validation failed: password is empty.");
		process.exitCode = 1;
	}

	const mysqlMasked = {
		host: state.mysql.host,
		port: state.mysql.port,
		user: state.mysql.user,
		passwordSet: !!state.mysql.password,
		schemaName: state.schemaName
	};
	log("MySQL (masked)", mysqlMasked);
	if (!state.mysql.host || !state.mysql.user) {
		console.error("MySQL validation failed: host and user are required.");
		process.exitCode = 1;
	}
}

main();
