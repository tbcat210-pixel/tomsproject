import { execFileSync } from 'node:child_process';

const base = process.env.CACHED_COMMIT_REF;
const head = process.env.COMMIT_REF;

if (!base || !head || /^0+$/.test(base)) {
  process.exit(1);
}

let output = '';
try {
  output = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' });
} catch {
  process.exit(1);
}

const changed = output
  .split(/\r?\n/)
  .map(x => x.trim())
  .filter(Boolean);

if (changed.length === 0) {
  process.exit(0);
}

const dataOnly = changed.every(file => file.startsWith('docs/data/'));
process.exit(dataOnly ? 0 : 1);
