/*
 * Haltune panel catalogue — shared chart definitions.
 *
 * Imported by tools/serve.mjs and inlined into the published artifact by
 * tools/build-artifact.mjs, so both surfaces draw the same panels from the same
 * spec. No imports beyond core.js, no DOM: it must inline as plain script.
 *
 * The catalogue is OPEN, not a whitelist. Curated entries give the channels we
 * understand a good label, unit, limit lines and a measured/target pairing.
 * Everything else in the log is discovered automatically and appended, so a
 * newly-enabled channel — vehicle speed, exhaust manifold pressure, coolant
 * system pressure — shows up in the picker the first time it is logged, with no
 * code change. Curate one later only to give it limits or a pairing.
 */

/* One line, deliberately: build-artifact.mjs strips imports with a per-LINE
 * regex, so a wrapped import would have its tail left behind in the page. */
import { kpaToPsi, lambdaToAfr, VEHICLE, dragSplits, channelLabel, pinFor, DYNO, dynoCurveFor, dynoTorqueNm } from './core.js';

/* AFR display basis. The analyzer's math stays in lambda (stoich-independent);
 * these convert lambda for READING as AFR only. Linear blend by volume. */
const STOICH_PETROL = 14.7;   // pump 95
const STOICH_ETHANOL = 9.0;   // E100

/* Pressure display. Logs are decoded to kPa absolute; graphs read in psi.
 *
 * The two conversions are NOT interchangeable and getting them the wrong way
 * round is silently wrong rather than obviously wrong:
 *   absolute  -> psi GAUGE       subtract atmosphere (matches the boost panel
 *                                and how the ECU shows load)
 *   differential -> psi DIFF     do NOT subtract atmosphere; it is already a
 *                                difference, so 400 kPa across an injector is
 *                                58 psi, not -73.
 */
const PSI_PER_KPA = 1 / 6.89476;
const psiGauge = kpa => kpaToPsi(kpa);
const psiDiff = kpa => kpa * PSI_PER_KPA;
/** A channel whose value is already a difference, not an absolute reading. */
const isDifferential = name => /differential|delta|diff\b/i.test(name);

/** Display unit inferred from the NSP channel Type, for uncurated channels. */
export const TYPE_UNIT = {
  Pressure: 'psi', AbsPressure: 'psi',
  Percentage: '%', Angle: '°', Temperature: '°C',
  EngineSpeed: 'rpm', AFR: 'λ', BatteryVoltage: 'V',
  Decibel: 'dB', Time_ms_as_s: 's', Resistance: 'Ω',
  Speed: 'km/h', Velocity: 'km/h', Raw: '',
};
const PRESSURE_TYPES = new Set(['Pressure', 'AbsPressure']);

/** Channels that are never interesting as a time-series graph. */
const SKIP = ['Engine Running Time'];

/**
 * Curated panels, in the order they appear in the picker. `from` lists candidate
 * channel names, first match wins. A panel with two series is a result and its
 * target — that pairing is the reason these are curated at all.
 */
