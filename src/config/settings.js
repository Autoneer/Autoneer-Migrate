const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "..", "..", "data", "migrate-settings.json");

const DEFAULT_SETTINGS = {
	defaultMappingProfileId: null,
	useDefaultSysdbaMasterkey: false
};

function readSettingsFile() {
	try {
		if (!fs.existsSync(SETTINGS_PATH)) {
			return { ...DEFAULT_SETTINGS };
		}
		const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
		const parsed = JSON.parse(raw);
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch (err) {
		return { ...DEFAULT_SETTINGS };
	}
}

function ensureSettingsDir() {
	const dir = path.dirname(SETTINGS_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function writeSettingsFile(settings) {
	ensureSettingsDir();
	fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function loadSettings() {
	return readSettingsFile();
}

function updateSettings(partial) {
	const current = readSettingsFile();
	const next = { ...current, ...partial };
	writeSettingsFile(next);
	return next;
}

module.exports = {
	loadSettings,
	updateSettings
};
