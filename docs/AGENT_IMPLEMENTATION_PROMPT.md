# AGENT IMPLEMENTATION PROMPT: Autoneer Migration PWA Refactoring

## OBJECTIVE
Refactor the Autoneer Migration PWA to separate concerns between **schema discovery**, **persistent mapping profiles**, **session-specific migration plans**, and **execution** to reduce complexity, improve testability, and enable on-the-fly error correction during runs.

## CONSTRAINTS & REQUIREMENTS

### Hard Constraints
1. **No breaking changes to existing database** - Keep migration_runs, migration_table_runs, migration_row_errors tables
2. **Backward compatibility for old mappings** - Convert old format on load
3. **Production data safety** - All schema changes via migrations, never DROP existing tables
4. **Session isolation** - Multiple users can have independent sessions without interference
5. **Zero-loss tolerance** - Data integrity checks must pass before run completion

### Soft Constraints
1. Maintain similar UI/UX flow (5-step process)
2. Keep existing features (profiles, dry-run, checksums)
3. Preserve logging/audit trail
4. Support existing deployment (Node.js + Express)

### Must-Haves for Phase 1 (Foundation)
- [ ] New data models (Schema, Mapping, Plan, Run, FieldMap)
- [ ] Validators for all models
- [ ] Schema caching mechanism
- [ ] API endpoints (RESTful)
- [ ] Pre-run validation step

### Nice-to-Haves for Phase 1
- [ ] Dry-run simulation
- [ ] Field-level type compatibility warnings
- [ ] Migration history UI

---

## DETAILED TASK BREAKDOWN

### TASK 1: Create Core Data Models (migrate/models/)

#### 1.1 Schema.js
**Purpose:** Represent database schemas (Firebird + MySQL)

```javascript
// migrate/models/Schema.js

/**
 * In-memory representation of Firebird and MySQL schemas
 * Cached after first discovery for performance
 * 
 * Structure:
 * Schema.firebird.tables['CUSTOMER'] = {
 *   name: 'CUSTOMER',
 *   columns: {
 *     'CID': { name: 'CID', type: 'INTEGER', nullable: false, ... },
 *     'NAME': { name: 'NAME', type: 'VARCHAR', length: 255, ... }
 *   },
 *   primaryKey: ['CID'],
 *   uniqueIndexes: [...]
 * }
 */

class Schema {
  constructor() {
    this.firebird = { tables: {}, lastUpdated: null };
    this.mysql = { tables: {}, lastUpdated: null };
  }

  /**
   * Discover Firebird schema by querying RDB$RELATIONS
   * @param {Object} firebirdConfig
   * @returns {Promise<void>}
   */
  async discoverFirebird(firebirdConfig) {
    // Query: SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE ...
    // For each table: SELECT RDB$FIELD_NAME, RDB$FIELD_TYPE FROM RDB$RELATION_FIELDS
    // Store normalized column metadata
  }

  /**
   * Discover MySQL schema from information_schema
   * @param {Object} mysqlConfig
   * @param {string} schemaName
   * @returns {Promise<void>}
   */
  async discoverMySQL(mysqlConfig, schemaName) {
    // Query: SELECT TABLE_NAME FROM TABLES WHERE TABLE_SCHEMA = ?
    // For each table: SELECT COLUMN_NAME, DATA_TYPE, ... FROM COLUMNS
    // Store with nullability, defaults, keys
  }

  /**
   * Check if schema has been cached recently
   * @param {number} maxAgeMs - Max cache age in milliseconds
   * @returns {boolean}
   */
  isCached(maxAgeMs = 300000) {
    // Return false if either DB > maxAge
  }

  /**
   * Serialize to disk cache
   * @param {string} filepath
   */
  async saveCache(filepath) {
    // Write JSON
  }

  /**
   * Load from disk cache
   * @param {string} filepath
   */
  async loadCache(filepath) {
    // Read JSON, validate timestamps
  }

  /**
   * Get table metadata
   * @param {'firebird'|'mysql'} db
   * @param {string} tableName
   * @returns {Object|null}
   */
  getTable(db, tableName) {
    return this[db]?.tables?.[tableName.toUpperCase()] || null;
  }

  /**
   * Get column metadata
   * @param {'firebird'|'mysql'} db
   * @param {string} tableName
   * @param {string} columnName
   * @returns {Object|null}
   */
  getColumn(db, tableName, columnName) {
    const table = this.getTable(db, tableName);
    return table?.columns?.[columnName.toUpperCase()] || null;
  }

  /**
   * Check if table exists
   */
  tableExists(db, tableName) {
    return this.getTable(db, tableName) !== null;
  }

  /**
   * Get all table names
   */
  getTableNames(db) {
    return Object.keys(this[db]?.tables || {});
  }
}

module.exports = Schema;
```

**Required Methods:**
- `discoverFirebird(config)` - Query Firebird RDB$ tables
- `discoverMySQL(config, schemaName)` - Query MySQL information_schema
- `isCached(maxAgeMs)` - Check cache age
- `saveCache(filepath)` - Persist to disk
- `loadCache(filepath)` - Load from disk
- `getTable(db, name)` - Get table metadata
- `getColumn(db, table, col)` - Get column metadata
- `tableExists(db, name)` - Bool check
- `getTableNames(db)` - List all tables

