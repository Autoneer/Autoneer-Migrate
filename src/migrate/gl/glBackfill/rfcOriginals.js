"use strict";

// Legacy supplier invoices left in RFC-ORIGINAL with no '-RFC' return to pair
// with: a return was started in the legacy system and never finished. The RFC
// migration never selects them and the backfill posts only DONE, POSTED and
// CREDIT invoices, so Tenant Check lists them and offers the fixes their data
// supports. Each fix changes only the tenant's copy; Firebird is never written.

const CENT = 0.005;
const LIMIT = 200;
const VOID_REASON = "Legacy RFC-ORIGINAL invoice with no return (Migrate GL Backfill)";

// Tables that key a supplier invoice by supplier and number, renumbered with
// the return as the PWA's invoice details correction renumbers them.
const RENUMBERED = [
	["invoice_items", "invoice_nr", "invoice line"],
	["invoice_general", "invoice_nr", "general invoice line"],
	["orders", "orderinvoice_nr", "order"],
	["payments_suppliers", "invoice_nr", "supplier payment"],
	["credit_notes_supplier", "invoice_nr", "supplier credit note"]
];

function httpError(statusCode, code, message) {
	return Object.assign(new Error(message), { statusCode, code });
}

const money = (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

// The invoice (alias o) has no return the RFC migration would pair with it.
function unpairedWhere(schema, alias) {
	return `${alias}.status = 'RFC-ORIGINAL'
		AND NOT EXISTS (
		  SELECT 1 FROM \`${schema}\`.invoices_supplier p
		  WHERE p.suppid = ${alias}.suppid AND p.invoice_nr LIKE '%-RFC' AND p.status IN ('RFC-DONE', 'POSTED')
		    AND REPLACE(p.invoice_nr, '-RFC', '') = ${alias}.invoice_nr
		)`;
}

// A return r numbered '<invoice>-<something>-RFC' that pairs with no invoice of
// its own, so it can only belong to invoice alias.
function orphanReturnWhere(schema, alias) {
	return `r.suppid = ${alias}.suppid AND r.sinvid <> ${alias}.sinvid AND r.status = 'RFC-DONE' AND r.invoice_nr LIKE '%-RFC'
		AND LEFT(r.invoice_nr, CHAR_LENGTH(${alias}.invoice_nr) + 1) = CONCAT(${alias}.invoice_nr, '-')
		AND CHAR_LENGTH(r.invoice_nr) > CHAR_LENGTH(${alias}.invoice_nr) + 4
		AND NOT EXISTS (
		  SELECT 1 FROM \`${schema}\`.invoices_supplier x
		  WHERE x.suppid = r.suppid AND x.invoice_nr = REPLACE(r.invoice_nr, '-RFC', '')
		)`;
}

/** Read-only: the unpaired invoices for Tenant Check, oldest first. */
async function readUnpaired(query, schema) {
	const rows = await query(
		`SELECT o.sinvid, o.suppid, sup.supplier AS supplier_name, o.invoice_nr, DATE_FORMAT(o.inv_date, '%Y-%m-%d') AS inv_date,
		        o.amount, o.paid, o.rfcamount,
		        (SELECT GROUP_CONCAT(r.invoice_nr ORDER BY r.invoice_nr SEPARATOR ', ') FROM \`${schema}\`.invoices_supplier r
		         WHERE ${orphanReturnWhere(schema, "o")}) AS unpaired_returns
		 FROM \`${schema}\`.invoices_supplier o
		 LEFT JOIN \`${schema}\`.suppliers sup ON sup.suppid = o.suppid
		 WHERE ${unpairedWhere(schema, "o")}
		 ORDER BY o.inv_date, o.sinvid
		 LIMIT ${LIMIT}`
	);
	return rows.map((row) => ({
		sinvid: Number(row.sinvid), supplier: row.supplier_name || `Supplier ${row.suppid}`, invoiceNr: row.invoice_nr,
		date: row.inv_date, amount: Number(row.amount), paid: Number(row.paid || 0),
		returnRecorded: Math.abs(Number(row.rfcamount || 0)), unpairedReturns: row.unpaired_returns
	}));
}

/**
 * The fixes one invoice's data supports, most suitable first, each with the
 * changes it makes. Pure, so the rules can be tested without a database.
 */
function fixActions({ invoice, payments, returns, targetTaken, journalLines, renumber }) {
	const amount = round2(invoice.amount);
	const paid = round2(invoice.paid);
	const payable = round2(invoice.payable);
	const returned = round2(invoice.rfcamount);
	const owing = round2(Math.max(amount - paid, 0));
	const actions = [];

	if (returns.length === 1 && !targetTaken && !journalLines) {
		const target = `${invoice.invoice_nr}-RFC`;
		actions.push({
			action: "pair",
			title: `Pair it with return ${returns[0].invoice_nr}`,
			hint: "The return was numbered differently, so the RFC migration could not find it.",
			changes: [
				`Renumber return ${returns[0].invoice_nr} to ${target}`,
				...renumber.filter((item) => item.rows).map((item) => `Renumber its ${item.rows} ${item.label}${item.rows === 1 ? "" : "s"}`),
				"Then run card 2 to migrate the pair"
			]
		});
	}
	if (Math.abs(returned) < CENT) {
		actions.push({
			action: "done",
			title: "Post it as a normal invoice",
			hint: paid >= amount - CENT ? "It was paid in full and no return was recorded." : "",
			changes: [
				"Change its status from RFC-ORIGINAL to DONE",
				...(Math.abs(payable - owing) >= CENT ? [`Set the amount owing from ${money(payable)} to ${money(owing)}`] : []),
				`The backfill then posts ${money(amount)} to the supplier's account`
			]
		});
	}
	if (paid < CENT && Math.abs(payments.total) < CENT) {
		actions.push({
			action: "void",
			title: "Void it",
			hint: amount < CENT ? "It is for nothing." : returned <= -(amount - CENT) ? "The full amount was returned and nothing was paid." : "",
			changes: [
				"Change its status from RFC-ORIGINAL to VOID",
				...(Math.abs(payable) >= CENT ? [`Set the amount owing from ${money(payable)} to 0.00`] : []),
				"The backfill posts nothing for it"
			]
		});
	}

	const pick = (key) => actions.find((item) => item.action === key);
	const recommended = pick("pair")
		|| (paid >= CENT && pick("done"))
		|| ((amount < CENT || returned <= -(amount - CENT)) && pick("void"))
		|| null;
	return actions.map((item) => ({ ...item, recommended: item === recommended }));
}

async function renumberTables(query, schema) {
	const rows = await query(
		`SELECT LOWER(table_name) AS t, LOWER(column_name) AS c FROM information_schema.columns
		 WHERE table_schema = ? AND column_name IN ('suppid', 'invoice_nr', 'orderinvoice_nr')`,
		[schema]
	);
	const columns = new Set(rows.map((row) => `${row.t}.${row.c}`));
	return RENUMBERED.filter(([table, column]) => columns.has(`${table}.suppid`) && columns.has(`${table}.${column}`));
}

async function readFacts(query, schema, sinvid, lock = false) {
	const id = Number(sinvid);
	if (!Number.isInteger(id) || id <= 0) throw httpError(400, "invalid_invoice", "Choose an invoice to fix.");
	const [invoice] = await query(
		`SELECT o.sinvid, o.suppid, o.invoice_nr, o.amount, o.paid, o.payable, o.rfcamount
		 FROM \`${schema}\`.invoices_supplier o
		 WHERE o.sinvid = ? AND ${unpairedWhere(schema, "o")}${lock ? " FOR UPDATE" : ""}`,
		[id]
	);
	if (!invoice) throw httpError(404, "not_unpaired", `Invoice ${id} is no longer an unpaired RFC-ORIGINAL invoice. Check Again.`);

	const [supplier] = await query(`SELECT supplier FROM \`${schema}\`.suppliers WHERE suppid = ?`, [invoice.suppid]);
	const [payments] = await query(
		`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM \`${schema}\`.payments_suppliers
		 WHERE (invid = ? OR (suppid = ? AND invoice_nr = ?)) AND UPPER(TRIM(COALESCE(status, ''))) <> 'REVERSED'`,
		[id, invoice.suppid, invoice.invoice_nr]
	);
	const returns = await query(
		`SELECT r.sinvid, r.invoice_nr FROM \`${schema}\`.invoices_supplier o
		 JOIN \`${schema}\`.invoices_supplier r ON ${orphanReturnWhere(schema, "o")}
		 WHERE o.sinvid = ? ORDER BY r.invoice_nr${lock ? " FOR UPDATE" : ""}`,
		[id]
	);
	const [taken] = await query(
		`SELECT COUNT(*) AS n FROM \`${schema}\`.invoices_supplier WHERE suppid = ? AND invoice_nr = ?`,
		[invoice.suppid, `${invoice.invoice_nr}-RFC`]
	);
	const tables = await renumberTables(query, schema);
	const renumber = [];
	let journalLines = 0;
	if (returns.length === 1) {
		const old = returns[0].invoice_nr;
		for (const [table, column, label] of tables) {
			const [row] = await query(`SELECT COUNT(*) AS n FROM \`${schema}\`.\`${table}\` WHERE suppid = ? AND \`${column}\` = ?`, [invoice.suppid, old]);
			renumber.push({ table, column, label, rows: Number(row.n) });
		}
		const [lines] = await query(
			`SELECT COUNT(*) AS n FROM \`${schema}\`.gl_journal_lines WHERE suppid = ? AND (invoice_nr = ? OR ref2 = ?)`,
			[invoice.suppid, old, old]
		);
		journalLines = Number(lines.n);
	}
	const facts = {
		invoice,
		payments: { count: Number(payments.n), total: round2(payments.total) },
		returns,
		targetTaken: Number(taken.n) > 0,
		journalLines,
		renumber
	};
	return { ...facts, supplier: supplier ? supplier.supplier : `Supplier ${invoice.suppid}`, actions: fixActions(facts) };
}

/** Read-only: one invoice and the fixes it supports, for the preview. */
async function readFixOptions(query, schema, sinvid) {
	const facts = await readFacts(query, schema, sinvid);
	const { invoice } = facts;
	return {
		sinvid: Number(invoice.sinvid),
		supplier: facts.supplier,
		invoiceNr: invoice.invoice_nr,
		amount: round2(invoice.amount),
		paid: round2(invoice.paid),
		payable: round2(invoice.payable),
		returnRecorded: Math.abs(round2(invoice.rfcamount)),
		payments: facts.payments,
		unpairedReturns: facts.returns.map((row) => row.invoice_nr),
		actions: facts.actions
	};
}

function assertOne(result, what) {
	if (!result || Number(result.affectedRows) !== 1) throw httpError(409, "changed", `${what} changed while it was being fixed. Check Again.`);
}

/** Applies one fix. Run it inside a transaction: it re-reads and locks the invoice first. */
async function applyFix(query, schema, sinvid, choice = {}) {
	const facts = await readFacts(query, schema, sinvid, true);
	const action = facts.actions.find((item) => item.action === choice.action);
	if (!action) throw httpError(409, "fix_unavailable", "That fix does not fit this invoice any more. Check Again.");
	const { invoice } = facts;

	if (action.action === "done") {
		assertOne(await query(
			`UPDATE \`${schema}\`.invoices_supplier SET status = 'DONE', payable = ? WHERE sinvid = ? AND status = 'RFC-ORIGINAL'`,
			[round2(Math.max(Number(invoice.amount) - Number(invoice.paid || 0), 0)), invoice.sinvid]
		), `Invoice ${invoice.invoice_nr}`);
	} else if (action.action === "void") {
		assertOne(await query(
			`UPDATE \`${schema}\`.invoices_supplier
			 SET status = 'VOID', payable = 0, voided_at = NOW(), voided_by = NULL, void_reason = ?
			 WHERE sinvid = ? AND status = 'RFC-ORIGINAL'`,
			[VOID_REASON, invoice.sinvid]
		), `Invoice ${invoice.invoice_nr}`);
	} else {
		const [ret] = facts.returns;
		const target = `${invoice.invoice_nr}-RFC`;
		for (const item of facts.renumber.filter((entry) => entry.rows)) {
			const result = await query(
				`UPDATE \`${schema}\`.\`${item.table}\` SET \`${item.column}\` = ? WHERE suppid = ? AND \`${item.column}\` = ?`,
				[target, invoice.suppid, ret.invoice_nr]
			);
			if (Number(result.affectedRows) !== item.rows) throw httpError(409, "changed", `The ${item.label}s of return ${ret.invoice_nr} changed while it was being fixed. Check Again.`);
		}
		assertOne(await query(
			`UPDATE \`${schema}\`.invoices_supplier SET invoice_nr = ? WHERE sinvid = ? AND invoice_nr = ?`,
			[target, ret.sinvid, ret.invoice_nr]
		), `Return ${ret.invoice_nr}`);
	}
	return { action: action.action, applied: action.changes };
}

module.exports = { readUnpaired, fixActions, readFixOptions, applyFix };
