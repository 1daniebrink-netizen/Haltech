/*
 * Haltune dashboard server — http://localhost:3000
 *
 *   node tools/serve.mjs
 *   node tools/serve.mjs --dir "C:\some\Logs" --port 3000
 *
 * No dependencies. All parsing, scaling and limit logic comes from src/core.js
 * so the dashboard cannot silently disagree with tools/test.mjs or
 * tools/limits.mjs about what a number means.
 */

import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLog, analyze, kpaToPsi, kpaToPsiDiff, lambdaToAfr, VEHICLE, dragTable, celCauses, logStamp, sortLogs } from '../src/core.js';
import { buildPanels, DEFAULT_PANELS, findCol } from '../src/panels.js';

/* AFR display basis. The analyzer's fuel math stays in lambda (stoich-independent);
 * these only convert lambda for READING as AFR. Linear blend by volume. */
const STOICH_PETROL = 14.7;   // pump 95
const STOICH_ETHANOL = 9.0;   // E100

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LOG_DIR = argOf('--dir', join(
  HOME, 'OneDrive - Talleys Limited', 'Documents shared', 'Haltech',
  'Nexus Maps and Data Logs', 'Suprise Rice', 'Logs',
));
const PORT = Number(argOf('--port', 3000));

/* ---------------------------------------------------------------- channels */

/* Panel definitions now live in src/panels.js so the dashboard and the published
 * artifact cannot drift apart, and so a newly-logged channel is discovered
 * automatically rather than needing an edit here. */

const round = (v, n = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null);

/* Stoich resolution, the mixture panel and panel materialisation all live in
 * src/panels.js now, so the dashboard and the published artifact build the
 * same panels from the same definitions. */

function buildPayload(file) {
  const text = readFileSync(join(LOG_DIR, file), 'latin1');
  const log = parseLog(text);

  // Panels come from the shared catalogue, which appends anything it does not
  // recognise — so a channel enabled in NSP for the first time appears here on
  // its own, without an edit to this file.
  const panels = buildPanels(log, VEHICLE);

  let report = null;
  try { report = analyze(log); }
  catch (e) { report = { warnings: [], error: String((e && e.message) || e) }; }

  return {
    file,
    meta: log.meta,
    channelCount: log.channels.length,
    channels: log.channels.map(c => c.name),
    t: log.rows.map(r => round(r.t)),
    panels,
    defaultPanels: DEFAULT_PANELS.filter(k => panels.some(p => p.key === k)),
    stats: summaryStats(log, report),
    // Same rows and same formatting the artifact renders — from core.js, so the
    // two surfaces cannot report one run differently.
    drag: dragTable(log),
    cel: celCauses(log),
    warnings: report.warnings || [],
    dataQuality: report.dataQuality || null,
    excluded: report.excluded || null,
    fuel: report.fuel || null,
    analyzeError: report.error || null,
  };
}

/**
 * Worst lean cell, taken from analyze()'s FILTERED grid rather than raw rows.
 * A raw scan reports the boost ramp, where the wideband is still catching up —
 * lag dressed up as a fuelling error. defaultFilter()'s maxLoadDeriv gate is
 * exactly what removes that, so reuse it instead of re-deciding here.
 */
function worstLeanCell(report) {
  if (!report || !Array.isArray(report.grid)) return null;
  const boosted = report.grid.filter(g => g.boostPsi > 1);
  if (!boosted.length) return null;
  return boosted.reduce((m, g) => (g.leanErrPct > m.leanErrPct ? g : m));
}

