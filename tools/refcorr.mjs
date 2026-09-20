/**
 * refcorr — rank every logged channel by how much it moves with a 5 V
 * sensor-reference disturbance, to name the circuit behind P0641.
 *
 *   node tools/refcorr.mjs <log.csv>... [--signal ratio|rail|abs]
 *        [--thresh N] [--top N] [--lag] [--dump]
 *
 * Pool the event log AND a quiet control log: the control contributes no events
 * but joins the comparison population, which is what stops a channel that is
 * merely busy-while-driving from ranking as if it were implicated.
 *
 * Two independent scores, because they answer different questions:
 *
 *   LEVEL  rank-AUC of a channel during event samples vs every other sample.
 *          Says a channel sits at unusual values WHEN the rail misbehaves.
 *          It localises the moment, not the circuit — anything correlated with
 *          driving scores high here, because the events only happen while
 *          rolling (see haltune-p0641-root-cause).
 *
 *   STEP   median of (window after each onset) − (window before it), scored
 *          against a null of the same contrast at 400 seeded-random quiet
 *          times. This is the one that can name a circuit: it asks whether the
 *          channel *jumped* at the onset, not whether it was high around it.
 *
 * What to look for: everything merely POWERED by the 5 V rail steps by roughly
 * the same fraction as the rail. A channel that steps by MORE is not sharing a
 * supply — it is sharing a ground or a connector, and that is the one to chase.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog } from '../src/core.js';

const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter(a => !a.startsWith('--') && /\.csv$/i.test(a));
if (!files.length) {
  console.error('usage: node tools/refcorr.mjs <log.csv>... [--signal ratio|rail|abs] '
    + '[--thresh N] [--top N] [--lag] [--dump]');
  process.exit(1);
}

const SIGNALS = {
  ratio: { channel: 'Diagnostic ratiometric voltage reference error', thresh: 8, mode: 'abs' },
  abs:   { channel: 'Diagnostic absolute voltage reference error',    thresh: 8, mode: 'abs' },
  rail:  { channel: 'Diagnostic Analogue 5V rail',                    thresh: 5.099, mode: 'below' },
};
const SIGNAL = opt('signal', 'ratio');
if (!SIGNALS[SIGNAL]) { console.error('--signal must be one of: ' + Object.keys(SIGNALS).join(', ')); process.exit(1); }
const SPEC = SIGNALS[SIGNAL];
const THRESH = Number(opt('thresh', SPEC.thresh));
const TOP = Number(opt('top', 30));

/* Haltech writes 8388607 (2^23-1) and its negative as "no value". decode() has
 * no idea and passes them through, where they otherwise dominate every mean,
 * median and rank in the table. */
const SENTINEL = 8388607;
const clean = v => (Number.isFinite(v) && Math.abs(v) < SENTINEL ? v : NaN);

// ---------------------------------------------------------------- load + pool
const sets = files.map(f => {
  const log = parseLog(fs.readFileSync(f, 'latin1'));
  const byName = new Map();
  log.channels.forEach((c, i) => { if (!byName.has(c.name.trim())) byName.set(c.name.trim(), i); });
  return { file: path.basename(f), log, byName };
});

const common = [...sets[0].byName.keys()].filter(n => sets.every(s => s.byName.has(n)));
console.log('logs pooled:');
for (const s of sets) console.log('  ' + s.file + '  ' + s.log.rows.length + ' rows, '
  + s.log.channels.length + ' channels');
console.log('channels common to all: ' + common.length);

// column extraction, sentinel-cleaned, per log
for (const s of sets) {
  s.cols = new Map();
  for (const n of common) {
    const ci = s.byName.get(n);
    const a = new Float64Array(s.log.rows.length);
    for (let i = 0; i < a.length; i++) a[i] = clean(s.log.rows[i].values[ci]);
    s.cols.set(n, a);
  }
  s.t = Float64Array.from(s.log.rows, r => r.t);
}

// ------------------------------------------------------------------- events
if (!common.includes(SPEC.channel)) {
  console.error('signal channel not in every log: ' + SPEC.channel);
  process.exit(1);
}
/* Power-up and power-down rows read 0.00 V on the rail, −273 °C on every
 * temperature and 0 V on the battery. `clean()` does not catch them — they are
 * not the 8388607 sentinel, just an unpowered ADC — so a bare `rail <= 5.099`
 * test scores every key-off as a dip. One slipped into each driving log before
 * this guard existed. Require the engine to be turning and the signal to be
 * physically plausible. --anyengine disables it. */
