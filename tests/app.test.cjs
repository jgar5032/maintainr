const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('../vendor/sql.js/sql-wasm.js');
const path = require('node:path');
let SQL, domain, GarageRepository, ConflictError, migrate;
before(async () => {
  SQL = await initSqlJs({ locateFile: file => path.join(__dirname, '../vendor/sql.js', file) });
  domain = await import('../src/domain.mjs');
  ({ GarageRepository, ConflictError } = await import('../src/database.mjs'));
  ({ migrate } = await import('../src/schema.mjs'));
});
class MemoryFile {
  saved = null;
  fail = false;
  async open() {}
  async read() { return structuredClone(this.saved); }
  async commit(bytes, revision) {
    if (this.fail) throw new Error('Storage full');
    if ((this.saved?.revision || 0) !== revision) throw new ConflictError();
    this.saved = { bytes: bytes.slice(), revision: revision + 1 };
    return revision + 1;
  }
}
const vehicle = id => ({ id, make: 'Honda', model: 'Civic', year: 2020, mileage: 12345 });
const legacy = () => ({ version: 2, vehicles: [vehicle('one'), vehicle('two')], activeVehicleId: 'one', services: [], expenses: [] });
const normalized = () => domain.normalizeGarage(legacy());
async function setup(state) {
  const file = new MemoryFile(), repo = new GarageRepository(SQL, file);
  const data = await repo.open(state);
  return { file, repo, data };
}
const values = { title: 'Oil change', date: '2026-01-14', mileage: '12000', category: 'Maintenance', notes: 'Synthetic' };
let serial = 0;
const id = () => `record-${++serial}`;

