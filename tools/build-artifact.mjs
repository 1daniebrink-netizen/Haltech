/*
 * Inline the CURRENT src/core.js into artifact/haltune.html.
 *
 *   node tools/build-artifact.mjs
 *
 * The artifact used to carry a hand-copied snapshot of the engine, which drifted
 * badly: it kept suggesting corrections in cells the local tools had blocked as
 * hardware-limited. This makes src/core.js the single source of truth for the
 * published page too, so that class of divergence cannot come back.
 *
 * The page runs a classic <script>, so the module's `export` keywords are
 * stripped. core.js is written with no imports and no DOM/Node access precisely
 * so this is a safe textual operation.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'src', 'core.js');
const PAGE = join(ROOT, 'artifact', 'haltune.html');

// Everything before this marker in the inline script is engine code and gets
// replaced wholesale. Everything from it on is the artifact's own UI.
const UI_MARKER = '/* Haltune UI.';

/* Inlined in dependency order. Local imports between them are stripped because
 * everything ends up in one scope; an import of anything OUTSIDE this set is a
 * hard error, since it would silently vanish. */
const PARTS = [
  ['src/core.js', join(ROOT, 'src', 'core.js')],
  ['src/panels.js', join(ROOT, 'src', 'panels.js')],
  ['src/charts.js', join(ROOT, 'src', 'charts.js')],
];

const pieces = [];
for (const [name, path] of PARTS) {
  let src = readFileSync(path, 'utf8').replace(/^﻿/, '');
  for (const line of src.match(/^\s*import\s.*$/gm) || []) {
    if (!/from\s+['"]\.\/(core|panels|charts)\.js['"]/.test(line)) {
      console.error(name + ' imports something outside the inline set:\n  ' + line.trim());
      process.exit(1);
    }
  }
  src = src
    .replace(/^\s*import\s.*$/gm, '')               // siblings share one scope
    .replace(/^export\s+/gm, '');                   // module -> classic script
  pieces.push('/* ---- ' + name + ' ---- */\n' + src.trim());
}
const inlined = pieces.join('\n\n');
const core = readFileSync(CORE, 'utf8');

const html = readFileSync(PAGE, 'utf8');
const sOpen = html.lastIndexOf('<scr' + 'ipt>');
const sClose = html.lastIndexOf('</scr' + 'ipt>');
if (sOpen < 0 || sClose < 0) { console.error('no inline <script> found'); process.exit(1); }

const body = html.slice(sOpen + 8, sClose);
const uiAt = body.indexOf(UI_MARKER);
if (uiAt < 0) {
  console.error('UI marker "' + UI_MARKER + '" not found — cannot tell engine from UI.');
  process.exit(1);
}

const oldCore = body.slice(0, uiAt);
const ui = body.slice(uiAt);

const header =
  '/* ===========================================================================\n'
  + ' * GENERATED — inlined from src/core.js, src/panels.js and src/charts.js by\n'
  + ' * tools/build-artifact.mjs. Do not edit this section by hand; edit the source\n'
  + ' * files and rebuild, or the published page silently drifts from the local\n'
  + ' * tools again — which is exactly what happened before.\n'
  + ' * =========================================================================== */\n\n';

const next = html.slice(0, sOpen + 8) + '\n' + header + inlined + '\n\n' + ui + html.slice(sClose);
writeFileSync(PAGE, next, 'utf8');

// Report what actually changed, since "it built" is not the same as "it differs".
const has = s => inlined.includes(s);
console.log('inlined src/core.js  ' + (oldCore.length / 1024).toFixed(1) + ' KB -> '
  + (inlined.length / 1024).toFixed(1) + ' KB');
console.log('page now ' + (next.length / 1024).toFixed(0) + ' KB');
console.log('\nengine features now present in the artifact:');
for (const f of ['VEHICLE', 'annotateLimits', 'checkLimits', 'resolveFuelReference',
                 'notOverrun', 'mapCeilingPsi', 'dutyLimited', 'ethMean',
                 'markFuelLiftTransients', 'throttleLifts']) {
  console.log('  ' + (has(f) ? '✓ ' : '✗ ') + f);
}
