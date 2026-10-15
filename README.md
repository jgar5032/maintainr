# Maintainr

A single-device vehicle maintenance app with embedded SQLite, offline use, and portable JSON backups. No accounts, backend server, subscription, or sync service.

## Run

Install Node.js 20 or newer, then:

```sh
node server.mjs
```

Open **http://localhost:4173**. No dependency installation or build step is needed; the pinned SQLite WebAssembly runtime is included in `vendor/sql.js`.

If that port is already in use, stop your previous server or choose another port:

```sh
node server.mjs 4175
```

Each browser and origin (including port) has separate storage. Keep using the same address for your garage, or export/import when changing it. Your existing `python3 -m http.server 4173` command also works.

## Use

1. Add a vehicle with its current mileage. Additional vehicles have separate histories and totals.
2. Schedule maintenance with an optional due date, optional odometer threshold, or miles from now (for example, 6000). Either threshold can make a service due; leaving both blank keeps the service unscheduled.
3. Complete a service with its actual date and mileage. Optionally enter a cost to create a linked expense in the same transaction. Mileage advances when recording later work.
4. Edit or delete vehicles, services, and expenses. Deleting a service keeps its expense as an independent record. Deleting a vehicle removes its records after confirmation.
5. Open **Data & backups** to export the entire garage as JSON, restore an older backup, or export expenses as CSV for a spreadsheet.

Fresh installations contain no example data. Existing browser records migrate automatically into SQLite once; the original `maintainr-data` entry remains untouched for recovery. Original demo records can be removed using their banner.

## Backups and device transfer

**Export garage** downloads a versioned `maintainr-backup-YYYY-MM-DD.json` file. Save it somewhere available from your next device. On the new device, open Maintainr, choose **Data & backups → Choose JSON backup**, review the counts and total, then confirm replacement.

- JSON includes every vehicle, service, expense, note, completion record, and selected vehicle.
- Earlier unversioned and v2 Maintainr JSON exports are converted during import.
- Future/unknown versions, duplicate IDs, invalid dates, malformed amounts, oversized files, and broken relationships are rejected before any records change.
- Restoration replaces the garage atomically. It does not merge or sync.
- The last-export date records an export request, not proof that a file was saved. Restoring resets that date on the new device.
- CSV is an all-vehicle expense report, not a restorable backup. Cells are quoted and formula-leading text is escaped.
- Files are plain text; save them somewhere appropriate for your vehicle information.

## Offline and platform support

The responsive PWA targets modern WebAssembly-capable browsers on Windows, Linux, iOS, and Android. It requires an initial successful visit to download the app and SQLite runtime. After the service worker finishes caching, the garage, navigation, editing, and JSON backups work without a network connection. There are no external runtime/CDN or font requests.

Host the files over **HTTPS** for mobile/offline installation; `localhost` is allowed for development. Opening a computer's HTTP LAN address on a phone is not equivalent to HTTPS and will not enable its service worker. Use the browser's installation option; on iPhone use Safari’s **Share → Add to Home Screen** where supported. Native app-store packages are not included.

The bell opens an in-app due-service summary. There are no push or background notifications.

App releases cache a complete shell including SQLite. A new service worker waits until **Update & reload** is accepted or all old windows are closed. Accepting an update does not clear the database. When changing cached files during development, increment the release cache name in `sw.js`; increment the app/style query versions and precache entries when those files change.

## Architecture

```text
Interface (app.js)
    → validation and garage operations (src/domain.mjs)
    → SQLite repository (src/database.mjs)
    → migrations, constraints and indexes (src/schema.mjs)
    → SQLite database bytes persisted locally

JSON backups ↔ validated garage model ↔ repository
Service worker → app files only
```

SQLite is real, embedded SQL via **sql.js 1.15.0**. Tables are `vehicles`, `services`, `expenses`, and `settings`. Foreign keys enforce ownership and service links. Expenses use integer cents. Prepared statements bind all user data. SQL schema versions (`PRAGMA user_version`), the garage data version, and the public JSON backup version are separate.

For broad browser compatibility, the SQLite engine operates in memory and the app commits its binary database snapshot into one IndexedDB record. IndexedDB is the browser's file persistence mechanism here; it does not hold separate application tables, and Dexie is not used. Both the SQLite transaction and durable browser transaction must finish before the UI reports success. A revision comparison inside the IndexedDB transaction prevents a stale window from overwriting a newer save. This snapshot approach suits a small text-record garage, not very large databases or attachments.

Browser storage can still be removed by clearing site data, private browsing, device loss, or storage eviction. **Keep exported backups.** The storage persistence request in Data & backups is optional and browser-controlled. SQLite is not a backup service or encryption layer.

## Verification

```sh
node tests/app.test.cjs
node --check app.js
node --check sw.js
```

The dependency-free tests run the actual bundled SQLite engine and cover schema migration, foreign keys, money arithmetic, completion and expenses, database reopen, legacy migration, backup round-trips, invalid restores, storage failures, and stale writers. GitHub Actions runs these checks on Windows and Linux.

Browser smoke testing also covered forms, real IndexedDB persistence, expense editing, import previews, a 390px mobile viewport, and reopening/exporting after the local server stopped in Firefox. Physical iOS/Android installation testing remains necessary before claiming support for specific devices.

See [docs/system-design.md](docs/system-design.md) for the schema and save/restore flow, and [vendor/sql.js/README.md](vendor/sql.js/README.md) for dependency provenance and license.
