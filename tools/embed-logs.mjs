/*
 * Build the embedded-log payload for the published artifact.
 *
 *   node tools/embed-logs.mjs [--n 4] [--every 1] [--keep Log3056]
 *
 * The artifact is a sandboxed page: no filesystem, no network. So its log
 * dropdown can only offer logs compiled into the page. This trims each log to
 * the channels the analyzer actually reads and emits already-decoded columns,
 * so the page skips parsing entirely and stays small.
 *
 * Writes artifact/logs.json and prints the size, which is the number that
 * decides how many logs are worth shipping.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, logStamp, sortLogs } from '../src/core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const LOG_DIR = join(HOME, 'OneDrive - Talleys Limited', 'Documents shared', 'Haltech',
  'Nexus Maps and Data Logs', 'Suprise Rice', 'Logs');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const N = Number(arg('--n', 4));
const EVERY = Number(arg('--every', 1));

/* Exactly the names the artifact's col() resolves. Keeping the ORIGINAL names
 * means its lookup behaves identically to a real file — including the fact that
 * 'Fuel - Load' does not match 'Fuel - Load (MAP)' and falls through to
 * Manifold Pressure. Do not "helpfully" rename anything here. */
const KEEP = [
  'RPM', 'Filtered RPM',
  'Fuel - Load', 'Fuel - Load (MAP)', 'Manifold Pressure',
  'Target Lambda', 'Wideband O2 1', 'Wideband Maximum',
  'Throttle Position', 'Injector 1 Duty Cycle',
  'Ignition Angle', 'Intake Air Temperature', 'Coolant Temperature',
  'Fuel Tuning Current Stoichiometry',
  'Knock Sensor 1 Knock Level', 'Knock Input 1 FFT.',
  'Boost Control Target Pressure',
  // the blend every correction is relative to — must ship with the data
  'Fuel Composition', 'Ethanol Content', 'Flex Fuel Ethanol Content',
];

/* Recency comes from logStamp() in core.js — the same rule serve.mjs and the
 * artifact's folder picker order by, so all three agree on which log is newest. */
const logTime = logStamp;

const round = v => {
  if (!Number.isFinite(v)) return null;
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/* Channel policy. The artifact now draws graphs, and its picker is meant to
 * expose everything the log carries — including channels enabled after this was
 * written. So the default is EVERY channel; --lean falls back to the analysis
 * subset for when page weight matters more than completeness. */
const LEAN = process.argv.includes('--lean');

const all = sortLogs(readdirSync(LOG_DIR)
  .filter(f => f.toLowerCase().endsWith('.csv'))
  .map(f => ({ file: f, when: logTime(f) })));

/* Recency alone is the wrong rule when the newest logs are part-throttle. On
 * 2026-08-09 the five newest reached 5,235 rpm and 38% duty; a straight --n 4
 * would have shipped a bundle where NOTHING hits a hardware limit, so the limit
 * gating and the blocked-cell 'X' would have had nothing to demonstrate.
 * --keep pins a reference log by filename substring so it survives a refresh. */
const KEEP_FILES = (arg('--keep', '') || '').split(',')   // trailing --keep yields undefined.map(s => s.trim()).filter(Boolean);

const files = all.slice(0, N);
for (const k of KEEP_FILES) {
  const hits = all.filter(f => f.file.toLowerCase().includes(k.toLowerCase()));
  if (!hits.length) {
    // Silently dropping a pin would produce exactly the bundle it was meant to prevent.
    console.error(`--keep ${k}: no log matches. Refusing to build a bundle missing a pinned log.`);
    process.exit(1);
  }
  for (const f of hits) if (!files.some(g => g.file === f.file)) files.push(f);
}
// newest RUN first, so out[0] is the page default. sortLogs RETURNS a new
// array — calling it for its side effect would leave the pins in push order.
const ordered = sortLogs(files);

const out = [];
for (const { file, when } of ordered) {
  const log = parseLog(readFileSync(join(LOG_DIR, file), 'latin1'));
  const keepIdx = [];
  for (const c of log.channels) {
    const want = !LEAN || KEEP.some(k => k.trim().toLowerCase() === c.name.trim().toLowerCase());
    if (want) keepIdx.push(log.byName[c.name]);
  }
  const names = keepIdx.map(i => log.channels[i].name);
  const rows = log.rows.filter((_, i) => i % EVERY === 0);

  out.push({
    file, when,
    meta: { 'Log Number': log.meta['Log Number'], DownloadDateTime: log.meta.DownloadDateTime },
    // seconds-into-the-day of the first row, so celCauses() can report an event
    // at the clock time NSP shows rather than as elapsed seconds
    startClock: log.startClock,
    names,
    t: rows.map(r => round(r.t)),
    cols: keepIdx.map(ci => rows.map(r => round(r.values[ci]))),
  });
  console.log(`  ${file}  ${log.rows.length} rows -> ${rows.length}  ${names.length}/${log.channels.length} channels`);
}

mkdirSync(join(ROOT, 'artifact'), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(join(ROOT, 'artifact', 'logs.json'), json, 'utf8');
console.log(`\npayload: ${out.length} logs — ${(json.length / 1024).toFixed(0)} KB`);
console.log(`newest (default): ${out[0].file}`);

// Inject into the artifact page, between the placeholder tags.
const page = join(ROOT, 'artifact', 'haltune.html');
if (existsSync(page)) {
  const html = readFileSync(page, 'utf8');
  const re = /(<script type="application\/json" id="embedded-logs">)([\s\S]*?)(<\/script>)/;
  if (!re.test(html)) {
    console.log('\n!! placeholder <script id="embedded-logs"> not found — nothing injected');
    process.exit(1);
  }
  // "</script>" inside JSON would terminate the tag early; the only character
  // that can start it is "<", so escaping that is sufficient and reversible.
  const safe = json.replace(/</g, '\\u003c');
  const next = html.replace(re, (_, a, __, c) => a + safe + c);
  writeFileSync(page, next, 'utf8');
  console.log(`injected into artifact/haltune.html — page now ${(next.length / 1024).toFixed(0)} KB`);
}
