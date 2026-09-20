/* Pre-publish check for artifact/haltune.html — syntax + axis binning. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const h = readFileSync(new URL('./haltune.html', import.meta.url), 'utf8');
const open = h.lastIndexOf('<scr' + 'ipt>');
const close = h.lastIndexOf('</scr' + 'ipt>');
const js = h.slice(open + 8, close);

new vm.Script(js, { filename: 'haltune-inline.js' });      // throws on syntax error
console.log('syntax: OK  (' + js.length + ' bytes of inline JS)');

const INHG = 3.386389, BARO = 101.325;
const LAB = [-29.5, -25.5, -21.4, -17.3, -13.2, -9.2, -5.1, -1.0,
             3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42];
const KPA = LAB.map(v => Math.round(v < 0 ? BARO + v * INHG : BARO + v * 6.89476));
const RPM = [0, 500, 900, 1000, 1100, 1200, 1500, 2000, 2500, 3000, 3500,
             4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500, 9000];

console.log('load columns: ' + LAB.length + '   distinct kPa: ' + new Set(KPA).size);
console.log('rpm rows    : ' + RPM.length + '   top-down: '
  + [...RPM].reverse().slice(0, 3).join(', ') + ' ... ' + [...RPM].reverse().slice(-2).join(', '));

// the file must contain the transposed headers, not the old ones
const must = ['RPM \\\\ Load', 'ECU_LOAD_KPA', 'notOverrun', 'rpmAxis: ECU_RPM'];
const gone = ['kPa \\\\ RPM'];
for (const s of must) console.log((h.includes(s) ? '  present : ' : '  MISSING : ') + s);
for (const s of gone) console.log((h.includes(s) ? '  STILL THERE : ' : '  removed : ') + s);

/* ---- engine parity: is the inlined core still src/core.js? -------------- */
{
  const uiAt = js.indexOf('/* Haltune UI.');
  const inlinedCore = js.slice(0, uiAt);
  const local = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8')
    .replace(/^export\s+/gm, '');
  const norm = s => s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  const a = norm(local), b = norm(inlinedCore);
  const same = b.includes(a);
  console.log('engine parity: ' + (same
    ? 'inlined core IS src/core.js'
    : '*** DRIFTED from src/core.js — run tools/build-artifact.mjs ***'));
  if (!same) {
    // Point at the first divergence rather than just asserting one exists.
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    console.log('  first difference near: …' + a.slice(Math.max(0, i - 60), i + 60) + '…');
    process.exitCode = 1;
  }
}

/* ---- embedded payload: does it reproduce the source CSV? ---------------- */
const jsonOpen = h.indexOf('id="embedded-logs">');
if (jsonOpen < 0) { console.log('embedded logs: PLACEHOLDER MISSING'); }
else {
  const from = jsonOpen + 'id="embedded-logs">'.length;
  const to = h.indexOf('</scr' + 'ipt>', from);
  const raw = h.slice(from, to).replace(/\\u003c/g, '<');
  const logs = JSON.parse(raw);
  console.log('embedded logs: ' + logs.length + '  (' + (raw.length / 1024).toFixed(0) + ' KB)');

  const { parseLog } = await import('../src/core.js');
  const { readFileSync: rf, existsSync: ex } = await import('node:fs');
  const { join } = await import('node:path');
  const DIR = join(process.env.USERPROFILE || process.env.HOME || '',
    'OneDrive - Talleys Limited', 'Documents shared', 'Haltech',
    'Nexus Maps and Data Logs', 'Suprise Rice', 'Logs');

  for (const e of logs) {
    const rows = e.t.length;
    const idx = n => e.names.indexOf(n);
    const colOf = n => (idx(n) < 0 ? null : e.cols[idx(n)]);
    const peak = c => (c ? c.reduce((m, v) => (v !== null && v > m ? v : m), -Infinity) : null);
    const map = colOf('Manifold Pressure'), rpm = colOf('RPM'), duty = colOf('Injector 1 Duty Cycle');

    let verdict = 'no source to compare';
    if (ex(join(DIR, e.file))) {
      const src = parseLog(rf(join(DIR, e.file), 'latin1'));
      const sc = n => (n in src.byName ? src.byName[n] : -1);
      const sPeak = n => {
        const c = sc(n); if (c < 0) return null;
        return src.rows.reduce((m, r) => (Number.isFinite(r.values[c]) && r.values[c] > m ? r.values[c] : m), -Infinity);
      };
      const near = (a, b) => a === null || b === null ? a === b : Math.abs(a - b) < 0.05;
      const okRows = rows === src.rows.length;
      /* EVERY shared channel, not a hand-picked three. The payload is decoded at
       * BUILD time, so a change to TYPE_SCALE does not reach it until embed-logs
       * is re-run — and a bundle can be stale on exactly the channel that just
       * changed. Checking only map/rpm/duty reported MATCHES over a payload whose
       * speed columns were still raw, which is how 410 km/h shipped twice. */
      const drift = [];
      for (const n of e.names) {
        if (sc(n) < 0) continue;
        if (!near(peak(colOf(n)), sPeak(n))) drift.push(n);
      }
      verdict = (okRows && !drift.length) ? 'MATCHES source'
        : `MISMATCH rows:${okRows}` + (drift.length
          ? ` — ${drift.length} channel(s) differ: ` + drift.slice(0, 4).join(', ')
            + (drift.length > 4 ? ' …' : '')
          : '');
      if (!okRows || drift.length) process.exitCode = 1;
    }
    console.log('  ' + e.file + '  rows ' + rows + '  ch ' + e.names.length
      + '  peakMAP ' + (peak(map) || 0).toFixed(1) + '  peakRPM ' + (peak(rpm) || 0)
      + '  peakDuty ' + (duty ? peak(duty).toFixed(1) : 'n/a') + '  -> ' + verdict);
  }
}

