const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const { engine } = require("express-handlebars");
require("dotenv").config();

const setupRoutes = require("./routes/setup");
const planRoutes = require("./routes/plan");
const mappingRoutes = require("./routes/mapping");
const runRoutes = require("./routes/run");
const resultsRoutes = require("./routes/results");
const eventsRoutes = require("./routes/events");
const migrationRoutes = require("./routes/migration");

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
app.use(planRoutes);
app.use(mappingRoutes);
app.use(migrationRoutes);
app.use(runRoutes);
app.use(resultsRoutes);
app.use(eventsRoutes);

app.use((err, req, res, next) => {
	const message = err?.message || "Unexpected error";
	res.status(500).render("error", { message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Autoneer migrator running on http://localhost:${port}`);
});
