const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const { engine } = require("express-handlebars");
require("dotenv").config();

const setupRoutes = require("./routes/setup");
const eventsRoutes = require("./routes/events");
const migrationRoutes = require("./routes/migration");
const wizardRoutes = require("./routes/wizard"); // Phase 3: New wizard UI
const { router: healthRoutes } = require("./routes/health"); // Destructure router since health.js exports object
const schemaRoutes = require("./routes/schema"); // New refactored schema API

// Phase 2 API routes - Refactored models
const mappingApiRoutes = require("./routes/api/mappings");
const planApiRoutes = require("./routes/api/plans");
const runApiRoutes = require("./routes/api/runs");

const app = express();

app.engine(
	"hbs",
	engine({
		extname: ".hbs",
		defaultLayout: "main",
		layoutsDir: path.join(__dirname, "views", "layouts"),
		partialsDir: path.join(__dirname, "views", "partials"),
		helpers: {
			eq: (a, b) => a === b,
			includes: (arr, value) => Array.isArray(arr) && arr.includes(value),
			json: (context) => JSON.stringify(context, null, 2),
			lookup: (obj, field) => (obj ? obj[field] : undefined),
			formatDate: (value, format) => {
				if (!value) return '-';
				const d = value instanceof Date ? value : new Date(value);
				if (isNaN(d.getTime())) return value;
				const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
				if (format === 'date') delete opts.hour, delete opts.minute;
				try {
					return d.toLocaleString('en-US', opts);
				} catch (e) {
					return d.toString();
				}
			}
		}
	})
);
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "1mb" }));

app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/setup"));

app.use(setupRoutes);
app.use(migrationRoutes);
app.use(wizardRoutes); // Phase 3: Wizard UI route
app.use(eventsRoutes);
app.use(healthRoutes);
app.use(schemaRoutes); // New schema API routes

// Phase 2: Refactored API routes
app.use("/api", mappingApiRoutes); // Mapping CRUD endpoints
app.use("/api", planApiRoutes);    // Plan management endpoints
app.use("/api", runApiRoutes);     // Run tracking endpoints

app.use((err, req, res, next) => {
	const message = err?.message || "Unexpected error";

	// If this is an API request, return standardized JSON error
	const wantsJson = req.path.startsWith('/api') || req.xhr || (req.get && req.get('Accept') && req.get('Accept').includes('application/json'));
	if (wantsJson) {
		return res.status(500).json({
			success: false,
			error: 'INTERNAL_ERROR',
			message
		});
	}

	// Fallback: render HTML error page for browser routes
	res.status(500).render("error", { message });
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
	console.log(`Autoneer migrator running on http://localhost:${port}`);
});
server.on('error', (err) => {
	if (err && err.code === 'EADDRINUSE') {
		console.error(`Port ${port} already in use. Set PORT or stop the other process.`);
		process.exit(1);
	} else {
		throw err;
	}
});