**Acceptance Criteria:**
- [ ] Discovers all tables from both databases
- [ ] Caches metadata with timestamp
- [ ] Handles case-insensitive lookups
- [ ] Includes column type, nullability, constraints
- [ ] Has 100% unit test coverage

---

#### 1.2 FieldMap.js
**Purpose:** Individual column transformation definition

```javascript
// migrate/models/FieldMap.js

class FieldMap {
  /**
   * @param {string} sourceColumn - Source column name
   * @param {string} targetColumn - Target column name
   * @param {string} [transform] - Transform function name ('trim', 'toNumber', etc)
   * @param {*} [defaultValue] - Value if source is null
   * @param {Object} [lookup] - { table: 'ID_MAP', sourceId: 'src_id', targetId: 'tgt_id' }
   */
  constructor(sourceColumn, targetColumn, { transform = null, defaultValue = null, lookup = null } = {}) {
    this.sourceColumn = sourceColumn.toUpperCase();
    this.targetColumn = targetColumn.toUpperCase();
    this.transform = transform;
    this.defaultValue = defaultValue;
    this.lookup = lookup;
  }

  /**
   * Validate this field map against schema
   * @param {Object} sourceColumnMetadata - From Schema.getColumn('firebird', ...)
   * @param {Object} targetColumnMetadata - From Schema.getColumn('mysql', ...)
   * @returns {Object} - { valid: bool, warnings: string[], errors: string[] }
   */
  validate(sourceColumnMetadata, targetColumnMetadata) {
    const warnings = [];
    const errors = [];

    // Check type compatibility
    const typeCheck = this.checkTypeCompatibility(
      sourceColumnMetadata?.type,
      targetColumnMetadata?.type
    );
    if (!typeCheck.safe && typeCheck.risk === 'high') {
      errors.push(`Type mismatch: ${sourceColumnMetadata?.type} → ${targetColumnMetadata?.type}`);
    } else if (!typeCheck.safe) {
      warnings.push(`Potential data loss: ${sourceColumnMetadata?.type} → ${targetColumnMetadata?.type}`);
    }

    // Check nullability
    if (targetColumnMetadata?.nullable === false && !this.defaultValue && !this.transform) {
      warnings.push(`Target column ${this.targetColumn} is NOT NULL but no default or transform provided`);
    }

    // Check transform validity
    if (this.transform && !this.isValidTransform(this.transform)) {
      errors.push(`Unknown transform: ${this.transform}`);
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors
    };
  }

  /**
   * Check if transform can safely convert sourceType to targetType
   * @returns {{ safe: bool, risk: 'none'|'low'|'medium'|'high', message: string }}
   */
  checkTypeCompatibility(sourceType, targetType) {
    // See transforms.js for type mapping
  }

  /**
   * Check if a transform function exists and is valid
   * @returns {bool}
   */
  isValidTransform(name) {
    const valid = ['trim', 'toNumber', 'toDate', 'toDateTime', 'toBoolean', 'toDecimal', 'zeroDateToNull'];
    return valid.includes(name);
  }

  /**
   * Convert to JSON for storage
   */
  toJSON() {
    return {
      sourceColumn: this.sourceColumn,
      targetColumn: this.targetColumn,
      transform: this.transform,
      defaultValue: this.defaultValue,
      lookup: this.lookup
    };
  }

  static fromJSON(obj) {
    return new FieldMap(obj.sourceColumn, obj.targetColumn, {
      transform: obj.transform,
      defaultValue: obj.defaultValue,
      lookup: obj.lookup
    });
  }
}

module.exports = FieldMap;
```

**Acceptance Criteria:**
- [ ] Validates against Schema metadata
- [ ] Type compatibility checks
- [ ] Nullability warnings
- [ ] Transform function validation
- [ ] 100% unit test coverage

---

#### 1.3 Mapping.js
**Purpose:** Persistent mapping profile (reusable across runs)