test('empty garage persists as a real SQLite database with versioned relational tables', async () => {
  const { file, repo, data } = await setup();
  assert.equal(data.vehicles.length, 0);
  assert.equal(Buffer.from(file.saved.bytes.slice(0, 15)).toString(), 'SQLite format 3');
  assert.equal(repo.db.exec('PRAGMA user_version')[0].values[0][0], 4);
  assert.equal(repo.db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.length, 4);
});
test('migration preserves legacy records, exact cents and ownership', async () => {
  const state = legacy(); state.expenses.push({ id: 'expense', vehicleId: 'two', title: 'Oil', date: '2026-01-01', mileage: 12000, amount: 79.99 });
  const { repo } = await setup(state); const data = repo.read();
  assert.equal(data.expenses[0].amountCents, 7999); assert.equal(data.expenses[0].vehicleId, 'two');
  assert.equal(state.expenses[0].amount, 79.99); // Original backup is never mutated.
});
test('oldest unversioned backups associate records with the original vehicle', () => {
  const state = legacy(); delete state.version;
  state.expenses.push({ id: 'e', title: 'Oil', date: '2026-01-01', mileage: 12000, amount: 80 });
  assert.equal(domain.parseBackup(JSON.stringify(state)).expenses[0].vehicleId, 'one');
});
test('vehicle, service, completion and expense survive database reopen', async () => {
  const { repo, file } = await setup(normalized());
  let state = domain.applyRecord(repo.read(), 'service', values, null, id);
  const serviceId = state.services[0].id;
  await repo.replace(state);
  state = domain.applyRecord(state, 'complete', { date: '2026-01-14', mileage: '12500', amount: '79.99', shop: 'Local garage' }, serviceId, id);
  await repo.replace(state);
  const reopened = new GarageRepository(SQL, file); await reopened.open(); const saved = reopened.read();
  assert.equal(saved.services[0].done, true); assert.equal(saved.services[0].completedMileage, 12500);
  assert.equal(saved.expenses[0].amountCents, 7999); assert.equal(saved.expenses[0].serviceId, serviceId);
  assert.equal(saved.vehicles[0].mileage, 12500); assert.equal(saved.vehicles[1].mileage, 12345);
  assert.throws(() => domain.applyRecord(saved, 'complete', { date: '2026-01-14', mileage: '12500' }, serviceId, id), /already complete/);
});
test('editing an expense preserves ID, service link and integer cents', () => {
  let state = domain.applyRecord(normalized(), 'service', values, null, id);
  state = domain.applyRecord(state, 'complete', { date: '2026-01-14', mileage: '12500', amount: '1.01' }, state.services[0].id, id);
  const expenseId = state.expenses[0].id, serviceId = state.expenses[0].serviceId;
  state = domain.applyRecord(state, 'expense', { ...values, shop: '', amount: '2.03' }, expenseId, id);
  assert.equal(state.expenses.length, 1); assert.equal(state.expenses[0].id, expenseId); assert.equal(state.expenses[0].serviceId, serviceId); assert.equal(state.expenses[0].amountCents, 203);
});
test('JSON backup round-trip preserves all records, Unicode and relationships', async () => {
  const { repo } = await setup(normalized());
  let state = domain.applyRecord(repo.read(), 'service', { ...values, notes: '日本語 🛠️\n"quoted", details' }, null, id);
  state = domain.applyRecord(state, 'complete', { date: '2026-01-14', mileage: '12500', amount: '100.10' }, state.services[0].id, id);
  const restored = domain.parseBackup(JSON.stringify(domain.createBackup(state)));
  assert.deepEqual(restored, state);
  await repo.replace(restored); assert.deepEqual(repo.read(), state);
});
test('deleting a service preserves its expense; deleting a vehicle removes only its records', async () => {
  let state = domain.applyRecord(normalized(), 'service', values, null, id);
  state = domain.applyRecord(state, 'complete', { date: '2026-01-14', mileage: '12500', amount: '5.00' }, state.services[0].id, id);
  const { repo } = await setup(state);
  const withoutService = domain.deleteRecord(state, 'service', state.services[0].id);
  assert.equal(withoutService.expenses[0].serviceId, null); await repo.replace(withoutService);
  const withoutVehicle = domain.deleteRecord(state, 'vehicle', 'one');
  assert.equal(withoutVehicle.activeVehicleId, 'two'); assert.equal(withoutVehicle.expenses.length, 0); assert.equal(withoutVehicle.services.length, 0); await repo.replace(withoutVehicle);
});
test('failed durable save leaves both memory and persisted SQLite data unchanged', async () => {
  const { repo, file, data } = await setup(normalized());
  const before = file.saved.bytes.slice(); file.fail = true;
  await assert.rejects(repo.replace(domain.applyRecord(data, 'service', values, null, id)), /Storage full/);
  assert.deepEqual(file.saved.bytes, before); assert.deepEqual(repo.read(), data);
});
test('invalid restore leaves all existing records intact', async () => {
  const { repo, file, data } = await setup(normalized());
  const invalid = structuredClone(data); invalid.expenses.push({ id: 'orphan', vehicleId: 'missing' });
  const before = file.saved.bytes.slice(); await assert.rejects(repo.replace(invalid));
  assert.deepEqual(repo.read(), data); assert.deepEqual(file.saved.bytes, before);
});
test('stale second window cannot overwrite a committed save', async () => {
  const { repo, file, data } = await setup(normalized());
  const other = new GarageRepository(SQL, file); await other.open();
  await repo.replace(domain.applyRecord(data, 'service', values, null, id));
  await assert.rejects(other.replace(data), ConflictError);
  const refreshed = await other.refresh(); assert.equal(refreshed.services.length, 1);
});
test('SQLite independently enforces relationships and amount constraints', () => {
  const db = new SQL.Database(); migrate(db);
  assert.throws(() => db.run("INSERT INTO expenses VALUES ('x','missing',NULL,'Repair','Repair','2026-01-01',1,100,'','')"), /FOREIGN KEY/);
  db.run("INSERT INTO vehicles VALUES ('v','Honda','Civic',2020,'Car','',0,NULL,NULL)");
  assert.throws(() => db.run("INSERT INTO expenses VALUES ('x','v',NULL,'Repair','Repair','2026-01-01',1,-100,'','')"), /CHECK/);
  assert.throws(() => db.run("INSERT INTO expenses VALUES ('x','v',NULL,'Repair','Repair','2026-01-01',1,100.5,'','')"), /INTEGER/);
  db.close();
});
test('database migrations are repeatable and refuse future schemas', () => {
  const db = new SQL.Database(); migrate(db); migrate(db); db.run('PRAGMA user_version = 999');
  assert.throws(() => migrate(db), /newer version/); db.close();
});
test('future backup versions, malformed JSON and invalid dates are rejected', () => {
  const backup = domain.createBackup(normalized());
  assert.throws(() => domain.parseBackup('{oops'), /JSON/);
  assert.throws(() => domain.parseBackup(JSON.stringify({ ...backup, schemaVersion: 999 })), /Unsupported/);
  const bad = structuredClone(backup); bad.services.push({ id: 'bad-date', vehicleId: 'one', ...values, date: '2026-02-30', mileage: 0 });
  assert.throws(() => domain.parseBackup(JSON.stringify(bad)), /date/);
});
test('duplicate IDs, dangling relationships and cross-vehicle service links are rejected', () => {
  const state = normalized(); state.vehicles[1].id = state.vehicles[0].id;
  assert.throws(() => domain.normalizeGarage(state), /Duplicate/);
  const linked = domain.applyRecord(normalized(), 'service', values, null, id);
  linked.expenses.push({ id: 'wrong-car', vehicleId: 'two', serviceId: linked.services[0].id, ...values, mileage: 0, amountCents: 100 });
  assert.throws(() => domain.normalizeGarage(linked), /different vehicle/);
});
test('money parser rejects fractions of cents, negatives and unsafe large numbers', () => {
  assert.equal(domain.moneyToCents('0.10') + domain.moneyToCents('0.20'), 30);
  for (const amount of ['-1', '1.001', 'Infinity', '', '1e3', '99999999999999999']) assert.throws(() => domain.moneyToCents(amount));
});
test('existing SQLite garage is used without reading obsolete browser records', async () => {
  const { file } = await setup(normalized()); const repo = new GarageRepository(SQL, file);
  await repo.open(() => { throw Error('Do not read legacy storage'); }); assert.equal(repo.read().vehicles.length, 2);
});
test('mileage-only, date-only, and unscheduled services persist and restore', async () => {
  let state = normalized();
  for (const fields of [{ date: '', mileage: '18345' }, { date: '2027-01-01', mileage: '' }, { date: '', mileage: '' }]) {
    state = domain.applyRecord(state, 'service', { ...values, ...fields }, null, id);
  }
  const { repo, file } = await setup(state);
  const reopened = new GarageRepository(SQL, file); await reopened.open();
  assert.deepEqual(reopened.read(), state);
  assert.deepEqual(state.services.map(s => [s.date, s.mileage]), [[null, 18345], ['2027-01-01', null], [null, null]]);
  const restored = domain.parseBackup(JSON.stringify(domain.createBackup(state)));
  await repo.replace(restored); assert.deepEqual(repo.read(), state);
  state = domain.applyRecord(state, 'service', { ...values, date: '', mileage: '' }, state.services[0].id, id);
  assert.equal(state.services[0].mileage, null);
});
test('due in 6000 miles converts to an odometer threshold and rejects conflicting inputs', () => {
  const state = domain.applyRecord(normalized(), 'service', { ...values, date: '', mileage: '', dueInMiles: '6000' }, null, id);
  assert.equal(state.services[0].mileage, 18345);
  assert.equal(state.services[0].date, null);
  assert.equal(domain.serviceTiming(state.services[0], 12345).description, 'In 6,000 mi');
  assert.throws(() => domain.applyRecord(normalized(), 'service', { ...values, dueInMiles: '6000' }, null, id), /not both/);
  for (const dueInMiles of ['-1', '1.5', 'not a number']) assert.throws(() => domain.applyRecord(normalized(), 'service', { ...values, date: '', mileage: '', dueInMiles }, null, id));
});
test('missing thresholds never imply overdue or create invalid date displays', () => {
  const service = { ...values, done: false, date: null, mileage: null };
  assert.equal(domain.serviceTiming(service, 50000).label, 'Unscheduled');
  assert.equal(domain.serviceTiming(service, 50000).due, false);
  assert.equal(domain.serviceTiming({ ...service, mileage: 56000 }, 50000).description, 'In 6,000 mi');
  assert.equal(domain.serviceTiming({ ...service, mileage: 56000 }, 56000).due, true);
  assert.equal(domain.serviceTiming({ ...service, date: '2026-01-01' }, 50000, '2026-01-01').due, true);
  assert.equal(domain.serviceTiming({ ...service, done: true, mileage: 0 }, 50000).due, false);
  assert.doesNotThrow(() => [service, { ...service, date: '2027-01-01' }, { ...service, mileage: 56000 }].sort((a,b) => domain.compareServices(a,b,50000)));
});
test('v1 SQLite migration preserves existing services, linked expenses, and settings', async () => {
  const { migrations } = await import('../src/schema.mjs');
  const db = new SQL.Database(); db.run('PRAGMA foreign_keys=ON'); db.run(migrations[0].sql); db.run('PRAGMA user_version=1');
  db.run("INSERT INTO vehicles VALUES ('v','Honda','Civic',2020,'Daily','',12345,NULL)");
  db.run("INSERT INTO services VALUES ('s','v','Oil','Maintenance','2026-01-01',12000,'Synthetic',1,'2026-01-01',12345)");
  db.run("INSERT INTO expenses VALUES ('e','v','s','Oil','Maintenance','2026-01-01',12345,7999,'Shop','Notes')");
  db.run("INSERT INTO settings VALUES ('activeVehicleId','\"v\"')");
  const file = new MemoryFile(); file.saved = { bytes: db.export(), revision: 1 }; db.close();
  const repo = new GarageRepository(SQL, file); let state = await repo.open();
  assert.equal(state.services[0].completedMileage, 12345); assert.equal(state.expenses[0].serviceId, 's'); assert.equal(state.expenses[0].amountCents, 7999); assert.equal(state.activeVehicleId, 'v');
  state = domain.applyRecord(state, 'service', { ...values, date: '', mileage: '' }, null, id); await repo.replace(state);
  const reopened = new GarageRepository(SQL, file); assert.deepEqual(await reopened.open(), state);
  assert.deepEqual(reopened.db.exec('PRAGMA foreign_key_check'), []);
});
test('original JSON envelope and garage v3 remain importable', () => {
  const old = { ...normalized(), version: 3, format: 'maintainr-backup', schemaVersion: 1, exportedAt: '2026-01-01T12:00:00Z' };
  assert.equal(domain.parseBackup(JSON.stringify(old)).version, 6);
});


