import { Store, restore } from './store.js';

const [command, ...args] = process.argv.slice(2);
const database = process.env.LABEL_DB || './data/label-service.sqlite';
try {
  if (command === 'audit') {
    const store = new Store(database, { readOnly: true });
    try { const audit = store.audit(); console.log(JSON.stringify(audit, null, 2)); process.exitCode = audit.ok ? 0 : 1; } finally { store.close(); }
  } else if (command === 'backup' && args[0]) {
    const store = new Store(database, { readOnly: true });
    try { await store.backup(args[0]); console.log(`Backup written to ${args[0]}.`); } finally { store.close(); }
  } else if (command === 'restore' && args[0] && args[1]) {
    console.log(JSON.stringify(await restore(args[0], args[1]), null, 2));
  } else {
    console.log('Usage: node src/cli.js audit | backup <file> | restore <backup> <new-database>');
    process.exitCode = 2;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