```javascript
// migrate/models/Mapping.js
const FieldMap = require('./FieldMap');

class Mapping {
  /**
   * @param {string} id - UUID
   * @param {string} name - Human-readable name
   * @param {Object} tableConfigs - { SOURCE_TABLE: { targetTable, columns: { SOURCE_COL: FieldMap } } }
   * @param {Date} [createdAt]
   * @param {Date} [updatedAt]
   */
  constructor(id, name, tableConfigs = {}, createdAt = null, updatedAt = null) {
    this.id = id;
    this.name = name;
    this.tables = tableConfigs; // { SOURCE: { targetTable, columns: {...} } }
    this.createdAt = createdAt || new Date();
    this.updatedAt = updatedAt || new Date();
  }

  /**
   * Add a table to the mapping
   * @param {string} sourceTable
   * @param {string} targetTable
   * @param {Map<string, FieldMap>} fieldMaps
   */
  addTable(sourceTable, targetTable, fieldMaps = new Map()) {
    this.tables[sourceTable.toUpperCase()] = {
      targetTable: targetTable.toUpperCase(),
      columns: Object.fromEntries(
        Array.from(fieldMaps.entries()).map(([src, field]) => [src.toUpperCase(), field])
      )
    };
    this.updatedAt = new Date();
  }

  /**
   * Get target table for source table
   * @returns {string|null}
   */
  getTargetTable(sourceTable) {
    return this.tables[sourceTable.toUpperCase()]?.targetTable || null;
  }

  /**
   * Get all FieldMaps for a source table
   * @returns {Map<string, FieldMap>|null}
   */
  getFieldMaps(sourceTable) {
    const config = this.tables[sourceTable.toUpperCase()];
    if (!config) return null;
    
    const map = new Map();
    for (const [src, field] of Object.entries(config.columns || {})) {
      map.set(src, FieldMap.fromJSON(field));
    }
    return map;
  }

  /**
   * Validate entire mapping against schema
   * @param {Schema} schema
   * @returns {{ valid: bool, issues: { table, warnings: [], errors: [] }[] }}
   */
  validate(schema) {
    const issues = [];

    for (const [sourceTable, config] of Object.entries(this.tables)) {
      const tableIssue = { table: sourceTable, warnings: [], errors: [] };

      // Check source table exists
      if (!schema.tableExists('firebird', sourceTable)) {
        tableIssue.errors.push(`Source table not found in Firebird: ${sourceTable}`);
        issues.push(tableIssue);
        continue;
      }

      // Check target table exists
      if (!schema.tableExists('mysql', config.targetTable)) {
        tableIssue.errors.push(`Target table not found in MySQL: ${config.targetTable}`);
        issues.push(tableIssue);
        continue;
      }

      // Validate each field
      for (const [srcCol, fieldJSON] of Object.entries(config.columns)) {
        const field = FieldMap.fromJSON(fieldJSON);
        const srcMeta = schema.getColumn('firebird', sourceTable, srcCol);
        const tgtMeta = schema.getColumn('mysql', config.targetTable, field.targetColumn);

        const fieldValidation = field.validate(srcMeta, tgtMeta);
        tableIssue.warnings.push(...fieldValidation.warnings);
        tableIssue.errors.push(...fieldValidation.errors);
      }

      if (tableIssue.warnings.length || tableIssue.errors.length) {
        issues.push(tableIssue);
      }
    }

    return {
      valid: issues.every(issue => issue.errors.length === 0),
      issues
    };
  }

  /**
   * Serialize to JSON for storage
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      tables: Object.fromEntries(
        Object.entries(this.tables).map(([src, config]) => [
          src,
          {
            targetTable: config.targetTable,
            columns: config.columns // Already in JSON format from FieldMap
          }
        ])
      )
    };
  }

  static fromJSON(obj) {
    return new Mapping(
      obj.id,
      obj.name,
      obj.tables,
      new Date(obj.createdAt),
      new Date(obj.updatedAt)
    );
  }
}

module.exports = Mapping;
```

**Acceptance Criteria:**
- [ ] Stores & loads from JSON
- [ ] Validates against Schema
- [ ] Supports multiple source→target mappings
- [ ] Includes field-level transformations
- [ ] 100% unit test coverage
- [ ] Can be saved/loaded from DB

---

#### 1.4 Plan.js
**Purpose:** Session-specific migration plan (uses Mapping + adds run config)

```javascript
// migrate/models/Plan.js

class Plan {
  /**
   * @param {string} mappingId - Reference to Mapping
   * @param {string} mappingName - For display
   * @param {Object} tableConfigs - { TABLE: { mode, keyStrategy, dedupeKeys, cleanBefore } }
   * @param {Date} [createdAt]
   */
  constructor(mappingId, mappingName, tableConfigs = {}, createdAt = null) {
    this.mappingId = mappingId;
    this.mappingName = mappingName;
    this.tables = tableConfigs; // Per-table migration config
    this.createdAt = createdAt || new Date();
    this.isValidated = false;
    this.validationErrors = [];
    this.validationWarnings = [];
  }

  /**
   * Add a table to the migration plan
   * @param {string} tableName - MySQL target table name
   * @param {Object} config - { mode, keyStrategy, dedupeKeys: [], cleanBefore }
   */
  addTable(tableName, config) {
    this.tables[tableName.toUpperCase()] = {
      mode: config.mode || 'INSERT',          // INSERT, UPSERT, TRUNCATE+INSERT
      keyStrategy: config.keyStrategy || 'preserve',  // preserve, rekey
      dedupeKeys: config.dedupeKeys || [],
      onDuplicate: config.onDuplicate || 'SKIP',  // SKIP, ERROR
      cleanBefore: config.cleanBefore || false
    };
  }

  /**
   * Get all included table names
   * @returns {string[]}
   */
  getIncludedTables() {
    return Object.keys(this.tables);
  }

  /**
   * Get config for a specific table
   * @returns {Object|null}
   */
  getTableConfig(tableName) {
    return this.tables[tableName.toUpperCase()] || null;
  }

  /**
   * Mark plan as validated
   * @param {Array} errors
   * @param {Array} warnings
   */
  recordValidation(errors = [], warnings = []) {
    this.isValidated = true;
    this.validationErrors = errors;
    this.validationWarnings = warnings;
  }

  /**
   * Check if plan is ready to execute
   * @returns {bool}
   */
  isReady() {
    return this.isValidated && this.validationErrors.length === 0;
  }

  /**
   * Serialize for storage
   */
  toJSON() {
    return {
      mappingId: this.mappingId,
      mappingName: this.mappingName,
      createdAt: this.createdAt.toISOString(),
      tables: this.tables,
      isValidated: this.isValidated,
      validationErrors: this.validationErrors,
      validationWarnings: this.validationWarnings
    };
  }

  static fromJSON(obj) {
    const plan = new Plan(obj.mappingId, obj.mappingName, obj.tables, new Date(obj.createdAt));
    plan.isValidated = obj.isValidated;
    plan.validationErrors = obj.validationErrors;
    plan.validationWarnings = obj.validationWarnings;
    return plan;
  }
}

module.exports = Plan;
```

