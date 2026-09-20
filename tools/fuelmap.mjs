/*
 * Base Fuel Tuning correction table.
 *
 *   node tools/fuelmap.mjs                       (all default logs)
 *   node tools/fuelmap.mjs Log3056.csv ...       (specific logs)
 *
 * Bins valid samples onto the SAME axes as the Haltech Base Fuel Tuning table
 * and emits a per-cell percentage change. Cells the analyzer disqualifies
 * (MAP clipped, injectors maxed, fuel starved, sensor implausible) never reach
 * the grid, so they come out blank rather than as confident nonsense.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, analyze, defaultFilter, psiToKpa, VEHICLE } from '../src/core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const LOG_DIR = join(HOME, 'OneDrive - Talleys Limited', 'Documents shared', 'Haltech',
  'Nexus Maps and Data Logs', 'Suprise Rice', 'Logs');

/* ---- the ECU's own axes, read off the Base Fuel Tuning table ------------- */

// Rows, high rpm first (as displayed).
const RPM_AXIS = [9000, 8500, 8000, 7500, 7000, 6500, 6000, 5500, 5000, 4500, 4000,
                  3500, 3000, 2500, 2000, 1500, 1200, 1100, 1000, 900, 500, 0];

// Columns. Negative entries are inHg of vacuum, positive are psi of boost.
const LOAD_LABELS = [-29.5, -25.5, -21.4, -17.3, -13.2, -9.2, -5.1, -1.0,
                     3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42];
const INHG_KPA = 3.386389;
const labelToKpa = v => (v < 0 ? VEHICLE.baroKpa + v * INHG_KPA
                               : VEHICLE.baroKpa + psiToKpa(v));
const LOAD_KPA = LOAD_LABELS.map(labelToKpa);

// analyze() expects the load axis ascending; keep an index map back to labels.
const loadOrder = LOAD_KPA.map((k, i) => ({ k, i })).sort((a, b) => a.k - b.k);
const LOAD_AXIS = loadOrder.map(o => Math.round(o.k));
const RPM_AXIS_ASC = [...RPM_AXIS].sort((a, b) => a - b);

/* ---- inputs -------------------------------------------------------------- */

const argFiles = process.argv.slice(2).filter(a => !a.startsWith('--'));
const files = argFiles.length ? argFiles
  : readdirSync(LOG_DIR).filter(f => /^2026-08-08.*\.csv$/i.test(f)).sort();

if (!files.length) { console.error('no logs'); process.exit(1); }

/* ---- accumulate across logs ---------------------------------------------- */

const cells = new Map();                       // "rpm|loadKpa" -> accumulator
const blockedCells = new Set();                // had data, disqualified by a hard limit
const perLog = [];

const AXES = { rpmAxis: RPM_AXIS_ASC, loadAxis: LOAD_AXIS, minSamples: 3 };

for (const f of files) {
  const path = existsSync(f) ? f : join(LOG_DIR, f);
  if (!existsSync(path)) { console.error('missing: ' + f); continue; }
  const log = parseLog(readFileSync(path, 'latin1'));
  const hasDuty = Object.keys(log.byName).some(k => /injector 1 duty/i.test(k));

  const rep = analyze(log, AXES);

  // Second pass ignoring the hard limits, purely to distinguish "no data here"
  // from "data here that we are not allowed to trust".
  const repLoose = analyze(log, { ...AXES, filter: defaultFilter({ enforceLimits: false }) });

  const trusted = new Set(rep.grid.map(g => g.rpm + '|' + g.load));
  for (const g of repLoose.grid) {
    const key = g.rpm + '|' + g.load;
    if (!trusted.has(key)) blockedCells.add(key);
  }

  for (const g of rep.grid) {
    const key = g.rpm + '|' + g.load;
    let a = cells.get(key);
    if (!a) { a = { n: 0, sMeas: 0, sTgt: 0, duty: null, dutyKnown: false, logs: new Set() }; cells.set(key, a); }
    a.n += g.n;
    a.sMeas += g.measured * g.n;
    a.sTgt += g.target * g.n;
    if (hasDuty) { a.duty = Math.max(a.duty ?? 0, g.injDuty); a.dutyKnown = true; }
    a.logs.add(f);
  }

  perLog.push({
    file: f, cells: rep.grid.length, valid: rep.counts.valid, total: rep.counts.total,
    blocked: rep.excluded, usable: rep.dataQuality.usable, hasDuty,
    ethanol: ethanolOf(log),
  });
}

