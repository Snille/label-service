import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { InputError, validatePrinting, validatePrintJob } from './validation.js';
import { defaultLabelStyles, printerModel, allMedia } from './label-media.js';

const schema = `
CREATE TABLE settings (id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY NOT NULL, token_hash TEXT UNIQUE NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record) AND json_extract(record, '$.id') = id AND json_extract(record, '$.tokenHash') = token_hash)
) STRICT;
PRAGMA user_version = 1;
`;
// Version 2 adds saved label templates: one row per template version, never rewritten except for its status.
const templatesSchema = `
CREATE TABLE templates (
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1),
  record TEXT NOT NULL CHECK(json_valid(record) AND json_extract(record, '$.id') = id AND json_extract(record, '$.version') = version),
  PRIMARY KEY (id, version)
) STRICT;
PRAGMA user_version = 2;
`;
// Version 3 adds pictures for labels: the record (name, size, who uploaded it) and the picture as PNG.
const assetsSchema = `
CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL CHECK(json_valid(record) AND json_extract(record, '$.id') = id), png BLOB NOT NULL
) STRICT;
PRAGMA user_version = 3;
`;
// Version 4 adds uploaded fonts: the record (family, style, who uploaded it) and the font file as uploaded.
const fontsSchema = `
CREATE TABLE fonts (
  id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL CHECK(json_valid(record) AND json_extract(record, '$.id') = id), data BLOB NOT NULL
) STRICT;
PRAGMA user_version = 4;
`;
const schemaVersion = 4;

// Settings saved before version 0.5 described one printer at the top level; they become the default printer.
export function migratePrinting(saved) {
  if (Array.isArray(saved.printers)) return saved;
  const id = (saved.queue || 'dymo').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'dymo';
  return { serverUrl: saved.serverUrl || '', defaultPrinter: id, batchLimit: 50,
    printers: [{ id, name: 'DYMO LabelWriter 5XL', model: 'lw5xl', enabled: saved.enabled, queue: saved.queue || '', mediaKey: saved.mediaKey, styles: saved.styles,
      ...(saved.rollReader ? { rollReader: saved.rollReader } : {}) }] };
}

export class Store {
  constructor(path, { readOnly = false } = {}) {
    this.path = path;
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    try {
      this.db.exec('PRAGMA trusted_schema = OFF;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > schemaVersion || (readOnly && version < 1)) throw new Error(`Unsupported database schema: ${version}`);
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        if (!version) this.transaction(() => this.db.exec(schema));
        if (version < 2) this.transaction(() => this.db.exec(templatesSchema));
        if (version < 3) this.transaction(() => this.db.exec(assetsSchema));
        if (version < 4) this.transaction(() => this.db.exec(fontsSchema));
      }
    } catch (error) { this.close(); throw error; }
  }

  close() { this.db.close(); }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  printing() {
    const row = this.db.prepare("SELECT record FROM settings WHERE id='printing'").get(); if (!row) return null;
    // Settings saved before a format was added get that format's defaults; formats no longer offered are dropped.
    const saved = migratePrinting(JSON.parse(row.record)), defaults = defaultLabelStyles(allMedia(saved));
    return { ...saved, rolls: saved.rolls || [], printers: saved.printers.map(printer => ({ ...printer, model: printerModel(printer.model) ? printer.model : 'lw5xl',
      styles: Object.fromEntries(Object.entries(defaults).map(([key, style]) => [key, printer.styles?.[key] || style])) })) };
  }
  writePrinting(config) {
    validatePrinting(config);
    this.db.prepare("INSERT INTO settings VALUES ('printing', ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record").run(JSON.stringify(config));
  }

  // The last 20 roll readings with the chip's raw answers, kept as one settings row (no schema change).
  rollReadings() { const row = this.db.prepare("SELECT record FROM settings WHERE id='roll-readings'").get(); return row ? JSON.parse(row.record).readings : []; }
  addRollReading(reading) {
    const readings = [reading, ...this.rollReadings()].slice(0, 20);
    this.db.prepare("INSERT INTO settings VALUES ('roll-readings', ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record").run(JSON.stringify({ readings }));
  }

