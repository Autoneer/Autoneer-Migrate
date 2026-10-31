function prepareLegacyMapping(mapping, logRun = () => {}) {
		// Auto-migrate old INVOICES column mapping to match actual schema
		if (mapping?.tables?.INVOICES?.columns) {
			const cols = mapping.tables.INVOICES.columns;
			const renames = {
				INVOICE_NR: "INV_NR",
				IDATE: "INVOICE_DATE",
				TOTAL: "INV_TOTALEXLVAT",
				TOTALINCLVAT: "INV_TOTALINCLVAT"
			};
			const targetRenames = {
				idate: "invoice_date",
				total: "inv_totalexlvat",
				totalinclvat: "inv_totalinclvat"
			};
			for (const [oldKey, newKey] of Object.entries(renames)) {
				if (cols[oldKey] && !cols[newKey]) {
					cols[newKey] = cols[oldKey];
					delete cols[oldKey];
					logRun({ level: "info", phase: "mapping_migrate", table: "INVOICES", oldKey, newKey });
				}
			}
			for (const rule of Object.values(cols)) {
				const lower = String(rule.target || "").toLowerCase();
				if (targetRenames[lower]) {
					logRun({ level: "info", phase: "mapping_migrate", table: "INVOICES", oldTarget: rule.target, newTarget: targetRenames[lower] });
					rule.target = targetRenames[lower];
				}
			}
		}

		// Auto-migrate old JOB_INFORMATION mappings that paired similarly named fields to the wrong targets.
		for (const [sourceKey, entry] of Object.entries(mapping?.tables || {})) {
			const targetName = String(entry?.target || entry?.targetTable || "").toLowerCase();
			if (String(sourceKey).toUpperCase() !== "JOB_INFORMATION" && targetName !== "job_information") continue;
			const cols = entry?.columns || {};
			if (cols.INVTOTAL) {
				const target = String(cols.INVTOTAL.target || cols.INVTOTAL.targetColumn || "").toLowerCase();
				if (target === "job_number") {
					cols.INVTOTAL.target = "invoice_total";
					cols.INVTOTAL.targetColumn = "invoice_total";
					logRun({ level: "info", phase: "mapping_migrate", table: "JOB_INFORMATION", source: "INVTOTAL", oldTarget: "job_number", newTarget: "invoice_total" });
				}
			}
			if (cols.CONT_JOBNR) {
				const target = String(cols.CONT_JOBNR.target || cols.CONT_JOBNR.targetColumn || "").toLowerCase();
				if (target === "cont_id") {
					cols.CONT_JOBNR.target = "cont_job_number";
					cols.CONT_JOBNR.targetColumn = "cont_job_number";
					logRun({ level: "info", phase: "mapping_migrate", table: "JOB_INFORMATION", source: "CONT_JOBNR", oldTarget: "cont_id", newTarget: "cont_job_number" });
				}
			}
		}

		// Auto-migrate old SPARES_USED column names
		if (mapping?.tables?.SPARES_USED?.columns) {
			const cols = mapping.tables.SPARES_USED.columns;
			const renames = {
				JOB_NUMBER: "JOB_NR",
				QTY: "QUANTITY",
				SPARE_ID: "SPARES_ID"
			};
			for (const [oldKey, newKey] of Object.entries(renames)) {
				if (cols[oldKey] && !cols[newKey]) {
					cols[newKey] = cols[oldKey];
					delete cols[oldKey];
					logRun({ level: "info", phase: "mapping_migrate", table: "SPARES_USED", oldKey, newKey });
				}
			}
		}
}
module.exports = { prepareLegacyMapping };
