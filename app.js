import { emptyGarage, applyRecord, deleteRecord, createBackup, parseBackup, serviceTiming, compareServices, MAX_BACKUP_BYTES } from './src/domain.mjs';
import { BrowserDatabaseFile, GarageRepository, ConflictError } from './src/database.mjs';

const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  car: '<path d="m5 11 1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><path d="M3 11h18v7H3z"/><path d="M6 18v2m12-2v2M6 14h.01M18 14h.01"/>',
  wrench: '<path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4L14 13l-3-3z"/>',
  receipt: '<path d="M4 3h16v18l-3-2-3 2-3-2-3 2-4-2z"/><path d="M8 8h8m-8 4h8m-8 4h4"/>',
  plus: '<path d="M12 5v14m-7-7h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  oil: '<path d="M12 3s6 7.2 6 11a6 6 0 1 1-12 0c0-3.8 6-11 6-11Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  gauge: '<path d="M12 14 16 8"/><path d="M20.2 15a9 9 0 1 0-16.4 0"/><path d="M12 14v.01"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12h4"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  filter: '<path d="M4 6h16M7 12h10m-7 6h4"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const fmtCurrency = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
const fmtDate = (date) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T00:00:00`));
const localDate = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
let data = emptyGarage();
let repository;
let storageError = '';
let saving = false;
let pendingImport = null;
let currentPage = 'dashboard';
let scheduleFilter = 'upcoming';
let expenseFilter = 'all';
let pendingRecordType = 'service';
async function saveData(next) {
  if (saving) { toast('A save is in progress. Please wait.'); return false; }
  saving = true;
  try { data = await repository.replace(next); storageError = ''; return true; }
  catch (error) {
    if (error instanceof ConflictError) { data = await repository.refresh(); dialog.close(); render(); }
    toast(error instanceof ConflictError ? error.message : `Save failed: ${error.message}. Your previous records are unchanged.`);
    return false;
  } finally { saving = false; }
}
const activeVehicle = () => data.vehicles.find(v => v.id === data.activeVehicleId) || data.vehicles[0];
const vehicleServices = () => data.services.filter(s => s.vehicleId === activeVehicle()?.id);
const vehicleExpenses = () => data.expenses.filter(e => e.vehicleId === activeVehicle()?.id);
const upcomingServices = () => vehicleServices().filter((service) => !service.done).sort((a, b) => compareServices(a, b, activeVehicle()?.mileage || 0));
const monthExpenses = () => vehicleExpenses().filter((expense) => { const date = new Date(`${expense.date}T00:00:00`); const now = new Date(); return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear(); });
const totalExpenses = () => vehicleExpenses().reduce((sum, item) => sum + item.amountCents, 0);
const serviceRow = service => {
  const timing = serviceTiming(service, activeVehicle().mileage);
  return `<li class="service-row"><span class="service-symbol">${icon(service.category === 'Tires' ? 'gauge' : service.category === 'Oil & fluids' ? 'oil' : 'wrench')}</span><span class="service-copy"><strong>${escapeText(service.title)}</strong><span>${service.mileage == null ? 'Mileage not set' : `${service.mileage.toLocaleString()} mi`}${service.category ? ` · ${escapeText(service.category)}` : ''}</span></span><span class="service-when ${timing.due ? 'is-due' : ''}"><strong>${timing.description}</strong><span>${service.date ? fmtDate(service.date) : 'No date set'}</span></span></li>`;
};
const expenseRow = (expense) => `<li class="expense-row"><span class="expense-category">${icon(expense.category === 'Repair' ? 'wrench' : expense.category === 'Tires' ? 'gauge' : 'receipt')}</span><span class="expense-description"><strong>${escapeText(expense.title)}</strong><span>${escapeText(expense.shop || expense.category)} · ${fmtDate(expense.date)}</span></span><span class="expense-amount">${fmtCurrency(expense.amountCents / 100)}</span></li>`;
const navLink = (page, label, symbol, count = '') => `<a class="nav-link ${currentPage === page ? 'active' : ''}" href="#${page}" data-page="${page}">${icon(symbol)}<span>${label}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</a>`;
const navMarkup = () => `${navLink('dashboard', 'Overview', 'grid')}${navLink('vehicles', 'My vehicles', 'car', data.vehicles.length)}${navLink('schedule', 'Service schedule', 'calendar', upcomingServices().length)}${navLink('costs', 'Cost history', 'receipt')}${navLink('backups', 'Data & backups', 'receipt')}`;
const header = () => `<div class="mobile-header"><a class="brand" href="#dashboard"><span class="brand-mark">${icon('wrench')}</span>maintainr</a><button class="icon-button" type="button" aria-label="Notifications">${icon('bell')}</button></div><header class="topbar"><div class="breadcrumb"><span>My garage</span>${icon('chevron')}<strong>${pageTitle()}</strong></div><div class="topbar-actions"><button class="icon-button" type="button" aria-label="Notifications">${icon('bell')}</button><button class="button button-primary" type="button" data-add="${currentPage === 'costs' ? 'expense' : 'service'}">${icon('plus')}<span>${currentPage === 'costs' ? 'Add expense' : 'Add service'}</span></button></div></header>`;
function pageTitle() { return ({ dashboard: 'Overview', vehicles: 'My vehicles', schedule: 'Service schedule', costs: 'Cost history', backups: 'Data & backups' })[currentPage] || 'Overview'; }
function heading(title, subtitle, action = '') { return `<div class="page-heading"><div><p class="eyebrow">${new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()}</p><h1>${title}</h1><p class="heading-subtitle">${subtitle}</p></div>${action}</div>`; }
function vehicleSelector() { return `<label class="garage-select">Vehicle <select id="vehicle-select" aria-label="Active vehicle">${data.vehicles.map(v => `<option value="${escapeAttr(v.id)}" ${v.id === activeVehicle()?.id ? 'selected' : ''}>${escapeText(v.year + ' ' + v.make + ' ' + v.model)}</option>`).join('')}</select></label>`; }
function vehicleCard() { const car = activeVehicle(); return `<section class="panel"><div class="vehicle-feature">${car.photo ? `<img src="${escapeAttr(car.photo)}" alt="">` : `<div class="car-art">${icon('car')}</div>`}<div class="vehicle-overlay"><div><h2>${escapeText(car.year + ' ' + car.make + ' ' + car.model)}</h2><p>${escapeText(car.nickname)} · ${escapeText(car.plate || 'No plate recorded')}</p></div><span class="vehicle-status">${upcomingServices().some(isDue) ? 'Service due' : 'Personal vehicle'}</span></div></div><div class="vehicle-facts"><div class="vehicle-fact"><span>Current mileage</span><strong>${car.mileage.toLocaleString()} mi</strong><button class="panel-link" type="button" data-update-mileage>Update mileage</button></div><div class="vehicle-fact"><span>Next service</span><strong>${upcomingServices()[0] ? (upcomingServices()[0].date ? fmtDate(upcomingServices()[0].date) : upcomingServices()[0].mileage != null ? `${upcomingServices()[0].mileage.toLocaleString()} mi` : 'Not scheduled') : 'Not scheduled'}</strong></div><div class="vehicle-fact"><span>Tracked since</span><strong>${car.createdAt ? fmtDate(car.createdAt) : 'Not recorded'}</strong></div></div></section>`; }
function costCard() { const expenses = monthExpenses(); const total = expenses.reduce((sum, item) => sum + item.amountCents, 0); const maintenance = expenses.filter((item) => item.category !== 'Repair').reduce((sum, item) => sum + item.amountCents, 0); const repairs = total - maintenance; const pct = total ? Math.round(maintenance / total * 100) : 0; return `<section class="panel"><div class="panel-head"><h2 class="panel-title">This month</h2><button class="panel-link" data-page="costs">All costs ${icon('arrow')}</button></div><div class="cost-summary"><div class="cost-caption"><span>Vehicle spend</span><span>${expenses.length} ${expenses.length === 1 ? 'record' : 'records'}</span></div><div class="cost-total">${fmtCurrency((total) / 100)}</div><div class="chart-wrap"><div class="mini-chart" style="background:conic-gradient(var(--forest) 0 ${pct}%, var(--lime) ${pct}% ${total ? 100 : 5}%, #e7eeec ${total ? 100 : 5}% 100%)"><span class="chart-label">${expenses.length ? 'MONTH' : '—'}</span></div><div class="legend"><span class="legend-line"><i class="legend-dot"></i>Maintenance ${fmtCurrency((maintenance) / 100)}</span><span class="legend-line"><i class="legend-dot lime"></i>Repairs ${fmtCurrency((repairs) / 100)}</span></div></div></div></section>`; }
function renderDashboard() { const vehicle = activeVehicle(); const services = upcomingServices(); const expenses = [...vehicleExpenses()].sort((a, b) => b.date.localeCompare(a.date)); const monthTotal = monthExpenses().reduce((sum, item) => sum + item.amountCents, 0); return `${heading('Your garage', 'Your maintenance schedule and costs, in one place.', vehicleSelector())}<section class="stat-grid"><article class="stat-card"><div class="stat-top"><span>Upcoming services</span><i class="stat-icon">${icon('calendar')}</i></div><p class="stat-value">${services.length.toString().padStart(2, '0')}</p><p class="stat-foot">${services.length ? `${services.filter(isDue).length} due · ${serviceTiming(services[0], vehicle.mileage).description}` : 'Nothing on the calendar'}</p></article><article class="stat-card"><div class="stat-top"><span>Spent this month</span><i class="stat-icon red">${icon('receipt')}</i></div><p class="stat-value">${fmtCurrency((monthTotal) / 100)}</p><p class="stat-foot">${monthExpenses().length} logged ${monthExpenses().length === 1 ? 'expense' : 'expenses'}</p></article><article class="stat-card"><div class="stat-top"><span>Lifetime vehicle cost</span><i class="stat-icon blue">${icon('trend')}</i></div><p class="stat-value">${fmtCurrency((totalExpenses()) / 100)}</p><p class="stat-foot">Across ${vehicleExpenses().length} service records</p></article></section><div class="dashboard-grid"><div class="column-stack">${vehicleCard()}<section class="panel"><div class="panel-head"><h2 class="panel-title">Coming up</h2><button class="panel-link" data-page="schedule">Full schedule ${icon('arrow')}</button></div>${services.length ? `<ul class="service-list">${services.slice(0, 3).map(serviceRow).join('')}</ul>` : '<p class="empty-state">No upcoming services. Add one to keep your car on track.</p>'}</section></div><div class="column-stack">${costCard()}<section class="panel"><div class="panel-head"><h2 class="panel-title">Recent costs</h2><button class="panel-link" data-page="costs">View all ${icon('arrow')}</button></div>${expenses.length ? `<ul class="expense-list">${expenses.slice(0, 3).map(expenseRow).join('')}</ul>` : '<p class="empty-state">No costs tracked yet.</p>'}</section></div></div>`; }
function renderSchedule() { const services = vehicleServices().filter((service) => scheduleFilter === 'all' || (scheduleFilter === 'upcoming' ? !service.done : service.done)).sort((a, b) => compareServices(a, b, activeVehicle()?.mileage || 0)); return `${heading('Service schedule', 'A little care now goes a long way down the road.', '<button class="button button-primary" data-add="service">' + icon('plus') + 'Add service</button>')}<div class="schedule-toolbar"><button class="filter-button ${scheduleFilter === 'upcoming' ? 'active' : ''}" data-filter="upcoming">Upcoming (${upcomingServices().length})</button><button class="filter-button ${scheduleFilter === 'completed' ? 'active' : ''}" data-filter="completed">Completed</button><button class="filter-button ${scheduleFilter === 'all' ? 'active' : ''}" data-filter="all">All services</button></div><div class="schedule-list">${services.length ? services.map(scheduleItem).join('') : '<p class="empty-state panel">Nothing to show here yet.</p>'}</div>`; }
function scheduleItem(service) {
  const date = service.date ? new Date(`${service.date}T00:00:00`) : null;
  const timing = serviceTiming(service, activeVehicle().mileage);
  const pill = service.done ? 'done' : timing.due ? 'overdue' : '';
  return `<article class="schedule-item"><div class="schedule-date">${date ? `<strong>${date.getDate()}</strong><span>${new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date)}</span>` : `<strong>${icon(service.mileage == null ? 'wrench' : 'gauge')}</strong><span>${service.mileage == null ? 'Any time' : 'Mileage'}</span>`}</div><div class="schedule-details"><h3>${escapeText(service.title)}</h3><p>${escapeText(service.category)}${service.mileage != null ? ` · Due at ${service.mileage.toLocaleString()} mi` : ''} · ${timing.description}${service.recurrenceUnit ? ` · Repeats every ${service.recurrenceInterval.toLocaleString()} ${service.recurrenceUnit}` : ''}${service.notes ? ` · ${escapeText(service.notes)}` : ''}${service.completedDate ? ` · Completed ${fmtDate(service.completedDate)} at ${Number(service.completedMileage).toLocaleString()} mi` : ''}</p></div><div class="schedule-meta"><span class="status-pill ${pill}">${timing.label}</span>${recordActions('service', service.id)}${!service.done ? `<button class="complete-button" data-complete="${escapeAttr(service.id)}" aria-label="Mark ${escapeAttr(service.title)} complete">${icon('check')}</button>` : ''}</div></article>`;
}
function renderCosts() { const sorted = [...vehicleExpenses()].filter((expense) => expenseFilter === 'all' || expense.category === expenseFilter).sort((a, b) => b.date.localeCompare(a.date)); const monthTotal = monthExpenses().reduce((sum, item) => sum + item.amountCents, 0); const categories = [...new Set(vehicleExpenses().map((item) => item.category))]; return `${heading('Cost history', 'Every dollar, accounted for. Keep an eye on what your car really costs.', '<button class="button button-primary" data-add="expense">' + icon('plus') + 'Add expense</button>')}<div class="cost-total-band"><div><p class="eyebrow">ALL-TIME SPEND</p><h2>${fmtCurrency((totalExpenses()) / 100)}</h2></div><span>${fmtCurrency((monthTotal) / 100)} this month</span></div><div class="cost-filters"><label for="expense-filter">Showing ${sorted.length} ${sorted.length === 1 ? 'record' : 'records'}</label><select id="expense-filter"><option value="all">All categories</option>${categories.map((category) => `<option ${expenseFilter === category ? 'selected' : ''}>${escapeText(category)}</option>`).join('')}</select></div><section class="panel"><div class="expense-table-head"><span>Service / repair</span><span>Date</span><span style="text-align:right">Amount</span></div>${sorted.length ? sorted.map((expense) => `<div class="expense-table-row"><div class="table-name"><span class="expense-category">${icon(expense.category === 'Repair' ? 'wrench' : expense.category === 'Tires' ? 'gauge' : 'receipt')}</span><div style="min-width:0"><strong>${escapeText(expense.title)}</strong><span>${escapeText(expense.shop || expense.category)} · ${escapeText(expense.category)}</span></div></div><span class="table-date">${fmtDate(expense.date)}</span><span class="table-amount">${fmtCurrency(expense.amountCents / 100)}${recordActions('expense', expense.id)}</span></div>`).join('') : '<p class="empty-state">No expenses in this category yet.</p>'}</section>`; }
function renderVehicles() { const car = activeVehicle(); return `${heading('My vehicles', 'The cars you care for, all in one place.', '<button class="button button-primary" data-add="vehicle">' + icon('plus') + 'Add vehicle</button>')}${vehicleSelector()}<div class="record-actions">${recordActions('vehicle', car.id)}</div><div class="vehicle-profile">${vehicleCard()}<section class="vehicle-details"><p class="eyebrow">VEHICLE DETAILS</p><h2 style="font-size:18px;margin-bottom:10px">${escapeText(car.nickname)}</h2><div class="detail-line"><span>Make & model</span><strong>${escapeText(car.make + ' ' + car.model)}</strong></div><div class="detail-line"><span>Model year</span><strong>${car.year}</strong></div><div class="detail-line"><span>License plate</span><strong>${escapeText(car.plate || 'No plate recorded')}</strong></div><div class="detail-line"><span>Current mileage</span><strong>${car.mileage.toLocaleString()} mi</strong></div><div class="detail-line"><span>Services tracked</span><strong>${vehicleServices().length}</strong></div><div class="detail-line"><span>Total cost tracked</span><strong>${fmtCurrency((totalExpenses()) / 100)}</strong></div></section></div>`; }
function render() { if (!repository?.db) return; const content = currentPage === 'backups' ? renderBackups() : !activeVehicle() ? onboarding() : ({ dashboard: renderDashboard, schedule: renderSchedule, costs: renderCosts, vehicles: renderVehicles })[currentPage](); document.querySelector('#app').innerHTML = `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#dashboard"><span class="brand-mark">${icon('wrench')}</span>maintainr</a><p class="sidebar-label">WORKSPACE</p><nav class="nav-list" aria-label="Main navigation">${navMarkup()}</nav><div class="sidebar-bottom"><div class="profile-line"><span class="avatar">M</span><div><div class="profile-name">My garage</div><div class="profile-sub">Personal garage</div></div></div></div></aside><main class="main">${header()}${sampleNotice()}${storageError ? `<p role="alert" class="storage-warning">${escapeText(storageError)}</p>` : ''}${currentPage !== 'dashboard' && currentPage !== 'vehicles' && currentPage !== 'backups' && activeVehicle() ? vehicleSelector() : ''}${content}${backupControls()}</main></div><nav class="mobile-nav" aria-label="Main navigation">${navMarkup()}</nav>`; bindInteractions(); }
function escapeText(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
const escapeAttr = escapeText;
function isDue(service) { return serviceTiming(service, activeVehicle()?.mileage || 0).due; }
function recordActions(type, id) { return `<span class="record-actions"><button class="panel-link" data-edit="${escapeAttr(id)}" data-type="${type}">Edit</button><button class="panel-link" data-delete="${escapeAttr(id)}" data-type="${type}">Delete</button></span>`; }
function onboarding() { return `${heading('Make this garage yours', 'Start with your vehicle, then track services and expenses.')}<section class="panel onboarding">${icon('car')}<h2>Add your first vehicle</h2><p>Your records stay in this browser. Export backups to keep a copy or move to another device.</p><button class="button button-primary" data-add="vehicle">Add vehicle</button></section>`; }
function sampleRecords() {
  const services = { 'service-1': ['Oil & filter change', 45000], 'service-2': ['Tire rotation', 44500], 'service-3': ['Cabin air filter', 46000] };
  const expenses = { 'expense-1': ['Brake pad replacement', 42100, 386], 'expense-2': ['Oil & filter change', 39850, 94], 'expense-3': ['New all-season tires', 36500, 724], 'expense-4': ['Annual inspection', 33110, 62] };
  return {
    services: data.services.filter(r => r.vehicleId === 'car-1' && services[r.id]?.[0] === r.title && services[r.id]?.[1] === r.mileage && !r.done),
    expenses: data.expenses.filter(r => r.vehicleId === 'car-1' && expenses[r.id]?.[0] === r.title && expenses[r.id]?.[1] === r.mileage && expenses[r.id]?.[2] * 100 === r.amountCents),
  };
}
function sampleNotice() {
  const samples = sampleRecords();
  if (!samples.services.length && !samples.expenses.length) return '';
  return `<section class="storage-warning" role="status"><strong>Example records from the original demo are still saved.</strong><p>Remove the original sample services and expenses to start tracking your own car. Export a backup first if you want a copy.</p><button class="button button-primary" id="remove-samples">Remove demo records</button></section>`;
}
function backupControls() { return `<footer class="backup-controls"><span>Saved on this device</span><button class="panel-link" data-page="backups">Data & backups ${icon('arrow')}</button></footer>`; }
function renderBackups() {
  return `${heading('Data & backups', 'Your garage stays on this device. Keep a backup somewhere you can access from your next phone.')}<div class="backup-grid"><section class="panel backup-panel"><span class="service-symbol">${icon('receipt')}</span><h2>Take your garage with you</h2><p>Export all vehicles, services, expenses, and notes as a portable JSON file. Save it in Files, a drive, or another location you control.</p><p class="backup-date">Last exported: <strong>${data.lastExportAt ? escapeText(new Date(data.lastExportAt).toLocaleString()) : 'Not yet'}</strong></p><p class="hint">This date records when an export was requested. It cannot confirm where you saved the file.</p><button class="button button-primary" id="export-data">Export garage</button><button class="button button-quiet" id="export-csv">Export expenses as CSV</button></section><section class="panel backup-panel"><span class="service-symbol">${icon('car')}</span><h2>Restore your garage</h2><p>Choose a Maintainr JSON backup from this or another device. You can review its contents before replacing your garage.</p><p>Backups from the earlier version of Maintainr are supported. CSV files are for spreadsheets and cannot restore a garage.</p><label class="button button-primary" for="import-data">Choose JSON backup</label><input id="import-data" type="file" accept="application/json,.json" class="backup-input"><div id="import-preview"></div></section></div><section class="panel backup-panel"><h2>About your data</h2><p>${data.vehicles.length} vehicles · ${data.services.length} services · ${data.expenses.length} expenses</p><p>There are no accounts or cloud sync. Clearing site data or losing your device can remove your garage. Private browsing is temporary.</p><p id="storage-status">Checking device storage…</p><button class="button button-quiet" id="persist-storage">Keep storage on this device</button><p class="hint">Your browser decides whether persistent storage can be granted. Exported backups remain your recovery option.</p></section>`;
}
function downloadFile(contents, filename, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function exportGarage() {
  try {
    const now = new Date().toISOString();
    const backup = JSON.stringify(createBackup(data, now), null, 2);
    downloadFile(backup, `maintainr-backup-${localDate()}.json`, 'application/json');
    if (await saveData({ ...data, lastExportAt: now })) { render(); toast('Backup export requested. Keep the file somewhere safe.'); }
  } catch (error) { toast(`Export failed: ${error.message}`); }
}
function expenseCSV() {
  const cell = value => {
    // Prevent spreadsheet formulas in user-entered text.
    const text = String(value ?? ''); const safe = /^[=+@\-\t\r\n]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const rows = [['Vehicle', 'Title', 'Category', 'Date', 'Odometer (mi)', 'Amount (USD)', 'Vendor', 'Notes'], ...data.expenses.map(e => [data.vehicles.find(v => v.id === e.vehicleId)?.nickname, e.title, e.category, e.date, e.mileage, (e.amountCents / 100).toFixed(2), e.shop, e.notes])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
async function showStorageStatus() {
  const node = document.querySelector('#storage-status'); if (!node) return;
  try { const persistent = await navigator.storage?.persisted?.(); node.textContent = persistent ? 'Persistent storage is granted on this device.' : 'Storage is managed by your browser. Keep exported backups.'; }
  catch { node.textContent = 'Your browser does not report storage status. Keep exported backups.'; }
}
function bindInteractions() {
  const removeSamples = document.querySelector('#remove-samples');
  if (removeSamples) removeSamples.onclick = async () => {
    if (!confirm('Remove the original demo records? Records with different titles, mileages, or costs will be kept. The sample vehicle is removed only if unchanged and has no remaining records.')) return;
    const samples = sampleRecords();
    const ids = new Set([...samples.services, ...samples.expenses].map(r => r.id));
    const next = structuredClone(data);
    next.services = next.services.filter(r => !ids.has(r.id)); next.expenses = next.expenses.filter(r => !ids.has(r.id));
    const car = next.vehicles.find(v => v.id === 'car-1');
    if (car && car.make === 'Volvo' && car.model === 'V60 Cross Country' && car.year === 2021 && car.mileage === 42860 && car.nickname === 'The daily' && car.plate === '••• 4821' && ![...next.services, ...next.expenses].some(r => r.vehicleId === car.id)) next.vehicles = next.vehicles.filter(v => v.id !== car.id);
    if (!next.vehicles.some(v => v.id === next.activeVehicleId)) next.activeVehicleId = next.vehicles[0]?.id || null;
    if (await saveData(next)) { render(); toast('Demo records removed.'); }
  };

  document.querySelectorAll('[data-page]').forEach(el => el.onclick = event => { event.preventDefault(); location.hash = el.dataset.page; });
  document.querySelectorAll('[data-update-mileage]').forEach(el => el.onclick = () => openDialog('mileage', activeVehicle().id));
  document.querySelectorAll('[data-add]').forEach(el => el.onclick = () => openDialog(activeVehicle() ? el.dataset.add : 'vehicle'));
  document.querySelectorAll('[data-filter]').forEach(el => el.onclick = () => { scheduleFilter = el.dataset.filter; render(); });
  document.querySelectorAll('[data-edit]').forEach(el => el.onclick = () => openDialog(el.dataset.type, el.dataset.edit));
  document.querySelectorAll('[data-delete]').forEach(el => el.onclick = async () => {
    const type = el.dataset.type;
    if (!confirm(type === 'vehicle' ? 'Delete this vehicle and all its services and expenses? Export a backup first if you need a copy.' : 'Delete this record?')) return;
    const next = deleteRecord(data, type, el.dataset.delete);
    if (await saveData(next)) { render(); toast('Record deleted.'); }
  });
  document.querySelectorAll('[data-complete]').forEach(el => el.onclick = () => openDialog('complete', el.dataset.complete));
  const select = document.querySelector('#expense-filter'); if (select) select.onchange = () => { expenseFilter = select.value; render(); };
  const vehicleSelect = document.querySelector('#vehicle-select'); if (vehicleSelect) vehicleSelect.onchange = async () => { const next = structuredClone(data); next.activeVehicleId = vehicleSelect.value; if (await saveData(next)) { expenseFilter = 'all'; render(); } };
  document.querySelectorAll('[aria-label="Notifications"]').forEach(el => el.onclick = () => { currentPage = 'schedule'; scheduleFilter = 'upcoming'; history.replaceState(null, '', '#schedule'); render(); toast(`${upcomingServices().filter(isDue).length} services due by date or mileage. Reminders appear here when you open the app.`); });
  const exportButton = document.querySelector('#export-data'); if (exportButton) exportButton.onclick = exportGarage;
  const csvButton = document.querySelector('#export-csv'); if (csvButton) csvButton.onclick = () => downloadFile(expenseCSV(), `maintainr-expenses-${localDate()}.csv`, 'text/csv;charset=utf-8');
  const importInput = document.querySelector('#import-data');
  if (importInput) importInput.onchange = async event => {
    pendingImport = null;
    const preview = document.querySelector('#import-preview'); preview.replaceChildren();
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 10 MB limit.');
      const candidate = parseBackup(await file.text()); pendingImport = candidate;
      const total = candidate.expenses.reduce((sum, e) => sum + e.amountCents, 0);
      preview.innerHTML = `<div class="import-preview"><h3>Ready to restore</h3><p>${escapeText(file.name)}</p><p>${candidate.vehicles.length} vehicles · ${candidate.services.length} services · ${candidate.expenses.length} expenses</p><p>Total expenses: ${fmtCurrency(total / 100)}</p><p role="note">Restoring replaces every record currently on this device. Export your current garage first if you need a copy.</p><button class="button button-primary" id="confirm-import">Replace garage with this backup</button><button class="button button-quiet" id="cancel-import">Cancel</button></div>`;
      document.querySelector('#cancel-import').onclick = () => { pendingImport = null; preview.replaceChildren(); };
      document.querySelector('#confirm-import').onclick = async () => {
        const selected = pendingImport; if (!selected) return;
        if (!confirm('Replace all current vehicles, services and expenses with this backup?')) return;
        // A restore is not a new export on this device.
        if (await saveData({ ...selected, lastExportAt: null })) { pendingImport = null; expenseFilter = 'all'; render(); toast('Garage restored.'); }
      };
    } catch (error) { pendingImport = null; preview.textContent = `Import failed: ${error.message}`; preview.setAttribute('role', 'alert'); }
    finally { event.target.value = ''; }
  };
  const persist = document.querySelector('#persist-storage');
  if (persist) persist.onclick = async () => { try { const granted = await navigator.storage?.persist?.(); toast(granted ? 'Persistent storage granted.' : 'Your browser has not granted persistent storage. Keep backups.'); await showStorageStatus(); } catch { toast('Storage permission could not be requested.'); } };
  showStorageStatus();
}
const serviceTemplates = [
  { title: 'Oil & filter change', category: 'Oil & fluids' },
  { title: 'Tire rotation', category: 'Tires' },
  { title: 'Tire replacement', category: 'Tires' },
  { title: 'Brake inspection', category: 'Inspection' },
  { title: 'Vehicle inspection', category: 'Inspection' },
  { title: 'Engine air filter replacement', category: 'Maintenance' },
  { title: 'Cabin air filter replacement', category: 'Maintenance' },
  { title: 'Coolant service', category: 'Oil & fluids' },
  { title: 'Spark plug replacement', category: 'Maintenance' },
];
let editingId = null;
const dialog = document.querySelector('#record-dialog');
function openDialog(type, id = null) {
  pendingRecordType = type; editingId = id;
  const key = type === 'vehicle' || type === 'mileage' ? 'vehicles' : type === 'expense' ? 'expenses' : 'services';
  const record = id ? data[key].find(i => i.id === id) : null;
  document.querySelector('#dialog-kicker').textContent = 'MY GARAGE';
  document.querySelector('#dialog-title').textContent = type === 'complete' ? 'Complete service' : type === 'mileage' ? 'Update mileage' : `${id ? 'Edit' : 'Add'} ${type}`;
  document.querySelector('#form-fields').innerHTML = type === 'mileage' ? `<p>Enter the current odometer reading for ${escapeText(record.nickname)}. You can also correct an earlier entry.</p><div class="form-grid">${field('Current mileage (mi)', 'mileage', 'number', record.mileage, 'min="0" max="1000000000" step="1"')}</div>` : type === 'complete' ? `<p>Record when this work was done. Optionally log its cost.${record?.recurrenceUnit ? ` The next service will be scheduled ${record.recurrenceInterval.toLocaleString()} ${record.recurrenceUnit} after completion.` : ''}</p><div class="form-grid">${field('Completed on', 'date', 'date', localDate(), `max="${localDate()}"`)}${field('Odometer (mi)', 'mileage', 'number', activeVehicle().mileage, 'min="0" step="1"')}${field('Cost (USD)', 'amount', 'number', '', 'min="0.01" step="0.01" placeholder="Optional"')}${field('Shop / vendor', 'shop', 'text', '', 'placeholder="Optional"')}</div>` : formMarkup(type);
  if (type === 'service' && !id) {
    const fields = document.querySelector('#form-fields');
    fields.insertAdjacentHTML('afterbegin', `<div class="form-field service-template"><label for="service-template">Start with a template (optional)</label><select id="service-template"><option value="">Custom service</option>${serviceTemplates.map((template, index) => `<option value="${index}">${escapeText(template.title)}</option>`).join('')}</select><span class="hint">Choosing a template fills the name and category. Set the schedule and repeat interval using your vehicle’s manual.</span></div>`);
    fields.querySelector('#service-template').addEventListener('change', event => {
      if (event.target.value === '') return;
      const template = serviceTemplates[Number(event.target.value)];
      fields.querySelector('#field-title').value = template.title;
      fields.querySelector('#field-category').value = template.category;
    });
  }
  if (record && type !== 'complete') for (const [name, value] of Object.entries(record)) { const input = document.querySelector('#record-form').elements.namedItem(name); if (input) input.value = value ?? ''; }
  if (type === 'vehicle') document.querySelector('.photo-remove').hidden = !record?.photo;
  if (type === 'service') document.querySelector('#field-recurrenceUnit').addEventListener('change', event => { if (!event.target.value) document.querySelector('#field-recurrenceInterval').value = ''; });
  document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
  if (record && type === 'expense') document.querySelector('#record-form').elements.namedItem('amount').value = (record.amountCents / 100).toFixed(2);
  dialog.showModal();
}
function field(label, name, type = 'text', value = '', extra = '') { const required = extra.includes('placeholder="Optional"') ? '' : 'required'; return `<div class="form-field"><label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" type="${type}" value="${escapeAttr(value)}" ${extra} ${required} /></div>`; }
function formMarkup(type) { if (type === 'service') return `<div class="form-grid">${field('Service name', 'title', 'text', '', 'placeholder="e.g. Oil & filter change"')}${field('Due date (optional)', 'date', 'date', '', 'placeholder="Optional"')}${field('Due at odometer (mi, optional)', 'mileage', 'number', '', 'min="0" step="1" placeholder="Optional"')}${field('Or due in (miles, optional)', 'dueInMiles', 'number', '', 'min="0" step="1" placeholder="Optional"')}<p class="form-field full hint">Use an odometer reading or miles from now, such as 6000. Date and mileage can both be left blank.</p><div class="form-field"><label for="field-category">Category</label><select id="field-category" name="category"><option>Maintenance</option><option>Oil & fluids</option><option>Tires</option><option>Inspection</option><option>Repair</option></select></div><div class="form-field"><label for="field-recurrenceUnit">Repeat automatically (optional)</label><select id="field-recurrenceUnit" name="recurrenceUnit"><option value="">Does not repeat</option><option value="miles">Every set number of miles</option><option value="months">Every set number of months</option></select></div>${field('Repeat interval', 'recurrenceInterval', 'number', '', 'min="1" step="1" placeholder="Optional"')}<p class="form-field full hint">To repeat this service, choose miles or months and enter an interval. Completing the service schedules the next one from the completion mileage or date.</p><div class="form-field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" placeholder="Optional details, parts, or reminders"></textarea></div></div>`; if (type === 'expense') return `<div class="form-grid">${field('Service or repair', 'title', 'text', '', 'placeholder="e.g. Brake pad replacement"')}${field('Amount (USD)', 'amount', 'number', '', 'min="0.01" step="0.01" placeholder="0.00"')}${field('Date', 'date', 'date', localDate())}${field('Odometer (mi)', 'mileage', 'number', activeVehicle().mileage, 'min="0" step="1"')}<div class="form-field"><label for="field-category">Category</label><select id="field-category" name="category"><option>Maintenance</option><option>Repair</option><option>Tires</option><option>Inspection</option><option>Other</option></select></div>${field('Shop / vendor', 'shop', 'text', '', 'placeholder="Optional"')}<div class="form-field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" placeholder="Optional details or parts replaced"></textarea></div></div>`; return `<div class="form-grid">${field('Make', 'make', 'text', '', 'placeholder="e.g. Volvo"')}${field('Model', 'model', 'text', '', 'placeholder="e.g. V60"')}${field('Year', 'year', 'number', new Date().getFullYear(), 'min="1900" max="2099" step="1"')}${field('Current mileage', 'mileage', 'number', '0', 'min="0"')}${field('Nickname', 'nickname', 'text', '', 'placeholder="Optional"')}${field('License plate', 'plate', 'text', '', 'placeholder="Optional"')}<div class="form-field full"><label for="vehicle-photo">Vehicle photo (optional)</label><input id="vehicle-photo" type="file" accept="image/jpeg,image/png,image/webp"><span class="hint">JPEG, PNG or WebP, up to 10 MB. The photo is resized and stored on this device.</span><label class="photo-remove"><input id="remove-photo" type="checkbox"> Remove current photo</label></div></div>`; }
async function prepareVehiclePhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a JPEG, PNG or WebP photo no larger than 10 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('This photo could not be opened.')); img.src = url; });
    const scale = Math.min(1, 960 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('This browser could not process the photo.');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5, 0.35]) { const result = canvas.toDataURL('image/jpeg', quality); if (result.length <= 400000) return result; }
    throw new Error('This photo is too detailed to save. Try a smaller image.');
  } finally { URL.revokeObjectURL(url); }
}
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => dialog.close()));
document.querySelector('#record-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  for (const input of form.querySelectorAll('input[required]')) input.setCustomValidity(input.type === 'text' && !input.value.trim() ? 'Please enter a value.' : '');
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  for (const key of Object.keys(values)) values[key] = values[key].trim();
  const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    if (pendingRecordType === 'vehicle') {
      const file = form.querySelector('#vehicle-photo').files[0];
      if (file && form.querySelector('#remove-photo').checked) throw new Error('Choose a new photo or remove the current one.');
      if (file) values.photo = await prepareVehiclePhoto(file);
      else if (form.querySelector('#remove-photo').checked) values.photo = null;
    }
    const vehicle = pendingRecordType === 'mileage' ? data.vehicles.find(item => item.id === editingId) : null;
    if (pendingRecordType === 'mileage' && !vehicle) throw new Error('This vehicle no longer exists.');
    const next = pendingRecordType === 'mileage' ? applyRecord(data, 'vehicle', { ...vehicle, mileage: values.mileage }, editingId) : applyRecord(data, pendingRecordType, values, editingId);
    if (pendingRecordType === 'vehicle' && new TextEncoder().encode(JSON.stringify(createBackup(next))).length > MAX_BACKUP_BYTES) throw new Error('The garage is too large for a backup. Remove a photo before saving.');
    if (!await saveData(next)) return;
    currentPage = pendingRecordType === 'mileage' ? currentPage : pendingRecordType === 'vehicle' ? 'vehicles' : pendingRecordType === 'expense' ? 'costs' : 'schedule'; history.replaceState(null, '', `#${currentPage}`);
    dialog.close(); render(); toast('Saved to this device.');
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
});
document.querySelector('#record-form').addEventListener('input', event => event.target.setCustomValidity?.(''));
window.addEventListener('hashchange', () => { const page = location.hash.slice(1); currentPage = ['dashboard', 'vehicles', 'schedule', 'costs', 'backups'].includes(page) ? page : 'dashboard'; render(); });
function toast(message) { document.querySelector('.toast')?.remove(); const node = document.createElement('div'); node.className = 'toast'; node.setAttribute('role', 'status'); node.textContent = message; document.body.append(node); setTimeout(() => node.remove(), 2600); }
const requestedPage = location.hash.slice(1); if (['dashboard', 'vehicles', 'schedule', 'costs', 'backups'].includes(requestedPage)) currentPage = requestedPage;
async function boot(skipLegacy = false) {
  document.querySelector('#app').innerHTML = '<main class="startup"><h1>Opening your garage…</h1><p>Loading saved records on this device.</p></main>';
  try {
    const SQL = await window.initSqlJs({ locateFile: file => `/vendor/sql.js/${file}` });
    repository = new GarageRepository(SQL, new BrowserDatabaseFile());
    data = await repository.open(() => {
      if (skipLegacy) return null;
      const stored = localStorage.getItem('maintainr-data');
      return stored ? parseBackup(stored) : null;
    });
    render();
  } catch (error) {
    document.querySelector('#app').innerHTML = `<main class="startup panel"><h1>Your garage could not be opened</h1><p role="alert">${escapeText(error.message)}</p><p>Your saved database has not been replaced. Reload to retry.</p><button class="button button-primary" id="retry-start">Retry</button><button class="button button-quiet" id="legacy-export">Download original browser records</button><button class="button button-quiet" id="skip-legacy">Continue without old browser records</button></main>`;
    document.querySelector('#retry-start').onclick = () => location.reload();
    document.querySelector('#legacy-export').onclick = () => { const raw = localStorage.getItem('maintainr-data'); if (raw) downloadFile(raw, 'maintainr-original-records.json', 'application/json'); else toast('No records from the old version were found.'); };
    document.querySelector('#skip-legacy').onclick = () => { if (confirm('Open without migrating old browser records? The original browser records will remain untouched. An existing SQLite database will still be opened.')) boot(true); };
  }
}
// Refresh when returning from another app/tab, without replacing an open form.
window.addEventListener('focus', async () => {
  if (!repository?.db || dialog.open || saving) return;
  try { data = await repository.refresh(); render(); } catch (error) { toast(error.message); }
});
boot();