const RUNNING = !flag('anyengine') && common.includes('RPM');
let totalEvents = 0, totalOnsets = 0;
for (const s of sets) {
  const sig = s.cols.get(SPEC.channel);
  const rpm = RUNNING ? s.cols.get('RPM') : null;
  const plausible = i => (SPEC.channel.includes('5V rail') ? sig[i] > 4.5 : true);
  const hit = i => (SPEC.mode === 'below' ? sig[i] <= THRESH : Math.abs(sig[i]) >= THRESH);
  s.event = new Uint8Array(sig.length);
  s.onsets = [];
  for (let i = 0; i < sig.length; i++) {
    if (!Number.isFinite(sig[i]) || !hit(i) || !plausible(i)) continue;
    if (rpm && !(rpm[i] > 0)) continue;
    s.event[i] = 1;
    if (i === 0 || !s.event[i - 1]) s.onsets.push(i);
  }
  totalEvents += s.event.reduce((a, b) => a + b, 0);
  totalOnsets += s.onsets.length;
  console.log('  ' + s.file + ': ' + s.onsets.length + ' onsets, '
    + s.event.reduce((a, b) => a + b, 0) + ' event samples');
}
console.log(`signal: ${SPEC.channel}  ${SPEC.mode === 'below' ? '<=' : '|x| >='} ${THRESH}`
  + (RUNNING ? '   (engine-running rows only)' : ''));
if (!totalOnsets) { console.error('no events at this threshold — lower --thresh'); process.exit(1); }

// ------------------------------------------------------------------ LEVEL AUC
/* Mann-Whitney AUC with the tie-midpoint rule. Nearly every channel here is
 * integer-valued after decoding, and a naive `a > b` count throws away every
 * tie — which for a channel that is constant through the whole log turns a
 * meaningless 0.5 into a confident 0.0. */
function auc(pos, neg) {
  const n = pos.length, m = neg.length;
  if (!n || !m) return NaN;
  const all = new Float64Array(n + m);
  all.set(pos, 0); all.set(neg, n);
  const idx = Array.from(all.keys()).sort((a, b) => all[a] - all[b]);
  const rank = new Float64Array(n + m);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && all[idx[j + 1]] === all[idx[i]]) j++;
    const mid = (i + j) / 2 + 1;                    // 1-based mid-rank
    for (let k = i; k <= j; k++) rank[idx[k]] = mid;
    i = j + 1;
  }
  let rp = 0;
  for (let i = 0; i < n; i++) rp += rank[i];
  return (rp - n * (n + 1) / 2) / (n * m);
}

/* LEVEL needs the same regime matching STEP got, or it is just an elaborate way
 * of asking "was the car moving". Restricting the comparison population to
 * engine-running, rolling samples is what makes the lead/lag scan built on top
 * of it mean anything — without it the scan saturates at the ±10 edge on RPM,
 * oil pressure and injection angle every time. */
function levelFor(name) {
  const pos = [], neg = [];
  for (const s of sets) {
    const a = s.cols.get(name);
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) continue;
      if (s.event[i]) pos.push(a[i]);
      else if (s.pool[i]) neg.push(a[i]);
    }
  }
  return { auc: auc(Float64Array.from(pos), Float64Array.from(neg)), n: pos.length };
}

// ------------------------------------------------------------------ STEP test
const AFTER = [0, 0.4], BEFORE = [-0.8, -0.1];
const DRAWS = 400;

/* Contrast TIME WINDOWS, never adjacent rows. An AutoLog is event-driven: it
 * emits a row when something changes, so consecutive rows are often identical
 * and an adjacent-row delta is mostly exactly zero. Against a null made of
 * those zeros, any nonzero delta lands at the 99th percentile and every channel
 * looks implicated. */
function windowIdx(s, centre, lo, hi) {
  const t0 = s.t[centre] + lo, t1 = s.t[centre] + hi;
  let a = centre; while (a > 0 && s.t[a - 1] >= t0) a--;
  let b = centre; while (b + 1 < s.t.length && s.t[b + 1] <= t1) b++;
  return [a, b];
}

