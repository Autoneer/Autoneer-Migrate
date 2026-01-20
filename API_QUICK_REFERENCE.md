# API Quick Reference Guide

Quick reference for all Phase 2 API endpoints. For detailed documentation, see [REFACTORING_README.md](REFACTORING_README.md).

## Base URL

```
http://localhost:3000
```

---

## 📋 Schema API

### Get All Schemas
```bash
GET /api/schemas
```
Returns cached Firebird and MySQL schemas.

### Refresh Schemas
```bash
POST /api/schemas/refresh
```
Forces re-discovery of database schemas.

### Get Firebird Schema Only
```bash
GET /api/schemas/firebird
```

### Get MySQL Schema Only
```bash
GET /api/schemas/mysql
```

### Get Specific Table
```bash
GET /api/schemas/table/:db/:tableName
# Example: GET /api/schemas/table/mysql/customers
```

---

## 🗂️ Mapping API

### List All Mappings
```bash
GET /api/mappings
```

### Create Mapping
```bash
POST /api/mappings
Content-Type: application/json

{
  "name": "My Mapping",
  "tables": {
    "SOURCE_TABLE": {
      "target": "target_table",
      "columns": {
        "SOURCE_COL": {
          "target": "target_col",
          "transform": "trim",
          "defaultValue": ""
        }
      }
    }
  }
}
```

### Get Mapping
```bash
GET /api/mappings/:id
```

### Update Mapping
```bash
PUT /api/mappings/:id
Content-Type: application/json

{
  "name": "Updated Name",
  "tables": { ... }
}
```

### Delete Mapping
```bash
DELETE /api/mappings/:id
```

### Validate Mapping
```bash
POST /api/mappings/:id/validate
```
Returns validation results and quality analysis.

### Convert Legacy Mapping
```bash
POST /api/mappings/convert-legacy
Content-Type: application/json

{
  "legacyMapping": { ... },
  "name": "Converted Mapping",
  "save": true
}
```

---

## 📊 Plan API

### List All Plans
```bash
GET /api/plans
```

### Create Plan
```bash
POST /api/plans
Content-Type: application/json

{
  "mappingId": "uuid-here",
  "name": "My Plan"
}
```

### Get Plan
```bash
GET /api/plans/:id
```

### Update Plan
```bash
PUT /api/plans/:id
Content-Type: application/json

{
  "name": "Updated Plan",
  "tables": {
    "table_name": {
      "mode": "UPSERT",
      "keyStrategy": "rekey",
      "dedupeKeys": ["email"],
      "onDuplicate": "UPDATE"
    }
  }
}
```

### Delete Plan
```bash
DELETE /api/plans/:id
```

### Validate Plan
```bash
POST /api/plans/:id/validate
```
Performs full pre-run validation.

### Dry Run
```bash
POST /api/plans/:id/dry-run
Content-Type: application/json

{
  "tableName": "customers"
}
```
Simulates migration on first row of data.

---

## 🏃 Run API

### List All Runs
```bash
GET /api/runs?limit=50&status=COMPLETED&planId=5
```
Query params: `limit`, `status`, `planId`

### Get Run Details
```bash
GET /api/runs/:runId
```
Returns complete run information including all tables.

### Get Run Progress
```bash
GET /api/runs/:runId/progress
```
Returns real-time progress percentage and estimated time remaining.

### Get Run Tables
```bash
GET /api/runs/:runId/tables
```
Returns table-level results for the run.

### Get Run Summary
```bash
GET /api/runs/:runId/summary
```
Returns aggregated statistics for the run.

### Delete Run
```bash
DELETE /api/runs/:runId
```
Cannot delete active runs.

---

## 🔧 Response Format

All API responses follow this format:

### Success Response
```json
{
  "success": true,
  "message": "Operation completed",
  "data": { ... }
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error message here"
}
```

---

## 📝 Common Fields

### Mapping Modes
- `INSERT` - Insert new rows only
- `UPSERT` - Insert or update existing rows

### Key Strategies
- `keep` - Preserve source primary keys
- `rekey` - Generate new primary keys

### On Duplicate Options
- `SKIP` - Skip duplicate rows
- `UPDATE` - Update existing rows

---

## 🔍 Example Workflows

### Create and Execute Migration

```bash
# 1. Refresh schemas
curl -X POST http://localhost:3000/api/schemas/refresh

# 2. Create mapping
MAPPING_ID=$(curl -X POST http://localhost:3000/api/mappings \
  -H "Content-Type: application/json" \
  -d '{"name":"My Mapping","tables":{...}}' \
  | jq -r '.mapping.id')

# 3. Validate mapping
curl -X POST http://localhost:3000/api/mappings/$MAPPING_ID/validate

# 4. Create plan
PLAN_ID=$(curl -X POST http://localhost:3000/api/plans \
  -H "Content-Type: application/json" \
  -d "{\"mappingId\":\"$MAPPING_ID\",\"name\":\"My Plan\"}" \
  | jq -r '.plan.id')

# 5. Update plan configuration
curl -X PUT http://localhost:3000/api/plans/$PLAN_ID \
  -H "Content-Type: application/json" \
  -d '{"tables":{"customers":{"mode":"UPSERT","dedupeKeys":["email"]}}}'

# 6. Validate plan
curl -X POST http://localhost:3000/api/plans/$PLAN_ID/validate

# 7. Dry run
curl -X POST http://localhost:3000/api/plans/$PLAN_ID/dry-run \
  -H "Content-Type: application/json" \
  -d '{"tableName":"customers"}'

# 8. Execute via UI, then track progress
curl http://localhost:3000/api/runs/20250120_140530/progress
```

### Monitor Active Run

```bash
# Check progress every 5 seconds
while true; do
  curl -s http://localhost:3000/api/runs/20250120_140530/progress | jq '.progress'
  sleep 5
done
```

---

## 🛠️ Testing

Run the automated test suite:

```bash
node scripts/test_phase2_api.js
```

Test individual endpoints:

```bash
# Schema
curl http://localhost:3000/api/schemas

# Mappings
curl http://localhost:3000/api/mappings

# Plans
curl http://localhost:3000/api/plans

# Runs
curl http://localhost:3000/api/runs?limit=10
```

---

## 📚 Additional Resources

- **Full Documentation**: [REFACTORING_README.md](REFACTORING_README.md)
- **Phase 2 Details**: [PHASE_2_COMPLETE.md](PHASE_2_COMPLETE.md)
- **Quick Start**: [QUICK_START_REFACTORING.md](QUICK_START_REFACTORING.md)
- **Complete Summary**: [COMPLETE_REFACTORING_SUMMARY.md](COMPLETE_REFACTORING_SUMMARY.md)

---

## 🚨 Important Notes

1. **Authentication**: Currently no authentication required (add for production)
2. **Rate Limiting**: No rate limits implemented yet
3. **CORS**: Configure for production if needed
4. **Validation**: Always validate before execution
5. **Dry Run**: Use dry-run to test before actual migration

---

## 💡 Tips

- Use `jq` for parsing JSON responses in bash
- Set `BASE_URL` environment variable for scripts
- Always check schema freshness before creating mappings
- Validate plans after any configuration changes
- Monitor run progress via `/api/runs/:runId/progress` endpoint
- Use dry-run to verify transformations before full execution

---

**Last Updated**: January 20, 2026  
**API Version**: Phase 2  
**Total Endpoints**: 28