**Acceptance Criteria:**
- [ ] Stores mapping reference (not copy)
- [ ] Per-table mode/strategy config
- [ ] Validation tracking
- [ ] 100% unit test coverage

---

#### 1.5 Run.js
**Purpose:** Execution state of a migration (result tracking)

```javascript
// migrate/models/Run.js

class Run {
  /**
   * @param {integer} id - Database run ID
   * @param {Plan} plan - Migration plan being executed
   * @param {Object} options - { dryRun, batchSize, fkChecks }
   */
  constructor(id, plan, options = {}) {
    this.id = id;
    this.plan = plan;
    this.dryRun = options.dryRun || false;
    this.batchSize = options.batchSize || 500;
    this.fkChecks = options.fkChecks || true;
    
    // Status tracking
    this.status = 'RUNNING'; // RUNNING, SUCCESS, FAILED, ABORTED
    this.startedAt = new Date();
    this.finishedAt = null;
    this.currentTable = null;
    this.lastError = null;
    
    // Per-table results
    this.tableResults = new Map(); // { TABLE: { status, inserted, updated, skipped, errors, ... } }
    
    // Totals
    this.totals = {
      migrated: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    };
  }

  /**
   * Record successful table completion
   * @param {string} tableName
   * @param {Object} stats - { inserted, updated, skipped, errors, cleaned }
   */
  recordTableSuccess(tableName, stats) {
    this.tableResults.set(tableName, {
      table: tableName,
      status: 'SUCCESS',
      ...stats,
      finishedAt: new Date()
    });
    
    this.totals.inserted += stats.inserted || 0;
    this.totals.updated += stats.updated || 0;
    this.totals.skipped += stats.skipped || 0;
    this.totals.migrated += (stats.inserted || 0) + (stats.updated || 0);
  }

  /**
   * Record table failure
   * @param {string} tableName
   * @param {string} errorMessage
   * @param {string} [hint]
   */
  recordTableFailure(tableName, errorMessage, hint = null) {
    this.tableResults.set(tableName, {
      table: tableName,
      status: 'FAILED',
      errorMessage,
      hint,
      finishedAt: new Date()
    });
    
    this.currentTable = tableName;
    this.lastError = { message: errorMessage, hint };
    this.status = 'FAILED';
  }

  /**
   * Record table as skipped (user choice)
   * @param {string} tableName
   * @param {string} [reason]
   */
  recordTableSkipped(tableName, reason = null) {
    this.tableResults.set(tableName, {
      table: tableName,
      status: 'SKIPPED',
      reason,
      finishedAt: new Date()
    });
  }

  /**
   * Mark run as complete
   * @param {'SUCCESS'|'FAILED'|'ABORTED'} status
   */
  finish(status = 'SUCCESS') {
    this.status = status;
    this.finishedAt = new Date();
  }

  /**
   * Get progress as percentage
   * @returns {number} 0-100
   */
  getProgress() {
    const total = this.plan.getIncludedTables().length;
    if (!total) return 0;
    
    const completed = Array.from(this.tableResults.values()).filter(
      r => ['SUCCESS', 'FAILED', 'SKIPPED'].includes(r.status)
    ).length;
    
    return Math.round((completed / total) * 100);
  }

  /**
   * Serialize for API response
   */
  toJSON() {
    return {
      id: this.id,
      status: this.status,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt?.toISOString() || null,
      dryRun: this.dryRun,
      progress: this.getProgress(),
      tableResults: Array.from(this.tableResults.values()),
      totals: this.totals,
      currentTable: this.currentTable,
      lastError: this.lastError
    };
  }
}

module.exports = Run;
```

**Acceptance Criteria:**
- [ ] Tracks per-table status
- [ ] Accumulates totals
- [ ] Progress calculation
- [ ] 100% unit test coverage

---

### TASK 2: Create Validators (migrate/validators/)

#### 2.1 SchemaValidator.js
**Purpose:** Validate schema compatibility

