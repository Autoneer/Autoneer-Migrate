// Explicit business identities supplement live MySQL constraints. No rule is
// inferred merely because a column happens to contain "id" or "invoice".
const REQUIRED_IDENTITIES = {
	invoices: { invoice_nr: 'positive' },
	stock: { partnr: 'text' },
	job_information: { job_number: 'positive' },
	spares_used: { job_number: 'positive' },
	work_done: { job_number: 'positive' },
	payments: { invoice_nr: 'positive' },
	invoices_supplier: { invoice_nr: 'text' },
	invoice_items: { invoice_nr: 'text' },
	payments_suppliers: { invoice_nr: 'text' }
};
// A general invoice sells parts and labour without a job: its lines carry job 0
// and are identified by their invoice number instead.
const IDENTITY_ALTERNATIVES = {
	spares_used: { job_number: 'invoice_nr' },
	work_done: { job_number: 'invoice_nr' }
};

const RELATIONSHIPS = [];
function add(tables, columns, parent, parentColumns, optionalZero = false) {
	for (const table of tables) RELATIONSHIPS.push({ table, columns, parent, parentColumns, optionalZero, kind: 'business' });
}
add(['invoices', 'job_information', 'payments', 'credit_notes', 'customer_notes'], ['cid'], 'customers', ['cid'], true);
add(['invoices', 'spares_used', 'work_done', 'job_report', 'job_checklist', 'job_checkin', 'work_timer', 'work_todo'], ['job_number'], 'job_information', ['job_number'], true);
add(['spares_used', 'work_done', 'payments', 'credit_notes'], ['invoice_nr'], 'invoices', ['invoice_nr'], true);
add(['invoice_items', 'invoices_supplier', 'payments_suppliers', 'credit_notes_supplier', 'supplier_notes'], ['suppid'], 'suppliers', ['suppid'], true);
add(['invoice_items', 'payments_suppliers'], ['invoice_nr', 'suppid'], 'invoices_supplier', ['invoice_nr', 'suppid']);
add(['spares_used', 'invoice_items', 'adjust_stock', 'remove_stock', 'stock_take'], ['stock_id'], 'stock', ['stock_id'], true);
add(['stock_links'], ['stock_id'], 'stock', ['stock_id']);

const isMissing = value => value == null || (typeof value === 'string' && !value.trim());
function invalidIdentity(value, type) {
	return isMissing(value) || (type === 'positive' && (!/^\d+$/.test(String(value)) || BigInt(String(value)) <= 0n));
}

module.exports = { REQUIRED_IDENTITIES, IDENTITY_ALTERNATIVES, RELATIONSHIPS, isMissing, invalidIdentity };
