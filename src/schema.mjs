// Each migration runs atomically. Add future migrations; never edit a released migration.
export const migrations = [{ version: 1, sql: `
CREATE TABLE vehicles (
 id TEXT PRIMARY KEY NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL,
 year INTEGER NOT NULL CHECK(year BETWEEN 1900 AND 2099), nickname TEXT NOT NULL,
 plate TEXT NOT NULL, mileage INTEGER NOT NULL CHECK(mileage >= 0), created_at TEXT
) STRICT;
CREATE TABLE services (
 id TEXT PRIMARY KEY NOT NULL, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
 title TEXT NOT NULL, category TEXT NOT NULL, due_date TEXT NOT NULL,
 due_mileage INTEGER NOT NULL CHECK(due_mileage >= 0), notes TEXT NOT NULL,
 done INTEGER NOT NULL CHECK(done IN (0,1)), completed_date TEXT, completed_mileage INTEGER CHECK(completed_mileage >= 0),
 UNIQUE(id, vehicle_id)
) STRICT;
CREATE TABLE expenses (
 id TEXT PRIMARY KEY NOT NULL, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
 service_id TEXT UNIQUE, title TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL,
 mileage INTEGER NOT NULL CHECK(mileage >= 0), amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
 shop TEXT NOT NULL, notes TEXT NOT NULL,
 FOREIGN KEY(service_id, vehicle_id) REFERENCES services(id, vehicle_id)
) STRICT;
CREATE INDEX services_vehicle_due ON services(vehicle_id, done, due_date);
CREATE INDEX expenses_vehicle_date ON expenses(vehicle_id, date);
CREATE INDEX expenses_category ON expenses(vehicle_id, category);
CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
` }, { version: 2, sql: `
-- Rebuild the related tables together so foreign keys remain enabled throughout.
CREATE TABLE services_optional (
 id TEXT PRIMARY KEY NOT NULL, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
 title TEXT NOT NULL, category TEXT NOT NULL, due_date TEXT,
 due_mileage INTEGER CHECK(due_mileage >= 0), notes TEXT NOT NULL,
 done INTEGER NOT NULL CHECK(done IN (0,1)), completed_date TEXT, completed_mileage INTEGER CHECK(completed_mileage >= 0),
 UNIQUE(id, vehicle_id)
) STRICT;
CREATE TABLE expenses_optional (
 id TEXT PRIMARY KEY NOT NULL, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
 service_id TEXT UNIQUE, title TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL,
 mileage INTEGER NOT NULL CHECK(mileage >= 0), amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
 shop TEXT NOT NULL, notes TEXT NOT NULL,
 FOREIGN KEY(service_id, vehicle_id) REFERENCES services_optional(id, vehicle_id)
) STRICT;
INSERT INTO services_optional SELECT * FROM services;
INSERT INTO expenses_optional SELECT * FROM expenses;
DROP TABLE expenses;
DROP TABLE services;
ALTER TABLE services_optional RENAME TO services;
ALTER TABLE expenses_optional RENAME TO expenses;
CREATE INDEX services_vehicle_due ON services(vehicle_id, done, due_date);
CREATE INDEX expenses_vehicle_date ON expenses(vehicle_id, date);
CREATE INDEX expenses_category ON expenses(vehicle_id, category);
` }];
export function migrate(db) {
  db.run('PRAGMA foreign_keys = ON');
  const version = db.exec('PRAGMA user_version')[0].values[0][0];
  if (version > migrations.at(-1).version) throw new Error('This database requires a newer version of Maintainr.');
  for (const migration of migrations.filter(m => m.version > version)) {
    db.run('BEGIN');
    try { db.run(migration.sql); db.run(`PRAGMA user_version = ${migration.version}`); db.run('COMMIT'); }
    catch (error) { db.run('ROLLBACK'); throw error; }
  }
}
