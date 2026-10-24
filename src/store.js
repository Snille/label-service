import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { InputError, validatePrinting, validatePrintJob } from './validation.js';

const schema = `
CREATE TABLE settings (id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY NOT NULL, token_hash TEXT UNIQUE NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record) AND json_extract(record, '$.id') = id AND json_extract(record, '$.tokenHash') = token_hash)
) STRICT;
PRAGMA user_version = 1;
`;

export class Store {
  constructor(path, { readOnly = false } = {}) {
    this.path = path;
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    try {
      this.db.exec('PRAGMA trusted_schema = OFF;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1 || (readOnly && version !== 1)) throw new Error(`Unsupported database schema: ${version}`);
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        if (!version) this.transaction(() => this.db.exec(schema));
      }
    } catch (error) { this.close(); throw error; }
  }

  close() { this.db.close(); }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  printing() { const row = this.db.prepare("SELECT record FROM settings WHERE id='printing'").get(); return row ? JSON.parse(row.record) : null; }
  writePrinting(config) {
    validatePrinting(config);
    this.db.prepare("INSERT INTO settings VALUES ('printing', ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record").run(JSON.stringify(config));
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
