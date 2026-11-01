'use strict';
/**
 * rebuildStockAccounting.js
 *
 * GL capitalisation of an internal rebuild job that is completed into rebuild
 * listed stock. One builder serves both live completion
 * (completeRebuildJobToStock) and GL Backfill (REBUILD_STOCK), so the two can
 * never disagree about what a rebuild capitalisation journal looks like.
 *
 *   Dr  Rebuilt master item Inventory asset       total_cost
 *   Cr  WIP                                       parts cost actually carried in WIP
 *   Cr  Source part Inventory asset(s)            remaining parts cost
 *   Cr  Rebuild Cost Recovery / Capitalisation    labour_cost + other_cost
 *       Offset (REBUILD_COST_RECOVERY)
 *
 * source    = REBUILD_STOCK_CAPITALISATION
 * source_id = <job_number>:<version>
 *
 * Rules:
 *  - Amounts come from the stored stock_rebuild_jobs cost snapshot. The part
 *    breakdown is re-read from spares_used with the rebuild costing inclusion
 *    rules and must reconcile to the stored parts_cost; a material difference
 *    fails closed instead of inventing a balancing line.
 *  - The WIP/Inventory split drains the job's real supplier-funded WIP balance
 *    (getJobWipDebitedTotal) part by part, exactly like job finalisation. Line
 *    status is never used as a proxy for "this part was bought for the job".
 *  - A posted supplier invoice allocated to the job without its creditor GL
 *    journal fails closed: capitalising then would credit Inventory for cost
 *    that belongs in WIP.
 *  - No VAT, Sales, AR or AP is ever posted here.
 *  - Everything that runs inside a caller-owned transaction takes that
 *    transaction's queryFn. Control accounts and period bootstrap are resolved
 *    beforehand (prepareRebuildGlContext) because resolveControlAccounts
 *    re-seeds gl_accounts on a pooled connection and would self-deadlock once
 *    the transaction holds journal/account locks.
 */

const logger = require('../logger');
const postingEngine = require('./postingEngine');
const stockGlResolver = require('./stockGlResolver');
const finaliseService = require('../../services/finalise/finalise.service');

const CAPITALISATION_SOURCE = 'REBUILD_STOCK_CAPITALISATION';
const CAPITALISATION_REVERSAL_SOURCE = 'REBUILD_STOCK_CAPITALISATION_REVERSAL';
const COST_RECOVERY_CONTROL_KEY = 'REBUILD_COST_RECOVERY';
const COST_RECOVERY_LABEL = 'Rebuild Cost Recovery / Capitalisation Offset';
const COST_RECOVERY_ACCOUNT_TYPES = Object.freeze(['EXPENSE', 'COS']);
const UNCOSTED_PART_STATUSES = Object.freeze(['AWAITING_QUOTE', 'ORDER', 'ORDERED']);
const MONEY_EPSILON = 0.009;

function defaultDeps() {
	return {
		resolveControlAccounts: postingEngine.resolveControlAccounts,
		getOpenPeriodId: postingEngine.getOpenPeriodId,
		postJournal: postingEngine.postJournal,
		postReversalJournal: postingEngine.postReversalJournal,
		resolveStockGlAccounts: stockGlResolver.resolveStockGlAccounts,
		getJobWipDebitedTotal: finaliseService.getJobWipDebitedTotal
	};
}

function withDeps(deps) {
	return { ...defaultDeps(), ...(deps || {}) };
}

