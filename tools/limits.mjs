/*
 * Regression test for the vehicle hard-limit checks in src/core.js.
 *
 *   node tools/limits.mjs <path-to-nsp-log.csv>
 *
 * Rather than assert against numbers from one particular log, each case derives
 * its threshold from that log's own peaks — set the injector ceiling below the
 * duty the log actually reached, and the check MUST fire. That keeps the test
 * meaningful against any log with a decent pull in it.
 *
 * Two invariants are worth stating outright, because both are bugs this file was
 * written in response to:
 *   - Advisory limits must never remove samples from the correction grid.
 *   - The fuel-starvation check must never fire against a fixed regulator, whose
 *     differential collapses under boost by design.
 *
 * Exits non-zero if any case fails.
 */
import { readFileSync } from 'node:fs';
import { parseLog, extractSamples, annotateLimits, analyze, VEHICLE, kpaToPsi, psiToKpa } from '../src/core.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/limits.mjs <path-to-nsp-log.csv>');
  process.exit(2);
}

const log = parseLog(readFileSync(path, 'latin1'));
const { samples, fuel } = extractSamples(log);
annotateLimits(samples, VEHICLE, fuel); // sets s.running / s.trustworthy, asserted below
const running = samples.filter(s => s.rpm >= VEHICLE.minRunningRpm);
if (!running.length) {
  console.error('log contains no running samples — cannot exercise the limit checks');
  process.exit(2);
}

const peak = sel => running.reduce((m, s) => (Number.isFinite(sel(s)) ? Math.max(m, sel(s)) : m), -Infinity);
const peakMap = peak(s => s.map);
const peakDuty = peak(s => s.injDuty);
const peakRpm = peak(s => s.rpm);
const peakIat = peak(s => s.iat);
const hasBoost = peakMap > VEHICLE.baroKpa + 20;

const base = analyze(log, { vehicle: VEHICLE });

let failed = 0, skipped = 0;
const has = (res, id) => res.warnings.some(w => w.id === id);