```javascript
// migrate/validators/SchemaValidator.js

class SchemaValidator {
  /**
   * Validate that a table exists in both databases
   * @param {Schema} schema
   * @param {string} sourceTable - Firebird table
   * @param {string} targetTable - MySQL table
   * @returns {{ compatible: bool, errors: string[], warnings: string[] }}
   */
  static validateTablePair(schema, sourceTable, targetTable) {
    const errors = [];
    const warnings = [];

    if (!schema.tableExists('firebird', sourceTable)) {
      errors.push(`Source table not found in Firebird: ${sourceTable}`);
    }

    if (!schema.tableExists('mysql', targetTable)) {
      errors.push(`Target table not found in MySQL: ${targetTable}`);
    }

    return {
      compatible: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate that all mapped columns exist
   * @param {Schema} schema
   * @param {string} sourceTable
   * @param {string} targetTable
   * @param {Map<string, FieldMap>} fieldMaps
   * @returns {{ compatible: bool, missing: { source: [], target: [] }, errors: [] }}
   */
  static validateFieldMapping(schema, sourceTable, targetTable, fieldMaps) {
    const missingSource = [];
    const missingTarget = [];
    const errors = [];

    for (const [srcCol, field] of fieldMaps) {
      if (!schema.getColumn('firebird', sourceTable, srcCol)) {
        missingSource.push(srcCol);
      }

      if (!schema.getColumn('mysql', targetTable, field.targetColumn)) {
        missingTarget.push(field.targetColumn);
      }
    }

    return {
      compatible: missingSource.length === 0 && missingTarget.length === 0,
      missing: { source: missingSource, target: missingTarget },
      errors: [
        ...missingSource.map(c => `Column not found in Firebird.${sourceTable}: ${c}`),
        ...missingTarget.map(c => `Column not found in MySQL.${targetTable}: ${c}`)
      ]
    };
  }

  /**
   * Validate primary key compatibility
   * @param {Schema} schema
   * @param {string} sourceTable
   * @param {string} targetTable
   * @returns {{ compatible: bool, message: string }}
   */
  static validatePrimaryKey(schema, sourceTable, targetTable) {
    const srcTable = schema.getTable('firebird', sourceTable);
    const tgtTable = schema.getTable('mysql', targetTable);

    // Both should have primary keys, or neither
    const srcHasPK = srcTable?.primaryKey?.length > 0;
    const tgtHasPK = tgtTable?.primaryKey?.length > 0;

    if (srcHasPK !== tgtHasPK) {
      return {
        compatible: false,
        message: `Primary key mismatch: Firebird ${srcHasPK ? 'has' : 'missing'} PK, MySQL ${tgtHasPK ? 'has' : 'missing'} PK`
      };
    }

    return { compatible: true, message: 'Primary keys compatible' };
  }
}

module.exports = SchemaValidator;
```

**Acceptance Criteria:**
- [ ] Checks table existence
- [ ] Validates field mappings
- [ ] Primary key compatibility
- [ ] 100% unit test coverage

---

#### 2.2 MappingValidator.js
**Purpose:** Validate mapping configuration

```javascript
// migrate/validators/MappingValidator.js
const SchemaValidator = require('./SchemaValidator');

class MappingValidator {
  /**
   * Full validation of a mapping against schema
   * @param {Mapping} mapping
   * @param {Schema} schema
   * @returns {{ valid: bool, errors: { table: string, issues: string[] }[], warnings: [] }}
   */
  static validateMapping(mapping, schema) {
    const errors = [];
    const warnings = [];

    for (const [sourceTable, config] of Object.entries(mapping.tables)) {
      const tableErrors = [];

      // Check table pair
      const tablePair = SchemaValidator.validateTablePair(schema, sourceTable, config.targetTable);
      tableErrors.push(...tablePair.errors);

      if (!tablePair.compatible) {
        errors.push({ table: sourceTable, issues: tableErrors });
        continue;
      }

      // Check fields
      const fieldMaps = mapping.getFieldMaps(sourceTable);
      if (!fieldMaps || fieldMaps.size === 0) {
        tableErrors.push(`No column mappings defined for ${sourceTable}`);
        errors.push({ table: sourceTable, issues: tableErrors });
        continue;
      }

      const fieldCheck = SchemaValidator.validateFieldMapping(
        schema,
        sourceTable,
        config.targetTable,
        fieldMaps
      );
      tableErrors.push(...fieldCheck.errors);

      if (!fieldCheck.compatible) {
        errors.push({ table: sourceTable, issues: tableErrors });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Check if a mapping is complete (all source columns mapped)
   * @param {Mapping} mapping
   * @param {Schema} schema
   * @returns {{ complete: bool, unmapped: { table: string, columns: string[] }[] }}
   */
  static checkCompleteness(mapping, schema) {
    const unmapped = [];

    for (const [sourceTable, config] of Object.entries(mapping.tables)) {
      const srcTableMeta = schema.getTable('firebird', sourceTable);
      if (!srcTableMeta) continue;

      const mappedCols = new Set(mapping.getFieldMaps(sourceTable)?.keys() || []);
      const unmappedCols = Object.keys(srcTableMeta.columns || {})
        .filter(col => !mappedCols.has(col));

      if (unmappedCols.length > 0) {
        unmapped.push({
          table: sourceTable,
          columns: unmappedCols
        });
      }
    }

    return {
      complete: unmapped.length === 0,
      unmapped
    };
  }
}

module.exports = MappingValidator;
```

