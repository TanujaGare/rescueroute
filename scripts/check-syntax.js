// Dependency-free lint: syntax-checks every JS file and flags debugging leftovers.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOTS = ['src', 'public', 'scripts', 'tests'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
ROOTS.forEach(walk);

let problems = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    problems += 1;
    console.error(`${file}: syntax error\n${err.stderr}`);
  }
  const src = readFileSync(file, 'utf8');
  if (!file.endsWith('check-syntax.js') && /\bdebugger\b/.test(src)) { problems += 1; console.error(`${file}: contains debugger`); }
  if (file.startsWith('public') && /\.innerHTML\s*=/.test(src)) { problems += 1; console.error(`${file}: innerHTML assignment (XSS risk)`); }
}
console.log(`Checked ${files.length} files, ${problems} problem(s).`);
process.exit(problems ? 1 : 0);