function check(name, fn) {
  let out;
  try { out = fn(); } catch (e) { out = `threw: ${e.message}`; }
  if (out === true) { console.log(`  PASS  ${name}`); return; }
  if (out === 'skip') { skipped++; console.log(`  SKIP  ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}\n        ${out}`);
}

console.log(`log: ${path}`);
console.log(`running=${running.length}  peakMAP=${peakMap.toFixed(0)}kPa (${kpaToPsi(peakMap).toFixed(1)}psi) `
  + `peakDuty=${Number.isFinite(peakDuty) ? peakDuty.toFixed(0) + '%' : 'n/a'} peakRPM=${peakRpm.toFixed(0)}`);
console.log(`fuel: regulator=${fuel.regulator} reference=${fuel.reference} slope=${Number.isFinite(fuel.slope) ? fuel.slope.toFixed(2) : 'n/a'}`);
console.log(`baseline: valid=${base.counts.valid} cells=${base.grid.length} usable=${base.dataQuality.usable}\n`);

// ---- shape ----
check('analyze() returns the limit fields', () =>
  Boolean(Array.isArray(base.warnings) && base.excluded && base.dataQuality && base.vehicle)
  || 'missing warnings/excluded/dataQuality/vehicle');

check('baseline produces at least one usable cell', () =>
  base.grid.length > 0 || 'no cells survived the default limits — checks are over-blocking');

// ---- blocking limits must fire AND remove samples ----
check('MAP ceiling below peak → blocks samples', () => {
  if (!hasBoost) return 'skip';
  const bar = Math.max(1, Math.floor((peakMap - 20) / 100)); // ceiling under the log's peak
  const r = analyze(log, { vehicle: { ...VEHICLE, mapSensorBar: bar } });
  if (!has(r, 'map-clipped')) return `no map-clipped warning at ${bar} bar vs peak ${peakMap.toFixed(0)} kPa`;
  if (r.counts.valid >= base.counts.valid) return `clipped samples were not excluded (${r.counts.valid} >= ${base.counts.valid})`;
  return true;
});

check('injector ceiling below peak duty → blocks samples', () => {
  if (!Number.isFinite(peakDuty) || peakDuty < 10) return 'skip';
  const ceiling = Math.floor(peakDuty * 0.7);
  const r = analyze(log, { vehicle: { ...VEHICLE, maxInjDutyPct: ceiling } });
  if (!has(r, 'inj-duty-ceiling')) return `no inj-duty-ceiling warning at ${ceiling}% vs peak ${peakDuty.toFixed(0)}%`;
  if (r.counts.valid >= base.counts.valid) return `maxed samples were not excluded (${r.counts.valid} >= ${base.counts.valid})`;
  return true;
});

check('blocking warnings are marked blocking', () => {
  if (!hasBoost) return 'skip';
  const bar = Math.max(1, Math.floor((peakMap - 20) / 100));
  const r = analyze(log, { vehicle: { ...VEHICLE, mapSensorBar: bar } });
  const w = r.warnings.find(x => x.id === 'map-clipped');
  return (w && w.blocking === true && w.severity === 'critical') || 'map-clipped not flagged blocking/critical';
});

// ---- advisory limits must NOT remove samples ----
check('IAT limit is advisory — no samples removed', () => {
  if (!Number.isFinite(peakIat)) return 'skip';
  const r = analyze(log, { vehicle: { ...VEHICLE, maxIatC: Math.floor(peakIat) - 5 } });
  if (!has(r, 'iat-high')) return 'no iat-high warning below peak IAT';
  if (r.counts.valid !== base.counts.valid) return `advisory limit changed the sample count (${r.counts.valid} vs ${base.counts.valid})`;
  return true;
});

check('rev limit is advisory — no samples removed', () => {
  const r = analyze(log, { vehicle: { ...VEHICLE, redlineRpm: Math.floor(peakRpm) - 200 } });
  if (!has(r, 'over-rev')) return 'no over-rev warning below peak RPM';
  if (r.counts.valid !== base.counts.valid) return `advisory limit changed the sample count (${r.counts.valid} vs ${base.counts.valid})`;
  return true;
});

// ---- the false-positive regressions ----
check('fuel starvation never fires against a non-1:1 regulator', () => {
  if (fuel.regulator === 'manifold') return 'skip';
  // Force the spec to claim 1:1; the DATA says otherwise and must win.
  const r = analyze(log, { vehicle: { ...VEHICLE, fuelRegulator: 'manifold' } });
  if (has(r, 'fuel-pressure-low')) return 'starvation fired against a regulator the data shows is not 1:1';
  if (!has(r, 'fuel-check-unavailable')) return 'check was skipped without reporting why';
  return true;
});

check('non-running samples are never flagged', () => {
  const off = samples.filter(s => !s.running);
  if (!off.length) return 'skip';
  const bad = off.filter(s => !s.trustworthy);
  return bad.length === 0 || `${bad.length} key-on/cranking samples were flagged as untrustworthy`;
});

check('limit checks ignore key-on data', () => {
  const off = samples.filter(s => !s.running);
  if (!off.length) return 'skip';
  // A log whose only implausible readings are engine-off must still be usable.
  return base.dataQuality.implausiblePct === 0
    || `engine-off samples leaked into the plausibility check (${base.dataQuality.implausiblePct}%)`;
});

// ---- suggested corrections respect injector capacity ----
check('post-correction duty is derived from the suggested change', () => {
  const cells = base.grid.filter(g => Number.isFinite(g.injDuty) && Number.isFinite(g.dutyAfter));
  if (!cells.length) return 'skip';
  const bad = cells.find(g => Math.abs(g.dutyAfter - g.injDuty * (1 + g.pctChange / 100)) > 1e-6);
  return !bad || `dutyAfter mismatch at ${bad.rpm} rpm: ${bad.dutyAfter} vs ${bad.injDuty} × ${bad.pctChange}%`;
});

check('duty-limited cells raise a capacity warning', () => {
  // The ceiling both excludes over-duty samples AND sets the dutyLimited threshold,
  // so a cell is only flagged in the narrow band between its current duty and its
  // post-correction duty. Scan for a ceiling that lands there; logs whose cells all
  // need small corrections have no such band, and legitimately skip.
  let hit = null;
  for (let ceiling = 99; ceiling >= 5 && !hit; ceiling -= 1) {
    const r = analyze(log, { vehicle: { ...VEHICLE, maxInjDutyPct: ceiling } });
    if (r.grid.some(g => g.dutyLimited)) hit = r;
  }
  if (!hit) return 'skip';
  if (!has(hit, 'correction-exceeds-injectors')) return 'dutyLimited cells did not raise a warning';
  const w = hit.warnings.find(x => x.id === 'correction-exceeds-injectors');
  if (!w.blocking) return 'capacity warning not marked blocking';
  return hit.danger.every(d => !d.dutyLimited || d.cause === 'capacity')
    || 'a duty-limited danger cell was reported as a calibration error';
});

// ---- axis sanity ----
check('load axis never exceeds the MAP sensor ceiling', () => {
  const ceil = VEHICLE.mapSensorBar * 100;
  const over = base.loadAxis.filter(v => v > ceil);
  return over.length === 0 || `axis runs to ${Math.max(...over)} kPa, past the ${ceil} kPa sensor ceiling`;
});

check('load axis covers the declared boost target', () => {
  const target = psiToKpa(VEHICLE.maxBoostPsi) + VEHICLE.baroKpa;
  const top = Math.max(...base.loadAxis);
  return top >= Math.min(target, VEHICLE.mapSensorBar * 100) - 20
    || `axis tops out at ${top} kPa, short of the ${target.toFixed(0)} kPa target`;
});

console.log(`\n${failed ? 'FAILED' : 'ok'} — ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
