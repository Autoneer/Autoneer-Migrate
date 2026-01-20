const express = require('express');
const Schema = require('../migrate/models/Schema');
const { state } = require('../config/state');
const path = require('path');

const router = express.Router();

// In-memory schema cache (could be moved to a service)
let cachedSchema = null;
const CACHE_PATH = path.join(__dirname, '../../data/schema_cache.json');

/**
 * GET /api/schemas/cached
 * Get cached schema if available
 */
router.get('/api/schemas/cached', async (req, res) => {
	try {
		const { maxAge = 3600000 } = req.query; // Default 1 hour

		// Try to load from cache if exists
		if (!cachedSchema) {
			cachedSchema = new Schema();
			await cachedSchema.loadCache(CACHE_PATH);
		}

		// Check if cache is fresh
		if (!cachedSchema.isCached(parseInt(maxAge, 10))) {
			return res.json({
				cached: false,
				lastUpdated: {
					firebird: cachedSchema.firebird.lastUpdated,
					mysql: cachedSchema.mysql.lastUpdated
				},
				message: 'Schema cache is stale. Use POST /api/schemas/discover to update.'
			});
		}

		res.json({
			cached: true,
			lastUpdated: {
				firebird: cachedSchema.firebird.lastUpdated,
				mysql: cachedSchema.mysql.lastUpdated
			},
			schema: cachedSchema.toJSON()
		});
	} catch (err) {
		res.status(500).json({
			cached: false,
			error: 'Failed to retrieve cached schemas',
			message: err.message
		});
	}
});

/**
 * POST /api/schemas/discover
 * Discover schemas from both databases
 */
router.post('/api/schemas/discover', async (req, res) => {
	try {
		console.log('[SchemaRoute] Starting schema discovery...');

		// Validate database configuration
		if (!state.firebird.database) {
			console.error('[SchemaRoute] Firebird database not configured');
			return res.status(400).json({
				success: false,
				error: 'Firebird database not configured',
				message: 'Please configure Firebird connection in Setup first'
			});
		}
		if (!state.schemaName) {
			console.error('[SchemaRoute] MySQL schema not configured');
			return res.status(400).json({
				success: false,
				error: 'MySQL schema not configured',
				message: 'Please configure MySQL schema name in Setup first'
			});
		}

		console.log('[SchemaRoute] Configuration validated:', {
			firebird: state.firebird.database,
			mysql: state.schemaName
		});

		const schema = new Schema();
		await schema.discover(state.firebird, state.mysql, state.schemaName);
		await schema.saveCache(CACHE_PATH);

		cachedSchema = schema;

		const firebirdTableCount = Object.keys(schema.firebird.tables).length;
		const mysqlTableCount = Object.keys(schema.mysql.tables).length;

		console.log(`[SchemaRoute] Discovery complete - Firebird: ${firebirdTableCount} tables, MySQL: ${mysqlTableCount} tables`);

		res.json({
			success: true,
			lastUpdated: {
				firebird: schema.firebird.lastUpdated,
				mysql: schema.mysql.lastUpdated
			},
			schema: schema.toJSON(),
			message: `Schema discovery complete - Found ${firebirdTableCount} Firebird and ${mysqlTableCount} MySQL tables`
		});
	} catch (err) {
		console.error('[SchemaRoute] Schema discovery error:', err);
		res.status(500).json({
			success: false,
			error: 'Failed to discover schemas',
			message: err.message,
			stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
		});
	}
});

/**
 * GET /api/schemas
 * Get current cached schema or discover if not cached
 */
router.get('/api/schemas', async (req, res) => {
	try {
		// Try to load from cache if exists
		if (!cachedSchema) {
			cachedSchema = new Schema();
			await cachedSchema.loadCache(CACHE_PATH);
		}

		// If cache is stale or empty, rediscover
		if (!cachedSchema.isCached(3600000)) { // 1 hour cache
			return res.json({
				cached: false,
				lastUpdated: {
					firebird: cachedSchema.firebird.lastUpdated,
					mysql: cachedSchema.mysql.lastUpdated
				},
				message: 'Schema cache is stale. Use POST /api/schemas/refresh to update.'
			});
		}

		res.json({
			cached: true,
			lastUpdated: {
				firebird: cachedSchema.firebird.lastUpdated,
				mysql: cachedSchema.mysql.lastUpdated
			},
			schema: cachedSchema.toJSON()
		});
	} catch (err) {
		res.status(500).json({
			error: 'Failed to retrieve schemas',
			message: err.message
		});
	}
});

/**
 * POST /api/schemas/refresh
 * Force re-discovery of both database schemas
 */
router.post('/api/schemas/refresh', async (req, res) => {
	try {
		cachedSchema = new Schema();

		// Discover Firebird schema
		await cachedSchema.discoverFirebird(state.firebird);

		// Discover MySQL schema
		await cachedSchema.discoverMySQL(state.mysql, state.schemaName);

		// Save to disk cache
		await cachedSchema.saveCache(CACHE_PATH);

		res.json({
			success: true,
			message: 'Schemas refreshed successfully',
			lastUpdated: {
				firebird: cachedSchema.firebird.lastUpdated,
				mysql: cachedSchema.mysql.lastUpdated
			},
			tables: {
				firebird: cachedSchema.getTableNames('firebird').length,
				mysql: cachedSchema.getTableNames('mysql').length
			}
		});
	} catch (err) {
		res.status(500).json({
			error: 'Failed to refresh schemas',
			message: err.message
		});
	}
});

/**
 * GET /api/schemas/firebird
 * Get just the Firebird schema
 */