function curated(v) {
  return [
    { key: 'mixture', label: 'Air–fuel ratio', kind: 'mixture' },

    { key: 'boost', label: 'Boost', unit: 'psi', xf: kpaToPsi,
      series: [{ name: 'Boost', from: ['Manifold Pressure'] }],
      limits: [{ v: v.maxBoostPsi, label: `target ${v.maxBoostPsi}`, status: 'warning' },
               { v: kpaToPsi(v.mapSensorBar * 100), label: 'MAP sensor max', status: 'critical' }] },

    { key: 'rpm', label: 'Engine speed', unit: 'rpm',
      series: [{ name: 'RPM', from: ['RPM', 'Filtered RPM'] }],
      limits: [{ v: v.redlineRpm, label: 'redline', status: 'critical' }] },

    { key: 'duty', label: 'Injector duty cycle', unit: '%',
      series: [{ name: 'Duty', from: ['Injector 1 Duty Cycle'] }],
      limits: [{ v: v.maxInjDutyPct, label: `ceiling ${v.maxInjDutyPct}`, status: 'warning' },
               { v: 100, label: 'static — maxed', status: 'critical' }] },

    // differential, NOT gauge — see psiDiff above
    { key: 'fueldiff', label: 'Injector pressure differential', unit: 'psi', xf: psiDiff,
      series: [{ name: 'Differential', from: ['Injector Pressure Differential'] }],
      // The band the analyser enforces, drawn on the trace it is judging: +/-5% of
      // base, both sides. The old single 'floor' marker had no upper counterpart,
      // so an over-pressure excursion had nothing to read against.
      limits: [{ v: psiDiff(v.fuelBaseDiffKpa), label: `base ${psiDiff(v.fuelBaseDiffKpa).toFixed(0)}`, status: 'good' },
               { v: psiDiff(v.fuelBaseDiffKpa * (1 - v.fuelDiffTolerancePct / 100)),
                 label: `-${v.fuelDiffTolerancePct}% ${psiDiff(v.fuelBaseDiffKpa * (1 - v.fuelDiffTolerancePct / 100)).toFixed(0)}`,
                 status: 'critical' },
               { v: psiDiff(v.fuelBaseDiffKpa * (1 + v.fuelDiffTolerancePct / 100)),
                 label: `+${v.fuelDiffTolerancePct}% ${psiDiff(v.fuelBaseDiffKpa * (1 + v.fuelDiffTolerancePct / 100)).toFixed(0)}`,
                 status: 'warning' }] },

    { key: 'fuelrail', label: 'Fuel rail pressure', unit: 'psi', xf: psiGauge,
      series: [{ name: 'Actual', from: ['Fuel Pressure'] },
               { name: 'ECU expected', from: ['Fuel Pressure Expected'] }] },

    { key: 'rail5v', label: '5V reference rail', unit: 'V',
      series: [{ name: '5V rail', from: ['Diagnostic Analogue 5V rail'] }],
      limits: [{ v: 5.0, label: 'nominal', status: 'good' },
               { v: 4.75, label: 'fault threshold', status: 'critical' }] },

    { key: 'battery', label: 'Battery voltage', unit: 'V',
      series: [{ name: 'Battery', from: ['Battery Voltage'] }],
      limits: [{ v: 12.0, label: 'dead-time floor', status: 'warning' }] },

    { key: 'tps', label: 'Throttle position', unit: '%',
      series: [{ name: 'TPS', from: ['Throttle Position'] }] },

    { key: 'ign', label: 'Ignition angle', unit: '°',
      series: [{ name: 'Ignition', from: ['Ignition Angle'] }] },

    { key: 'temps', label: 'Temperatures', unit: '°C',
      series: [{ name: 'Coolant', from: ['Coolant Temperature'] },
               { name: 'Intake air', from: ['Intake Air Temperature'] }],
      limits: [{ v: v.maxCltC, label: `max coolant ${v.maxCltC}`, status: 'critical' }] },

    { key: 'emap', label: 'Exhaust manifold pressure', unit: 'psi', xf: psiGauge,
      series: [{ name: 'EMAP', from: ['Exhaust Manifold Pressure', 'Exhaust Back Pressure'] }] },

    { key: 'oil', label: 'Oil pressure', unit: 'psi', xf: psiGauge,
      series: [{ name: 'Oil', from: ['Oil Pressure'] }] },

    { key: 'coolantpress', label: 'Coolant system pressure', unit: 'psi', xf: psiGauge,
      series: [{ name: 'Coolant pressure', from: ['Coolant Pressure'] }] },

    { key: 'speed', label: 'Vehicle speed', unit: 'km/h',
      series: [{ name: 'Speed', from: ['Vehicle Speed', 'GPS Vehicle Speed', 'Ground Speed'] }] },

    { key: 'distance', label: 'Distance & drag splits', kind: 'distance' },

    { key: 'torque', label: 'Engine torque', kind: 'torque' },

    { key: 'ethanol', label: 'Fuel composition', unit: '% ethanol',
      series: [{ name: 'Ethanol', from: ['Fuel Composition', 'Ethanol Content'] }] },

    { key: 'knock', label: 'Knock', unit: 'raw',
      series: [{ name: 'Signal', from: ['Knock Sensor 1 Knock Signal'] },
               { name: 'Threshold', from: ['Knock Threshold'] }] },

    { key: 'knockretard', label: 'Knock ignition retard', unit: '°',
      series: [{ name: 'Retard', from: ['Knock Control Bank 1 Ignition Correction'] }] },

    { key: 'boostduty', label: 'Boost solenoid duty', unit: '%',
      series: [{ name: 'Solenoid', from: ['Boost Control Solenoid Duty Cycle'] }] },
  ];
}