/* ---- decode plausibility --------------------------------------------------
 * A missing TYPE_SCALE entry does NOT throw. The channel falls through as a raw
 * scaled integer and draws a perfectly normal-looking graph with the right axis
 * label and a value 10x too large — 'Speed' shipped exactly that way and read
 * 410 km/h. Parse and boot checks both sail past it, so assert that decoded
 * values land inside physical bounds. Bounds are deliberately generous: the
 * target is an order-of-magnitude scaling error, not a tuning opinion. */
{
  const { parseLog, TYPE_SCALE } = await import('../src/core.js');
  const { readFileSync: rf, existsSync: ex } = await import('node:fs');
  const { join } = await import('node:path');
  const DIR = join(process.env.USERPROFILE || process.env.HOME || '',
    'OneDrive - Talleys Limited', 'Documents shared', 'Haltech',
    'Nexus Maps and Data Logs', 'Suprise Rice', 'Logs');

  const BOUNDS = {
    Speed: [-100, 400],            // km/h
    EngineSpeed: [0, 12000],       // rpm
    // Deliberately loose. The target is a 10x scaling error, not a tuning opinion,
    // and several percentage channels legitimately run far past 100: injector duty
    // peaks at 111.8%, normalised air mass flow at 212% on boost, and Fuel
    // Correction Total at 423% on a cold start (it is a multiplier off a 100% base).
    Percentage: [-200, 1000],      // %
    Temperature: [-60, 300],       // degC
    BatteryVoltage: [-1, 20],      // V (analogue inputs read a shade below zero)
    Pressure: [-20, 1200],         // kPa abs (fuel rail ~550 is the highest seen)
    AbsPressure: [-20, 1200],      // kPa abs
    AFR: [0, 3],                   // lambda
    Angle: [-360, 720],            // deg — injection timing is referenced over the
                                   // full 4-stroke cycle; start-of-injection hits 501
    Stoichiometry: [4, 20],        // stoich AFR
    Density: [0, 3],               // g/cc
  };

  /* A DERIVATIVE is a rate, not the quantity. Its magnitude is not bounded by the
   * base channel's physical range — transmission line pressure moves 4,962 kPa/s —
   * so a physical bound cannot say anything about its scaling. Report them as
   * unchecked rather than inventing a limit or, worse, failing the build on a
   * healthy channel. */
  const isRate = n => /\bDerivative\b/i.test(n);

  /* An ERROR / CORRECTION / TRIM is a signed delta of the base quantity, so the
   * base type's floor of 0 is simply the wrong floor: idle RPM error runs to -70,
   * O2 control error to -0.2 lambda. Mirror the ceiling instead of guessing. */
  const isDelta = n => /\b(Error|Correction|Trim|Offset)\b/i.test(n);

  /* Unpopulated channels pass through as raw integer sentinels — an unfitted WBC2
   * input reads -2147483.6 (int32 min, scaled), RPM Limit - Fuel reads 2147483647,
   * Engine Limiter Max RPM reads 65535. Those are "no value", not a decode error,
   * and counting them as out-of-range buried 48 real channels in noise.
   *
   * The tolerance is RELATIVE, not absolute: the payload bakes decoded values at
   * one decimal, so int32-min /1000 lands as -2147483.6 and re-multiplying misses
   * the true -2147483648 by 48. An absolute epsilon rejected every one of them. */
  const SENTINELS = [2147483647, -2147483648, 65535, 4294967295];
  const isSentinel = v => SENTINELS.some(s =>
    [1, 10, 100, 1000, 10000].some(k => Math.abs(v * k - s) < Math.abs(s) * 1e-5));

  /* A configured LIMIT is a setting, not a measurement: Engine Protection RPM
   * Limit reads 20000 to mean "not armed". Physical bounds do not apply. */
  const isConfig = n => /\b(Limit|Limiter|Setpoint|Threshold)\b/i.test(n);

  /* Run this over the EMBEDDED columns — the numbers the page actually draws —
   * not over a fresh parse of the source. The first version of this check
   * re-parsed the CSV with the current engine, so it proved the engine was fixed
   * while the stale payload beside it still shipped raw speed. The source is
   * consulted only for each channel's declared Type. */
  const i = h.indexOf('id="embedded-logs">');
  const from = i + 'id="embedded-logs">'.length;
  const logs = i < 0 ? [] :
    JSON.parse(h.slice(from, h.indexOf('</scr' + 'ipt>', from)).replace(/\\u003c/g, '<'));

  const unscaled = new Map();   // Type -> sample channel name
  const rates = new Set();      // derivative channels, reported but not bounded
  const empty = new Set();      // present but only ever the "no value" sentinel
  const bad = [];
  for (const e of logs) {
    if (!ex(join(DIR, e.file))) continue;
    const src = parseLog(rf(join(DIR, e.file), 'latin1'));
    const typeOf = Object.create(null);
    for (const ch of src.channels) {
      typeOf[ch.name] = ch.type;
      if (!(ch.type in TYPE_SCALE) && !unscaled.has(ch.type)) unscaled.set(ch.type, ch.name);
    }
    e.names.forEach((n, ci) => {
      const base = BOUNDS[typeOf[n]];
      if (!base) return;
      if (isRate(n) || isConfig(n)) { rates.add(`${n} (${typeOf[n]})`); return; }
      const b = isDelta(n) ? [-Math.abs(base[1]), base[1]] : base;
      let lo = Infinity, hi = -Infinity, seen = 0, sent = 0;
      for (const v of e.cols[ci]) {
        if (v === null || !Number.isFinite(v)) continue;
        seen++;
        if (isSentinel(v)) { sent++; continue; }           // "no value", not a decode error
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      if (!Number.isFinite(hi)) {                          // nothing but sentinels, or never populated
        if (seen && sent === seen) empty.add(`${n} (${typeOf[n]})`);
        return;
      }
      if (lo < b[0] || hi > b[1])
        bad.push(`${e.file}  ${n} (${typeOf[n]})  ${lo.toFixed(1)}..${hi.toFixed(1)}  outside ${b[0]}..${b[1]}`);
    });
  }

  console.log('decode plausibility: ' + (bad.length ? bad.length + ' CHANNEL(S) OUT OF RANGE' : 'all typed channels within physical bounds'));
  for (const b of bad) console.log('  *** ' + b);
  if (bad.length) process.exitCode = 1;

  // Not failures, but say so out loud: a channel nobody bounds-checked is exactly
  // where the next Speed-/10 hides, and silence would read as "verified".
  if (rates.size) console.log(`  ${rates.size} rate/config channel(s) not bounds-checked `
    + `(a derivative has no physical ceiling, a configured limit is not a measurement) `
    + `— e.g. ${[...rates].sort()[0]}`);
  if (empty.size) console.log(`  ${empty.size} channel(s) carry only the no-value sentinel `
    + `(unfitted input or unset limit) — e.g. ${[...empty].sort()[0]}`);

  if (unscaled.size) {
    console.log('  unscaled types (raw pass-through), verify before trusting a graph:');
    for (const [t, n] of [...unscaled].sort()) console.log('    ' + t.padEnd(26) + 'e.g. ' + n);
  }
}

/* ---- drag splits ----------------------------------------------------------
 * No real log has a standing launch yet, so the case the feature exists for has
 * no coverage from the embedded data. Assert against a closed form instead:
 * constant acceleration from rest, where s = 1/2*a*t^2 gives each mark exactly.
 * This caught a window where the launch threshold started the clock ~90 ms late
 * and every split read short. */
{
  const { dragSplits } = await import('../src/core.js');
  const g = 9.80665 * 0.6, rows = [];
  for (let i = 0; i <= 1500; i++) {
    const t = i * 0.01;
    rows.push({ t, values: [Math.max(0, t - 3) * g * 3.6] });   // 3 s stopped, then pull
  }
  const d = dragSplits({ channels: [{ name: 'Vehicle Speed', type: 'Speed' }],
                         byName: { 'Vehicle Speed': 0 }, rows });
  let worst = 0;
  for (const m of d.marks.filter(m => m.reached))
    worst = Math.max(worst, Math.abs(m.t - Math.sqrt(2 * (m.ft * 0.3048) / g)) * 1000);
  /* The rendered table, not just the maths: a standing start must report 0 km/h
   * at 0 ft, and an unreached mark must read NA rather than vanish. */
  const { dragTable } = await import('../src/core.js');
  const tbl = dragTable({ channels: [{ name: 'Vehicle Speed', type: 'Speed' }],
                          byName: { 'Vehicle Speed': 0 }, rows });
  const shape = tbl.available && tbl.rows.length === 3
    && tbl.rows[0].dist === '0 ft' && tbl.rows[0].speed === '0.0' && tbl.rows[0].time === '0.000'
    && tbl.rows[1].dist === '60 ft' && tbl.rows[2].dist === '1/4 mile';
  console.log('run summary: ' + tbl.rows.map(r => r.dist + ' ' + r.time + 's/' + r.speed).join('  |  '));
  if (!shape) { console.log('  *** run-summary table has the wrong shape ***'); process.exitCode = 1; }

  const okLaunch = !d.rollingStart && Math.abs(d.startTime - 3) < 0.02;
  console.log('drag splits: launch ' + d.startTime.toFixed(3) + ' s (expect 3.000), '
    + d.marks.filter(m => m.reached).length + ' marks, worst error '
    + worst.toFixed(1) + ' ms vs closed form');
  if (!okLaunch) { console.log('  *** launch not detected at the standstill ***'); process.exitCode = 1; }
  if (worst > 15) { console.log('  *** split timing drifted beyond 15 ms ***'); process.exitCode = 1; }
}

/* ---- one scope, no shadowing ----------------------------------------------
 * core.js, panels.js, charts.js and the page's own UI are concatenated into a
 * SINGLE script scope. Two `function foo()` declarations there is not an error
 * — the later one silently wins. That is how a `renderLogPicker` first written
 * as `renderPicker` replaced charts.js's graph picker, leaving the Channel
 * graphs section with no checkboxes and nothing thrown anywhere. `const` and
 * `let` collide loudly and are caught by the syntax check; function
 * declarations need this. */
{
  const names = new Map();
  for (const m of js.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm))
    names.set(m[1], (names.get(m[1]) || 0) + 1);
  const dupes = [...names].filter(([, n]) => n > 1);
  console.log('top-level functions: ' + names.size + ' declared, ' + dupes.length + ' duplicated');
  for (const [name, n] of dupes) {
    console.log('  *** ' + name + '() declared ' + n + ' times — the last one wins silently ***');
    process.exitCode = 1;
  }
}

