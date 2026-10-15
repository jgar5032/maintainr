import { emptyGarage, normalizeGarage } from './domain.mjs';
import { migrate } from './schema.mjs';

export class ConflictError extends Error {
  constructor() { super('The garage changed in another window. Your view has been refreshed; review it before saving again.'); this.name = 'ConflictError'; }
}
export class BrowserDatabaseFile {
  async open() {
    this.connection = await new Promise((resolve, reject) => {
      const request = indexedDB.open('maintainr-sqlite', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other Maintainr windows and try again.'));
    });
    this.connection.onversionchange = () => this.connection.close();
  }
  async read() {
    return new Promise((resolve, reject) => {
      const tx = this.connection.transaction('files', 'readonly');
      const request = tx.objectStore('files').get('garage');
      tx.oncomplete = () => resolve(request.result || null);
      tx.onabort = () => reject(tx.error || new Error('Could not read the garage.'));
      tx.onerror = () => {}; // onabort reports the failed transaction.
    });
  }
  async commit(bytes, expectedRevision) {
    return new Promise((resolve, reject) => {
      // IndexedDB serializes readwrite transactions across tabs. The comparison
      // and replacement share a transaction, so stale snapshots cannot overwrite.
      const tx = this.connection.transaction('files', 'readwrite');
      const store = tx.objectStore('files'), request = store.get('garage');
      let conflict = false;
      request.onsuccess = () => {
        if ((request.result?.revision || 0) !== expectedRevision) { conflict = true; tx.abort(); return; }
        store.put({ bytes, revision: expectedRevision + 1 }, 'garage');
      };
      tx.oncomplete = () => resolve(expectedRevision + 1);
      tx.onabort = () => reject(conflict ? new ConflictError() : tx.error || new Error('Could not save the database.'));
      tx.onerror = () => {};
    });
  }
}
function rows(db, sql) {
  const statement = db.prepare(sql), result = [];
  try { while (statement.step()) result.push(statement.getAsObject()); } finally { statement.free(); }
  return result;
}
export class GarageRepository {
  constructor(SQL, file) { this.SQL = SQL; this.file = file; this.revision = 0; }
  async open(legacy = null) {
    await this.file.open();
    const saved = await this.file.read();
    if (saved) return this.load(saved);
    this.db = new this.SQL.Database(); migrate(this.db);
    const original = typeof legacy === 'function' ? legacy() : legacy;
    return this.replace(original ? normalizeGarage(original) : emptyGarage());
  }
  load(saved) {
    const candidate = new this.SQL.Database(new Uint8Array(saved.bytes));
    try {
      const integrity = candidate.exec('PRAGMA quick_check')[0]?.values[0]?.[0];
      if (integrity !== 'ok') throw new Error('The saved database is damaged. Restore a JSON backup.');
      migrate(candidate);
      if (candidate.exec('PRAGMA foreign_key_check').length) throw new Error('The database contains invalid relationships.');
      const state = this.read(candidate);
      this.db?.close(); this.db = candidate; this.revision = saved.revision;
      return state;
    } catch (error) { candidate.close(); throw error; }
  }
  read(db = this.db) {
    const settings = Object.fromEntries(rows(db, 'SELECT key, value FROM settings').map(r => [r.key, JSON.parse(r.value)]));
    return normalizeGarage({ version: 4,
      vehicles: rows(db, 'SELECT id, make, model, year, nickname, plate, mileage, created_at AS createdAt FROM vehicles ORDER BY rowid'),
      services: rows(db, 'SELECT id, vehicle_id AS vehicleId, title, category, due_date AS date, due_mileage AS mileage, notes, done, completed_date AS completedDate, completed_mileage AS completedMileage FROM services ORDER BY rowid').map(r => ({ ...r, done: !!r.done })),
      expenses: rows(db, 'SELECT id, vehicle_id AS vehicleId, service_id AS serviceId, title, category, date, mileage, amount_cents AS amountCents, shop, notes FROM expenses ORDER BY rowid'),
      ...settings,
    });
  }
  async refresh() { const saved = await this.file.read(); return saved ? this.load(saved) : this.read(); }
  async replace(value) {
    const state = normalizeGarage(value);
    // Work on a separate SQLite connection. The live view changes only after
    // both the SQL transaction and durable file commit have succeeded.
    const candidate = new this.SQL.Database(this.db.export());
    try {
      migrate(candidate); candidate.run('BEGIN');
      candidate.run('DELETE FROM expenses; DELETE FROM services; DELETE FROM vehicles; DELETE FROM settings;');
      const insert = (sql, records, values) => { const statement = candidate.prepare(sql); try { for (const record of records) statement.run(values(record)); } finally { statement.free(); } };
      insert('INSERT INTO vehicles VALUES (?,?,?,?,?,?,?,?)', state.vehicles, v => [v.id, v.make, v.model, v.year, v.nickname, v.plate, v.mileage, v.createdAt]);
      insert('INSERT INTO services VALUES (?,?,?,?,?,?,?,?,?,?)', state.services, s => [s.id, s.vehicleId, s.title, s.category, s.date, s.mileage, s.notes, Number(s.done), s.completedDate, s.completedMileage]);
      insert('INSERT INTO expenses VALUES (?,?,?,?,?,?,?,?,?,?)', state.expenses, e => [e.id, e.vehicleId, e.serviceId, e.title, e.category, e.date, e.mileage, e.amountCents, e.shop, e.notes]);
      for (const key of ['activeVehicleId', 'lastExportAt']) candidate.run('INSERT INTO settings VALUES (?,?)', [key, JSON.stringify(state[key])]);
      candidate.run('COMMIT');
      const bytes = candidate.export(), revision = await this.file.commit(bytes, this.revision);
      this.db.close(); this.db = candidate; this.revision = revision;
      return state;
    } catch (error) { candidate.close(); throw error; }
  }
}
