const express = require('express');
const router = express.Router();

router.get('/admin/presets', (req, res) => {
	// NOTE: Admin auth should be applied here in real app
	res.render('admin_presets', { title: 'Manage Presets' });
});

module.exports = router;