function median(a) {
  if (!a.length) return NaN;
  const v = Float64Array.from(a).sort();
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}

function windowMedian(col, [a, b]) {
  const v = [];
  for (let i = a; i <= b; i++) if (Number.isFinite(col[i])) v.push(col[i]);
  return median(v);
}

// precompute the index windows for every onset and every null draw
let seed = 20260815;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/* The null must be drawn from the SAME driving regime as the events, or the
 * test degenerates into "what changes while the car is moving". These events
 * only happen above ~10 km/h; a null containing the stationary control log
 * makes battery voltage, distance travelled and every frequency channel look
 * implicated purely because the car was rolling. --anynull disables the match
 * to show the difference. */
const MATCH = !flag('anynull') && common.includes('Vehicle Speed');
const MOVING_KMH = Number(opt('movingkmh', 10));
for (const s of sets) {
  s.onsetWin = s.onsets.map(i => ({ a: windowIdx(s, i, ...AFTER), b: windowIdx(s, i, ...BEFORE) }));
  const spd = MATCH ? s.cols.get('Vehicle Speed') : null;
  // quiet candidates: at least 2 s clear of any event, with room for both windows
  s.quiet = [];
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] < 1 || s.t[i] > s.t[s.t.length - 1] - 1) continue;
    if (spd && !(spd[i] >= MOVING_KMH)) continue;
    let near = false;
    for (const o of s.onsets) if (Math.abs(s.t[o] - s.t[i]) < 2) { near = true; break; }
    if (!near) s.quiet.push(i);
  }
}
// the same regime restriction, as a mask, for the LEVEL AUC comparison class
for (const s of sets) {
  const spd = MATCH ? s.cols.get('Vehicle Speed') : null;
  const rpm = RUNNING ? s.cols.get('RPM') : null;
  s.pool = new Uint8Array(s.t.length);
  for (let i = 0; i < s.pool.length; i++)
    s.pool[i] = (!spd || spd[i] >= MOVING_KMH) && (!rpm || rpm[i] > 0) ? 1 : 0;
}
if (MATCH) console.log('regime matched: quiet draws and the LEVEL comparison class both require '
  + 'Vehicle Speed >= ' + MOVING_KMH + ' km/h');
const quietPool = sets.flatMap((s, si) => s.quiet.map(i => [si, i]));
const drawSets = [];
for (let d = 0; d < DRAWS; d++) {
  const pick = [];
  for (let k = 0; k < totalOnsets; k++) {
    const [si, i] = quietPool[Math.floor(rnd() * quietPool.length)];
    pick.push({ si, win: { a: windowIdx(sets[si], i, ...AFTER), b: windowIdx(sets[si], i, ...BEFORE) } });
  }
  drawSets.push(pick);
}
console.log('null model: ' + DRAWS + ' draws of ' + totalOnsets + ' quiet times from '
  + quietPool.length + ' candidates (seeded, reproducible)');

function stepFor(name) {
  const obs = [];
  for (const s of sets) {
    const col = s.cols.get(name);
    for (const w of s.onsetWin) {
      const d = windowMedian(col, w.a) - windowMedian(col, w.b);
      if (Number.isFinite(d)) obs.push(d);
    }
  }
  const observed = median(obs);
  if (!Number.isFinite(observed)) return { step: NaN, pct: NaN };
  const nulls = [];
  for (const draw of drawSets) {
    const d = [];
    for (const p of draw) {
      const col = sets[p.si].cols.get(name);
      const v = windowMedian(col, p.win.a) - windowMedian(col, p.win.b);
      if (Number.isFinite(v)) d.push(v);
    }
    const m = median(d);
    if (Number.isFinite(m)) nulls.push(Math.abs(m));
  }
  if (!nulls.length) return { step: observed, pct: NaN };
  const beaten = nulls.filter(v => v < Math.abs(observed)).length;
  return { step: observed, pct: 100 * beaten / nulls.length };
}

// ------------------------------------------------------------------- rank it
console.log('\nscoring ' + common.length + ' channels…');
const rows = [];
for (const name of common) {
  const lv = levelFor(name);
  if (!Number.isFinite(lv.auc)) continue;
  const st = stepFor(name);
  rows.push({ name, level: lv.auc, step: st.step, pct: st.pct });
}

