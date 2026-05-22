import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const dist = join(here, '..', 'dist');

mkdirSync(dist, { recursive: true });

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full);
    } else if (name.endsWith('.json') || name.endsWith('.html') || name.endsWith('.css')) {
      const rel = relative(src, full);
      const dest = join(dist, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(full, dest);
      console.log('copied', rel);
    }
  }
}

walk(src);