/* ---- check engine light ---------------------------------------------------
 * No embedded log carries the Check Engine Light Cause channel yet, so the
 * feature ships with zero coverage from the bundle. Assert against a synthetic
 * log that exercises every rule at once: episodes counted as runs and not as
 * samples, a sub-second run reading Flicker against a long one reading Solid,
 * a DTC resolved to its published name, an unattributed cause staying a bare
 * code, and the idle code being derived from the lamp rather than assumed to
 * be zero — this ECU never emits 0 and idles on 1. */
{
  const { celCauses, dtcCode, dtcLabel } = await import('../src/core.js');
  const rows = [];
  //                        t, cause, lamp, flaggedDTC, epSeverity, clearedDTC
  const push = (t, c, l, f, cl) => rows.push({ t, values: [c, l, f, 0, cl] });
  for (let i = 0; i < 20; i++) push(i * 0.05, 1, 0, 0, 0);          // idle, nothing cleared yet
  for (let i = 0; i < 40; i++) push(1 + i * 0.05, 6, 1, 0, 0);      // 1.95 s, unattributable
  for (let i = 0; i < 20; i++) push(3 + i * 0.05, 1, 0, 0, 0);
  for (let i = 0; i < 4; i++) push(4 + i * 0.05, 4, 1, 1601, 0);    // 0.15 s, P0641 seen flagged
  for (let i = 0; i < 10; i++) push(4.2 + i * 0.05, 1, 0, 0, 1601); // P0641 cleared
  /* Second P0641 event with NOTHING flagged in-window — the fault came and went
   * between samples, exactly as it did in the real 2026-08-15 log. It must still
   * be named, from the cleared channel holding steady at 1601: any other fault
   * clearing would have moved it. */
  for (let i = 0; i < 4; i++) push(4.7 + i * 0.05, 4, 1, 0, 1601);
  for (let i = 0; i < 10; i++) push(4.9 + i * 0.05, 1, 0, 0, 1601);
  const names = ['Check Engine Light Cause', 'Check Engine Light Output State',
                 'Latest flagged DTC', 'Engine Protection Severity Level', 'Latest cleared DTC'];
  const log = {
    channels: names.map(name => ({ name })),
    byName: Object.fromEntries(names.map((n, i) => [n, i])),
    rows,
  };
  log.startClock = 12 * 3600 + 42 * 60 + 30;              // 12:42:30 — as parseLog reports it
  const c = celCauses(log);
  const p0641 = c.rows.find(r => r.code === 4), bare = c.rows.find(r => r.code === 6);
  console.log('check engine light: ' + c.rows.map(r =>
    r.cause + ' [' + r.protection + '/' + r.events + '/' + r.occurrence + ' @ ' + r.when + ']')
    .join('  |  '));

  const fail = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };
  if (dtcCode(1601) !== 'P0641') fail('DTC 1601 did not decode to P0641');
  if (dtcCode(0) !== null) fail('DTC 0 must decode to null, not a code');
  if (!/^P0641 — /.test(dtcLabel(1601))) fail('P0641 lost its published description');
  if (c.rows.length !== 2) fail('expected 2 lit causes, got ' + c.rows.length);
  /* ONE row per cause code. Keying rows on (code, DTC) split code 4 across two
   * rows when only one of its events could be named, so the table showed two
   * faults where the graph showed one code stepping twice. */
  if (!p0641 || p0641.events !== 2) fail('both code-4 events belong to ONE row, got ' + (p0641 && p0641.events));
  if (c.rows.filter(r => r.code === 4).length !== 1) fail('cause code 4 must not span two rows');
  if (!p0641 || !p0641.inferred) fail('the second event should be named from the cleared channel');
  if (!p0641 || p0641.occurrence !== 'Flicker') fail('a 0.15 s episode must read Flicker');
  if (!p0641 || !p0641.named) fail('P0641 should be reported as a named cause');
  if (!p0641 || p0641.protection !== 'No') fail('engine protection was idle, column should read No');
  if (!bare || bare.occurrence !== 'Solid') fail('a 1.95 s episode must read Solid');
  if (!bare || bare.named) fail('a cause with no DTC must not claim a name');
  if (!/^Code 6/.test(bare ? bare.cause : '')) fail('unnamed cause should render as its raw code');
  if (c.rows.some(r => r.code === 1)) fail('the idle code must not be tabled');
  if (c.quietCodes.join() !== '1') fail('idle code should be derived as 1, got ' + c.quietCodes.join());
  if (celCauses({ channels: [], byName: {}, rows: [] }).available)
    fail('a log without the channel must report unavailable, not an empty table');

  /* Times must be seconds from the start of the log — the graph axis — because
   * that is what someone reading this table can carry across to a trace. Both
   * events of a group get one, not just the first: two flickers a minute apart
   * read very differently from two in the same second. */
  if (!p0641 || p0641.times.length !== 2) fail('both P0641 events should carry a time');
  if (!p0641 || p0641.times.join(' ') !== '4.000 s 4.700 s')
    fail('P0641 events should read 4.000 s and 4.700 s, got ' + (p0641 && p0641.times.join(' ')));
  if (!bare || bare.times[0] !== '1.000 s')
    fail('the unnamed cause should read 1.000 s, got ' + (bare && bare.times[0]));
  if (c.startClock !== '12:42:30.0') fail('the log clock should be reported once, for NSP');
  if (!/same axis as the graphs/.test(c.note)) fail('the note must say what the times are measured from');
  // string-sorted times would put "155.865 s" before "79.880 s"
  const late = celCauses({ ...log, rows: log.rows.map(r => ({ ...r, t: r.t + 77 })) });
  const lt = late.rows.find(r => r.code === 4).times;
  if (parseFloat(lt[0]) > parseFloat(lt[1])) fail('event times are not in chronological order: ' + lt.join(' '));
  if (celCauses({ ...log, startClock: null }).startClock !== null)
    fail('a log with no clock must not invent one');
}

/* ---- the engine-off cause code --------------------------------------------
 * Cause 2 is named from evidence, not from the ECU — NSP encrypts the cause
 * enum's labels — so the name has to be withheld when the log contradicts it.
 * Both directions, because the failure this guards against is a table reading
 * "Engine off" beside a trace at 3,000 rpm. */
{
  const { celCauses, CEL_CAUSE_NAMES } = await import('../src/core.js');
  const fail = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };
  const names = ['Check Engine Light Cause', 'Check Engine Light Output State',
                 'Latest flagged DTC', 'Latest cleared DTC', 'RPM'];
  const build = rpmAt => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ t: i * 0.05, values: [1, 0, 0, 0, 1500] });
    // shutdown: the cause code steps a sample before RPM catches up, as it does
    // in the real log — one stale reading must not cost the name.
    rows.push({ t: 1, values: [2, 1, 0, 0, rpmAt] });
    for (let i = 1; i < 60; i++) rows.push({ t: 1 + i * 0.05, values: [2, 1, 0, 0, rpmAt === 1065 ? 0 : rpmAt] });
    return { channels: names.map(name => ({ name })), byName: Object.fromEntries(names.map((n, i) => [n, i])), rows };
  };

  const off = celCauses(build(1065)).rows.find(r => r.code === 2);
  console.log('engine-off cause: ' + (off ? off.cause + '  [' + off.occurrence + ']' : 'NO ROW'));
  if (CEL_CAUSE_NAMES[2] !== 'Engine off') fail('cause code 2 lost its Engine off name');
  if (!off || off.cause !== 'Code 2 — Engine off') fail('a stopped engine should be named, got ' + (off && off.cause));
  if (!off || !off.named) fail('a named cause must not render as a raw code');
  if (!off || off.knownCause !== 'Engine off') fail('knownCause should carry the name');
  if (!/key on and the engine stopped/.test(celCauses(build(1065)).note))
    fail('the table should say why an engine-off lamp is normal');

  // Same code, engine turning throughout: the name must NOT be claimed.
  const run = celCauses(build(3000));
  const hot = run.rows.find(r => r.code === 2);
  if (!hot || hot.knownCause) fail('Engine off was claimed over a running engine');
  if (!hot || !hot.causeMismatch) fail('the mismatch should be reported, not swallowed');
  if (!/RPM says the engine was running/.test(run.note)) fail('the note should explain the withheld name');
  console.log('  engine running under code 2 -> "' + (hot && hot.cause) + '" (name withheld)');

  // No RPM channel is not evidence against the name — nothing to check it with.
  const bare = ['Check Engine Light Cause', 'Check Engine Light Output State'];
  const rows = [{ t: 0, values: [1, 0] }];
  for (let i = 1; i < 40; i++) rows.push({ t: i * 0.05, values: [2, 1] });
  const noRpm = celCauses({ channels: bare.map(name => ({ name })),
                            byName: Object.fromEntries(bare.map((n, i) => [n, i])), rows });
  const r2 = noRpm.rows.find(r => r.code === 2);
  if (!r2 || r2.knownCause !== 'Engine off') fail('a log without RPM should still get the name');
}

