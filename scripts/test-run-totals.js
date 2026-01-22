const Run = require('../src/migrate/models/Run');

const plan = { getIncludedTables: () => ['A', 'B', 'C'] };
const run = new Run('test', plan);

run.recordTableSuccess('A', { inserted: 5, updated: 0, skipped: 0, errors: 0, durationMs: 100 });
run.recordTableSuccess('B', { inserted: 10, updated: 2, skipped: 0, errors: 0, durationMs: 200 });
run.recordTableSuccess('C', { inserted: 0, updated: 0, skipped: 0, errors: 0, durationMs: 50 });

console.log('totals:', run.totals);
console.log('tableResults:', run.tableResults);
console.log('progress:', run.getProgress());
