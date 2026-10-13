# Maintainr

A small, responsive car-care app for service schedules and repair/maintenance costs. Entries are stored in browser with `localStorage`; no account or backend is required for this prototype.

## Run locally

From this folder, start a static server:

```sh
python3 -m http.server 4173
```

Then open <http://localhost:4173>. The app is installable as a PWA in supported browsers and caches its shell for offline use. On iPhone, open the hosted app in Safari and use **Share → Add to Home Screen**. The same responsive web app can later be wrapped with Capacitor or replaced by a native client while preserving a shared backend.

## Current scope

- One starter vehicle with mileage and vehicle details
- Add scheduled services and mark them complete
- Log expenses, filter by category, and review lifetime/monthly totals
- Data remains on this device/browser; it does not sync between devices yet