/** Panels selected by default: the diagnostic spine, each with its target where one exists. */
export const DEFAULT_PANELS = ['mixture', 'boost', 'rpm', 'duty', 'fueldiff', 'fuelrail', 'distance'];

/** Tolerant channel lookup — NSP names carry stray spaces and "(MAP)" suffixes. */
export function findCol(log, ...candidates) {
  const keys = Object.keys(log.byName);
  for (const want of candidates) {
    const w = String(want).trim().toLowerCase();
    let hit = keys.find(k => k.trim().toLowerCase() === w);
    if (hit !== undefined) return log.byName[hit];
    hit = keys.find(k => k.trim().toLowerCase().startsWith(w));
    if (hit !== undefined) return log.byName[hit];
  }
  return -1;
}

/**
 * Which panels this log can actually draw.
 *
 * Returns curated panels whose channels are present, then every remaining
 * channel as its own auto-discovered panel. `cols` on each series is an index
 * into row.values, so the caller materialises the numbers however it likes.
 */
export function resolvePanels(log, vehicle) {
  const v = vehicle || VEHICLE;
  const out = [];
  const used = new Set();

  for (const p of curated(v)) {
    if (p.kind === 'mixture') {
      const meas = findCol(log, 'Wideband O2 1', 'Wideband Maximum');
      const tgt = findCol(log, 'Target Lambda');
      if (meas < 0 && tgt < 0) continue;
      if (meas >= 0) used.add(meas);
      if (tgt >= 0) used.add(tgt);
      out.push({ key: p.key, label: p.label, kind: 'mixture', measCol: meas, tgtCol: tgt,
                 ethCol: findCol(log, 'Fuel Composition', 'Ethanol Content'),
                 stoichCol: findCol(log, 'Fuel Tuning Current Stoichiometry'),
                 limits: [] });
      continue;
    }
    if (p.kind === 'distance') {
      // Speed stays available as its own panel — this one is derived, not a
      // second view of the same column, so the column is deliberately not
      // marked used.
      if (findCol(log, 'Vehicle Speed', 'Vehicle Speed GPS', 'Ground Speed') < 0) continue;
      out.push({ key: p.key, label: p.label, kind: 'distance', limits: [] });
      continue;
    }
    if (p.kind === 'torque') {
      /* Needs all three: rpm to look the curve up on, throttle to know the
       * curve applies at all, and ethanol to know WHICH curve. Missing any one
       * of them and the answer would be a guess wearing a number, so the panel
       * simply is not offered. Like `distance`, the columns are read but not
       * marked used — rpm and throttle keep their own panels. */
      const rpmCol = findCol(log, 'RPM', 'Filtered RPM');
      const tpsCol = findCol(log, 'Throttle Position', 'Throttle Position - Cable');
      const ethCol = findCol(log, 'Fuel Composition', 'Ethanol Content', 'Flex Fuel Sensor');
      if (rpmCol < 0 || tpsCol < 0 || ethCol < 0) continue;
      out.push({ key: p.key, label: p.label, kind: 'torque', rpmCol, tpsCol, ethCol, limits: [] });
      continue;
    }
    const series = [];
    for (const s of p.series) {
      const c = findCol(log, ...s.from);
      if (c >= 0) { series.push({ name: s.name, col: c }); used.add(c); }
    }
    if (!series.length) continue;
    out.push({ key: p.key, label: p.label, unit: p.unit, xf: p.xf,
               limits: p.limits || [], series, curated: true });
  }

  // Anything else the log carries. This is what makes newly-enabled channels
  // appear on their own — no catalogue edit required.
  for (const ch of log.channels) {
    const c = log.byName[ch.name];
    if (used.has(c)) continue;
    if (SKIP.some(s => s.toLowerCase() === ch.name.trim().toLowerCase())) continue;
    // Pressure channels convert to psi like the curated ones, so a channel
    // enabled later does not arrive in kPa while everything else reads psi.
    // Name decides gauge vs differential; absolute is the safe default because
    // nearly every NSP pressure channel is an absolute reading.
    const isPressure = PRESSURE_TYPES.has(ch.type);
    /* Generic ECU resources (AVI2, Digital Pulse Output 5, …) are relabelled to
     * the function they are wired to — see ECU_PINS in core.js. The key stays on
     * the raw name so a saved panel selection survives a change of label, and
     * the raw name stays inside the label so the picker can still be searched
     * for "AVI2" and the panel still matches what NSP calls it. */
    const pin = pinFor(ch.name);
    out.push({
      key: 'auto:' + ch.name, label: channelLabel(ch.name),
      unit: TYPE_UNIT[ch.type] !== undefined ? TYPE_UNIT[ch.type] : '',
      xf: isPressure ? (isDifferential(ch.name) ? psiDiff : psiGauge) : undefined,
      limits: [], series: [{ name: ch.name.trim(), col: c }], discovered: true,
      note: pin ? 'ECU resource ' + pin.generic + ', pin ' + pin.pin + ' — wired to '
        + pin.fn.toLowerCase() + '. Raw pin channel: what the wire reads before the '
        + 'ECU\'s channel configuration is applied.' : undefined,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ payload */

const round = (v, n) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null);

/**
 * Per-sample stoichiometric ratio, for reading lambda as AFR.
 *
 * Preference order matters: the ECU's own stoich channel beats anything derived,
 * and derived beats a constant. Whichever is used is reported back, because an
 * AFR number is meaningless without its basis — on this car the flex sensor
 * moves stoich by ~0.6 between logs.
 */
export function stoichSeries(log) {
  const cS = findCol(log, 'Fuel Tuning Current Stoichiometry', 'Stoichiometric Ratio');
  if (cS >= 0) {
    const values = log.rows.map(r => r.values[cS]);
    if (values.some(Number.isFinite)) return { values, basis: 'ECU stoichiometry channel' };
  }
  const cE = findCol(log, 'Fuel Composition', 'Ethanol Content', 'Flex Fuel Ethanol Content');
  if (cE >= 0) {
    const values = log.rows.map(r => {
      const e = r.values[cE];
      return Number.isFinite(e) ? STOICH_PETROL - (STOICH_PETROL - STOICH_ETHANOL) * (e / 100) : NaN;
    });
    const ok = values.filter(Number.isFinite);
    if (ok.length) {
      const lo = Math.min(...ok), hi = Math.max(...ok);
      const span = Math.abs(hi - lo) < 0.005
        ? 'stoich ' + lo.toFixed(2)
        : 'stoich ' + lo.toFixed(2) + '–' + hi.toFixed(2);
      return { values, basis: span + ' — from flex sensor' };
    }
  }
  return {
    values: log.rows.map(() => STOICH_PETROL),
    basis: 'stoich ' + STOICH_PETROL.toFixed(1) + ' assumed — no fuel-composition channel',
  };
}

/* What the Target series IS, spelled out on the chart.
 *
 * `Target Lambda` is the ECU's FINAL commanded target — the target table's
 * output plus every correction applied after it. NSP's Target Lambda Table
 * screen shows the table output, a different channel, and the 448-channel logs
 * carry both: in AutoLog_2026-08-09_0305pm they disagree on 11,950 of 18,896
 * samples, by exactly `Target Lambda Coolant Correction`.
 *
 * Without this line the chart is quietly misleading. On 2026-08-22 Danie read
 * a 0.070 dip in this series against an NSP table cell that never moved and
 * reasonably concluded one of the two was wrong; neither was. The dip was
 * engine protection enriching the target — see CEL_CAUSE_NAMES code 7. A graph
 * that invites that reading is worse than one that labels its own axis. */
const TARGET_NOTE = 'Target is the ECU\'s final commanded target — the target table\'s output '
  + 'plus corrections (coolant, air temp, engine protection). NSP\'s target table screen shows '
  + 'the table output, so the two can differ.';

/** Mixture panel: measured + target, in BOTH units so the page can toggle freely. */
function mixturePanel(log, p) {
  const st = stoichSeries(log);
  const grab = c => (c < 0 ? null : log.rows.map(r => r.values[c]));
  const raw = [
    { name: 'Measured', values: grab(p.measCol) },
    { name: 'Target', values: grab(p.tgtCol) },
  ].filter(s => s.values && s.values.some(Number.isFinite));
  if (!raw.length) return null;
  // no Target series drawn, nothing to explain about it
  const hasTarget = raw.some(s => s.name === 'Target');

  const modes = [
    /* The AFR note also has to say WHICH AFR. NSP's target table is displayed
     * as gasoline-equivalent AFR (lambda x 14.7) whatever is in the tank, so
     * on E81 its 11.5 is this chart's 7.9 — the same 0.782 lambda. Comparing
     * the two screens number-for-number without that is a trap. */
    { id: 'afr', label: 'AFR', unit: 'AFR',
      note: st.basis + (hasTarget ? '. ' + TARGET_NOTE : '')
        + '. AFR here is against that stoich, not NSP\'s gasoline-equivalent scale.',
      series: raw.map(s => ({ name: s.name,
        values: s.values.map((v, i) => round(lambdaToAfr(v, st.values[i]), 2)) })) },
    { id: 'lambda', label: 'λ', unit: 'λ',
      note: 'stoich-independent — the basis the analyzer corrects against'
        + (hasTarget ? '. ' + TARGET_NOTE : ''),
      series: raw.map(s => ({ name: s.name, values: s.values.map(v => round(v, 4)) })) },
  ];
  return {
    key: p.key, label: p.label, limits: [],
    unit: modes[0].unit, series: modes[0].series, note: modes[0].note, modes,
  };
}

/**
 * Distance panel: integrated distance in feet, with a dashed line at each drag
 * mark so the crossing time can be read straight off the chart.
 *
 * Only marks within reach are drawn. `limits` extend the y-range (charts.js), so
 * a 1320 ft line on a run that covered 342 ft would flatten the trace along the
 * bottom of the frame and make the panel useless. Reached marks plus the next
 * one keeps the run legible and still shows what it was heading for.
 */
function distancePanel(log, p) {
  const d = dragSplits(log);
  if (!d.available) return null;

  const lastReached = d.marks.reduce((n, m, i) => (m.reached ? i : n), -1);
  const shown = d.marks.slice(0, Math.min(lastReached + 2, d.marks.length));

  const fmt = m => (m.reached
    ? `${m.name} ${m.t.toFixed(2)} s @ ${m.speedKmh.toFixed(1)} km/h`
    : `${m.name} not reached`);
  const notes = [];
  if (d.rollingStart) {
    notes.push('<b>rolling start</b> — log opens at ' + d.startSpeedKmh.toFixed(1)
      + ' km/h, so these are elapsed times from the start of the log, NOT drag splits');
  } else {
    notes.push('launch detected at ' + d.startTime.toFixed(2) + ' s');
  }
  notes.push(d.marks.map(fmt).join(' · '));
  notes.push('covered ' + d.totalFt.toFixed(0) + ' ft, integrated from ' + d.channel);

  return {
    key: p.key, label: p.label, unit: 'ft',
    limits: shown.map(m => ({ v: m.ft, label: m.name, status: m.reached ? 'good' : undefined })),
    series: [{ name: 'Distance', values: d.distanceFt.map(v => round(v, 1)) }],
    note: notes.join(' — '),
  };
}

/**
 * Engine torque, looked up on the dyno curve the car is actually running.
 *
 * Three things decide each sample: throttle (the curves are WOT ramps, so
 * anything under DYNO.wotThrottlePct is blank rather than wrong), ethanol
 * content (over 80% the E85 map is in play, under it the petrol map), and
 * engine speed (the lookup itself). Blank is deliberate and frequent — a
 * dotted line across a part-throttle cruise would be an invention.
 *
 * What it is NOT: a measurement of what the engine made in this log. It is
 * what the dyno recorded at that rpm on that map, which the car only matches
 * if it is also making the dyno's boost. Where the two disagree, that gap is
 * the interesting part, and it is why the panel exists.
 */
function torquePanel(log, p) {
  const values = [];
  let wot = 0, offCurve = 0, nE85 = 0, n98 = 0, rpmLo = Infinity, rpmHi = -Infinity;
  for (const r of log.rows) {
    const tps = r.values[p.tpsCol], rpm = r.values[p.rpmCol], eth = r.values[p.ethCol];
    if (!(tps > DYNO.wotThrottlePct)) { values.push(null); continue; }
    wot++;
    const nm = dynoTorqueNm(rpm, eth);
    if (!Number.isFinite(nm)) { offCurve++; values.push(null); continue; }
    if (dynoCurveFor(eth) === DYNO.e85) nE85++; else n98++;
    if (rpm < rpmLo) rpmLo = rpm;
    if (rpm > rpmHi) rpmHi = rpm;
    values.push(round(nm, 1));
  }
  // Nothing at full throttle: an empty frame says less than no panel at all.
  if (!wot || !(nE85 + n98)) return null;

  const curves = [];
  if (nE85) curves.push(DYNO.e85);
  if (n98) curves.push(DYNO.petrol98);
  const which = curves.length === 2
    ? 'BOTH maps appear in this log — ' + nE85 + ' samples over '
      + DYNO.ethanolSwitchPct + '% ethanol on E85, ' + n98 + ' under it on 98'
    : curves[0].label + ' map (' + (nE85 + n98) + ' samples)';

  const notes = [which];
  notes.push('full throttle only: ' + wot + ' of ' + log.rows.length + ' samples are over '
    + DYNO.wotThrottlePct + '% throttle'
    + (offCurve ? ', and ' + offCurve + ' of those sit outside the ramp\'s '
        + DYNO.from + '–' + (DYNO.from + (DYNO.e85.nm.length - 1) * DYNO.rpmStep)
        + ' rpm range, so they are left blank rather than extrapolated' : ''));
  if (Number.isFinite(rpmLo)) notes.push('covered ' + rpmLo.toFixed(0) + '–' + rpmHi.toFixed(0) + ' rpm');
  notes.push('HUB dyno — driveline losses are already inside these numbers, so this is '
    + 'torque at the hubs referred to engine rpm, not flywheel torque. '
    + 'It is what the dyno made on a controlled ramp; the car only matches it where it is '
    + 'also making the dyno\'s boost. ' + DYNO.source);

  return {
    key: p.key, label: p.label, unit: 'Nm',
    limits: curves.map(c => ({ v: c.peakNm, label: c.label + ' peak ' + c.peakNm.toFixed(0)
      + ' @ ' + c.peakNmRpm, status: 'good' })),
    series: [{ name: 'Dyno torque', values }],
    note: notes.join(' — '),
  };
}

/**
 * Materialise every drawable panel for a log. Both the dashboard server and the
 * published artifact call this, so the two render identical panels from the same
 * definitions rather than each keeping its own list.
 */
export function buildPanels(log, vehicle) {
  const out = [];
  for (const p of resolvePanels(log, vehicle)) {
    if (p.kind === 'mixture') {
      const m = mixturePanel(log, p);
      if (m) out.push(m);
      continue;
    }
    if (p.kind === 'distance') {
      const d = distancePanel(log, p);
      if (d) out.push(d);
      continue;
    }
    if (p.kind === 'torque') {
      const t = torquePanel(log, p);
      if (t) out.push(t);
      continue;
    }
    const series = p.series
      .map(s => ({ name: s.name,
        values: log.rows.map(r => round(p.xf ? p.xf(r.values[s.col]) : r.values[s.col], 3)) }))
      .filter(s => s.values.some(v => v !== null));
    if (!series.length) continue;
    out.push({ key: p.key, label: p.label, unit: p.unit, limits: p.limits || [],
               series, note: p.note, discovered: !!p.discovered });
  }
  return out;
}