const railStep = (rows.find(r => r.name === 'Diagnostic Analogue 5V rail') || {}).step;
for (const r of rows) {
  // how far a channel moved relative to the rail, in fractions of its own scale
  r.rel = Number.isFinite(railStep) && railStep !== 0 ? r.step / railStep : NaN;
  r.pull = Math.abs(r.level - 0.5);
}

const byStep = [...rows].filter(r => Number.isFinite(r.pct)).sort((a, b) => b.pct - a.pct || Math.abs(b.step) - Math.abs(a.step));
const byLevel = [...rows].sort((a, b) => b.pull - a.pull);

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const line = r => '  ' + r.name.slice(0, 44).padEnd(46)
  + fmt(r.level).padStart(7) + fmt(r.pull).padStart(8)
  + fmt(r.step, 4).padStart(12) + fmt(r.pct, 1).padStart(8);

console.log('\n=== STEP: channels that JUMPED at the onset (percentile vs the quiet null) ===');
console.log('  ' + 'channel'.padEnd(46) + 'LEVEL'.padStart(7) + '|dev|'.padStart(8)
  + 'step'.padStart(12) + 'pct'.padStart(8));
byStep.slice(0, TOP).forEach(r => console.log(line(r)));

/* The reference points the whole test is read against: how far the rail itself
 * moved. Anything merely powered by it should step by about the same fraction;
 * a channel stepping by MORE is sharing a ground or a connector, not a supply. */
console.log('\n  reference —');
for (const n of ['Diagnostic Analogue 5V rail', SPEC.channel])
  for (const r of rows.filter(x => x.name === n))
    console.log(line(r));

console.log('\n=== LEVEL: channels at unusual values during events (drive-correlated, weaker) ===');
byLevel.slice(0, Math.min(TOP, 15)).forEach(r => console.log(line(r)));

// ------------------------------------------------------------------ lead/lag
if (flag('lag')) {
  console.log('\n=== lead/lag: does a channel move BEFORE the rail? (negative = leads) ===');
  /* The original plan scanned the top LEVEL channels. That was written before
   * the speed-matched null showed LEVEL is dominated by "the car was moving" —
   * scanning it just re-ranks speed and ignition-angle channels. The STEP
   * leaders are the ones with a real jump to be early or late about, so scan
   * the union and let the offsets speak. */
  const seenC = new Set();
  const cands = [...byStep.slice(0, 25), ...byLevel.slice(0, 40)]
    .filter(c => !seenC.has(c.name) && seenC.add(c.name));
  const out = [];
  for (const c of cands) {
    let best = { off: 0, auc: 0.5, pull: -1 };
    for (let off = -10; off <= 10; off++) {
      const pos = [], neg = [];
      for (const s of sets) {
        const a = s.cols.get(c.name);
        for (let i = 0; i < a.length; i++) {
          const j = i + off;
          if (j < 0 || j >= a.length || !Number.isFinite(a[j])) continue;
          if (s.event[i]) pos.push(a[j]);
          else if (s.pool[i]) neg.push(a[j]);
        }
      }
      const v = auc(Float64Array.from(pos), Float64Array.from(neg));
      if (Number.isFinite(v) && Math.abs(v - 0.5) > best.pull) best = { off, auc: v, pull: Math.abs(v - 0.5) };
    }
    out.push({ name: c.name, ...best });
  }
  out.sort((a, b) => a.off - b.off || b.pull - a.pull);
  for (const r of out.slice(0, TOP))
    console.log('  ' + r.name.slice(0, 44).padEnd(46) + String(r.off).padStart(5)
      + fmt(r.auc).padStart(8) + (r.off < 0 ? '   <- leads the rail' : ''));
}

// ---------------------------------------------------------------------- dump
if (flag('dump')) {
  // fileURLToPath, not pathname.slice(1) — the latter mangles Windows paths
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'refcorr-' + SIGNAL + '.csv');
  const csv = 'channel,levelAUC,levelDev,step,stepPct,relativeToRail\n'
    + byStep.map(r => [JSON.stringify(r.name), r.level, r.pull, r.step, r.pct, r.rel].join(',')).join('\n');
  fs.writeFileSync(p, csv, 'utf8');
  console.log('\nwrote ' + p + '  (' + byStep.length + ' channels)');
}
