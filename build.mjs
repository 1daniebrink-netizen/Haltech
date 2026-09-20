// Bundle src/core.js + src/app.js into the HTML template -> dist/Haltune.html
// Single self-contained file: no imports, no external requests, double-click to run.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(root, p), 'utf8');

let core = read('src/core.js')
  .replace(/^export\s+/gm, '');          // strip ES export keywords -> plain top-level consts/funcs

const app = read('src/app.js');
const tpl = read('src/template.html');

const out = tpl
  .replace('/*__CORE__*/', core)
  .replace('/*__APP__*/', app);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'Haltune.html'), out);
console.log(`built dist/Haltune.html  (${(out.length / 1024).toFixed(1)} KB)`);