---

#### 2.3 PlanValidator.js
**Purpose:** Validate plan before execution

```javascript
// migrate/validators/PlanValidator.js
const SchemaValidator = require('./SchemaValidator');

class PlanValidator {
  /**
   * Full pre-run validation
   * @param {Plan} plan
   * @param {Mapping} mapping
   * @param {Schema} schema
   * @returns {Promise<{ valid: bool, blockers: [], warnings: [] }>}
   */
  static async validate(plan, mapping, schema) {
    const blockers = [];
    const warnings = [];

    // Validate each table in plan
    for (const tableName of plan.getIncludedTables()) {
      const tableConfig = plan.getTableConfig(tableName);
      const sourceTable = mapping.tables[Object.keys(mapping.tables).find(
        key => mapping.tables[key].targetTable.toUpperCase() === tableName.toUpperCase()
      )];

      if (!sourceTable) {
        blockers.push(`No mapping found for target table: ${tableName}`);
        continue;
      }

      // Check table exists
      const tableCheck = SchemaValidator.validateTablePair(
        schema,
        sourceTable,
        tableName
      );

      if (!tableCheck.compatible) {
        blockers.push(...tableCheck.errors);
        continue;
      }

      // Check fields exist
      const fieldMaps = mapping.getFieldMaps(sourceTable);
      const fieldCheck = SchemaValidator.validateFieldMapping(schema, sourceTable, tableName, fieldMaps);

      if (!fieldCheck.compatible) {
        blockers.push(...fieldCheck.errors);
      }

      // Validate mode/strategy combo
      const modeCheck = this.validateModeConfig(tableConfig);
      if (!modeCheck.valid) {
        blockers.push(...modeCheck.errors);
      }

      // Validate dedupe keys if present
      if (tableConfig.dedupeKeys?.length) {
        const dedupeCheck = this.validateDedupeKeys(
          schema,
          tableName,
          tableConfig.dedupeKeys,
          fieldMaps
        );

        if (!dedupeCheck.valid) {
          blockers.push(...dedupeCheck.errors);
        } else {
          warnings.push(...dedupeCheck.warnings);
        }
      }
    }

    return {
      valid: blockers.length === 0,
      blockers,
      warnings,
      canProceed: blockers.length === 0
    };
  }

  /**
   * Validate mode + keyStrategy combination
   */
  static validateModeConfig(tableConfig) {
    const errors = [];

    if (tableConfig.mode === 'UPSERT' && tableConfig.keyStrategy === 'rekey') {
      if (!tableConfig.dedupeKeys || tableConfig.dedupeKeys.length === 0) {
        errors.push(
          `UPSERT with re-key IDs requires dedupe keys to identify existing rows`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate dedupe key configuration
   */
  static validateDedupeKeys(schema, tableName, dedupeKeys, fieldMaps) {
    const errors = [];
    const warnings = [];

    // Check each dedupe key exists in target table
    const tgtTable = schema.getTable('mysql', tableName);
    if (!tgtTable) return { valid: false, errors: [`Table not found: ${tableName}`], warnings };

    for (const dedupeKey of dedupeKeys) {
      if (!tgtTable.columns[dedupeKey.toUpperCase()]) {
        errors.push(`Dedupe key not found in ${tableName}: ${dedupeKey}`);
      }

      // Check if mapped from source
      const isMapped = Array.from(fieldMaps?.values() || []).some(
        f => f.targetColumn.toUpperCase() === dedupeKey.toUpperCase()
      );

      if (!isMapped) {
        warnings.push(`Dedupe key ${dedupeKey} is not mapped from source columns`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Check if row 1 can be migrated (dry-run)
   * @param {any} firstRow - First row from source
   * @param {Mapping} mapping
   * @param {string} sourceTable
   * @returns {Promise<{ migratable: bool, issues: string[] }>}
   */
  static async dryRun(firstRow, mapping, sourceTable) {
    const issues = [];

    const fieldMaps = mapping.getFieldMaps(sourceTable);
    if (!fieldMaps) return { migratable: false, issues: ['No field mapping found'] };

    for (const [srcCol, field] of fieldMaps) {
      const srcValue = firstRow[srcCol.toLowerCase()];

      // Check if null/undefined and no default
      if ((srcValue === null || srcValue === undefined) && !field.defaultValue) {
        issues.push(`Source column ${srcCol} is null and no default provided`);
      }

      // Try transform
      if (field.transform && srcValue !== null) {
        try {
          const transformed = this.applyTransform(field.transform, srcValue);
          if (transformed === null && !field.defaultValue) {
            issues.push(`Transform ${field.transform} on ${srcCol} returned null, no default`);
          }
        } catch (err) {
          issues.push(`Transform ${field.transform} failed on ${srcCol}: ${err.message}`);
        }
      }
    }

    return {
      migratable: issues.length === 0,
      issues
    };
  }

  static applyTransform(name, value) {
    // Import from transforms.js
    const transforms = require('../mappers/transforms');
    return transforms[name]?.(value) || value;
  }
}

module.exports = PlanValidator;
```