/** Headline numbers for the tile row. Each carries its own status verdict. */
function summaryStats(log, report) {
  const c = {
    map: findCol(log, 'Manifold Pressure'),
    rpm: findCol(log, 'RPM', 'Filtered RPM'),
    duty: findCol(log, 'Injector 1 Duty Cycle'),
    diff: findCol(log, 'Injector Pressure Differential'),
    meas: findCol(log, 'Wideband O2 1'),
    tgt: findCol(log, 'Target Lambda'),
    rail: findCol(log, 'Diagnostic Analogue 5V rail'),
    batt: findCol(log, 'Battery Voltage'),
    clt: findCol(log, 'Coolant Temperature'),
    eth: findCol(log, 'Fuel Composition', 'Ethanol Content', 'Flex Fuel Ethanol Content'),
  };
  const at = (r, k) => (c[k] >= 0 ? r.values[c[k]] : NaN);

  let peakBoost = -Infinity, peakRpm = -Infinity, peakDuty = -Infinity;
  let minDiff = Infinity, worstLean = -Infinity, worstLeanAt = null;
  let railLo = Infinity, railHi = -Infinity, battLo = Infinity, cltHi = -Infinity;
  let ethSum = 0, ethN = 0, ethLo = Infinity, ethHi = -Infinity;
  let running = 0;

  for (const r of log.rows) {
    const rpm = at(r, 'rpm');
    if (!(Number.isFinite(rpm) && rpm >= VEHICLE.minRunningRpm)) continue;
    running++;
    const map = at(r, 'map');
    if (Number.isFinite(map)) peakBoost = Math.max(peakBoost, kpaToPsi(map));
    peakRpm = Math.max(peakRpm, rpm);

    const duty = at(r, 'duty');
    if (Number.isFinite(duty)) peakDuty = Math.max(peakDuty, duty);

    const boosted = Number.isFinite(map) && map > VEHICLE.baroKpa;
    const diff = at(r, 'diff');
    if (boosted && Number.isFinite(diff)) minDiff = Math.min(minDiff, diff);

    // "lean under boost" is the number that matters; off-boost cruise is noise.
    const m = at(r, 'meas'), t = at(r, 'tgt');
    if (boosted && m > 0.6 && m < 1.3 && t > 0.6 && t < 1.3) {
      const lean = (m / t - 1) * 100;
      if (lean > worstLean) {
        worstLean = lean;
        worstLeanAt = { rpm: Math.round(rpm), boostPsi: round(kpaToPsi(map), 1) };
      }
    }

    const rail = at(r, 'rail');
    if (Number.isFinite(rail)) { railLo = Math.min(railLo, rail); railHi = Math.max(railHi, rail); }
    const b = at(r, 'batt');
    if (Number.isFinite(b)) battLo = Math.min(battLo, b);
    const clt = at(r, 'clt');
    if (Number.isFinite(clt)) cltHi = Math.max(cltHi, clt);
    const eth = at(r, 'eth');
    if (Number.isFinite(eth)) {
      ethSum += eth; ethN++;
      ethLo = Math.min(ethLo, eth); ethHi = Math.max(ethHi, eth);
    }
  }

  const fin = v => (Number.isFinite(v) ? round(v, 2) : null);
  const band = (ok, warn) => (ok ? 'good' : warn ? 'warning' : 'critical');
  const none = l => ({ value: null, status: 'none', label: l, note: 'not logged' });

  return {
    runningSamples: running,
    peakBoost: peakBoost === -Infinity ? none('Peak boost') : {
      value: fin(peakBoost), unit: 'psi', label: 'Peak boost',
      status: peakBoost > VEHICLE.maxBoostPsi ? 'warning' : 'good',
      note: `target ${VEHICLE.maxBoostPsi} psi`,
    },
    peakRpm: peakRpm === -Infinity ? none('Peak RPM') : {
      value: Math.round(peakRpm), unit: 'rpm', label: 'Peak RPM',
      status: peakRpm > VEHICLE.redlineRpm ? 'critical' : 'good',
      note: `redline ${VEHICLE.redlineRpm}`,
    },
    peakDuty: peakDuty === -Infinity ? none('Peak injector duty') : {
      value: fin(peakDuty), unit: '%', label: 'Peak injector duty',
      status: peakDuty >= 100 ? 'critical' : peakDuty >= VEHICLE.maxInjDutyPct ? 'warning' : 'good',
      note: peakDuty >= 100 ? 'injectors static' : `ceiling ${VEHICLE.maxInjDutyPct}%`,
    },
    // psi like every other pressure on the page. Differential, so no baro offset.
    minDiff: minDiff === Infinity ? none('Min inj. differential') : {
      value: fin(kpaToPsiDiff(minDiff)), unit: 'psi', label: 'Min inj. differential',
      status: band(minDiff >= VEHICLE.fuelBaseDiffKpa * (1 - VEHICLE.fuelDiffTolerancePct / 100),
        minDiff >= VEHICLE.fuelBaseDiffKpa * 0.85),
      note: `-${VEHICLE.fuelDiffTolerancePct}% at `
        + `${kpaToPsiDiff(VEHICLE.fuelBaseDiffKpa * (1 - VEHICLE.fuelDiffTolerancePct / 100)).toFixed(0)} psi · `
        + `base ${kpaToPsiDiff(VEHICLE.fuelBaseDiffKpa).toFixed(0)} psi`,
    },
    worstLean: (() => {
      const cell = worstLeanCell(report);
      if (!cell) {
        return worstLean === -Infinity ? none('Peak lean under boost') : {
          value: fin(worstLean), unit: '%', label: 'Peak lean under boost',
          status: worstLean > 10 ? 'critical' : worstLean > 3 ? 'warning' : 'good',
          note: (worstLeanAt ? `${worstLeanAt.rpm} rpm / ${worstLeanAt.boostPsi} psi · ` : '')
            + 'unfiltered — no steady cells',
        };
      }
      const v = cell.leanErrPct;
      return {
        value: fin(v), unit: '%', label: 'Peak lean under boost',
        status: v > 10 ? 'critical' : v > 3 ? 'warning' : 'good',
        note: `${cell.rpm} rpm / ${cell.boostPsi.toFixed(0)} psi · ${cell.n} samples, transients excluded`,
      };
    })(),
    rail5v: railLo === Infinity ? none('5V rail low') : {
      value: fin(railLo), unit: 'V', label: '5V rail low',
      status: band(railLo >= 4.9, railLo >= 4.75),
      note: `range ${fin(railLo)}\u2013${fin(railHi)} V`,
    },
    batteryLow: battLo === Infinity ? none('Battery low') : {
      value: fin(battLo), unit: 'V', label: 'Battery low',
      status: band(battLo >= 12, battLo >= 11), note: 'dead-time floor 12 V',
    },
    // What the injectors were actually asked for, against what four of them can
    // pass. Sized off the MSEL flow curve at each sample's real differential.
    fuelDemand: (() => {
      const s = (report && report.summary) || {};
      if (!Number.isFinite(s.peakImpliedHp)) return none('Peak fuel demand');
      const ceil = s.injectorCeilingHp;
      return {
        value: Math.round(s.peakImpliedHp), unit: 'hp', label: 'Peak fuel demand',
        status: s.peakImpliedHp > ceil ? 'critical'
          : s.peakImpliedHp > VEHICLE.powerGoalHp * 1.1 ? 'warning' : 'good',
        note: `injectors pass ${Math.round(ceil)} hp · ${VEHICLE.powerGoalHp} hp goal`,
      };
    })(),

    flowLoss: (() => {
      const s = (report && report.summary) || {};
      if (!Number.isFinite(s.flowLossMaxPct)) return none('Flow lost to pressure');
      return {
        value: fin(s.flowLossMaxPct), unit: '%', label: 'Flow lost to pressure',
        status: s.flowLossMaxPct > 10 ? 'critical' : s.flowLossMaxPct > 4 ? 'warning' : 'good',
        note: `${Math.round(s.flowAtMinDiffCcMin)} cc/min per inj. at the low point`,
      };
    })(),

    // Knock comes from analyze()'s summary, which counts over ALL running
    // samples rather than the filtered set — see knockSummary() in core.js.
    knock: (() => {
      const s = (report && report.summary) || {};
      if (!s.knockLogged) return none('Knock events');
      const n = s.knockEvents;
      const bits = [];
      if (s.knockRetardMax > 0) bits.push(`peak retard ${fin(s.knockRetardMax)}°`);
      if (s.knockLevelMax > 0) bits.push(`peak level ${fin(s.knockLevelMax)}`);
      return {
        value: n, unit: '', label: 'Knock events',
        status: n > 0 ? 'critical' : 'good',
        note: n > 0 ? (bits.join(' · ') || 'knock detected') : 'none detected',
      };
    })(),

    // Which fuel this log is about. A correction derived at E76 does not belong
    // on an E89 map, so the blend travels with every number that comes off it.
    ethanol: ethN === 0 ? none('Mean ethanol') : (() => {
      const mean = ethSum / ethN, spread = ethHi - ethLo;
      return {
        value: fin(mean), unit: '%', label: 'Mean ethanol',
        status: spread > 2 ? 'warning' : 'good',
        note: spread <= 0.05 ? `steady · stoich ~${fin(14.7 - 5.7 * mean / 100)}`
          : `${fin(ethLo)}–${fin(ethHi)}% in log · stoich ~${fin(14.7 - 5.7 * mean / 100)}`,
      };
    })(),
    coolantPeak: cltHi === -Infinity ? none('Peak coolant') : {
      value: fin(cltHi), unit: '\u00b0C', label: 'Peak coolant',
      status: band(cltHi <= VEHICLE.maxCltC, cltHi <= 110), note: `max ${VEHICLE.maxCltC}\u00b0C`,
    },
  };
}