router.get('/api/schemas/firebird', async (req, res) => {
	try {
		if (!cachedSchema) {
			cachedSchema = new Schema();
			await cachedSchema.loadCache(CACHE_PATH);
		}

		res.json({
			tables: cachedSchema.firebird.tables,
			tableNames: cachedSchema.getTableNames('firebird'),
			lastUpdated: cachedSchema.firebird.lastUpdated
		});
	} catch (err) {
		res.status(500).json({
			error: 'Failed to retrieve Firebird schema',
			message: err.message
		});
	}
});

/**
 * GET /api/schemas/mysql
 * Get just the MySQL schema
 */
router.get('/api/schemas/mysql', async (req, res) => {
	try {
		if (!cachedSchema) {
			cachedSchema = new Schema();
			await cachedSchema.loadCache(CACHE_PATH);
		}

		res.json({
			tables: cachedSchema.mysql.tables,
			tableNames: cachedSchema.getTableNames('mysql'),
			lastUpdated: cachedSchema.mysql.lastUpdated
		});
	} catch (err) {
		res.status(500).json({
			error: 'Failed to retrieve MySQL schema',
			message: err.message
		});
	}
});

/**
 * GET /api/schemas/table/:db/:tableName
 * Get metadata for a specific table
 */
router.get('/api/schemas/table/:db/:tableName', async (req, res) => {
	try {
		const { db, tableName } = req.params;

		if (!['firebird', 'mysql'].includes(db)) {
			return res.status(400).json({
				error: 'Invalid database type',
				message: 'Database must be "firebird" or "mysql"'
			});
		}

		if (!cachedSchema) {
			cachedSchema = new Schema();
			await cachedSchema.loadCache(CACHE_PATH);
		}

		const table = cachedSchema.getTable(db, tableName);

		if (!table) {
			return res.status(404).json({
				error: 'Table not found',
				message: `Table ${tableName} not found in ${db}`
			});
		}

		res.json(table);
	} catch (err) {
		res.status(500).json({
			error: 'Failed to retrieve table metadata',
			message: err.message
		});
	}
});

//  * GET /api/schemas/firebird/diagnostic
//  * Diagnostic endpoint to see what's in the Firebird database
//  
router.get('/api/schemas/firebird/diagnostic', async (req, res) => {
	try {
		if (!state.firebird.database) {
			return res.status(400).json({
				error: 'Firebird database not configured',
				message: 'Please configure Firebird connection in Setup first'
			});
		}

		const firebird = require('../db/firebird');
		const db = await firebird.attach(state.firebird);

		const query = (sql, params = []) => {
			return new Promise((resolve, reject) => {
				db.query(sql, params, (err, result) => {
					if (err) return reject(err);
					resolve(result);
				});
			});
		};

		try {
			// Get ALL relations
			const allRelationsQuery = `
				SELECT 
					TRIM(RDB$RELATION_NAME) AS TABLE_NAME,
					RDB$SYSTEM_FLAG,
					CASE WHEN RDB$VIEW_BLR IS NULL THEN 'TABLE' ELSE 'VIEW' END AS RELATION_TYPE
				FROM RDB$RELATIONS
				ORDER BY RDB$RELATION_NAME
			`;

			const allRelations = await query(allRelationsQuery);

			// Get user tables only
			const userTablesQuery = `
				SELECT TRIM(RDB$RELATION_NAME) AS TABLE_NAME
				FROM RDB$RELATIONS
				WHERE RDB$SYSTEM_FLAG = 0
				AND RDB$VIEW_BLR IS NULL
				ORDER BY RDB$RELATION_NAME
			`;

			const userTables = await query(userTablesQuery);

			// Get user views
			const userViewsQuery = `
				SELECT TRIM(RDB$RELATION_NAME) AS VIEW_NAME
				FROM RDB$RELATIONS
				WHERE RDB$SYSTEM_FLAG = 0
				AND RDB$VIEW_BLR IS NOT NULL
				ORDER BY RDB$RELATION_NAME
			`;

			const userViews = await query(userViewsQuery);

			res.json({
				success: true,
				connection: {
					host: state.firebird.host,
					port: state.firebird.port,
					database: state.firebird.database,
					user: state.firebird.user
				},
				statistics: {
					totalRelations: allRelations.length,
					userTables: userTables.length,
					userViews: userViews.length,
					systemObjects: allRelations.length - userTables.length - userViews.length
				},
				userTables: userTables.map(t => t?.TABLE_NAME ?? t?.table_name ?? t?.RDB$RELATION_NAME ?? t?.rdb$relation_name).filter(Boolean),
				userViews: userViews.map(v => v?.VIEW_NAME ?? v?.view_name ?? v?.RDB$RELATION_NAME ?? v?.rdb$relation_name).filter(Boolean),
				sampleRelations: allRelations.slice(0, 10).map(r => ({
					name: r?.TABLE_NAME ?? r?.table_name ?? r?.RDB$RELATION_NAME ?? r?.rdb$relation_name,
					systemFlag: r?.RDB$SYSTEM_FLAG ?? r?.rdb$system_flag,
					relationType: r?.RELATION_TYPE ?? r?.relation_type
				}))
			});
		} finally {
			db.detach();
		}
	} catch (err) {
		console.error('[Diagnostic] Firebird diagnostic error:', err);
		res.status(500).json({
			success: false,
			error: 'Failed to run diagnostic',
			message: err.message,
			stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
		});
	}
});

/**
 * Export the cached schema for use by other modules
 */
function getCachedSchema() {
	return cachedSchema;
}

module.exports = router;
module.exports.getCachedSchema = getCachedSchema;