  templateVersions(id) { return this.db.prepare('SELECT record FROM templates WHERE id=? ORDER BY version').all(id).map(row => JSON.parse(row.record)); }
  templateIds() { return this.db.prepare('SELECT DISTINCT id FROM templates ORDER BY id').all().map(row => row.id); }
  template(id, version) { const row = this.db.prepare('SELECT record FROM templates WHERE id=? AND version=?').get(id, version); return row ? JSON.parse(row.record) : null; }
  addTemplateVersion(record) {
    return this.transaction(() => {
      const next = (this.db.prepare('SELECT MAX(version) AS v FROM templates WHERE id=?').get(record.id).v || 0) + 1;
      const saved = { ...record, version: next, definition: { ...record.definition, id: record.id } };
      this.db.prepare('INSERT INTO templates VALUES (?, ?, ?)').run(saved.id, next, JSON.stringify(saved));
      return saved;
    });
  }
  assets() { return this.db.prepare("SELECT record FROM assets ORDER BY json_extract(record, '$.createdAt')").all().map(row => JSON.parse(row.record)); }
  asset(id) { const row = this.db.prepare('SELECT record FROM assets WHERE id=?').get(id); return row ? JSON.parse(row.record) : null; }
  assetPng(id) { const row = this.db.prepare('SELECT png FROM assets WHERE id=?').get(id); return row ? Buffer.from(row.png) : null; }
  addAsset(record, png) { this.db.prepare('INSERT INTO assets VALUES (?, ?, ?)').run(record.id, JSON.stringify(record), png); return record; }
  deleteAsset(id) { return this.db.prepare('DELETE FROM assets WHERE id=?').run(id).changes; }
  fonts() { return this.db.prepare("SELECT record FROM fonts ORDER BY json_extract(record, '$.family'), json_extract(record, '$.style')").all().map(row => JSON.parse(row.record)); }
  font(id) { const row = this.db.prepare('SELECT record FROM fonts WHERE id=?').get(id); return row ? JSON.parse(row.record) : null; }
  fontData(id) { const row = this.db.prepare('SELECT data FROM fonts WHERE id=?').get(id); return row ? Buffer.from(row.data) : null; }
  fontFiles() { return this.db.prepare('SELECT record, data FROM fonts').all().map(row => ({ ...JSON.parse(row.record), data: Buffer.from(row.data) })); }
  addFont(record, data) { this.db.prepare('INSERT INTO fonts VALUES (?, ?, ?)').run(record.id, JSON.stringify(record), data); return record; }
  deleteFont(id) { return this.db.prepare('DELETE FROM fonts WHERE id=?').run(id).changes; }
  allTemplateVersions() { return this.db.prepare('SELECT record FROM templates').all().map(row => JSON.parse(row.record)); }
  deleteTemplate(id) { return this.db.prepare('DELETE FROM templates WHERE id=?').run(id).changes; }
  updateTemplateVersion(id, version, changes) {
    return this.transaction(() => {
      const before = this.template(id, version); if (!before) throw new InputError('Template version not found.', 404);
      const record = { ...before, ...changes, id, version, definition: before.definition };
      this.db.prepare('UPDATE templates SET record=? WHERE id=? AND version=?').run(JSON.stringify(record), id, version);
      return record;
    });
  }

  printJobs() { return this.db.prepare('SELECT record FROM print_jobs ORDER BY id').all().map(row => JSON.parse(row.record)); }
  printJob(id) { const row = this.db.prepare('SELECT record FROM print_jobs WHERE id=?').get(id); return row ? JSON.parse(row.record) : null; }
  claimPrint(record) {
    validatePrintJob(record);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT record FROM print_jobs WHERE id=? OR token_hash=?').get(record.id, record.tokenHash);
      if (existing) {
        const job = JSON.parse(existing.record);
        if (job.id !== record.id || job.tokenHash !== record.tokenHash) throw new InputError('This preview has already been submitted. Check its job status.', 409);
        return { claimed: false, job };
      }
      this.db.prepare('INSERT INTO print_jobs VALUES (?, ?, ?)').run(record.id, record.tokenHash, JSON.stringify(record));
      return { claimed: true, job: record };
    });
  }
  updatePrint(id, changes) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT record FROM print_jobs WHERE id=?').get(id);
      if (!row) throw new InputError('Print job not found.', 404);
      const before = JSON.parse(row.record), record = validatePrintJob({ ...before, ...changes });
      if (record.id !== before.id || record.tokenHash !== before.tokenHash) throw new InputError('Print job identity cannot change.');
      this.db.prepare('UPDATE print_jobs SET record=? WHERE id=?').run(JSON.stringify(record), id);
      return record;
    });
  }

  audit() {
    const errors = [];
    if (this.db.prepare('PRAGMA integrity_check').all().some(r => r.integrity_check !== 'ok')) errors.push('SQLite integrity check failed.');
    try { const printing = this.printing(); if (printing) validatePrinting(printing); } catch (error) { errors.push(`Invalid printing settings: ${error.message}`); }
    let invalidJobs = 0;
    for (const job of this.printJobs()) { try { validatePrintJob(job); } catch { invalidJobs++; } }
    if (invalidJobs) errors.push(`${invalidJobs} invalid print job record(s).`);
    let invalidTemplates = 0;
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 2) {
      for (const row of this.db.prepare('SELECT record FROM templates').all()) {
        const t = JSON.parse(row.record);
        if (!['draft', 'published', 'archived'].includes(t.status) || t.definition?.id !== t.id) invalidTemplates++;
      }
    }
    if (invalidTemplates) errors.push(`${invalidTemplates} invalid template record(s).`);
    const states = {};
    for (const job of this.printJobs()) states[job.state] = (states[job.state] || 0) + 1;
    return { ok: errors.length === 0, schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      counts: { printJobs: this.printJobs().length, ...states }, errors };
  }

  async backup(destination) {
    if (this.path !== ':memory:' && resolve(destination) === resolve(this.path)) throw new InputError('Backup destination must differ from the active database.');
    // Reserve the path atomically; never overwrite a previous backup.
    const fd = openSync(destination, 'wx', 0o600); closeSync(fd);
    // VACUUM INTO produces a consistent SQLite snapshot without copying live WAL files.
    try { this.db.prepare('VACUUM main INTO ?').run(resolve(destination)); }
    catch (error) { unlinkSync(destination); throw error; }
  }
}

export async function restore(source, destination) {
  if (!existsSync(source)) throw new InputError('Backup does not exist.');
  if (existsSync(destination)) throw new InputError('Restore destination already exists.', 409);
  const input = new Store(source, { readOnly: true });
  try {
    const audit = input.audit();
    if (!audit.ok) throw new InputError(`Backup audit failed: ${audit.errors.join(' ')}`);
    await input.backup(destination);
    return audit;
  } finally { input.close(); }
}