/* ------------------------------------------------------------------ server */

/**
 * Sort key for "most recent". Filename order is NOT recency — NSP writes both
 * `2026-08-08_0453pm_Log3056.csv` and `PCLog_2026-01-17_0906pm.csv`, and a plain
 * string sort puts every PCLog above every dated log. Parse the stamp out of the
 * name; fall back to mtime only when there isn't one (OneDrive rewrites mtimes,
 * so the name is the more trustworthy source here).
 */
function logTime(file, path) {
  const stamp = logStamp(file);
  if (stamp) return stamp;
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function listLogs() {
  if (!existsSync(LOG_DIR)) return [];
  const list = readdirSync(LOG_DIR)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .map(f => {
      const p = join(LOG_DIR, f);
      return { file: f, size: statSync(p).size, when: logTime(f, p) };
    });
  return sortLogs(list);   // newest RUN first — see sortLogs() in core.js
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // src/charts.js is inlined at request time rather than duplicated into the
      // page, so the dashboard and the published artifact share one chart engine.
      // Read on every request so an edit shows up on refresh.
      const page = readFileSync(join(ROOT, 'src', 'dashboard.html'), 'utf8');
      const charts = readFileSync(join(ROOT, 'src', 'charts.js'), 'utf8');
      /* Function replacement, not a string one. A string replacement expands
       * `$&`, `` $` `` and `$'` inside it, and charts.js contains `` $` `` in a
       * comment — which spliced the whole page prefix into the script and gave
       * the served page a second `const S`, so the entire inline script died
       * with "Identifier 'S' has already been declared" and the dashboard
       * rendered nothing. A callback is passed through verbatim. */
      return send(res, 200, page.replace('/*__CHARTS__*/', () => charts), 'text/html');
    }
    if (url.pathname === '/api/logs') {
      return send(res, 200, { dir: LOG_DIR, exists: existsSync(LOG_DIR), logs: listLogs() });
    }
    if (url.pathname === '/api/log') {
      const file = url.searchParams.get('file');
      if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
        return send(res, 400, { error: 'bad file parameter' });
      }
      if (!existsSync(join(LOG_DIR, file))) return send(res, 404, { error: `not found: ${file}` });
      return send(res, 200, buildPayload(file));
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String((err && err.stack) || err) });
  }
}).listen(PORT, () => {
  console.log(`\n  Haltune dashboard   http://localhost:${PORT}`);
  console.log(`  log directory       ${LOG_DIR}`);
  console.log(existsSync(LOG_DIR)
    ? `  logs found          ${listLogs().length}\n`
    : '  logs found          directory missing \u2014 pass --dir "<path>"\n');
});