/* ---- lit-vs-idle without the lamp channel ---------------------------------
 * The ECU-download Log####.csv files carry Check Engine Light Cause but NOT
 * Output State, and they are the only logs that cover an actual run. Taking the
 * most-common code as idle there is backwards for a LATCHING fault, which owns
 * the tail of the log while the quiet code owns the short lead-in: on
 * 2026-08-22 that hid a P1276 lean trip Danie had watched NSP report, and
 * tabled the idle code in its place. Assert both halves — the fault appears,
 * and the idle code does not — because a fix that only stops tabling code 1
 * would still leave the light missing. */
{
  const { celCauses, CEL_DARK_CODES } = await import('../src/core.js');
  const fail = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };
  const names = ['Check Engine Light Cause', 'Wideband O2 1', 'Target Lambda'];
  const mk = rows => ({ channels: names.map(name => ({ name })),
                        byName: Object.fromEntries(names.map((n, i) => [n, i])), rows });
  /* Log3097's shape: a short stretch of idle, then the code latches to the end
   * of the log and outnumbers it 5:1. Lean at the trip, as the real one is. */
  const latch = (code, wbAfter) => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push({ t: i * 0.005, values: [1, 0.86, 0.78] });
    for (let i = 0; i < 200; i++) rows.push({ t: 0.2 + i * 0.005, values: [code, wbAfter, 0.712] });
    return mk(rows);
  };

  const c = celCauses(latch(7, 0.86));
  console.log('latched fault without the lamp channel: '
    + (c.rows.length ? c.rows.map(r => r.cause + ' [' + r.occurrence + ' @ ' + r.when + ']').join(' | ') : 'NO ROWS')
    + '   idle=' + c.quietCodes.join(','));
  if (!CEL_DARK_CODES.has(1)) fail('code 1 must be in the never-lit reference set');
  if (!c.rows.some(r => r.code === 7)) fail('the latching fault was not tabled — this is the 08-22 bug');
  if (c.rows.some(r => r.code === 1)) fail('the idle code was tabled as the fault');
  if (c.quietCodes.join() !== '1') fail('code 1 should be footnoted as idle, got ' + c.quietCodes.join());
  if (!/never once driven the lamp/.test(c.note)) fail('the note must say where lit-vs-idle came from');
  if (/most-common code is assumed/.test(c.note)) fail('the most-common guess should not be used here');

  /* The most-common fallback still applies where the reference set recognises
   * nothing — there it is the only signal there is, and it must say so. */
  const unknown = celCauses(mk([
    ...Array.from({ length: 40 }, (_, i) => ({ t: i * 0.005, values: [3, 0.86, 0.78] })),
    ...Array.from({ length: 10 }, (_, i) => ({ t: 0.2 + i * 0.005, values: [6, 0.86, 0.78] })),
  ]));
  if (!unknown.rows.some(r => r.code === 6)) fail('with no known code, the rarer one should still be tabled');
  if (!/most-common code is assumed/.test(unknown.note)) fail('the assumption must be stated');

  /* Code 7's name is Danie's NSP readout, not something the log says, so it is
   * gated the same way "Engine off" is: withheld when the log contradicts it. */
  const lean = celCauses(latch(7, 0.86)).rows.find(r => r.code === 7);
  if (!lean || lean.knownCause !== 'Wideband 1 AFR lean trip (P1276)')
    fail('a lean trip should be named, got ' + (lean && lean.cause));
  if (!/P1276/.test(celCauses(latch(7, 0.86)).note)) fail('the note should say where the P1276 name comes from');
  // same code, measured AT target where it appeared: the name must not be claimed
  const rich = celCauses(latch(7, 0.70));
  const r7 = rich.rows.find(r => r.code === 7);
  if (!r7 || r7.knownCause) fail('the lean-trip name was claimed over a wideband at target');
  if (!r7 || !r7.causeMismatch) fail('the mismatch should be reported, not swallowed');
  if (!/wideband was not lean of target/.test(rich.note)) fail('the note should explain the withheld name');
  console.log('  wideband at target under code 7 -> "' + (r7 && r7.cause) + '" (name withheld)');
  // no wideband channel at all is not a contradiction — nothing to check it with
  const bare = ['Check Engine Light Cause'];
  const noWb = celCauses({ channels: bare.map(name => ({ name })), byName: { [bare[0]]: 0 },
    rows: [{ t: 0, values: [1] }, ...Array.from({ length: 40 }, (_, i) => ({ t: 0.005 + i * 0.005, values: [7] }))] });
  if (!noWb.rows.find(r => r.code === 7)?.knownCause)
    fail('a log with no wideband should still get the name');
}

/* ---- lift transients are suppressed SILENTLY ------------------------------
 * Two halves, and both have to hold:
 *   1. the excursion is still dismissed (annotateLimits clears the fuel flags),
 *   2. nothing is REPORTED about it.
 * The second half is the one with history. The suppression first shipped with an
 * `info` card saying "28 samples were dismissed as throttle-lift recovery", and
 * Danie had it removed: the warnings panel is for things needing attention, and
 * a dismissed excursion by definition needs none.
 *
 * The rule is about PURPOSE, not the severity label. An earlier version of this
 * check banned `info` outright and was wrong: `overrun-gate-fallback` is info and
 * belongs, because it ends by asking for an action ("Log Injector 1 Duty Cycle
 * for the direct test"). 44 of the 105 logs raise it. So assert the one card is
 * gone, and leave severity alone. */
{
  const { extractSamples, annotateLimits, checkLimits, VEHICLE } = await import('../src/core.js');
  const fail = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };
  const names = ['RPM', 'Throttle Position', 'Manifold Pressure', 'Fuel Pressure',
                 'Fuel Pressure Expected', 'Injector 1 Duty Cycle', 'Wideband O2 1',
                 'Target Lambda'];
  /* Channels are declared Raw so decode() is the identity — these are already in
   * real units. Getting that wrong reads throttle 970 as 970%, which trips the
   * plausibility bound and buries the thing under test. */
  //                     rpm,  tps, map, fuelP, expected, duty, wb,   tgt
  const row = (t, v) => ({ t, values: v });
  const wot = [6000, 97, 250, 650, 650, 30, 0.85, 0.80];   // diff 400 vs target 400
  const lift = [4000, 0, 40, 740, 440, 8, 0.90, 1.00];     // diff 700 vs target 400 = +75%
  const calm = [4000, 0, 40, 440, 440, 8, 0.99, 1.00];     // back in band
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(row(i * 0.006, wot));            // WOT, in band
  for (let i = 0; i < 30; i++) rows.push(row(1.8 + i * 0.006, lift));      // lift + spike
  for (let i = 0; i < 300; i++) rows.push(row(2.0 + i * 0.006, calm));     // recovered
  const log = { channels: names.map(name => ({ name, type: 'Raw' })),
                byName: Object.fromEntries(names.map((n, i) => [n, i])), rows, meta: {} };
  const { samples, fuel } = extractSamples(log);
  annotateLimits(samples, VEHICLE, fuel);
  const trans = samples.filter(s => s.fuelTransient);
  if (!trans.length) fail('the lift spike was not recognised as a transient at all');
  if (trans.some(s => s.fuelOverPressure || s.fuelStarved))
    fail('a transient sample kept its fuel flag - suppression is not working');
  const w = checkLimits(samples, VEHICLE, fuel);
  console.log('lift transient: ' + trans.length + ' samples suppressed, '
    + w.length + ' warning(s) raised [' + (w.map(x => x.id).join(' ') || 'none') + ']');
  if (w.some(x => x.id === 'fuel-lift-transient'))
    fail('the dismissed-transient card is back - Danie asked for it gone');
  if (w.length)
    fail('a suppressed lift transient must raise NOTHING, got: ' + w.map(x => x.id).join(' '));
}

/* ---- engine protection derived from the actuators, and the code-4 name -----
 * The ECU-download logs carry no Engine Protection channels, so that column
 * read "—" on exactly the row where protection had fired. It is inferred from
 * three actuators moving the protective way in one sample. Assert the
 * attribution too: in the real Log3097 the intervention lands on the LAST
 * sample of the code-4 flicker, one before code 7 starts, and it belongs to
 * code 7 — an "any sample in the episode" rule would blame both. */
{
  const { celCauses, CEL_CAUSE_NAMES } = await import('../src/core.js');
  const fail = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };
  const names = ['Check Engine Light Cause', 'Wideband O2 1', 'Target Lambda',
                 'Ignition Correction Total', 'Boost Control Solenoid Duty Cycle',
                 'Diagnostic Analogue 5V rail'];
  //                 cause, wb,   tgt,   ignCorr, boostDuty, rail
  const calm = c => [c, 0.86, 0.782, 4.5, 60, 5.122];
  const prot = c => [c, 0.86, 0.712, -0.4, 0, 5.122];   // -5.0 deg, -0.070 λ, duty -> 0
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ t: i * 0.005, values: calm(1) });
  for (let i = 0; i < 3; i++) rows.push({ t: 0.2 + i * 0.005, values: calm(4) });   // the flicker
  rows.push({ t: 0.215, values: prot(4) });            // intervention, still under code 4
  for (let i = 0; i < 200; i++) rows.push({ t: 0.22 + i * 0.005, values: prot(7) });
  const c = celCauses({ channels: names.map(name => ({ name })),
                        byName: Object.fromEntries(names.map((n, i) => [n, i])), rows });
  const r4 = c.rows.find(r => r.code === 4), r7 = c.rows.find(r => r.code === 7);
  console.log('derived protection: ' + c.rows.map(r => r.cause + ' [prot ' + r.protection + ']').join('  |  '));
  if (!r7 || r7.protection !== 'Yes') fail('protection should be derived for the latched code');
  if (!r7 || !r7.protectionDerived) fail('the row should record that protection was derived');
  if (!r4 || r4.protection !== 'No') fail('protection was blamed on the 4-sample flicker too, got ' + (r4 && r4.protection));
  if (!/read off the actuators/.test(c.note)) fail('the note must say the column was derived');

  // all three levers are required — any two must not read as an intervention
  const partial = rows.map(r => (r.values[0] === 7 || r.values[4] === 0)
    ? { ...r, values: [...r.values.slice(0, 4), 60, r.values[5]] } : r);   // boost never drops
  const cp = celCauses({ channels: names.map(name => ({ name })),
                         byName: Object.fromEntries(names.map((n, i) => [n, i])), rows: partial });
  if (cp.rows.find(r => r.code === 7)?.protection !== 'No')
    fail('ignition + lambda without the boost cut must not read as protection');
  if (!/none of them show an intervention/.test(cp.note))
    fail('"checked, nothing found" must not render the same as "cannot check"');

  /* Code 4's name comes from the DTCs seen against it in OTHER logs, so it is
   * gated on this log's 5V rail being off nominal — and a captured DTC must
   * still win over it. */
  if (CEL_CAUSE_NAMES[4] !== 'Sensor 5V reference (P0641/P0642)') fail('code 4 lost its name');
  if (!r4 || r4.knownCause !== CEL_CAUSE_NAMES[4]) fail('code 4 should be named, got ' + (r4 && r4.cause));
  if (!/9 of them/.test(c.note)) fail('the note should say where the code-4 name comes from');
  const healthy = celCauses({ channels: names.map(name => ({ name })),
    byName: Object.fromEntries(names.map((n, i) => [n, i])),
    rows: rows.map(r => ({ ...r, values: [...r.values.slice(0, 5), 5.000] })) });
  const h4 = healthy.rows.find(r => r.code === 4);
  if (!h4 || h4.knownCause) fail('the 5V name was claimed over a rail sitting on 5.000 V');
  if (!h4 || !h4.causeMismatch) fail('the mismatch should be reported, not swallowed');
  console.log('  5V rail on nominal under code 4 -> "' + (h4 && h4.cause) + '" (name withheld)');
  // a bare code must say WHICH kind of nothing it is
  if (!/no DTC channel logged/.test(healthy.rows.find(r => r.code === 4).cause))
    fail('a bare code should say the log has no DTC channel');
}

