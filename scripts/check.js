import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
}
for (const file of ['src', 'scripts', 'test', 'web'].flatMap(files).filter(f => f.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const test = spawnSync(process.execPath, ['--test', '--test-timeout=20000'], { stdio: 'inherit' });
if (test.status !== 0) process.exit(test.status || 1);
const diff = spawnSync('git', ['diff', '--check'], { stdio: 'inherit' });
process.exit(diff.status || 0);
