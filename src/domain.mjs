export const BACKUP_FORMAT = 'maintainr-backup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const localDate = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const emptyGarage = () => ({ version: 3, vehicles: [], services: [], expenses: [], activeVehicleId: null, lastExportAt: null });
const fail = message => { throw new Error(message); };
function text(value, name, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > 10000 || (required && !value.trim())) fail(`Invalid ${name}.`);
  return value.trim();
}
function integer(value, name, min = 0, max = 1_000_000_000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}.`);
  return value;
}
function date(value, name, optional = false) {
  if (!value && optional) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) !== value) fail(`Invalid ${name}.`);
  return value;
}
export function moneyToCents(value) {
  const input = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(input)) fail('Enter an amount with no more than two decimal places.');
  const [whole, fraction = ''] = input.split('.');
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), 'amount', 1);
}
export function normalizeGarage(input) {
  if (!input || !['vehicles', 'services', 'expenses'].every(k => Array.isArray(input[k]))) fail('This file does not contain a garage.');
  if (input.version != null && ![1, 2, 3].includes(input.version)) fail('This garage uses a newer, unsupported data version.');
  if (input.vehicles.length + input.services.length + input.expenses.length > 50000) fail('Too many records in this backup.');
  const current = input.version === 3;
  const ids = new Set();
  const id = r => { if (!r || typeof r !== 'object') fail('Invalid record.'); const v = text(r.id, 'record ID', true); if (ids.has(v)) fail('Duplicate record IDs.'); ids.add(v); return v; };
  const vehicles = input.vehicles.map(v => ({ id: id(v), make: text(v.make, 'make', true), model: text(v.model, 'model', true), year: integer(v.year, 'model year', 1900, 2099), nickname: text(v.nickname, 'nickname') || `${v.make} ${v.model}`, plate: text(v.plate, 'license plate'), mileage: integer(v.mileage, 'mileage'), createdAt: date(v.createdAt, 'creation date', true) }));
  const vehicleIds = new Set(vehicles.map(v => v.id));
  const vehicleId = r => { const v = r.vehicleId || (!current && input.version !== 2 ? vehicles[0]?.id : null); if (!vehicleIds.has(v)) fail('A record refers to a missing vehicle.'); return v; };
  const services = input.services.map(s => {
    if (s.done != null && typeof s.done !== 'boolean') fail('Invalid completion status.');
    const completedDate = date(s.completedDate, 'completion date', true);
    if (completedDate && !s.done) fail('An upcoming service cannot have completion details.');
    return { id: id(s), vehicleId: vehicleId(s), title: text(s.title, 'service title', true), category: text(s.category, 'category') || 'Maintenance', date: date(s.date, 'due date'), mileage: integer(s.mileage, 'due mileage'), notes: text(s.notes, 'notes'), done: !!s.done, completedDate, completedMileage: completedDate ? integer(s.completedMileage, 'completion mileage') : null };
  });
  const serviceMap = new Map(services.map(s => [s.id, s]));
  const linked = new Set();
  const expenses = input.expenses.map(e => {
    const recordId = id(e), owner = vehicleId(e), serviceId = e.serviceId || null;
    if (serviceId && (!serviceMap.has(serviceId) || serviceMap.get(serviceId).vehicleId !== owner)) fail('An expense refers to a missing service or a different vehicle.');
    if (serviceId && linked.has(serviceId)) fail('Duplicate expense for a completed service.');
    if (serviceId) linked.add(serviceId);
    // Legacy dollar values are rounded once during migration; new records use integer cents.
    if (!current && (typeof e.amount !== 'number' || !Number.isFinite(e.amount) || e.amount < 0)) fail('Invalid legacy amount.');
    const amountCents = current ? integer(e.amountCents, 'amount', 0) : integer(Math.round(e.amount * 100), 'legacy amount', 0);
    return { id: recordId, vehicleId: owner, serviceId, title: text(e.title, 'expense title', true), category: text(e.category, 'category') || 'Maintenance', date: date(e.date, 'expense date'), mileage: integer(e.mileage, 'odometer'), amountCents, shop: text(e.shop, 'vendor'), notes: text(e.notes, 'notes') };
  });
  const lastExportAt = input.lastExportAt || null;
  if (lastExportAt && (typeof lastExportAt !== 'string' || !Number.isFinite(Date.parse(lastExportAt)))) fail('Invalid export timestamp.');
  return { version: 3, vehicles, services, expenses, activeVehicleId: vehicleIds.has(input.activeVehicleId) ? input.activeVehicleId : vehicles[0]?.id || null, lastExportAt };
}
export function createBackup(garage, now = new Date().toISOString()) {
  const normalized = normalizeGarage(garage);
  return { format: BACKUP_FORMAT, schemaVersion: BACKUP_VERSION, exportedAt: now, ...normalized };
}
export function parseBackup(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BACKUP_BYTES) fail('Backup exceeds the 10 MB limit.');
  let value;
  try { value = JSON.parse(raw); } catch { fail('This is not a valid JSON file.'); }
  if (value?.format != null) {
    if (value.format !== BACKUP_FORMAT) fail('This is not a Maintainr backup.');
    if (value.schemaVersion !== BACKUP_VERSION) fail('Unsupported backup format. Update Maintainr before importing this file.');
    if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) fail('Invalid backup export date.');
  } else if (!value || ![undefined, 1, 2].includes(value.version)) fail('Unrecognized backup format.');
  return normalizeGarage(value);
}
export function applyRecord(garage, type, values, editingId = null, idFactory = () => crypto.randomUUID()) {
  const next = structuredClone(garage), id = editingId || idFactory();
  const vehicleId = next.activeVehicleId;
  const key = type === 'vehicle' ? 'vehicles' : type === 'expense' ? 'expenses' : 'services';
  const old = next[key].find(r => r.id === id);
  if (editingId && !old) fail('This record no longer exists. Reopen it and try again.');
  if (type === 'complete') {
    if (old.done) fail('This service is already complete.');
    if (values.date > localDate()) fail('Completion date cannot be in the future.');
    Object.assign(old, { done: true, completedDate: values.date, completedMileage: Number(values.mileage) });
    if (values.amount) next.expenses.push({ id: idFactory(), vehicleId: old.vehicleId, serviceId: id, title: old.title, category: old.category === 'Repair' ? 'Repair' : 'Maintenance', date: values.date, mileage: Number(values.mileage), amountCents: moneyToCents(values.amount), shop: values.shop || '', notes: old.notes });
  } else {
    const record = { ...old, ...values, id, mileage: Number(values.mileage) };
    delete record.amount;
    if (type === 'vehicle') { record.year = Number(values.year); record.createdAt = old?.createdAt || localDate(); record.nickname ||= `${values.make} ${values.model}`; next.activeVehicleId = id; }
    else { record.vehicleId = old?.vehicleId || vehicleId; if (type === 'expense') record.amountCents = moneyToCents(values.amount); else record.done = old?.done || false; }
    if (old) Object.assign(old, record); else next[key].push(record);
  }
  if (type === 'expense' || type === 'complete') { const car = next.vehicles.find(v => v.id === (old?.vehicleId || vehicleId)); if (!car) fail('Select a vehicle first.'); car.mileage = Math.max(car.mileage, Number(values.mileage)); }
  return normalizeGarage(next);
}
export function deleteRecord(garage, type, id) {
  const next = structuredClone(garage), key = type === 'vehicle' ? 'vehicles' : type === 'service' ? 'services' : 'expenses';
  next[key] = next[key].filter(r => r.id !== id);
  if (type === 'vehicle') { next.services = next.services.filter(r => r.vehicleId !== id); next.expenses = next.expenses.filter(r => r.vehicleId !== id); }
  if (type === 'service') next.expenses.forEach(e => { if (e.serviceId === id) e.serviceId = null; });
  return normalizeGarage(next);
}