/** Mean / range of fuel composition over running samples. */
function ethanolOf(log) {
  const c = findColIn(log, 'Fuel Composition', 'Ethanol Content', 'Flex Fuel Ethanol Content');
  const rpm = findColIn(log, 'RPM', 'Filtered RPM');
  if (c < 0) return null;
  let sum = 0, n = 0, lo = Infinity, hi = -Infinity;
  for (const r of log.rows) {
    if (rpm >= 0 && !(r.values[rpm] >= VEHICLE.minRunningRpm)) continue;
    const v = r.values[c];
    if (!Number.isFinite(v)) continue;
    sum += v; n++; lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return n ? { mean: sum / n, lo, hi, n } : null;
}

function findColIn(log, ...names) {
  const keys = Object.keys(log.byName);
  for (const want of names) {
    const w = want.trim().toLowerCase();
    const hit = keys.find(k => k.trim().toLowerCase() === w);
    if (hit !== undefined) return log.byName[hit];
  }
  return -1;
}

/* The blend this whole table is about. Corrections derived on one fuel do not
 * belong on another map — that is the single easiest way to apply this to the
 * wrong table — so it is stated before the numbers, not after. */
const eths = perLog.map(p => p.ethanol).filter(Boolean);
const ethLo = eths.length ? Math.min(...eths.map(e => e.lo)) : null;
const ethHi = eths.length ? Math.max(...eths.map(e => e.hi)) : null;
const ethMean = eths.length
  ? eths.reduce((s, e) => s + e.mean * e.n, 0) / eths.reduce((s, e) => s + e.n, 0) : null;
const stoichOf = e => 14.7 - 5.7 * e / 100;

/* ---- resolve each cell --------------------------------------------------- */

const at = (rpm, kpa) => {
  const a = cells.get(rpm + '|' + Math.round(kpa));
  if (!a || !a.n) return null;
  const meas = a.sMeas / a.n, tgt = a.sTgt / a.n;
  const pct = (meas / tgt - 1) * 100;
  const dutyAfter = a.duty == null ? null : a.duty * (1 + pct / 100);
  return {
    pct, n: a.n, meas, tgt, duty: a.duty, dutyAfter, dutyKnown: a.dutyKnown,
    limited: dutyAfter != null && dutyAfter > VEHICLE.maxInjDutyPct,
    logs: a.logs.size,
  };
};

/* ---- render -------------------------------------------------------------- */

const pad = (s, w) => String(s).padStart(w);
const W = 7;

/* ---- fuel basis banner --------------------------------------------------- */
console.log('\n' + '='.repeat(78));
if (ethMean === null) {
  console.log('  FUEL: ethanol NOT LOGGED — the blend these corrections apply to is unknown.');
} else {
  console.log(`  FUEL: these corrections apply to E${ethMean.toFixed(1)}`
    + `   (stoich ~${stoichOf(ethMean).toFixed(2)})`);
  console.log(`  Ethanol across the source logs: ${ethLo.toFixed(1)}% – ${ethHi.toFixed(1)}%`);
  for (const p of perLog) {
    if (!p.ethanol) { console.log(`    ${p.file}  ethanol not logged`); continue; }
    const e = p.ethanol, spread = e.hi - e.lo;
    console.log(`    ${p.file}  E${e.mean.toFixed(1)}`
      + (spread > 0.05 ? `  (${e.lo.toFixed(1)}–${e.hi.toFixed(1)} in log)` : '  (steady)'));
  }
  if (ethHi - ethLo > 2) {
    console.log('\n  ** WARNING: the source logs span more than 2 points of ethanol. These cells are a');
    console.log('     BLEND of different fuels, not a single-blend recommendation. Do not apply them to');
    console.log('     a flex map tuned for one specific ethanol content without re-checking per log.');
  }
}
console.log('='.repeat(78));

console.log('\nBase Fuel Tuning — suggested cell change (%)');
console.log('  positive = ADD fuel      .  = no data');
console.log('  *        = correction exceeds injector capacity');
console.log('  X        = data exists but is BLOCKED (injectors maxed / fuel starved / MAP clipped)');
console.log('             — a hardware limit, not a calibration error. Do not tune these.');
console.log('  ?        = boosted cell whose logs predate the duty channel: injector');
console.log('             headroom is UNVERIFIED here, so the correction may be undeliverable.\n');

let head = pad('RPM', 6) + ' |';
for (const L of LOAD_LABELS) head += pad(L < 0 ? L.toFixed(1) : '+' + L, W);
console.log(head);
console.log('-'.repeat(head.length));

const covered = [];
for (const rpm of RPM_AXIS) {
  let row = pad(rpm, 6) + ' |';
  for (let ci = 0; ci < LOAD_LABELS.length; ci++) {
    const c = at(rpm, LOAD_KPA[ci]);
    if (!c) {
      row += pad(blockedCells.has(rpm + '|' + Math.round(LOAD_KPA[ci])) ? 'X' : '.', W);
      continue;
    }
    const mark = c.limited ? '*' : (!c.dutyKnown && LOAD_LABELS[ci] > 0 ? '?' : '');
    row += pad((c.pct >= 0 ? '+' : '') + c.pct.toFixed(1) + mark, W);
    covered.push({ rpm, load: LOAD_LABELS[ci], ...c });
  }
  console.log(row);
}

/* ---- summary ------------------------------------------------------------- */

console.log('\nLogs used:');
for (const p of perLog) {
  console.log('  ' + p.file + '  valid ' + p.valid + '/' + p.total +
    '  cells ' + p.cells +
    '  blocked{clip ' + p.blocked.mapClipped + ' duty ' + p.blocked.dutyMaxed +
    ' starved ' + p.blocked.fuelStarved + ' implausible ' + p.blocked.implausible + '}' +
    (p.usable ? '' : '  <-- LOW QUALITY'));
}

const boosted = covered.filter(c => c.load > 0);
const lim = covered.filter(c => c.limited);
console.log('\nCells with data: ' + covered.length + ' of ' + (RPM_AXIS.length * LOAD_LABELS.length) +
  '   (' + boosted.length + ' in positive boost)');
if (boosted.length) {
  const worst = boosted.reduce((m, c) => (c.pct > m.pct ? c : m));
  console.log('Largest boosted correction: ' + worst.pct.toFixed(1) + '% at ' +
    worst.rpm + ' rpm / ' + worst.load + ' psi  (n=' + worst.n + ')');
}
if (lim.length) {
  console.log('Injector-limited cells (marked *): ' + lim.length +
    '  — these are capacity, not calibration; the map cannot fix them.');
}

/* ---- CSV ----------------------------------------------------------------- */

const out = join(ROOT, 'dist', 'fuel-correction.csv');
// The blend rides on the file itself. A bare grid of percentages with no fuel
// attached is the thing most likely to end up pasted into the wrong map.
const ethLine = ethMean === null
  ? 'FUEL BASIS,ethanol not logged - blend unknown'
  : `FUEL BASIS,E${ethMean.toFixed(1)} (stoich ~${stoichOf(ethMean).toFixed(2)}),`
    + `source logs span E${ethLo.toFixed(1)}-E${ethHi.toFixed(1)}`
    + (ethHi - ethLo > 2 ? ',*** MIXED BLEND - not a single-fuel recommendation ***' : '');
let csv = ethLine + '\n' + 'RPM,' + LOAD_LABELS.join(',') + '\n';
for (const rpm of RPM_AXIS) {
  csv += rpm;
  for (let ci = 0; ci < LOAD_LABELS.length; ci++) {
    const c = at(rpm, LOAD_KPA[ci]);
    csv += ',' + (c ? c.pct.toFixed(1) : '');
  }
  csv += '\n';
}
/* The grid above is deliberately bare so it can be pasted straight into a
 * spreadsheet — which means it loses the *, ? and X markers, and a blocked cell
 * becomes indistinguishable from an empty one. Anything acted on needs the
 * provenance, so it goes in a companion file rather than being lost. */
const detailOut = join(ROOT, 'dist', 'fuel-correction-detail.csv');
let dcsv = ethLine + '\n'
         + 'RPM,Load(psi/inHg),Change%,Samples,Logs,MeasuredLambda,TargetLambda,'
         + 'MeanDuty%,DutyAfter%,Status\n';
for (const rpm of RPM_AXIS) {
  for (let ci = 0; ci < LOAD_LABELS.length; ci++) {
    const kpa = LOAD_KPA[ci];
    const c = at(rpm, kpa);
    if (c) {
      const status = c.limited ? 'EXCEEDS INJECTOR CAPACITY - do not apply'
        : (!c.dutyKnown && LOAD_LABELS[ci] > 0 ? 'duty unverified in source logs' : 'ok');
      dcsv += [rpm, LOAD_LABELS[ci], c.pct.toFixed(1), c.n, c.logs,
        c.meas.toFixed(4), c.tgt.toFixed(4),
        c.duty == null ? '' : c.duty.toFixed(1),
        c.dutyAfter == null ? '' : c.dutyAfter.toFixed(1), status].join(',') + '\n';
    } else if (blockedCells.has(rpm + '|' + Math.round(kpa))) {
      dcsv += [rpm, LOAD_LABELS[ci], '', '', '', '', '', '', '',
        'BLOCKED by hardware limit - data exists but cannot be tuned'].join(',') + '\n';
    }
  }
}

/* Written independently, and never silently skipped: an open spreadsheet locks
 * the file on Windows, and a shared try{} meant one lock swallowed both files
 * while the run still looked successful. */
function writeOut(path, body, what) {
  try {
    writeFileSync(path, body, 'utf8');
    console.log('  ' + what.padEnd(20) + path);
    return true;
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM') {
      console.log('  ' + what.padEnd(20) + 'FAILED: ' + e.message);
      return false;
    }
    const alt = path.replace(/\.csv$/i, '.new.csv');
    try {
      writeFileSync(alt, body, 'utf8');
      console.log('  ' + what.padEnd(20) + alt);
      console.log('  '.padEnd(22) + '^ original is open in another program — wrote here instead');
      return true;
    } catch (e2) {
      console.log('  ' + what.padEnd(20) + 'FAILED: ' + e2.message);
      return false;
    }
  }
}

console.log('');
writeOut(out, csv, 'Grid (for import)');
writeOut(detailOut, dcsv, 'Detail (provenance)');
console.log('\nNOTE: the grid CSV carries numbers only. Blocked and capacity-limited cells');
console.log('      are not distinguishable there — check the detail file before applying.\n');