/* ---- log ordering ---------------------------------------------------------
 * The dropdown's "most recent" must mean the most recent RUN. File mtime and
 * the download stamp both get this wrong: NSP extracts newest-first, so within
 * a batch they run backwards against the ECU's own log numbers. Measured on the
 * real folder, 7 of 8 multi-log batches were inverted. */
{
  const { sortLogs, logNumber } = await import('../src/core.js');
  const fail = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };

  if (logNumber('2026-08-09_0333pm_Log3060.csv') !== 3060) fail('log number not read');
  if (logNumber('2026-08-15_1006am_Logs3065to3085.csv') !== 3085)
    fail('a combined export should rank by its HIGHEST log number');
  if (logNumber('PCLog_2026-08-15_1242pm20.csv') !== null)
    fail('a PC log has no ECU log number');

  const order = sortLogs([
    '2026-08-15_1000am_Log3078.csv',       // downloaded LATER but recorded earlier
    '2026-08-15_0959am_Log3085.csv',
    '2026-08-09_0333pm_Log3060.csv',
    '2026-08-09_0333pm_Log3062.csv',
    'PCLog_2026-08-15_1242pm20.csv',
  ].map(file => ({ file }))).map(x => x.file);
  console.log('log order: ' + order.map(f => f.replace(/\.csv$/, '')).join('  >  '));

  const at = n => order.findIndex(f => f.includes(n));
  if (at('1242pm20') !== 0) fail('the 12:42pm PC log is the newest run and should sort first');
  if (at('3085') > at('3078')) fail('Log3085 is a later run than Log3078 despite the earlier download');
  if (at('3062') > at('3060')) fail('Log3062 is a later run than Log3060');
  if (at('Log3078') > at('3060')) fail('the 08-15 logs should outrank the 08-09 ones');
}

