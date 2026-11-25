export const BACKUP_FORMAT = 'maintainr-backup';
export const BACKUP_VERSION = 4;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const localDate = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const emptyGarage = () => ({ version: 6, vehicles: [], services: [], expenses: [], activeVehicleId: null, lastExportAt: null });
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
  if ((value == null || value === '') && optional) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) !== value) fail(`Invalid ${name}.`);
  return value;
}
export function moneyToCents(value) {
  const input = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(input)) fail('Enter an amount with no more than two decimal places.');
  const [whole, fraction = ''] = input.split('.');
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), 'amount', 1);
}
function photo(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 400000 || !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('Invalid vehicle photo.');
  return value;
}
export function normalizeGarage(input) {
  if (!input || !['vehicles', 'services', 'expenses'].every(k => Array.isArray(input[k]))) fail('This file does not contain a garage.');
  if (input.version != null && ![1, 2, 3, 4, 5, 6].includes(input.version)) fail('This garage uses a newer, unsupported data version.');
  if (input.vehicles.length + input.services.length + input.expenses.length > 50000) fail('Too many records in this backup.');
  const current = input.version >= 3;
  const ids = new Set();
  const id = r => { if (!r || typeof r !== 'object') fail('Invalid record.'); const v = text(r.id, 'record ID', true); if (ids.has(v)) fail('Duplicate record IDs.'); ids.add(v); return v; };
  const vehicles = input.vehicles.map(v => ({ id: id(v), make: text(v.make, 'make', true), model: text(v.model, 'model', true), year: integer(v.year, 'model year', 1900, 2099), nickname: text(v.nickname, 'nickname') || `${v.make} ${v.model}`, plate: text(v.plate, 'license plate'), mileage: integer(v.mileage, 'mileage'), createdAt: date(v.createdAt, 'creation date', true), photo: photo(v.photo) }));
  const vehicleIds = new Set(vehicles.map(v => v.id));
  const vehicleId = r => { const v = r.vehicleId || (!current && input.version !== 2 ? vehicles[0]?.id : null); if (!vehicleIds.has(v)) fail('A record refers to a missing vehicle.'); return v; };
  const services = input.services.map(s => {
    if (s.done != null && typeof s.done !== 'boolean') fail('Invalid completion status.');
    const completedDate = date(s.completedDate, 'completion date', true);
    if (completedDate && !s.done) fail('An upcoming service cannot have completion details.');
    const recurrenceUnit = s.recurrenceUnit || null;
    if (recurrenceUnit && !['miles', 'months'].includes(recurrenceUnit)) fail('Invalid repeat unit.');
    const recurrenceInterval = recurrenceUnit ? integer(s.recurrenceInterval, 'repeat interval', 1, recurrenceUnit === 'months' ? 1200 : 1_000_000_000) : null;
    if (!recurrenceUnit && s.recurrenceInterval != null && s.recurrenceInterval !== '') fail('Choose a repeat unit.');
    return { recurrenceUnit, recurrenceInterval, id: id(s), vehicleId: vehicleId(s), title: text(s.title, 'service title', true), category: text(s.category, 'category') || 'Maintenance', date: date(s.date, 'due date', true), mileage: s.mileage == null || s.mileage === '' ? null : integer(s.mileage, 'due mileage'), notes: text(s.notes, 'notes'), done: !!s.done, completedDate, completedMileage: completedDate ? integer(s.completedMileage, 'completion mileage') : null };
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
  return { version: 6, vehicles, services, expenses, activeVehicleId: vehicleIds.has(input.activeVehicleId) ? input.activeVehicleId : vehicles[0]?.id || null, lastExportAt };
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
    if (![1, 2, 3, BACKUP_VERSION].includes(value.schemaVersion)) fail('Unsupported backup format. Update Maintainr before importing this file.');
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
    if (old.recurrenceUnit) {
      let nextDate = null, nextMileage = null;
      if (old.recurrenceUnit === 'miles') nextMileage = integer(Number(values.mileage) + old.recurrenceInterval, 'next due mileage');
      else {
        const [year, month, day] = values.date.split('-').map(Number);
        const target = new Date(Date.UTC(year, month - 1 + old.recurrenceInterval, 1));
        const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
        target.setUTCDate(Math.min(day, lastDay));
        nextDate = target.toISOString().slice(0, 10);
        date(nextDate, 'next due date');
      }
      next.services.push({ ...old, id: idFactory(), date: nextDate, mileage: nextMileage, done: false, completedDate: null, completedMileage: null });
    }
    if (values.amount) next.expenses.push({ id: idFactory(), vehicleId: old.vehicleId, serviceId: id, title: old.title, category: old.category === 'Repair' ? 'Repair' : 'Maintenance', date: values.date, mileage: Number(values.mileage), amountCents: moneyToCents(values.amount), shop: values.shop || '', notes: old.notes });
  } else {
    const record = { ...old, ...values, id, mileage: Number(values.mileage) };
    delete record.amount;
    if (type === 'service') {
      record.mileage = values.mileage == null || values.mileage === '' ? null : Number(values.mileage);
      if (values.dueInMiles != null && values.dueInMiles !== '') {
        if (record.mileage != null) fail('Enter either the due odometer or miles from now, not both.');
        const car = next.vehicles.find(v => v.id === (old?.vehicleId || vehicleId));
        if (!car) fail('Select a vehicle first.');
        record.mileage = car.mileage + integer(Number(values.dueInMiles), 'miles from now');
      }
      record.date = values.date || null;
      record.recurrenceUnit = values.recurrenceUnit || null;
      record.recurrenceInterval = record.recurrenceUnit ? Number(values.recurrenceInterval) : (values.recurrenceInterval ? Number(values.recurrenceInterval) : null);
    }
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

export function serviceTiming(service, currentMileage, today = localDate()) {
  const days = service.date ? Math.round((Date.parse(service.date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) : null;
  const miles = service.mileage == null ? null : service.mileage - currentMileage;
  const due = !service.done && ((days != null && days <= 0) || (miles != null && miles <= 0));
  const soon = !service.done && days != null && days > 0 && days <= 7;
  const label = service.done ? 'Completed' : due ? 'Due' : days == null && miles == null ? 'Unscheduled' : soon ? 'Due soon' : 'Scheduled';
  const parts = [];
  if (miles != null) parts.push(miles < 0 ? `${Math.abs(miles).toLocaleString()} mi overdue` : miles === 0 ? 'Mileage due' : `In ${miles.toLocaleString()} mi`);
  if (days != null) parts.push(days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? 'Due today' : `In ${days} days`);
  return { due, soon, label, description: parts.join(' · ') || 'No date or mileage set' };
}
export function compareServices(a, b, currentMileage) {
  const priority = Number(serviceTiming(b, currentMileage).due) - Number(serviceTiming(a, currentMileage).due);
  if (priority) return priority;
  if (a.date && b.date) return a.date.localeCompare(b.date);
  if (a.date || b.date) return a.date ? -1 : 1;
  return (a.mileage ?? Infinity) - (b.mileage ?? Infinity) || a.title.localeCompare(b.title);
}
