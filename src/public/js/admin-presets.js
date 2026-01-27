(async function () {
	const listEl = document.getElementById('preset-list');
	const nameEl = document.getElementById('preset-name');
	const codeEl = document.getElementById('preset-code');
	const jsonEl = document.getElementById('preset-json');
	const msgEl = document.getElementById('preset-messages');

	async function loadPresets() {
		listEl.innerHTML = '<em>Loading...</em>';
		try {
			const res = await fetch('/api/presets');
			const data = await res.json();
			listEl.innerHTML = '';
			data.presets.forEach(p => {
				const btn = document.createElement('button');
				btn.className = 'btn btn-sm btn-secondary';
				btn.style.display = 'block';
				btn.style.marginBottom = '6px';
				btn.textContent = p.name + (p.is_system ? ' (system)' : '');
				btn.addEventListener('click', () => selectPreset(p.preset_id));
				listEl.appendChild(btn);
			});
		} catch (e) {
			listEl.innerHTML = 'Failed to load presets';
		}
	}

	async function selectPreset(id) {
		msgEl.textContent = '';
		try {
			const res = await fetch('/api/presets/' + id);
			const data = await res.json();
			if (!data.success) return msgEl.textContent = 'Failed to load preset';
			const p = data.preset;
			nameEl.value = p.name;
			codeEl.value = p.code;
			jsonEl.value = JSON.stringify(typeof p.definition_json === 'string' ? JSON.parse(p.definition_json) : p.definition_json, null, 2);
			jsonEl.dataset.presetId = p.preset_id;
		} catch (e) {
			msgEl.textContent = 'Error loading preset';
		}
	}

	document.getElementById('btn-validate').addEventListener('click', () => {
		try {
			JSON.parse(jsonEl.value);
			msgEl.style.color = 'green';
			msgEl.textContent = 'JSON OK';
		} catch (e) {
			msgEl.style.color = '#a00';
			msgEl.textContent = 'JSON error: ' + e.message;
		}
	});

	document.getElementById('btn-save').addEventListener('click', async () => {
		msgEl.textContent = '';
		try {
			const def = JSON.parse(jsonEl.value);
			const payload = { code: codeEl.value, name: nameEl.value, definition_json: def, is_active: 1 };
			if (jsonEl.dataset.presetId) {
				const id = jsonEl.dataset.presetId;
				const res = await fetch('/api/presets/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
				const jr = await res.json();
				if (jr.success) { msgEl.style.color = 'green'; msgEl.textContent = 'Saved'; loadPresets(); }
				else { msgEl.style.color = '#a00'; msgEl.textContent = JSON.stringify(jr); }
			} else {
				const res = await fetch('/api/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
				const jr = await res.json();
				if (jr.success) { msgEl.style.color = 'green'; msgEl.textContent = 'Created'; loadPresets(); }
				else { msgEl.style.color = '#a00'; msgEl.textContent = JSON.stringify(jr); }
			}
		} catch (e) {
			msgEl.style.color = '#a00';
			msgEl.textContent = 'Error: ' + e.message;
		}
	});

	document.getElementById('btn-deactivate').addEventListener('click', async () => {
		const id = jsonEl.dataset.presetId;
		if (!id) return msgEl.textContent = 'Select a preset first';
		if (!confirm('Deactivate this preset?')) return;
		try {
			const res = await fetch('/api/presets/' + id, { method: 'DELETE' });
			const jr = await res.json();
			if (jr.success) { msgEl.style.color = 'green'; msgEl.textContent = 'Deactivated'; loadPresets(); }
			else { msgEl.style.color = '#a00'; msgEl.textContent = JSON.stringify(jr); }
		} catch (e) {
			msgEl.style.color = '#a00';
			msgEl.textContent = e.message;
		}
	});

	loadPresets();
})();