/* ---- execute it -----------------------------------------------------------
 * Parsing is not running. A `const` referenced before its initialiser, or a
 * filter that silently matches nothing, both parse perfectly and then fail in
 * the browser. So boot the page against a stub DOM and assert it produced a
 * grid — the same path a visitor hits on load. */
{
  const rawJson = (() => {
    const i = h.indexOf('id="embedded-logs">');
    if (i < 0) return '[]';
    const from = i + 'id="embedded-logs">'.length;
    return h.slice(from, h.indexOf('</scr' + 'ipt>', from));
  })();

  const noop = () => {};
  const ctx2d = new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : noop) });

  function makeEl(tag = 'div') {
    const e = {
      tagName: tag, children: [], _text: '', _html: '', value: '',
      classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
      dataset: {}, onchange: null, onclick: null,
      style: new Proxy({}, { get: (t, k) => (k === 'setProperty' ? noop : t[k]),
                             set: (t, k, v) => { t[k] = v; return true; } }),
      appendChild(c) { e.children.push(c); return c; },
      addEventListener: noop, removeEventListener: noop,
      querySelector: () => makeEl(), querySelectorAll: () => [],
      setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
      getContext: () => ctx2d,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 150 }),
      focus: noop, click: noop, remove: noop,
      /* Real enough for the graph filter, which rebuilds its <option> list on
       * every keystroke and restores focus afterwards. A stub that threw on
       * `contains` meant the page booted here and nowhere else. */
      contains: n => { for (const c of e.children) if (c === n || (c.contains && c.contains(n))) return true; return false; },
      setSelectionRange: noop,
    };
    // Real textContent REPLACES the children. The filter clears its <option>
    // list that way, so a stub that only set a string let options pile up and
    // "the list narrowed" would have been unfalsifiable.
    Object.defineProperty(e, 'textContent', {
      get: () => e._text, set: v => { e._text = String(v); e.children.length = 0; } });
    Object.defineProperty(e, 'innerHTML', { get: () => e._html, set: v => { e._html = String(v); } });
    return e;
  }

  const REG = Object.create(null);
  REG['embedded-logs'] = makeEl('script');
  REG['embedded-logs'].textContent = rawJson;
  const pick = sel => {
    const id = String(sel).replace(/^#/, '');
    return (REG[id] ||= makeEl());
  };

  const sandbox = {
    console,
    document: {
      getElementById: pick, querySelector: pick,
      querySelectorAll: () => [], createElement: t => makeEl(t),
      createElementNS: (_, t) => makeEl(t),
      addEventListener: noop, documentElement: makeEl('html'), body: makeEl('body'),
      activeElement: null,
      readyState: 'complete', fonts: { ready: Promise.resolve() },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#000000' }),
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: fn => fn(),          // run the canvas path too
    setTimeout: fn => fn(), clearTimeout: noop,
    innerWidth: 1400, innerHeight: 900,
    addEventListener: noop, localStorage: { getItem: () => null, setItem: noop },
    URL: { createObjectURL: () => 'blob:', revokeObjectURL: noop },
    Blob: class {}, FileReader: class { readAsText() {} },
  };

  /* A stand-in for the claude.ai runtime, so the ask panel can be driven here.
   * It records every sample() call: the page spends the VIEWER's Claude usage
   * on each one, so "it never samples unless a human clicks" is a property that
   * has to be asserted, not assumed.
   *
   * THE SIGNATURE HERE IS POSITIONAL — sample(prompt, options) — because that
   * is what the live runtime does, verified from its own rejection message on
   * 2026-09-11. An earlier stub took a single {prompt, modelTier} object, which
   * is what the bundled type definitions describe; the page passed that stub,
   * shipped, and failed on every question in the real viewer. A stub that
   * accepts a shape the platform refuses is worse than no stub, so this one
   * refuses the object form exactly the way the runtime does. */
  const sampled = [];
  /* 'ok'      — answers anything well-formed
   * 'no-opts' — refuses the options argument, to prove the fallback
   * 'fail'    — rejects everything, to prove the error surfaces its code
   * 'shape:*' — answers with the text somewhere OTHER than `completion`, or
   *             with no text at all; see SAMPLE_SHAPES below */
  let sampleMode = 'ok';

  /* The answer text does not always come back under `completion`.
   *
   * The 0.2.2 type definitions say it does, and this stub said it does, and on
   * 2026-09-11 the live runtime returned an object carrying modelTierApplied
   * and NOTHING under `completion` — 38.6 s of real work rendered as an empty
   * answer on Danie's screen while this gate stayed green, because the one
   * shape it ever produced was the one shape that already worked. A stub that
   * only reproduces the happy path cannot catch this class of bug at all.
   *
   * So: every plausible carrier, plus the case that matters most — a reply with
   * no text anywhere. That one must stay DIAGNOSABLE (name the keys that did
   * come back) and must not be filed as an answer. */
  const SAMPLE_MD = '## Most likely\nFuel **supply**, not calibration.\n\n'
    + '- differential fell at `1.97 s`\n- duty hit the ceiling\n\n'
    + '| cell | change |\n| --- | --- |\n| 7000x300 | +4% |\n\n'
    + 'Script check: <img src=x onerror=alert(1)> & <b>tags</b>';
  const SAMPLE_SHAPES = {
    completion: { reply: t => ({ completion: t }),                                via: 'completion' },
    string:     { reply: t => t,                                                  via: 'string' },
    text:       { reply: t => ({ text: t }),                                      via: 'text' },
    blocks:     { reply: t => ({ content: [{ type: 'text', text: t }] }),         via: 'content[]' },
    nested:     { reply: t => ({ message: { content: [{ type: 'text', text: t }] } }), via: 'message.text' },
    // No text under any key — only metadata. This is the 2026-09-11 failure.
    none:       { reply: () => ({ modelTierApplied: 'complex', stopReason: 'end_turn' }), via: null },
  };
  sandbox.claude = {
    use: name => Promise.resolve(name === 'sample'
      ? ((prompt, options) => {
          sampled.push({ prompt, options });
          if (typeof prompt !== 'string' || !prompt.trim())
            return Promise.reject({ code: 'invalid_request',
              message: 'pass the prompt as the first argument: sample(prompt, options)' });
          if (sampleMode === 'no-opts' && options !== undefined)
            return Promise.reject({ code: 'invalid_request', message: 'unexpected options' });
          if (sampleMode === 'fail')
            return Promise.reject({ code: 'rate_limited', message: 'usage limit reached' });
          const shape = SAMPLE_SHAPES[sampleMode.replace(/^shape:/, '')]
            || SAMPLE_SHAPES.completion;
          const r = shape.reply(SAMPLE_MD);
          if (r && typeof r === 'object' && !('modelTierApplied' in r))
            r.modelTierApplied = (options && options.modelTier) || 'default';
          return Promise.resolve(r);
        })
      : null),
  };
  sandbox.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.createContext(sandbox);
    vm.runInContext(js
      + '\n;globalThis.__state = (typeof state !== "undefined") ? state : null;'
      + '\n;globalThis.__S = (typeof S !== "undefined") ? S : null;'
      + '\n;globalThis.__ts = { move: tsMove, set: tsSetWindow, at: tsIdxAt, sync: syncCharts };'
      + '\n;globalThis.__render = render;'
      + '\n;globalThis.__ask = { state: ASK, md: askMarkdown, brief: buildLogBrief,'
      + '\n                      events: detectEvents, hidden: askHidden,'
      + '\n                      fromEmbedded: logFromEmbedded, embedded: EMBEDDED };',
      sandbox, { filename: 'haltune-inline.js' });
    const st = sandbox.__state;
    if (!st) throw new Error('script ran but never created `state`');
    if (!st.res) throw new Error('no analysis produced — the default log did not load');
    const g = st.res.grid || [];
    console.log('boot: OK — loaded "' + st.fileName + '", '
      + st.res.counts.valid + '/' + st.res.counts.total + ' samples, '
      + g.length + ' cells, ' + (st.res.warnings || []).length + ' warnings, '
      + (st.blocked ? st.blocked.size : 0) + ' blocked cells');
    if (!g.length) { console.log('  *** grid is EMPTY — the page would render nothing ***'); process.exitCode = 1; }

    /* ---- masthead log tile ------------------------------------------------
     * The log dropdown and the folder picker were removed on 2026-08-24, so
     * this tile is the ONLY place the page names the log on screen. It is
     * innerHTML written from render(); nothing short of a boot catches it going
     * blank, or still saying "Sample" over a log the viewer opened. Assert it
     * is populated, and that the controls it replaced are really gone rather
     * than merely hidden — a stray $('#logsel') would throw on the live page. */
    const tile = (REG['logtile'] && REG['logtile'].innerHTML) || '';
    console.log('log tile: '
      + (tile.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '(empty)'));
    if (!tile.includes(st.fileName)) {
      console.log('  *** the masthead tile does not name the loaded log ***');
      process.exitCode = 1;
    }
    if (st.fileKind !== 'bundled' || !/Sample/.test(tile)) {
      console.log('  *** a bundled log must be labelled Sample — it is not off the car ***');
      process.exitCode = 1;
    }
    for (const dead of ['logsel', 'folderBtn', 'dirTop', 'srcnote']) {
      if (js.includes('#' + dead) || h.includes('id="' + dead + '"')) {
        console.log('  *** removed control #' + dead + ' is still referenced ***');
        process.exitCode = 1;
      }
    }

    /* ---- ask panel --------------------------------------------------------
     * Driven end to end against the stub runtime above. Three of these can only
     * fail at runtime and all three would be expensive to ship:
     *   - sampling on page load would spend the viewer's Claude usage without
     *     them asking for anything;
     *   - a prompt over 64 KiB is rejected outright, and the log decides its
     *     size, so the cap has to hold on the biggest thing this page carries;
     *   - the answer is model text written into innerHTML, so if it is not
     *     escaped the page has a script-injection hole with a very short path
     *     from "ask a question" to "run whatever came back". */
    const bad = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };
    await new Promise(r => setImmediate(r));          // let initAsk()'s await settle
    const A = sandbox.__ask;

    if (typeof A.state.fn !== 'function') bad('the ask panel never resolved the sample capability');
    if (A.hidden()) bad('the ask panel is hidden even though a log is loaded and sampling works');
    if (sampled.length) bad('the page sampled Claude on LOAD (' + sampled.length + ' calls) — '
      + 'that spends the viewer\'s usage without them asking');

    // The evidence brief over the log that is actually on screen.
    const brief = A.brief(st.log, { fileName: st.fileName, res: st.res });
    const want = ['## LOG', '## CAR AND CONFIGURATION', '## TIME-RESOLVED EVENTS',
                  '## MEASURED VS TARGET BY CELL', '## CHANNELS LOGGED'];
    const missing = want.filter(w => !brief.text.includes(w));
    console.log('evidence brief: ' + (brief.bytes / 1024).toFixed(1) + ' KB, '
      + brief.sections.length + ' sections, ' + brief.events.events.length + ' events listed'
      + (brief.droppedSections.length ? ', dropped ' + brief.droppedSections.join('/') : ''));
    if (missing.length) bad('the brief is missing section(s): ' + missing.join(', '));
    if (brief.bytes < 2000) bad('the brief is suspiciously small (' + brief.bytes + ' B)');
    if (!brief.text.includes(st.fileName)) bad('the brief does not name the log it came from');

    /* Event detection against the SHIPPED payload for the reference pull, not a
     * fresh parse: Log3056 is the one bundled log known to hit the injector
     * ceiling (111.8%) and drop rail differential, so if the detector goes
     * quiet on it, it has stopped working. */
    const ref = (A.embedded || []).find(e => /Log3056/.test(e.file));
    if (!ref) bad('Log3056 is no longer in the bundle — the event detector has nothing to prove itself on');
    else {
      const ev = A.events(A.fromEmbedded(ref));
      const tally = Object.entries(ev.counts).filter(([, n]) => n > 0)
        .map(([k, n]) => k + ' ' + n).join(', ');
      console.log('events on Log3056: ' + (tally || 'NONE') + '  (' + ev.events.length
        + ' listed, ' + ev.dropped + ' held back)');
      if (!ev.available) bad('event detection failed on Log3056: ' + ev.reason);
      if (!ev.counts['duty-ceiling']) bad('no duty-ceiling event on Log3056, which peaks at 111.8%');
      if (!ev.counts['fuel-starve']) bad('no fuel-starve event on Log3056, whose rail differential collapses');
      for (const e of ev.events) {
        if (!(e.tWorst >= e.t - 1e-9 && e.tWorst <= e.tEnd + 1e-9))
          bad('event ' + e.kind + ' reports a snapshot time outside its own episode');
      }

      /* ---- Engine torque, on the same reference pull -----------------------
       * The log the page boots with is an idle capture that never passes 95%
       * throttle, so the torque panel is correctly ABSENT there and proves
       * nothing. Log3056 is the pull: 85-87% ethanol, throttle to 98%, 7980
       * rpm. Assert the panel exists, that it picked the E85 map off the
       * ethanol channel, and that it is blank off-throttle rather than drawing
       * a line through a part-throttle cruise. */
      /* Only FUNCTIONS reach the sandbox global — a top-level `const` does not
       * — so this asserts the contract through the functions and the literal
       * thresholds the panel is specified in terms of (95% throttle, 80%
       * ethanol), which is the right thing to pin anyway. */
      const bp = sandbox.buildPanels, dq = sandbox.dynoTorqueNm, dc = sandbox.dynoCurveFor;
      const WOT = 95, SWITCH = 80;
      if (typeof bp !== 'function' || typeof dq !== 'function' || typeof dc !== 'function') {
        bad('buildPanels/dynoTorqueNm/dynoCurveFor are not in the inlined engine — torque cannot be checked');
      } else {
        const dyn = { wotThrottlePct: WOT, e85: dc(86), petrol98: dc(0), from: 3500, rpmStep: 100 };
        const refLog = A.fromEmbedded(ref);
        const tp = (bp(refLog) || []).find(q => q.key === 'torque');
        if (!tp) bad('no Engine torque panel on Log3056, which reaches 98% throttle on E85');
        else {
          const vals = tp.series[0].values;
          const live = vals.filter(v => v !== null);
          const tpsCol = refLog.byName['Throttle Position'];
          const wot = refLog.rows.filter(r => r.values[tpsCol] > dyn.wotThrottlePct).length;
          console.log('engine torque on Log3056: ' + live.length + '/' + vals.length
            + ' samples, ' + Math.min(...live).toFixed(0) + '-' + Math.max(...live).toFixed(0)
            + ' Nm, limit line "' + tp.limits.map(l => l.label).join(' | ') + '"');
          if (!live.length) bad('the torque panel drew nothing on a log that does reach full throttle');
          if (live.length > wot) bad('the torque panel put a value on ' + live.length
            + ' samples but only ' + wot + ' are over ' + dyn.wotThrottlePct
            + '% throttle — it is drawing through part throttle');
          if (tp.unit !== 'Nm') bad('the torque panel is not in Nm');
          if (!/E85/.test(tp.note)) bad('Log3056 runs 85-87% ethanol but the panel did not select the E85 map');
          if (Math.max(...live) > dyn.e85.peakNm)
            bad('a sample exceeds the E85 map peak of ' + dyn.e85.peakNm + ' Nm');
        }
        /* The 80% ethanol switch and the refusal to extrapolate are the two
         * decisions most likely to rot silently. */
        for (const [what, eth, want] of [
          ['E85 just above the switch', SWITCH + 1, dyn.e85],
          ['98 just below it', SWITCH - 1, dyn.petrol98],
          ['98 when ethanol is absent', NaN, dyn.petrol98],
        ]) if (dc(eth) !== want) bad('dyno map choice wrong for ' + what);
        if (dyn.e85.peakNm <= dyn.petrol98.peakNm)
          bad('the E85 map does not out-torque the 98 map — the two curves are swapped');
        for (const rpm of [dyn.from - 100, dyn.from + dyn.e85.nm.length * dyn.rpmStep])
          if (Number.isFinite(dq(rpm, 86)))
            bad('dyno torque extrapolated to ' + rpm + ' rpm, outside the ramp');
        // The printed peaks are what the whole table was anchored on.
        for (const c of [dyn.e85, dyn.petrol98]) {
          const got = dq(c.peakNmRpm, c === dyn.e85 ? 86 : 0);
          if (!(Math.abs(got - c.peakNm) / c.peakNm < 0.02))
            bad(c.label + ': lookup at its own peak rpm gives ' + got.toFixed(1)
              + ' Nm, over 2% from the printed ' + c.peakNm);
        }
      }
    }

    // Drive the button the way a viewer does.
    REG['askQ'].value = 'Why does it stutter under acceleration?';
    await REG['askGo'].onclick();
    await new Promise(r => setImmediate(r));

    if (sampled.length !== 1) bad('one click produced ' + sampled.length + ' sample calls');
    const p = sampled[0] ? sampled[0].prompt : '';
    const pBytes = Buffer.byteLength(p, 'utf8');
    console.log('ask: 1 click -> 1 call, prompt ' + (pBytes / 1024).toFixed(1) + ' KB positional, '
      + 'options ' + JSON.stringify(sampled[0] && sampled[0].options));
    if (typeof p !== 'string' || !p.trim())
      bad('the prompt did not arrive as the first positional argument — sample(prompt, options)');
    if (pBytes > 64 * 1024) bad('the prompt is ' + pBytes + ' B, past the 64 KiB sampling cap');
    if (!p.includes('=== EVIDENCE FROM THE LOG ===')) bad('the prompt carries no evidence block');
    if (!p.includes('stutter under acceleration')) bad('the prompt does not carry the question');
    if (!p.includes('NO web access')) bad('the prompt does not tell the model it has no web access');

    const rendered = REG['askOut'].innerHTML || '';
    if (!A.state.turns.length) bad('the answer was never added to the conversation');
    if (!/<table>/.test(rendered)) bad('a markdown table in the answer did not render');
    /* A LIVE tag is the hole. The string "onerror=" surviving inside escaped
     * text is not — it is inert once the angle brackets are entities, and
     * testing for it would fail on a correctly escaped page. */
    if (/<img|<script/i.test(rendered))
      bad('model output reached innerHTML UNESCAPED — that is a script-injection hole');
    if (!/&lt;img/.test(rendered)) bad('the escaped form of the answer is not in the output');

    // A follow-up must carry the conversation, since sampling is memory-less.
    REG['askQ'].value = 'And what should I log next?';
    await REG['askGo'].onclick();
    await new Promise(r => setImmediate(r));
    if (sampled.length !== 2) bad('the follow-up did not produce exactly one more call');
    else if (!sampled[1].prompt.includes('EARLIER IN THIS CONVERSATION'))
      bad('the follow-up dropped the conversation history — every answer would start from scratch');
    else console.log('  follow-up carries the previous turn, answers escaped, tables rendered');

    /* A viewer whose runtime refuses the options argument must still get an
     * answer, rather than the dead panel 2026-09-11 shipped. */
    sampleMode = 'no-opts';
    const before = sampled.length, turnsBefore = A.state.turns.length;
    REG['askQ'].value = 'Retry against a runtime that refuses modelTier';
    await REG['askGo'].onclick();
    await new Promise(r => setImmediate(r));
    const tried = sampled.slice(before);
    if (A.state.turns.length !== turnsBefore + 1)
      bad('a viewer that refuses the options argument gets no answer — the fallback did not fire');
    else if (tried.length !== 2)
      bad('the options fallback took ' + tried.length + ' calls, expected 2');
    else if (tried[1].options !== undefined)
      bad('the fallback passed options again, so it would fail the same way');
    else console.log('  options refused -> retried with the prompt alone -> answered '
      + '(' + tried.length + ' calls)');

    /* And a rejection that nothing can work around must SHOW its code. The
     * first cut of this panel printed a friendly sentence and swallowed the
     * code, which is what made that bug expensive to find. */
    sampleMode = 'fail';
    REG['askQ'].value = 'Ask against a runtime that refuses everything';
    await REG['askGo'].onclick();
    await new Promise(r => setImmediate(r));
    const errHtml = REG['askOut'].innerHTML || '';
    if (!A.state.err || A.state.err.code !== 'rate_limited')
      bad('a rejection did not reach the panel as a coded error');
    else if (!errHtml.includes('rate_limited') || !errHtml.includes('usage limit reached'))
      bad('the error is shown without its code or upstream message — undiagnosable from a screenshot');
    else console.log('  a refused call shows its code and upstream message');
    sampleMode = 'ok';

    /* ---- where the answer text arrives ------------------------------------
     * The bug this exists to prevent: a reply the page cannot read renders as
     * nothing, after the viewer has already spent the call. Two properties,
     * and the second is the one that survives the next surprise:
     *   - text under any plausible key is FOUND, and the meta line names the
     *     key when it is not `completion`, so a screenshot dates itself;
     *   - a reply with NO text is an error naming the keys that did come back
     *     — never a filed turn, which would carry "nothing" into the history
     *     of the next question as though Claude had said it. */
    for (const [name, want] of Object.entries(SAMPLE_SHAPES)) {
      if (name === 'completion') continue;          // already proven above
      sampleMode = 'shape:' + name;
      const turnsWas = A.state.turns.length;
      REG['askQ'].value = 'Answer shaped as ' + name;
      await REG['askGo'].onclick();
      await new Promise(r => setImmediate(r));
      const html = REG['askOut'].innerHTML || '';

      if (want.via === null) {                     // the text-less reply
        if (A.state.turns.length !== turnsWas)
          bad('a reply with no answer text was filed as an answer — the next question '
            + 'would carry an empty turn as conversation history');
        else if (!A.state.err || A.state.err.code !== 'unknown-result-shape')
          bad('a reply with no answer text did not surface a coded error');
        else if (!html.includes('modelTierApplied') || !html.includes('stopReason'))
          bad('the unreadable reply is reported without naming its keys — that is the '
            + '"(empty answer)" screenshot again, undiagnosable');
        else console.log('  reply with no text -> coded error naming its keys ('
          + A.state.err.detail + ')');
        continue;
      }

      const turn = A.state.turns[A.state.turns.length - 1];
      if (A.state.turns.length !== turnsWas + 1)
        bad('text under `' + name + '` was not read out of the reply — the viewer pays '
          + 'for the call and sees nothing');
      else if (turn.meta.via !== want.via)
        bad('text under `' + name + '` was read via "' + turn.meta.via
          + '", expected "' + want.via + '"');
      else if (!/<table>/.test(html))
        bad('the answer read via ' + want.via + ' did not render as markdown');
      else if (!html.includes('text via ' + want.via))
        bad('the meta line does not say the text came from ' + want.via
          + ' — the next time the runtime moves it, the screenshot says nothing again');
      else console.log('  text under `' + name + '` -> found via ' + want.via + ', shown in the meta line');
    }
    sampleMode = 'ok';

    // The chart layer is the point of the page now — assert it actually drew,
    // not merely that nothing threw.
    const Sx = sandbox.__S;
    const drawn = (REG['charts'] && REG['charts'].children.length) || 0;
    const picked = (REG['picker'] && REG['picker'].children.length) || 0;
    if (!Sx || !Sx.data) {
      console.log('  *** chart state never built ***'); process.exitCode = 1;
    } else {
      const auto = Sx.data.panels.filter(p => p.discovered).length;
      console.log('charts: ' + Sx.data.panels.length + ' available ('
        + auto + ' auto-discovered), default '
        + Sx.data.defaultPanels.join(', ') + ' — ' + drawn + ' rendered');
      if (!drawn) { console.log('  *** no panels rendered ***'); process.exitCode = 1; }
      if (!picked) { console.log('  *** picker rendered nothing ***'); process.exitCode = 1; }

      /* ---- pin map ---------------------------------------------------------
       * A generic ECU resource name is a number with no meaning attached: AVI2
       * is the surge tank float, and read as "some input" it is worse than
       * absent. The picker must show the function. AVI2 is the specimen because
       * it is the ONE assigned pin with no functional channel of its own, so if
       * this relabelling stops working nothing else in the page names it.
       *
       * The raw name has to survive in the label too — every cross-check goes
       * back to NSP, where this channel is still called AVI2 and nothing else. */
      /* A generic label is only a BUG when that resource has an assignment.
       * DBW1 Pin 2 and Stepper 1 Pin 4 are wired to nothing, so they must stay
       * generic — asking pinFor() rather than pattern-matching the label is
       * what keeps this check honest as the car's wiring changes. */
      const pinOf = sandbox.pinFor;
      const genericLeft = typeof pinOf !== 'function' ? [] : Sx.data.panels.filter(p => {
        const raw = (p.series && p.series[0] && p.series[0].name) || '';
        const hit = pinOf(raw);
        return hit && !p.label.includes(hit.fn);
      });
      if (typeof pinOf !== 'function') {
        console.log('  *** pinFor() is not in the inlined engine — the pin map cannot be checked ***');
        process.exitCode = 1;
      }
      const avi2 = Sx.data.panels.filter(p => /AVI2/i.test(p.label));
      const named = avi2.filter(p => /surge tank level/i.test(p.label));
      const pinned = avi2.filter(p => /\bA16\b/.test(p.label));
      if (!avi2.length) {
        console.log('  *** no AVI2 panel — the specimen channel is gone, this check proves nothing ***');
        process.exitCode = 1;
      } else if (named.length !== avi2.length || pinned.length !== avi2.length) {
        console.log('  *** ' + (avi2.length - named.length) + '/' + avi2.length
          + ' AVI2 panels unnamed, ' + (avi2.length - pinned.length) + ' missing pin A16 — '
          + 'e.g. "' + avi2[0].label + '" ***');
        process.exitCode = 1;
      } else if (genericLeft.length) {
        console.log('  *** ' + genericLeft.length + ' assigned pin(s) still show a generic label, '
          + 'e.g. "' + genericLeft[0].label + '" ***');
        process.exitCode = 1;
      } else {
        const relabelled = Sx.data.panels.filter(p => /·\s[AB]\d+\)/.test(p.label));
        const stillGeneric = Sx.data.panels.filter(p =>
          /^(AVI\s*\d|Synced Pulse Input \d|Digital Pulse Output \d|Drive By Wire \d Pin \d|Stepper \d Pin \d)/i
            .test(p.label));
        console.log('pin map: ' + relabelled.length + ' channel(s) relabelled to their function, '
          + 'e.g. "' + named[0].label + '"');
        console.log('  ' + stillGeneric.length + ' left generic — pins wired to nothing'
          + (stillGeneric.length ? ' (' + stillGeneric[0].label + ' …)' : ''));
      }

      /* ---- graph filter ----------------------------------------------------
       * 444 panels in one native dropdown is a list you scroll past, not one
       * you read, so the filter is the only way in. Drive it the way a visitor
       * does — type, then check the <option> list actually narrowed — because
       * "the input rendered" says nothing about whether it filters. */
      const pkAdd = (REG['picker'].children || []).find(c => c.children && c.children.length === 2
        && c.children.some(x => x.tagName === 'select'));
      const box = pkAdd && pkAdd.children.find(x => x.tagName === 'input');
      const drop = pkAdd && pkAdd.children.find(x => x.tagName === 'select');
      if (!box || !drop) {
        console.log('  *** the graph picker has no filter box beside its dropdown ***');
        process.exitCode = 1;
      } else {
        const all = drop.children.length - 1;              // less the "+ add a graph…" head
        const type = q => { box.value = q; box.oninput(); return drop.children.length - 1; };
        const nAvi2 = type('avi2');
        const nSurge = type('surge tank');                 // the function name, not the ECU's
        const nBoth = type('avi2 switch');                 // every term must match
        const nMiss = type('zzzz-no-such-channel');
        const back = type('');
        const bad = [];
        if (!(nAvi2 > 0 && nAvi2 < all)) bad.push('"avi2" gave ' + nAvi2 + ' of ' + all);
        if (nSurge <= 0) bad.push('"surge tank" found nothing — the function name must be searchable too');
        if (!(nBoth > 0 && nBoth < nAvi2)) bad.push('"avi2 switch" gave ' + nBoth + ', not narrower than ' + nAvi2);
        if (nMiss !== 0) bad.push('a nonsense query still offered ' + nMiss + ' graphs');
        if (back !== all) bad.push('clearing the filter left ' + back + ' of ' + all);
        if (bad.length) {
          console.log('  *** graph filter: ' + bad.join('; ') + ' ***');
          process.exitCode = 1;
        } else {
          console.log('graph filter: ' + all + ' available -> "avi2" ' + nAvi2
            + ', "surge tank" ' + nSurge + ', "avi2 switch" ' + nBoth
            + ', no-match 0, cleared ' + back);
        }
      }

      /* ---- time-window slider ---------------------------------------------
       * The bubbles are pointer-driven, so nothing here proves the gesture
       * works — but the arithmetic behind it can be driven directly, and that
       * is where a window can silently come out inverted, empty, or ignored by
       * the charts. Assert it mounted and that a drag actually narrows S.i0/S.i1
       * the charts read from. */
      const ts = sandbox.__ts, n = Sx.data.t.length;
      const bubbles = (REG['tslider'] && REG['tslider'].children.length) || 0;
      const bad = m => { console.log('  *** ' + m + ' ***'); process.exitCode = 1; };
      if (!bubbles) bad('the time-window slider mounted nothing into #tslider');

      const a = Math.round(n * 0.30), b = Math.round(n * 0.70);
      ts.move('a', a); ts.move('b', b);
      console.log('time slider: ' + bubbles + ' element(s) mounted; dragged to samples '
        + Sx.i0 + '..' + Sx.i1 + ' of ' + n + '  ('
        + Sx.data.t[Sx.i0].toFixed(1) + '–' + Sx.data.t[Sx.i1].toFixed(1) + ' s)');
      if (Sx.i0 !== a || Sx.i1 !== b) bad('dragging the bubbles did not set the window to ' + a + '..' + b);

      // The bubbles must not cross: dragging the left one past the right leaves
      // a minimum span, or the panels are asked to draw a zero-width window.
      ts.move('a', n - 1);
      if (!(Sx.i0 < Sx.i1)) bad('the start bubble crossed the end bubble');
      ts.move('b', 0);
      if (!(Sx.i0 < Sx.i1)) bad('the end bubble crossed the start bubble');

      ts.set(0, n - 1);
      if (Sx.i0 !== 0 || Sx.i1 !== n - 1) bad('the slider could not be reset to the whole log');

      /* render() rebuilds the entire page for reasons unrelated to time — the
       * λ/AFR toggle is the common one — and every rebuild lands in syncCharts.
       * A chosen window has to survive that, and has to NOT survive a different
       * log being loaded. Both directions, because either one alone is a bug
       * someone would report as "the zoom keeps jumping". */
      ts.set(a, b);
      ts.sync();
      if (Sx.i0 !== a || Sx.i1 !== b)
        bad('a page re-render threw away the time window (' + Sx.i0 + '..' + Sx.i1 + ')');
      const wasFile = st.fileName;
      st.fileName = wasFile + '-another-log.csv';
      ts.sync();
      if (Sx.i0 !== 0 || Sx.i1 !== n - 1) bad('loading another log kept the previous time window');
      st.fileName = wasFile;
      console.log('  window survives a re-render, resets on a new log');

      /* The tile over the path that now matters most: a log the viewer opened.
       * FileReader is a stub in here, so set the state loadFile() would have set
       * and re-render. Last, because it leaves a different filename on `state`. */
      st.fileName = '2026-08-15_1242pm_Log3099.csv';
      st.fileKind = 'opened';
      sandbox.__render();
      const tile2 = (REG['logtile'] && REG['logtile'].innerHTML) || '';
      console.log('log tile (opened): '
        + (tile2.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '(empty)'));
      if (!tile2.includes(st.fileName)) bad('the tile does not name an opened log');
      if (/Sample/.test(tile2)) bad('an opened log is still labelled Sample');
    }
  } catch (err) {
    console.log('boot: FAILED — ' + err.message);
    console.log('  ' + String(err.stack || '').split('\n').slice(1, 4).join('\n  '));
    process.exitCode = 1;
  }
}

const bin = (ax, v) => ax.reduce((b, x, i) => (Math.abs(x - v) < Math.abs(ax[b] - v) ? i : b), 0);
console.log('sample binning (Log3056):');
for (const [kpa, d] of [[320.7, 'peak boost 31.8psi'], [288.5, '27.1psi'],
                        [184.1, '12psi'], [122.0, '3psi'], [28.2, 'idle vacuum']]) {
  const i = bin(KPA, kpa);
  console.log('  ' + String(kpa).padStart(6) + ' kPa (' + d + ') -> column '
    + (LAB[i] > 0 ? '+' : '') + LAB[i]);
}