**Acceptance Criteria:**
- [ ] Validates mode/strategy combinations
- [ ] Checks dedupe key validity
- [ ] Dry-run simulation on first row
- [ ] 100% unit test coverage

---

### TASK 3: Create Executors (migrate/executors/)

#### 3.1 PreflightExecutor.js
**Purpose:** Pre-run connectivity and schema checks

```javascript
// migrate/executors/PreflightExecutor.js
const PlanValidator = require('../validators/PlanValidator');

class PreflightExecutor {
  /**
   * @param {Object} firebirdConfig
   * @param {Object} mysqlConfig
   * @param {string} schemaName
   * @param {Object} logger
   */
  constructor(firebirdConfig, mysqlConfig, schemaName, logger) {
    this.firebirdConfig = firebirdConfig;
    this.mysqlConfig = mysqlConfig;
    this.schemaName = schemaName;
    this.logger = logger;
  }

  /**
   * Run all preflight checks
   * @param {Plan} plan
   * @param {Mapping} mapping
   * @param {Schema} schema
   * @returns {Promise<{ pass: bool, errors: [], warnings: [] }>}
   */
  async execute(plan, mapping, schema) {
    const errors = [];
    const warnings = [];

    this.logger?.log({ level: 'info', phase: 'preflight', action: 'start' });

    try {
      // 1. Validate connectivity
      await this.checkConnectivity();
      this.logger?.log({ level: 'info', phase: 'preflight', action: 'connectivity', status: 'pass' });
    } catch (err) {
      errors.push(`Connectivity failed: ${err.message}`);
      return { pass: false, errors, warnings };
    }

    try {
      // 2. Validate plan against mapping + schema
      const planValidation = await PlanValidator.validate(plan, mapping, schema);
      if (!planValidation.canProceed) {
        errors.push(...planValidation.blockers);
      }
      warnings.push(...planValidation.warnings);

      if (!planValidation.canProceed) {
        return { pass: false, errors, warnings };
      }

      this.logger?.log({ level: 'info', phase: 'preflight', action: 'schema_validation', status: 'pass' });
    } catch (err) {
      errors.push(`Schema validation failed: ${err.message}`);
      return { pass: false, errors, warnings };
    }

    // 3. Check foreign key state
    try {
      await this.checkForeignKeyState();
      this.logger?.log({ level: 'info', phase: 'preflight', action: 'fk_check', status: 'pass' });
    } catch (err) {
      warnings.push(`Foreign key check warning: ${err.message}`);
    }

    return {
      pass: errors.length === 0,
      errors,
      warnings
    };
  }

  async checkConnectivity() {
    // Ping both databases
  }

  async checkForeignKeyState() {
    // Get @@foreign_key_checks status
  }
}

module.exports = PreflightExecutor;
```

---

#### 3.2 TableExecutor.js
**Purpose:** Execute migration for a single table

```javascript
// migrate/executors/TableExecutor.js

class TableExecutor {
  /**
   * @param {Object} tableConfig - From Plan
   * @param {string} sourceTable - Firebird table
   * @param {string} targetTable - MySQL table
   * @param {Mapping} mapping
   * @param {Schema} schema
   * @param {Object} connections - { firebird, mysql }
   * @param {Object} logger
   */
  constructor(tableConfig, sourceTable, targetTable, mapping, schema, connections, logger) {
    this.tableConfig = tableConfig;
    this.sourceTable = sourceTable;
    this.targetTable = targetTable;
    this.mapping = mapping;
    this.schema = schema;
    this.connections = connections;
    this.logger = logger;
  }

  /**
   * Execute migration for this table
   * @param {Object} options - { batchSize, dryRun }
   * @returns {Promise<{ inserted: number, updated: number, skipped: number, errors: number }>}
   */
  async execute(options = {}) {
    const { batchSize = 500, dryRun = false } = options;

    this.logger?.log({
      level: 'info',
      phase: 'table_start',
      table: this.targetTable,
      mode: this.tableConfig.mode,
      strategy: this.tableConfig.keyStrategy
    });

    try {
      // 1. Pre-check
      await this.preCheck();

      // 2. Clean if needed
      if (this.tableConfig.cleanBefore && !dryRun) {
        await this.clean();
      }

      // 3. Migrate in batches
      const stats = await this.migrateInBatches(batchSize, dryRun);

      // 4. Post-validation
      await this.postValidate(stats);

      this.logger?.log({
        level: 'info',
        phase: 'table_end',
        table: this.targetTable,
        ...stats
      });

      return stats;
    } catch (err) {
      this.logger?.log({
        level: 'error',
        phase: 'table_error',
        table: this.targetTable,
        error: err.message
      });
      throw err;
    }
  }

  async preCheck() {
    // Verify table/columns exist
  }

  async clean() {
    // DELETE FROM targetTable
  }

  async migrateInBatches(batchSize, dryRun) {
    // Fetch from Firebird in batches
    // Transform rows
    // Insert/Update in MySQL
    // Return stats
  }

  async postValidate(stats) {
    // Checksums
    // Row counts
  }
}

module.exports = TableExecutor;
```

