const express = require("express");
const router = express.Router();

/**
 * Wizard route - New Phase 3 UI with 5-step wizard flow
 */
router.get("/wizard", (req, res) => {
	res.render("wizard", {
		currentStep: "wizard",
		title: "Migration Wizard"
	});
});

module.exports = router;
