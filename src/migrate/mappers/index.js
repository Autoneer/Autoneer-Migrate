const transforms = require("./transforms");

function applyTransform(transformName, value) {
	if (!transformName) return value;
	const fn = transforms[transformName];
	return fn ? fn(value) : value;
}

module.exports = {
	applyTransform,
	transforms
};