function round2(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

function money(value) {
	return round2(value).toFixed(2);
}

function q(schema) {
	const value = String(schema || '').trim();
	if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('Invalid tenant schema.');
	return `\`${value}\``;
}

function accountingError(message, code = 'REBUILD_GL_CAPITALISATION_FAILED', cause = null) {
	const err = new Error(message);
	err.code = code;
	err.statusCode = 409;
	if (cause) err.cause = cause;
	return err;
}

/** 'YYYY-MM-DD' for a date string or a driver Date (local components). */
function toSqlDate(value) {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'string') {
		const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
		if (match) return match[1];
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Local-midnight Date for a journal date, so the DATE column receives the same
 * calendar day whatever the server's UTC offset is.
 */
function toJournalDate(value) {
	const sqlDate = toSqlDate(value);
	if (!sqlDate) throw accountingError('A valid journal date is required for rebuild capitalisation.', 'REBUILD_GL_INVALID_DATE');
	const [year, month, day] = sqlDate.split('-').map(Number);
	return new Date(year, month - 1, day);
}

function capitalisationSourceId(jobNumber, version) {
	return `${Number(jobNumber)}:${Number(version)}`;
}

function describePeriodError(err, sqlDate, action) {
	if (err && err.code === 'PERIOD_CLOSED') {
		return accountingError(
			`The accounting period for ${sqlDate} is closed, so ${action} cannot be posted. Reopen that period first; the posting is never moved into another period.`,
			'PERIOD_CLOSED',
			err
		);
	}
	if (err && err.code === 'PERIOD_NOT_DEFINED') {
		return accountingError(
			`No accounting period covers ${sqlDate}, so ${action} cannot be posted. Create the period first.`,
			'PERIOD_NOT_DEFINED',
			err
		);
	}
	return null;
}

/**
 * Resolve everything that must NOT be resolved inside the posting transaction:
 * the stock control accounts used by the stock GL resolver, the WIP control
 * account, and (optionally) an open period for the journal date, which may need
 * bootstrapping on a pooled connection.
 *
 * Failures are captured rather than thrown so a rebuild that never needs them
 * (for example a zero-value rebuild) is not blocked; the builder raises the
 * captured error as soon as it actually needs that account.
 */
async function prepareRebuildGlContext({ schema, trxdate = null, deps } = {}) {
	const d = withDeps(deps);
	const context = {
		stockControls: null,
		stockControlsError: null,
		wipAccnr: null,
		wipError: null,
		periodError: null
	};
	try {
		context.stockControls = await d.resolveControlAccounts(schema, ['INVENTORY', 'SALES', 'COS'], {
			transactionTypeByKey: { INVENTORY: 'PARTS', SALES: 'PARTS', COS: 'PARTS' }
		});
	} catch (err) {
		context.stockControlsError = err;
	}
	try {
		const wip = await d.resolveControlAccounts(schema, ['WIP']);
		context.wipAccnr = wip && wip.WIP ? Number(wip.WIP) : null;
	} catch (err) {
		// A tenant without a WIP control posts job-tagged supplier lines to
		// Inventory, so there is no supplier WIP to relieve. Any other failure is
		// unknown state and must not be read as "no WIP".
		if (!err || err.code !== 'CONTROL_ACCOUNT_NOT_CONFIGURED') context.wipError = err;
	}
	if (trxdate) {
		try {
			await d.getOpenPeriodId(schema, toJournalDate(trxdate));
		} catch (err) {
			context.periodError = err;
		}
	}
	return context;
}

/**
 * Pooled-connection period bootstrap for a date, done before a transaction
 * that may post to it. Errors are swallowed: the in-transaction posting raises
 * them again, with a clear message, only if a journal really has to be posted.
 */
async function ensurePeriodBeforeTransaction({ schema, trxdate, deps } = {}) {
	const d = withDeps(deps);
	try {
		await d.getOpenPeriodId(schema, toJournalDate(trxdate));
		return null;
	} catch (err) {
		return err;
	}
}

/**
 * Costed part lines of a rebuild job, using the rebuild costing inclusion rules
 * (calculateRebuildJobCost): included lines only, open procurement statuses
 * ignored, cost = cost_price (per unit) x quantity.
 */
async function loadRebuildPartCosts({ queryFn, schema, jobNumber }) {
	const statusPlaceholders = UNCOSTED_PART_STATUSES.map(() => '?').join(', ');
	const rows = await queryFn(
		`SELECT spares_id, stock_id, partnr, cost_price, quantity
		 FROM ${q(schema)}.spares_used
		 WHERE job_number = ?
		   AND ${finaliseService.INCLUDED_LINE_SQL}
		   AND (status IS NULL OR UPPER(status) NOT IN (${statusPlaceholders}))
		 ORDER BY spares_id`,
		[Number(jobNumber), ...UNCOSTED_PART_STATUSES]
	);
	return (rows || []).map((row) => {
		const quantity = row.quantity === null || row.quantity === undefined ? 1 : Number(row.quantity);
		return {
			spares_id: row.spares_id === null || row.spares_id === undefined ? null : Number(row.spares_id),
			stock_id: row.stock_id ? Number(row.stock_id) : null,
			partnr: row.partnr || null,
			cost: round2((Number(row.cost_price) || 0) * (Number.isFinite(quantity) ? quantity : 1))
		};
	});
}

/**
 * Posted/completed supplier invoices allocated (invoice_items.job_number) to
 * the rebuild job that carry value but have no creditor GL journal. `asAt`
 * limits the check to invoices dated on or before the rebuild completion.
 */
async function findSupplierInvoicesMissingGl({ queryFn, schema, jobNumber, asAt = null }) {
	const s = q(schema);
	const asAtDate = asAt ? toSqlDate(asAt) : null;
	try {
		const rows = await queryFn(
			`SELECT si.suppid, si.invoice_nr
			 FROM (
			   SELECT DISTINCT ii.suppid, ii.invoice_nr
			   FROM ${s}.invoice_items ii
			   WHERE ii.job_number = ?
			     AND (COALESCE(ii.amount, 0) > 0.009 OR COALESCE(ii.amountexvat, 0) > 0.009)
			 ) alloc
			 JOIN ${s}.invoices_supplier si
			   ON si.suppid = alloc.suppid AND si.invoice_nr = alloc.invoice_nr
			 WHERE (si.posted_at IS NOT NULL OR UPPER(TRIM(COALESCE(si.status, ''))) IN ('DONE', 'POSTED'))
			   AND COALESCE(si.amount, 0) > 0.009
			   AND CAST(si.invoice_nr AS CHAR) NOT LIKE '%-RFC'
			   ${asAtDate ? 'AND si.inv_date <= ?' : ''}
			   AND NOT EXISTS (
			     SELECT 1
			     FROM ${s}.gl_journal_headers h
			     JOIN ${s}.gl_journal_lines l ON l.header_id = h.id
			     WHERE h.source IN ('CREDITOR_INVOICE', 'SUPPLIER_INVOICE')
			       AND h.status = 'POSTED'
			       AND l.suppid = si.suppid
			       AND (h.source_id = si.invoice_nr
			         OR h.source_id = CONCAT(si.suppid, ':', si.invoice_nr)
			         OR CAST(l.invoice_nr AS CHAR) = si.invoice_nr
			         OR l.ref2 = si.invoice_nr)
			   )
			 GROUP BY si.suppid, si.invoice_nr
			 ORDER BY si.suppid, si.invoice_nr`,
			asAtDate ? [Number(jobNumber), asAtDate] : [Number(jobNumber)]
		);
		return (rows || []).map((row) => ({ suppid: Number(row.suppid), invoice_nr: String(row.invoice_nr) }));
	} catch (err) {
		// A tenant without supplier invoice tables has no supplier-funded cost.
		if (err && err.code === 'ER_NO_SUCH_TABLE') return [];
		throw err;
	}
}

/**
 * The dedicated REBUILD_COST_RECOVERY mapping. Deliberately NOT resolved via
 * resolveControlAccounts: that resolver scores and auto-picks accounts, and this
 * mapping must only ever be an account the tenant chose explicitly.
 */
async function resolveCostRecoveryAccount({ queryFn, schema }) {
	const s = q(schema);
	const rows = await queryFn(
		`SELECT c.accnr, c.active AS mapping_active,
		        a.accnr AS account_accnr, a.name AS account_name, a.active AS account_active,
		        t.code AS type_code
		 FROM ${s}.gl_control_accounts c
		 LEFT JOIN ${s}.gl_accounts a ON a.accnr = c.accnr
		 LEFT JOIN ${s}.gl_account_types t ON t.id = a.type_id
		 WHERE c.control_key = ? AND c.transaction_type = 'GENERIC'
		 LIMIT 1`,
		[COST_RECOVERY_CONTROL_KEY]
	);
	const row = rows && rows[0];
	const setupHint = `Set it under Accounting → Account List → Control Accounts (${COST_RECOVERY_LABEL}) before capitalising a rebuild with labour or other cost.`;
	if (!row || Number(row.mapping_active) !== 1 || !Number(row.accnr)) {
		throw accountingError(
			`The ${COST_RECOVERY_LABEL} control account (${COST_RECOVERY_CONTROL_KEY}) is not configured. ${setupHint}`,
			'REBUILD_COST_RECOVERY_NOT_CONFIGURED'
		);
	}
	const accnr = Number(row.accnr);
	if (!row.account_accnr) {
		throw accountingError(`The ${COST_RECOVERY_LABEL} control account ${accnr} does not exist in the chart of accounts. ${setupHint}`, 'REBUILD_COST_RECOVERY_INVALID');
	}
	if (Number(row.account_active) !== 1) {
		throw accountingError(`The ${COST_RECOVERY_LABEL} control account ${accnr} is inactive. ${setupHint}`, 'REBUILD_COST_RECOVERY_INVALID');
	}
	const typeCode = String(row.type_code || '').toUpperCase();
	if (!COST_RECOVERY_ACCOUNT_TYPES.includes(typeCode)) {
		throw accountingError(
			`The ${COST_RECOVERY_LABEL} control account ${accnr} is a ${typeCode || 'untyped'} account; it must be an EXPENSE or COS account. ${setupHint}`,
			'REBUILD_COST_RECOVERY_INVALID'
		);
	}
	return accnr;
}

async function resolveAssetAccnr({ d, queryFn, schema, context, stockId, partnr, label }) {
	try {
		const accounts = await d.resolveStockGlAccounts({
			schema,
			stockId: stockId || null,
			partnr: partnr || null,
			txnType: 'PARTS',
			queryFn,
			controlAccounts: context.stockControls
		});
		const accnr = Number(accounts && accounts.assetAccnr);
		if (!accnr) throw new Error('no Inventory asset account resolved');
		return accnr;
	} catch (err) {
		const reason = context.stockControlsError && /controlAccounts are required/i.test(String(err && err.message))
			? context.stockControlsError.message
			: (err && err.message) || String(err);
		throw accountingError(`The Inventory asset account for ${label} could not be resolved: ${reason}`, 'REBUILD_STOCK_GL_UNRESOLVED', err);
	}
}

function emptySummary(source, sourceId, version) {
	return {
		source,
		sourceId,
		version,
		debitAssetAccnr: null,
		partsCost: 0,
		wipAccnr: null,
		wipBalance: 0,
		wipCredited: 0,
		partsInventoryCredited: 0,
		inventoryCredits: [],
		recoveryAccnr: null,
		recoveryCredited: 0,
		totalCapitalised: 0,
		wipUnrelieved: 0
	};
}

/**
 * Build (but never post) the capitalisation journal for one rebuild.
 *
 * @param {object} args
 * @param {Function} args.queryFn     transaction or pooled query function
 * @param {string}   args.schema
 * @param {object}   args.rebuild     { job_number, master_stock_id, parts_cost, labour_cost, other_cost, total_cost }
 * @param {number}   args.version     capitalisation version (>= 1)
 * @param {string|Date} args.trxdate  journal date (the rebuild completion date)
 * @param {string|Date} [args.asAt]   limit supplier WIP/invoices to this date (backfill)
 * @param {object}   args.context     from prepareRebuildGlContext
 * @returns {Promise<{source, sourceId, trxdate, description, lines, skipped, reason, summary}>}
 */
async function buildRebuildCapitalisationJournal({ queryFn, schema, rebuild, version, trxdate, asAt = null, context, deps }) {
	const d = withDeps(deps);
	const ctx = context || {};
	const jobNumber = Number(rebuild && rebuild.job_number);
	if (!Number.isInteger(jobNumber) || jobNumber <= 0) {
		throw accountingError('A valid rebuild job number is required for GL capitalisation.', 'REBUILD_GL_INVALID_JOB');
	}
	const journalVersion = Number(version);
	if (!Number.isInteger(journalVersion) || journalVersion <= 0) {
		throw accountingError(`Rebuild job ${jobNumber} has an invalid GL capitalisation version.`, 'REBUILD_GL_INVALID_VERSION');
	}
	const sqlDate = toSqlDate(trxdate);
	if (!sqlDate) throw accountingError(`Rebuild job ${jobNumber} has no valid completion date to capitalise on.`, 'REBUILD_GL_INVALID_DATE');

	const sourceId = capitalisationSourceId(jobNumber, journalVersion);
	const summary = emptySummary(CAPITALISATION_SOURCE, sourceId, journalVersion);
	const journal = {
		source: CAPITALISATION_SOURCE,
		sourceId,
		trxdate: sqlDate,
		description: `Rebuild job ${jobNumber} capitalised to rebuild stock (${sourceId})`,
		lines: [],
		skipped: false,
		reason: null,
		summary
	};

	const partsCost = round2(rebuild.parts_cost);
	const labourCost = round2(rebuild.labour_cost);
	const otherCost = round2(rebuild.other_cost);
	const totalCost = round2(rebuild.total_cost);
	if ([partsCost, labourCost, otherCost, totalCost].some((amount) => amount < 0)) {
		throw accountingError(`Rebuild job ${jobNumber} has a negative stored cost and cannot be capitalised.`, 'REBUILD_GL_INVALID_COST');
	}
	const recoveryAmount = round2(labourCost + otherCost);
	if (Math.abs(round2(partsCost + recoveryAmount) - totalCost) > 0.005) {
		throw accountingError(
			`Rebuild job ${jobNumber} stored total cost ${money(totalCost)} does not equal parts ${money(partsCost)} + labour ${money(labourCost)} + other ${money(otherCost)}. Correct the rebuild cost snapshot before capitalising.`,
			'REBUILD_GL_COST_SNAPSHOT_MISMATCH'
		);
	}
	summary.partsCost = partsCost;
	summary.totalCapitalised = totalCost;
	if (totalCost <= MONEY_EPSILON) {
		journal.skipped = true;
		journal.reason = 'Zero-value rebuild — nothing to capitalise.';
		summary.totalCapitalised = 0;
		return journal;
	}

	// ── Parts: reconcile the detail to the stored snapshot ───────────────────
	const parts = await loadRebuildPartCosts({ queryFn, schema, jobNumber });
	if (parts.some((part) => part.cost < -MONEY_EPSILON)) {
		throw accountingError(`Rebuild job ${jobNumber} has a part line with a negative cost and cannot be capitalised.`, 'REBUILD_GL_INVALID_COST');
	}
	const costedParts = parts.filter((part) => part.cost > MONEY_EPSILON);
	const detailTotal = round2(costedParts.reduce((sum, part) => sum + part.cost, 0));
	// Per-line cent rounding can differ from rounding the summed cost by at most
	// half a cent per line (plus the final rounding); anything beyond that is a
	// real change to the job's parts since the snapshot was taken.
	const tolerance = 0.005 * (costedParts.length + 1) + 1e-9;
	const roundingDifference = round2(partsCost - detailTotal);
	if (Math.abs(roundingDifference) > tolerance) {
		throw accountingError(
			`Rebuild job ${jobNumber} stored parts cost ${money(partsCost)} does not reconcile to its costed part lines (${money(detailTotal)}). The rebuild was not capitalised; correct the job's part costs or cost snapshot first.`,
			'REBUILD_GL_PARTS_COST_MISMATCH'
		);
	}
	if (Math.abs(roundingDifference) >= 0.005 && costedParts.length) {
		// Keep the credit equal to the stored snapshot by absorbing the rounding
		// cent into the largest existing line — never a separate balancing line.
		const largest = costedParts.reduce((best, part) => (part.cost > best.cost ? part : best), costedParts[0]);
		largest.cost = round2(largest.cost + roundingDifference);
	}

	// ── Supplier/WIP safety ──────────────────────────────────────────────────
	if (partsCost > MONEY_EPSILON) {
		const missing = await findSupplierInvoicesMissingGl({ queryFn, schema, jobNumber, asAt });
		if (missing.length) {
			const listed = missing.slice(0, 5).map((row) => `${row.invoice_nr} (supplier ${row.suppid})`).join(', ');
			const more = missing.length > 5 ? ` and ${missing.length - 5} more` : '';
			throw accountingError(
				`Rebuild job ${jobNumber} cannot be capitalised: supplier invoice ${listed}${more} allocated to this job is posted but has no creditor GL journal. Backfill or fix the supplier invoice GL first (GL Backfill → Supplier invoices), then try again.`,
				'REBUILD_SUPPLIER_INVOICE_GL_MISSING'
			);
		}
		if (ctx.wipError) {
			throw accountingError(
				`Rebuild job ${jobNumber} cannot be capitalised because the WIP control account could not be resolved: ${ctx.wipError.message || ctx.wipError}`,
				'REBUILD_GL_WIP_UNRESOLVED',
				ctx.wipError
			);
		}
	}

	let wipBalance = 0;
	const wipAccnr = ctx.wipAccnr ? Number(ctx.wipAccnr) : null;
	if (partsCost > MONEY_EPSILON && wipAccnr) {
		const wip = await d.getJobWipDebitedTotal(queryFn, String(schema), jobNumber, {
			resolveControlAccountsFn: async () => ({ WIP: wipAccnr }),
			...(asAt ? { asAt: toSqlDate(asAt) } : {})
		});
		wipBalance = round2(wip && wip.total);
	}

	let wipRemaining = wipBalance;
	let wipCredited = 0;
	const inventoryCredits = new Map();
	for (const part of costedParts) {
		if (part.cost <= MONEY_EPSILON) continue;
		const wipPortion = round2(Math.min(part.cost, Math.max(wipRemaining, 0)));
		const assetPortion = round2(part.cost - wipPortion);
		wipRemaining = round2(wipRemaining - wipPortion);
		wipCredited = round2(wipCredited + wipPortion);
		if (assetPortion > MONEY_EPSILON) {
			const accnr = await resolveAssetAccnr({
				d, queryFn, schema, context: ctx,
				stockId: part.stock_id,
				partnr: part.partnr,
				label: `part ${part.partnr || `#${part.spares_id}`}`
			});
			inventoryCredits.set(accnr, round2((inventoryCredits.get(accnr) || 0) + assetPortion));
		}
	}
	if (wipRemaining > 0.01) {
		logger.warn('Rebuild capitalisation: supplier WIP for the job exceeds its costed parts — some WIP stays unrelieved', {
			schema, jobNumber, wipBalance, wipRemaining
		});
	}

	// ── Debit: the rebuilt master item's Inventory asset ─────────────────────
	if (!rebuild.master_stock_id) {
		throw accountingError(`Rebuild job ${jobNumber} has no master stock item to capitalise into.`, 'REBUILD_GL_NO_MASTER');
	}
	const debitAssetAccnr = await resolveAssetAccnr({
		d, queryFn, schema, context: ctx,
		stockId: rebuild.master_stock_id,
		partnr: null,
		label: `rebuilt master stock item #${rebuild.master_stock_id}`
	});

	// ── Credit: labour + other cost recovery ─────────────────────────────────
	const recoveryAccnr = recoveryAmount > MONEY_EPSILON
		? await resolveCostRecoveryAccount({ queryFn, schema })
		: null;

	const refs = { job_number: jobNumber, ref1: `REBUILD ${sourceId}` };
	const lines = [{ accnr: debitAssetAccnr, debit: totalCost, credit: 0, ...refs }];
	if (wipCredited > MONEY_EPSILON) lines.push({ accnr: wipAccnr, debit: 0, credit: wipCredited, ...refs });
	for (const [accnr, amount] of inventoryCredits) {
		if (amount > MONEY_EPSILON) lines.push({ accnr, debit: 0, credit: amount, ...refs });
	}
	if (recoveryAccnr) lines.push({ accnr: recoveryAccnr, debit: 0, credit: recoveryAmount, ...refs });

	try {
		postingEngine.validateLines(lines);
	} catch (err) {
		throw accountingError(`Rebuild job ${jobNumber} capitalisation journal is invalid: ${err.message}`, 'REBUILD_GL_UNBALANCED', err);
	}

	const partsInventoryCredited = round2(Array.from(inventoryCredits.values()).reduce((sum, amount) => sum + amount, 0));
	Object.assign(summary, {
		debitAssetAccnr,
		wipAccnr: wipCredited > MONEY_EPSILON ? wipAccnr : null,
		wipBalance,
		wipCredited,
		partsInventoryCredited,
		inventoryCredits: Array.from(inventoryCredits.entries()).map(([accnr, amount]) => ({ accnr, amount })),
		recoveryAccnr,
		recoveryCredited: recoveryAccnr ? recoveryAmount : 0,
		wipUnrelieved: Math.max(0, round2(wipRemaining))
	});
	journal.lines = lines;
	return journal;
}

/**
 * Build and post the capitalisation journal inside the caller's transaction.
 * Returns { status: 'posted' | 'exists' | 'skipped', journalId, journal }.
 * Callers decide what an already-existing journal means for them.
 */
async function postRebuildCapitalisation({
	queryFn, schema, rebuild, version, trxdate, asAt = null, userId = null,
	context, postedAt = null, createdAt = null, deps
}) {
	const d = withDeps(deps);
	const journal = await buildRebuildCapitalisationJournal({ queryFn, schema, rebuild, version, trxdate, asAt, context, deps });
	if (journal.skipped) return { status: 'skipped', journalId: null, journal };

	let posted;
	try {
		posted = await d.postJournal({
			schema,
			source: journal.source,
			sourceId: journal.sourceId,
			trxdate: toJournalDate(journal.trxdate),
			description: journal.description,
			lines: journal.lines,
			userId: userId || null,
			extraRefs: { job_number: Number(rebuild.job_number) },
			...(postedAt ? { postedAt } : {}),
			...(createdAt ? { createdAt } : {}),
			queryFn
		});
	} catch (err) {
		throw describePeriodError(err, journal.trxdate, `the capitalisation of rebuild job ${rebuild.job_number}`)
			|| accountingError(
				`Rebuild job ${rebuild.job_number} could not be capitalised in the GL: ${(err && err.message) || err}`,
				(err && err.code) || 'REBUILD_GL_POST_FAILED',
				err
			);
	}
	return {
		status: posted && posted.status === 'exists' ? 'exists' : 'posted',
		journalId: posted && Number(posted.id) ? Number(posted.id) : null,
		journal
	};
}

/**
 * Reverse the live capitalisation journal of `version` with an exact mirror
 * posted through the posting engine. The original journal is never deleted.
 * Returns { reversed:false } when there is nothing live to reverse (legacy
 * stocked rebuilds, zero-value rebuilds, or an already reversed version).
 */
async function reverseRebuildCapitalisation({ queryFn, schema, jobNumber, version, trxdate, userId = null, deps }) {
	const d = withDeps(deps);
	const journalVersion = Number(version) || 0;
	if (journalVersion <= 0) return { reversed: false, reason: 'NOT_CAPITALISED', sourceId: null };
	const sourceId = capitalisationSourceId(jobNumber, journalVersion);
	const s = q(schema);

	const originals = await queryFn(
		`SELECT id, status FROM ${s}.gl_journal_headers WHERE source = ? AND source_id = ? LIMIT 1`,
		[CAPITALISATION_SOURCE, sourceId]
	);
	const original = originals && originals[0];
	if (!original || String(original.status || '').toUpperCase() !== 'POSTED') {
		return { reversed: false, reason: 'NO_LIVE_JOURNAL', sourceId };
	}
	const reversals = await queryFn(
		`SELECT id FROM ${s}.gl_journal_headers WHERE source = ? AND source_id = ? LIMIT 1`,
		[CAPITALISATION_REVERSAL_SOURCE, sourceId]
	);
	if (reversals && reversals[0]) {
		return {
			reversed: false,
			reason: 'ALREADY_REVERSED',
			sourceId,
			journalId: Number(original.id),
			reversalJournalId: Number(reversals[0].id)
		};
	}

	const sqlDate = toSqlDate(trxdate);
	let posted;
	try {
		posted = await d.postReversalJournal({
			schema,
			source: CAPITALISATION_SOURCE,
			sourceId,
			reversalSource: CAPITALISATION_REVERSAL_SOURCE,
			reversalSourceId: sourceId,
			description: `Reversal of rebuild job ${Number(jobNumber)} capitalisation (${sourceId}) — job reopened`,
			userId: userId || null,
			trxdate: toJournalDate(sqlDate),
			queryFn
		});
	} catch (err) {
		throw describePeriodError(err, sqlDate, `the reversal of rebuild job ${jobNumber}'s stock capitalisation`)
			|| accountingError(
				`The stock capitalisation of rebuild job ${jobNumber} could not be reversed: ${(err && err.message) || err}`,
				(err && err.code) || 'REBUILD_GL_REVERSAL_FAILED',
				err
			);
	}
	return {
		reversed: true,
		sourceId,
		reversalSource: CAPITALISATION_REVERSAL_SOURCE,
		journalId: Number(original.id),
		reversalJournalId: posted && Number(posted.id) ? Number(posted.id) : null,
		trxdate: sqlDate
	};
}

/** Flat audit fields for the STOCKED event. */
function buildCapitalisationAuditValues({ status, journalId, journal }) {
	const summary = (journal && journal.summary) || {};
	return {
		capitalisation_source: CAPITALISATION_SOURCE,
		capitalisation_source_id: summary.sourceId || (journal && journal.sourceId) || null,
		capitalisation_version: summary.version || null,
		capitalisation_status: status ? String(status).toUpperCase() : null,
		capitalisation_journal_id: journalId || null,
		capitalisation_trxdate: journal ? journal.trxdate : null,
		capitalisation_debit_asset_accnr: summary.debitAssetAccnr || null,
		capitalisation_parts_cost: round2(summary.partsCost),
		capitalisation_wip_accnr: summary.wipAccnr || null,
		capitalisation_wip_credited: round2(summary.wipCredited),
		capitalisation_parts_inventory_credited: round2(summary.partsInventoryCredited),
		capitalisation_inventory_credits: summary.inventoryCredits || [],
		capitalisation_recovery_accnr: summary.recoveryAccnr || null,
		capitalisation_recovery_credited: round2(summary.recoveryCredited),
		capitalisation_total: round2(summary.totalCapitalised)
	};
}

module.exports = {
	CAPITALISATION_SOURCE,
	CAPITALISATION_REVERSAL_SOURCE,
	COST_RECOVERY_CONTROL_KEY,
	COST_RECOVERY_LABEL,
	COST_RECOVERY_ACCOUNT_TYPES,
	capitalisationSourceId,
	toSqlDate,
	toJournalDate,
	prepareRebuildGlContext,
	ensurePeriodBeforeTransaction,
	loadRebuildPartCosts,
	findSupplierInvoicesMissingGl,
	resolveCostRecoveryAccount,
	buildRebuildCapitalisationJournal,
	postRebuildCapitalisation,
	reverseRebuildCapitalisation,
	buildCapitalisationAuditValues
};
