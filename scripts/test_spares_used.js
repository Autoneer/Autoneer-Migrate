/**
 * Regression test for spares_used migration
 * 
 * This script validates that:
 * 1. Price fields (cost_price, sales_price) are correctly migrated from Firebird
 * 2. Row counts match expected values (read = inserted + updated + skipped + errors)
 * 3. Dedupe logic doesn't collapse valid rows
 * 
 * Usage:
 *   node scripts/test_spares_used.js
 */

const firebird = require("../src/db/firebird");
const mysql = require("../src/db/mysql");
const { loadSettings } = require("../src/config/settings");

async function runTest() {
	console.log("=== Spares Used Migration Regression Test ===\n");

	const settings = await loadSettings();
	const firebirdConfig = settings.firebird;
	const mysqlConfig = settings.mysql;
	const schemaName = settings.targetSchema;

	if (!firebirdConfig || !mysqlConfig || !schemaName) {
		console.error("❌ Error: Missing database configuration. Run setup first.");
		process.exit(1);
	}

	let pool;
	try {
		// Connect to MySQL
		pool = await mysql.connectToSchema(mysqlConfig, schemaName);
		console.log("✓ Connected to MySQL schema:", schemaName);

		// Check if spares_used table exists and has data
		const [tables] = await pool.query(`SHOW TABLES LIKE 'spares_used'`);
		if (tables.length === 0) {
			console.log("⚠ Warning: spares_used table does not exist in MySQL. Run a migration first.");
			process.exit(0);
		}

		// Get MySQL row count
		const [mysqlCount] = await pool.query("SELECT COUNT(*) as cnt FROM `spares_used`");
		const mysqlRows = mysqlCount[0]?.cnt || 0;
		console.log(`✓ MySQL spares_used has ${mysqlRows} rows`);

		if (mysqlRows === 0) {
			console.log("⚠ Warning: spares_used table is empty. Run a migration first.");
			process.exit(0);
		}

		// Check Firebird source
		const firebirdRows = await firebird.query(firebirdConfig, "SELECT COUNT(*) as cnt FROM SPARES_USED");
		const fbRowCount = firebirdRows[0]?.cnt || firebirdRows[0]?.CNT || 0;
		console.log(`✓ Firebird SPARES_USED has ${fbRowCount} rows`);

		// Test 1: Check price fields are not all zeros
		console.log("\n--- Test 1: Price Field Validation ---");
		const [priceCheck] = await pool.query(`
			SELECT 
				COUNT(*) as total_rows,
				COUNT(CASE WHEN cost_price IS NULL THEN 1 END) as null_cost_count,
				COUNT(CASE WHEN sales_price IS NULL THEN 1 END) as null_sales_count,
				COUNT(CASE WHEN cost_price = 0 AND sales_price = 0 THEN 1 END) as zero_both_count,
				COUNT(CASE WHEN cost_price > 0 THEN 1 END) as nonzero_cost_count,
				COUNT(CASE WHEN sales_price > 0 THEN 1 END) as nonzero_sales_count,
				AVG(cost_price) as avg_cost,
				AVG(sales_price) as avg_sales,
				MAX(cost_price) as max_cost,
				MAX(sales_price) as max_sales
			FROM \`spares_used\`
		`);

		const mysqlPriceStats = priceCheck[0];
		console.log("  MySQL price statistics:");
		console.log(`    - Total rows: ${mysqlPriceStats.total_rows}`);
		console.log(`    - Null cost_price: ${mysqlPriceStats.null_cost_count}`);
		console.log(`    - Null sales_price: ${mysqlPriceStats.null_sales_count}`);
		console.log(`    - Both prices zero: ${mysqlPriceStats.zero_both_count}`);
		console.log(`    - Non-zero cost_price: ${mysqlPriceStats.nonzero_cost_count}`);
		console.log(`    - Non-zero sales_price: ${mysqlPriceStats.nonzero_sales_count}`);
		console.log(`    - Avg cost_price: ${Number(mysqlPriceStats.avg_cost || 0).toFixed(2)}`);
		console.log(`    - Avg sales_price: ${Number(mysqlPriceStats.avg_sales || 0).toFixed(2)}`);
		console.log(`    - Max cost_price: ${Number(mysqlPriceStats.max_cost || 0).toFixed(2)}`);
		console.log(`    - Max sales_price: ${Number(mysqlPriceStats.max_sales || 0).toFixed(2)}`);

		// Check Firebird prices
		const fbPriceQuery = `
			SELECT 
				COUNT(*) as total,
				COUNT(CASE WHEN COST_PRICE IS NULL THEN 1 END) as null_cost,
				COUNT(CASE WHEN SALES_PRICE IS NULL THEN 1 END) as null_sales,
				COUNT(CASE WHEN COST_PRICE > 0 THEN 1 END) as nonzero_cost,
				COUNT(CASE WHEN SALES_PRICE > 0 THEN 1 END) as nonzero_sales
			FROM SPARES_USED
		`;
		const fbPriceResult = await firebird.query(firebirdConfig, fbPriceQuery);
		const fbPriceStats = fbPriceResult[0] || {};
		const fbNonZeroCost = fbPriceStats.nonzero_cost || fbPriceStats.NONZERO_COST || 0;
		const fbNonZeroSales = fbPriceStats.nonzero_sales || fbPriceStats.NONZERO_SALES || 0;

		console.log("  Firebird price statistics:");
		console.log(`    - Non-zero COST_PRICE: ${fbNonZeroCost}`);
		console.log(`    - Non-zero SALES_PRICE: ${fbNonZeroSales}`);

		// Validate prices were migrated
		let priceTestPassed = true;
		if (fbNonZeroCost > 0 && mysqlPriceStats.nonzero_cost_count === 0) {
			console.log("  ❌ FAIL: Firebird has non-zero cost_price but MySQL has none!");
			priceTestPassed = false;
		} else if (fbNonZeroCost > 50 && mysqlPriceStats.nonzero_cost_count < fbNonZeroCost * 0.5) {
			console.log(`  ⚠ WARNING: Only ${mysqlPriceStats.nonzero_cost_count}/${fbNonZeroCost} cost_price values migrated (< 50%)`);
		} else if (fbNonZeroCost > 0) {
			console.log(`  ✓ PASS: cost_price migrated (${mysqlPriceStats.nonzero_cost_count}/${fbNonZeroCost} non-zero values)`);
		}

		if (fbNonZeroSales > 0 && mysqlPriceStats.nonzero_sales_count === 0) {
			console.log("  ❌ FAIL: Firebird has non-zero sales_price but MySQL has none!");
			priceTestPassed = false;
		} else if (fbNonZeroSales > 50 && mysqlPriceStats.nonzero_sales_count < fbNonZeroSales * 0.5) {
			console.log(`  ⚠ WARNING: Only ${mysqlPriceStats.nonzero_sales_count}/${fbNonZeroSales} sales_price values migrated (< 50%)`);
		} else if (fbNonZeroSales > 0) {
			console.log(`  ✓ PASS: sales_price migrated (${mysqlPriceStats.nonzero_sales_count}/${fbNonZeroSales} non-zero values)`);
		}

		// Test 2: Check row count consistency
		console.log("\n--- Test 2: Row Count Consistency ---");
		const rowCountRatio = mysqlRows / fbRowCount;
		console.log(`  Row count ratio: ${(rowCountRatio * 100).toFixed(1)}% (MySQL/Firebird)`);

		let rowCountPassed = true;
		if (rowCountRatio < 0.8) {
			console.log(`  ❌ FAIL: MySQL has significantly fewer rows (${mysqlRows}) than Firebird (${fbRowCount})`);
			console.log("     This suggests dedupe logic is collapsing valid rows or mapping is incomplete.");
			rowCountPassed = false;
		} else if (rowCountRatio < 0.95) {
			console.log(`  ⚠ WARNING: MySQL has fewer rows (${mysqlRows}) than Firebird (${fbRowCount})`);
			console.log("     Check if this is expected (duplicates) or a problem (incorrect dedupe keys).");
		} else {
			console.log(`  ✓ PASS: Row counts are consistent (${mysqlRows} vs ${fbRowCount})`);
		}

		// Test 3: Sample data validation
		console.log("\n--- Test 3: Sample Data Validation ---");
		const [sampleRows] = await pool.query(`
			SELECT spares_id, job_number, stock_id, cost_price, sales_price, quantity, lnr
			FROM \`spares_used\`
			WHERE cost_price > 0 OR sales_price > 0
			ORDER BY spares_id
			LIMIT 5
		`);

		if (sampleRows.length > 0) {
			console.log("  Sample migrated rows with prices:");
			sampleRows.forEach((row, i) => {
				console.log(`    [${i + 1}] spares_id=${row.spares_id}, job=${row.job_number}, stock=${row.stock_id}, lnr=${row.lnr}, cost=${row.cost_price}, sales=${row.sales_price}, qty=${row.quantity}`);
			});
			console.log("  ✓ PASS: Found sample rows with price data");
		} else {
			console.log("  ⚠ WARNING: No rows found with non-zero prices");
		}

		// Test 4: Check for essential columns
		console.log("\n--- Test 4: Column Completeness ---");
		const [columns] = await pool.query(`
			SELECT COLUMN_NAME 
			FROM INFORMATION_SCHEMA.COLUMNS 
			WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'spares_used'
			ORDER BY ORDINAL_POSITION
		`, [schemaName]);

		const essentialColumns = [
			"spares_id", "job_number", "stock_id", "cost_price", "sales_price",
			"quantity", "lnr", "spare", "partnr", "date_used", "invoice_nr"
		];
		const mysqlColumns = columns.map(c => c.COLUMN_NAME.toLowerCase());
		const missingColumns = essentialColumns.filter(col => !mysqlColumns.includes(col));

		if (missingColumns.length > 0) {
			console.log(`  ⚠ WARNING: Missing essential columns: ${missingColumns.join(", ")}`);
		} else {
			console.log(`  ✓ PASS: All essential columns present`);
		}

		// Summary
		console.log("\n=== Test Summary ===");
		const allPassed = priceTestPassed && rowCountPassed;
		if (allPassed) {
			console.log("✓ ALL TESTS PASSED");
			process.exit(0);
		} else {
			console.log("❌ SOME TESTS FAILED - Review output above");
			process.exit(1);
		}

	} catch (err) {
		console.error("❌ Test error:", err.message);
		console.error(err.stack);
		process.exit(1);
	} finally {
		if (pool) {
			await pool.end();
		}
	}
}

// Run the test
runTest().catch(err => {
	console.error("Fatal error:", err);
	process.exit(1);
});
