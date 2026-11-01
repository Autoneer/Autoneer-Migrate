const express = require("express");

const router = express.Router();

router.get("/tools/gl", (req, res) => {
	res.render("gl_tools", {
		currentStep: "glTools",
		title: "GL Maintenance"
	});
});

router.get("/tools/gl-backfill", (req, res) => {
	res.render("gl_backfill", {
		currentStep: "glBackfill",
		title: "GL Backfill"
	});
});

module.exports = router;
