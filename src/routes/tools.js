const express = require("express");

const router = express.Router();

router.get("/tools/gl", (req, res) => {
	res.render("gl_tools", {
		currentStep: "glTools",
		title: "GL Tools"
	});
});

module.exports = router;
