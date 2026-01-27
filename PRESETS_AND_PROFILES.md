# Presets and Profiles

This document describes the preset JSON format and usage in the Autoneer-Migrate wizard.

## Preset JSON schema (canonical)

{
  "version": 1,
  "code": "STOCK",
  "name": "Select Stock",
  "description": "Standard stock + pricing migration",
  "tablePairs": [
    { "sourceTable": "STOCK", "targetTable": "stock" },
    { "sourceTable": "PRICING", "targetTable": "labour_pricing" }
  ],
  "forcedFieldMappings": [
    {
      "sourceTable": "STOCK",
      "targetTable": "stock",
      "overrides": [
        { "sourceField": "LOCATION", "targetField": "location" },
        { "sourceField": "WIPSTATUS", "targetField": "wip_status" }
      ]
    }
  ],
  "options": {
    "replaceExistingMappings": true,
    "skipMissingTables": true
  }
}

- `tablePairs`: array of table mappings to apply if both source and target tables exist.
- `forcedFieldMappings`: optional, per-source-table list of source→target field overrides. These override auto-mapping.
- `options.skipMissingTables`: skip silently if a table is missing in the discovered schema.
- `options.replaceExistingMappings`: indicates preset should replace existing mappings (UI will confirm).

## Admin UI

- Visit `/admin/presets` to manage presets (create/edit/deactivate) using raw JSON.
- Server validates the shape; errors are returned as 400 with details.

## APIs

- `GET /api/presets` — list active presets
- `GET /api/presets/:id` — get full preset
- `POST /api/presets` — create preset (admin)
- `PUT /api/presets/:id` — update preset (admin)
- `DELETE /api/presets/:id` — soft-delete (admin)

- `GET /api/profiles` — list saved profiles
- `GET /api/profiles/:id` — get profile
- `POST /api/profiles` — save mapping_json as profile
- `POST /api/profiles/from-preset/:presetId` — server generates mapping from preset and saves profile

## Notes

- System presets are seeded on app startup from `src/migrate/default_presets.json`.
- Preset application respects the discovered schema; missing tables are skipped if configured.
- Forced field mappings win over auto-map.
- Profiles are saved in `migration_profiles.mapping_json` and can be loaded back into the wizard.