---

### TASK 4: Create API Routes (routes/)

#### 4.1 schema.js
```javascript
// routes/schema.js

router.get('/api/schemas', async (req, res) => {
  // Return cached schema or trigger discovery
});

router.post('/api/schemas/refresh', async (req, res) => {
  // Force re-discovery from both databases
});

router.get('/api/schemas/firebird', async (req, res) => {
  // Return just Firebird schema
});

router.get('/api/schemas/mysql', async (req, res) => {
  // Return just MySQL schema
});
```

#### 4.2 mapping.js
```javascript
// routes/mapping.js

router.get('/api/mappings', async (req, res) => {
  // List all mapping profiles from DB
});

router.post('/api/mappings', async (req, res) => {
  // Create new mapping profile
});

router.get('/api/mappings/:id', async (req, res) => {
  // Get one mapping with full details
});

router.put('/api/mappings/:id', async (req, res) => {
  // Update mapping
});

router.post('/api/mappings/:id/validate', async (req, res) => {
  // Validate mapping against current schemas
});

router.delete('/api/mappings/:id', async (req, res) => {
  // Delete mapping profile
});
```

#### 4.3 plan.js
```javascript
// routes/plan.js

router.post('/api/plans', async (req, res) => {
  // Create plan from mapping + table selections
  const { mappingId, selectedTables, tableConfigs } = req.body;
  // Returns: { planId, validation: { blockers, warnings } }
});

router.post('/api/plans/:id/validate', async (req, res) => {
  // Run PlanValidator on existing plan
});

router.post('/api/plans/:id/dry-run', async (req, res) => {
  // Simulate migration of first row per table
});
```

#### 4.4 run.js
```javascript
// routes/run.js

router.post('/api/runs', async (req, res) => {
  // Start migration from plan
  const { planId, dryRun, batchSize } = req.body;
  // Returns: { runId }
});

router.get('/api/runs/:id', async (req, res) => {
  // Get run status + progress
});

router.get('/api/runs/:id/events', async (req, res) => {
  // Server-sent events for progress updates
});

router.post('/api/runs/:id/abort', async (req, res) => {
  // Cancel running migration
});
```

---

### TASK 5: Database Schema Changes

```sql
-- Add migration_plans table
CREATE TABLE IF NOT EXISTS migration_plans (
  plan_id INT AUTO_INCREMENT PRIMARY KEY,
  mapping_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  plan_json LONGTEXT NOT NULL,
  INDEX idx_mapping (mapping_id)
);

-- Modify migration_runs to link to plan
ALTER TABLE migration_runs
ADD COLUMN plan_id INT,
ADD FOREIGN KEY (plan_id) REFERENCES migration_plans(plan_id);

-- Add migration_schemas table for caching
CREATE TABLE IF NOT EXISTS migration_schemas (
  schema_id INT AUTO_INCREMENT PRIMARY KEY,
  db_name VARCHAR(50),  -- 'firebird' or 'mysql'
  schema_json LONGTEXT,
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_db (db_name)
);
```

---

## ACCEPTANCE CRITERIA FOR COMPLETION

### All Models (Task 1)
- [ ] Schema.js: Discover, cache, query metadata
- [ ] FieldMap.js: Validate field mappings
- [ ] Mapping.js: Persist & validate mapping profiles
- [ ] Plan.js: Session-specific migration config
- [ ] Run.js: Execution tracking

### All Validators (Task 2)
- [ ] SchemaValidator: Table & field existence
- [ ] MappingValidator: Mapping completeness
- [ ] PlanValidator: Pre-run validation + dry-run

### All Executors (Task 3)
- [ ] PreflightExecutor: Connectivity & schema checks
- [ ] TableExecutor: Single-table migration
- [ ] TransactionExecutor: ACID guarantees

### All API Routes (Task 4)
- [ ] Schema endpoints: Discover & cache
- [ ] Mapping endpoints: CRUD
- [ ] Plan endpoints: Create, validate, dry-run
- [ ] Run endpoints: Start, monitor, abort

### Database (Task 5)
- [ ] migration_plans table created
- [ ] migration_runs linked to plan
- [ ] migration_schemas cache table

### Testing
- [ ] 90%+ code coverage
- [ ] All models testable without DB
- [ ] Validators have unit tests
- [ ] Integration tests for executors

---

## SUCCESS METRICS

After Phase 1 completion, your PWA will have:

1. **Separation of Concerns**
   - Schema → Mapping → Plan → Run (clear dependency chain)
   - No mixing of persistent (Mapping) with ephemeral (Plan) data

2. **Better Error Handling**
   - Schema mismatches caught pre-run
   - User can fix or skip issues on the fly
   - Clear error messages with remediation suggestions

3. **Reusable Mappings**
   - One Mapping used across many Plans
   - Plans are lightweight, session-specific

4. **Cleaner Code**
   - runner.js split into focused executors
   - Validators for each layer
   - Better testability

5. **Future-Proof**
   - Easy to add: webhooks, scheduled runs, batch scheduling
   - Easy to extend: new transform functions, validators
   - Easy to monitor: structured events, audit trail

