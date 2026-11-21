// Fails fast if the app's inline module script has a syntax error.
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os'; import path from 'node:path';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
const f = path.join(await mkdtemp(path.join(os.tmpdir(), 'bl-')), 'app.mjs');
await writeFile(f, m[1]);
execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log('syntax: ok');