test('recurring services schedule from completion and survive backup and database reopen', async () => {
  const { repo, file } = await setup(normalized());
  let state = domain.applyRecord(repo.read(), 'service', { ...values, recurrenceUnit: 'miles', recurrenceInterval: '5000' }, null, id);
  const original = state.services[0].id;
  state = domain.applyRecord(state, 'complete', { date: '2026-01-31', mileage: '13000', amount: '40.00' }, original, id);
  assert.equal(state.services.length, 2);
  assert.equal(state.services[1].mileage, 18000);
  assert.equal(state.services[1].date, null);
  assert.equal(state.expenses[0].serviceId, original);
  await repo.replace(state);
  const reopened = new GarageRepository(SQL, file); await reopened.open();
  assert.deepEqual(reopened.read(), state);
  assert.deepEqual(domain.parseBackup(JSON.stringify(domain.createBackup(state))), state);
  state = domain.applyRecord(normalized(), 'service', { ...values, recurrenceUnit: 'months', recurrenceInterval: '1' }, null, id);
  state = domain.applyRecord(state, 'complete', { date: '2024-01-31', mileage: '13000' }, state.services[0].id, id);
  assert.equal(state.services[1].date, '2024-02-29');
  assert.equal(state.services[1].mileage, null);
  assert.throws(() => domain.applyRecord(normalized(), 'service', { ...values, recurrenceUnit: 'months', recurrenceInterval: '0' }, null, id), /interval/);
});


test('vehicle photos persist, survive backups, and can be removed', async () => {
  const { repo, file } = await setup(normalized());
  const photo = 'data:image/jpeg;base64,/9j/2Q==';
  let state = domain.applyRecord(repo.read(), 'vehicle', { ...repo.read().vehicles[0], photo }, 'one');
  await repo.replace(state);
  const reopened = new GarageRepository(SQL, file); await reopened.open();
  assert.equal(reopened.read().vehicles[0].photo, photo);
  assert.equal(domain.parseBackup(JSON.stringify(domain.createBackup(state))).vehicles[0].photo, photo);
  state = domain.applyRecord(state, 'vehicle', { ...state.vehicles[0], photo: null }, 'one');
  assert.equal(state.vehicles[0].photo, null);
  assert.throws(() => domain.normalizeGarage({ ...state, vehicles: [{ ...state.vehicles[0], photo: 'data:image/svg+xml;base64,AAAA' }] }), /photo/);
});
