/*
 * Haltune core — parse + decode + analyze Haltech NSP CSV datalogs.
 *
 * This file is the single source of truth for the analysis engine. It is:
 *   - imported directly by the Node test harness (tools/test.mjs), and
 *   - inlined into the standalone browser app by build.mjs.
 *
 * No imports / no DOM / no Node APIs here — pure functions over strings & arrays
 * so it runs identically in both environments.
 *
 * ---- Value decoding (calibrated against the NSP training-course sample logs,
 *      which are a DIFFERENT engine to the subject car — scaling is channel-type
 *      driven so it transfers, but do not carry car-specific assumptions across) ----
 * NSP stores every channel as a scaled integer. Scale factor depends on the
 * channel's declared Type. Verified factors:
 *   AFR            -> /1000  => lambda            (Haltech "AFR" channels are lambda*1000)
 *   Pressure       -> /10    => kPa absolute
 *   AbsPressure    -> /10    => kPa absolute
 *   EngineSpeed    -> *1     => RPM
 *   Angle          -> /10    => degrees
 *   Percentage     -> /10    => %
 *   Temperature    -> /10    => Kelvin, then -273.15 => degC
 *   BatteryVoltage -> /1000  => volts
 *   Speed          -> /10    => km/h
 * Anything else falls through as raw (scale 1) — fine for channels we don't
 * physically interpret.
 *
 * The fall-through is the dangerous default: a channel enabled later gets a
 * PLAUSIBLE-LOOKING number rather than an obviously broken one. 'Speed' was
 * missing until 2026-08-09 and Vehicle Speed rendered as 410 km/h instead of
 * 41.0 — right shape, right units on the axis, off by 10x. When a new channel
 * appears, check its Type is listed here before trusting the graph.
 */

export const TYPE_SCALE = {
  AFR: v => v / 1000,            // lambda
  Pressure: v => v / 10,        // kPa abs
  AbsPressure: v => v / 10,     // kPa abs
  EngineSpeed: v => v,          // rpm
  Angle: v => v / 10,           // deg
  Percentage: v => v / 10,      // %
  Temperature: v => v / 10 - 273.15, // degC
  BatteryVoltage: v => v / 1000, // volts
  Stoichiometry: v => v / 1000,  // stoich AFR (e.g. 14.7 gasoline, 11.05 ~E40)
  /* g/cc. Was /1000 and shipped reading 7.8 — no fuel is 7.8 g/cc. Same class as
   * the Speed /10 bug below, and confirmed the same three ways: the channel
   * declares DisplayMaxMin 10000,100 (= 0.01..1.00 g/cc, and 1.0 is a sensible
   * ceiling for a liquid fuel); the corrected reading is 0.78, which is E85; and
   * that matches VEHICLE.fuelDensityGperCc (0.782). Primary reads 0.74 = petrol. */
  Density: v => v / 10000,       // fuel density, g/cc
  /* km/h. Confirmed three ways: Danie's NSP shows 41.0 where Log3062 carries 410;
   * the channel declares DisplayMaxMin 4000,0 (= 400.0 km/h); and the road-driven
   * PCLog samples cruise at 66-83 km/h with a constant 33 rpm per km/h, which is a
   * real gear ratio. Also covers 'Vehicle Speed Derivative' (km/h/s). */
  Speed: v => v / 10,
};

function decode(type, raw) {
  const f = TYPE_SCALE[type];
  return f ? f(raw) : raw;
}

// Convert kPa absolute -> psi gauge (boost). 101.325 kPa == 0 psi gauge.
export const kpaToPsi = kpa => (kpa - 101.325) / 6.89476;
/**
 * Convert a DIFFERENTIAL in kPa -> psi. No baro offset, because the value is
 * already a difference: 400 kPa across an injector is 58 psi, not -73. Using
 * kpaToPsi() here is the easy mistake and it fails silently.
 */
export const kpaToPsiDiff = kpa => kpa / 6.89476;
// lambda -> AFR given stoichiometric ratio (14.7 gasoline, ~9.8 E85, etc.)
export const lambdaToAfr = (lambda, stoich = 14.7) => lambda * stoich;
export const psiToKpa = psi => psi * 6.89476;

/* ------------------------------------------------------------------------
 * Vehicle hard limits — see docs/vehicle-spec.md (the source of truth).
 *
 * These exist so the analyzer can REFUSE to give fuel advice derived from
 * data it cannot trust. A lean cell recorded while the MAP sensor is pegged,
 * the injectors are maxed, or fuel pressure has collapsed is not a tuning
 * error — it is a hardware limit, and "add fuel" is the wrong answer there.
 *
 * Override per-call:  analyze(log, { vehicle: {...VEHICLE, maxBoostPsi: 40} })
 * ---------------------------------------------------------------------- */
export const VEHICLE = {
  name: '4G63T 2.3 stroker · Haltech Elite 1500',

  // --- sensing envelope ---
  mapSensorBar: 4,          // absolute-pressure sensor rating -> 400 kPa abs ceiling
  mapClipMarginKpa: 4,      // treat readings within this of the ceiling as saturated
  baroKpa: 101.325,

  // --- operating targets ---
  maxBoostPsi: 36,
  redlineRpm: 8000,

  // --- fuel system ---
  maxInjDutyPct: 95,
  fuelRegulator: 'manifold', // 'manifold' = 1:1 referenced | 'fixed' = constant rail
  fuelBaseDiffKpa: 400,     // 4 bar, regulator referenced 1:1 to manifold
  // The injector pressure differential is the measure that tells the story: the
  // regulator's whole job is to hold it constant, so ANY sustained departure is a
  // fault, in either direction. Low = starvation (lean, and the injectors cannot
  // pass rated flow); high = stuck regulator or blocked return (rich). Judged as a
  // percentage of the target differential, not an absolute floor, and the target is
  // the ECU's own `Fuel Pressure Expected` when the log carries it.
  fuelDiffTolerancePct: 5,
  minFuelDiffKpa: 380,      // = 400 - 5%; kept for the fixed-regulator fallback text
  /* --- lift transients ---
   * Coming off the throttle collapses fuel demand faster than the regulator can
   * dump the rail, so the differential always overshoots for a moment. That is the
   * regulator recovering, not a fault, and it must not be reported as one. An
   * excursion is dismissed only when it is BOTH short AND tied to a lift; either
   * test alone would hide a real fault. See markFuelLiftTransients(). */
  fuelTransientMaxS: 0.6,        // longest excursion dismissible as a recovery transient
  fuelTransientLiftDropPct: 50,  // throttle fall (percentage points) that counts as a lift
  fuelTransientWindowS: 0.6,     // excursion must START this soon after the lift commences
  minRunningRpm: 500,       // below this the engine is not running; ignore all limits

  /* --- injector flow (Bosch 1550cc / MSEL INJBOS1550S) ---
   * The sheet's curve is pure sqrt-of-differential off a 1584 cc/min @ 3 bar
   * base: 1584@3, 1840@4, 2056@5, 2236@6. So the two constants below define the
   * whole curve and injectorFlowCcMin() reproduces the sheet to within 1%.
   *
   * CONFIRMED 2026-09-20 against the printed sheet (`Injector spec sheet.jpeg`
   * in the project root) and against the ECU's own `Injection Stage 1 Flow
   * Rate`, which reads 1765-1802 cc/min at a ~400 kPa differential. The car
   * was bought both Bosch 1650s and FIC 2150s along the way, so the question
   * "which injectors are actually fitted" is a live one — it is these.
   *
   * The duty -> flow model is confirmed too: on the 448-channel idle log,
   * duty x this rate x 4 matches the ECU's own `Fuel Mass Flow` channel (8.4%
   * duty -> 593 cc/min both ways). Do not "fix" either number without
   * re-checking against that channel. */
  injectorCcMin: 1840,      // per injector, at injectorRatedBar
  injectorRatedBar: 4,
  injectorCount: 4,

  // --- fuel energy, for sanity-checking commanded flow against plausible power ---
  fuelDensityGperCc: 0.782, // E85
  bsfcLbPerHpHr: 0.68,      // E85, boosted — a sanity yardstick, not a claim
  powerGoalHp: 800,

  // --- thermal ---
  maxIatC: 60,
  maxCltC: 105,

  // --- plausibility bounds (a 5V reference fault shows up as excursions here) ---
  sane: { mapKpa: [15, 420], tpsPct: [-2, 105], fuelKpa: [0, 900], batteryV: [8, 16] },

  // --- geometry (reference; not enforced) ---
  displacementCc: 2296.6,
  strokeMm: 100,
  rodMm: 150,
};

/**
 * Static flow of ONE injector at an actual differential, cc/min.
 *
 * Flow through a fixed orifice goes with the square root of the pressure across
 * it, which is why a collapsing rail costs less flow than it looks like it
 * should — and why quoting an injector as "1840cc" without saying at what
 * pressure is meaningless. Verified against the MSEL sheet at 3/4/5/6 bar.
 */
export const injectorFlowCcMin = (diffKpa, v = VEHICLE) =>
  (Number.isFinite(diffKpa) && diffKpa > 0)
    ? v.injectorCcMin * Math.sqrt(diffKpa / (v.injectorRatedBar * 100))
    : NaN;

/** cc/min of E85 -> horsepower it could support at the vehicle's BSFC. */
export const ccMinToHp = (ccMin, v = VEHICLE) =>
  (Number.isFinite(ccMin)
    ? (ccMin * v.fuelDensityGperCc * 60 / 1000) * 2.20462 / v.bsfcLbPerHpHr
    : NaN);

/** MAP sensor saturation point, kPa absolute. */
export const mapCeilingKpa = (v = VEHICLE) => v.mapSensorBar * 100;
/** Highest boost the MAP sensor can actually report, psi gauge. */
export const mapCeilingPsi = (v = VEHICLE) => kpaToPsi(mapCeilingKpa(v));

/**
 * Parse an NSP CSV datalog (raw text) into a structured object.
 * Returns { meta, channels:[{name,id,type}], byName:{name->col}, rows:[{t, values:Float}] }
 * where each row's `values` is decoded (real units) indexed by channel column.
 */
export function parseLog(text) {
  const lines = text.split(/\r?\n/);
  const meta = {};
  const channels = [];
  let cur = null;
  const rows = [];
  let t0 = null;

  const flush = () => { if (cur) { channels.push(cur); cur = null; } };

  for (const line of lines) {
    if (line.startsWith('Channel : ')) {
      flush();
      cur = { name: line.slice(10).trim(), id: null, type: 'Raw' };
    } else if (cur && line.startsWith('ID : ')) {
      cur.id = Number(line.slice(5).trim());
    } else if (cur && line.startsWith('Type : ')) {
      cur.type = line.slice(7).trim();
    } else if (/^\d{2}:\d{2}:\d{2}\.\d+,/.test(line)) {
      flush();
      const parts = line.split(',');
      const t = parseClock(parts[0]);
      if (t0 == null) t0 = t;
      const values = new Array(channels.length);
      for (let i = 0; i < channels.length; i++) {
        const raw = Number(parts[i + 1]); // +1: leading timestamp column
        values[i] = Number.isFinite(raw) ? decode(channels[i].type, raw) : NaN;
      }
      rows.push({ t: t - t0, values });
    } else if (line.includes(' : ') && !line.startsWith('DisplayMaxMin') && !cur) {
      const [k, v] = line.split(' : ');
      if (k && v !== undefined) meta[k.trim()] = v.trim();
    }
  }
  flush();

  const byName = {};
  channels.forEach((c, i) => { byName[c.name] = i; });
  /* startClock is the log's first timestamp as seconds-into-the-day. Rows keep
   * only elapsed time, which is what every calculation wants; this is kept so a
   * moment can be reported back as the wall clock the ECU recorded it at, which
   * is what you need to find the same instant again in NSP. */
  return { meta, channels, byName, rows, startClock: t0 == null ? null : t0 };
}

function parseClock(s) {
  // HH:MM:SS.mmm -> seconds
  const m = /^(\d{2}):(\d{2}):(\d{2})\.(\d+)/.exec(s);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4]));
}

/** Resolve a channel column by trying several candidate names (trimmed). */
function col(log, ...names) {
  for (const n of names) {
    if (n in log.byName) return log.byName[n];
    // tolerant match: trimmed / trailing-space variants
    const hit = Object.keys(log.byName).find(k => k.trim() === n.trim());
    if (hit) return log.byName[hit];
  }
  return -1;
}

const val = (row, c) => (c >= 0 ? row.values[c] : NaN);

/* ------------------------------------------------------------------ pin map */

/*
 * What each generic ECU resource on this car is actually wired to.
 *
 * Source: the "ECU Pin Map" sheet of HILUX Drag Ute.xlsx, columns AM/AN/AO —
 * generic resource -> connector pin -> function. NSP logs the RESOURCE name
 * ("AVI2 Voltage"), never the function, so without this table a raw input is a
 * trace with no meaning attached and you have to go and find the spreadsheet
 * to read it.
 *
 * A pin whose sensor is properly configured in the ECU also logs under a
 * functional name of its own — AVI9 is A15 is `Fuel Pressure`. The raw channel
 * is not redundant with that: it is the same wire seen BEFORE the channel
 * configuration is applied, which is exactly the comparison you want when the
 * question is whether a bad number came from the sensor or from the setup.
 * AVI2 / A16 is the one input with no functional channel at all — the surge
 * tank level trigger is only ever visible as AVI2.
 *
 * Only pins carrying an assignment are listed. A34 (Step 4) is free, so it
 * stays generic, and so does anything absent from this table.
 */
export const ECU_PINS = {
  // Analogue voltage inputs — log as "AVI<n> Voltage" / "Resistance" / "Switch State"
  'AVI 1':  { pin: 'B13', fn: 'Trans oil pressure' },
  'AVI 2':  { pin: 'A16', fn: 'Surge tank level' },
  'AVI 3':  { pin: 'A17', fn: 'Exhaust manifold pressure' },
  'AVI 4':  { pin: 'A2',  fn: 'Anti-lag + trans-brake button' },
  'AVI 5':  { pin: 'B20', fn: 'Radiator pressure' },
  'AVI 6':  { pin: 'B12', fn: 'Engine oil pressure' },
  'AVI 7':  { pin: 'B3',  fn: 'Intake air temp' },
  'AVI 8':  { pin: 'B4',  fn: 'Coolant temp' },
  'AVI 9':  { pin: 'A15', fn: 'Fuel pressure' },
  'AVI 10': { pin: 'A14', fn: 'Throttle position' },

  // Synchronised pulse inputs — "Synced Pulse Input <n> ..."
  'SPI 1': { pin: 'B8',  fn: 'GPS vehicle speed' },
  'SPI 2': { pin: 'B9',  fn: 'Flex fuel sensor' },
  'SPI 3': { pin: 'B10', fn: 'Wheel speed sensor' },
  'SPI 4': { pin: 'B7',  fn: 'Trans-brake bump button' },

  // Digital pulse outputs — "Digital Pulse Output <n> ..."
  'DPO 1': { pin: 'A18', fn: 'Fuel pump — Bosch main' },
  'DPO 2': { pin: 'A1',  fn: 'Radiator fan 1' },
  'DPO 3': { pin: 'A23', fn: 'Tacho / RPM out' },
  'DPO 4': { pin: 'B19', fn: 'Fuel pump — Bosch auxiliary' },
  'DPO 5': { pin: 'A24', fn: 'Fuel pump — 525 LPH big tank' },
  'DPO 6': { pin: 'A25', fn: 'ECR out — fuse box' },

  /* Stepper pins driven as outputs — "Stepper 1 Pin <n> Output State".
   * Pin 3 is CONFIRMED against data: in PCLog_2026-09-13_1230pm it agrees with
   * the ECU's own `Exhaust Valve (Generic Output 2 Out)` on 99.1% of 1511
   * samples. Pins 1 and 2 are from the sheet only — that is the sole log
   * carrying Stepper channels and the lamp is dark throughout it, so nothing in
   * the data yet distinguishes Step 1 from Step 2. A log with the CEL lit would
   * settle it: whichever pin follows `Check Engine Light Output State` is A31. */
  'Step 1': { pin: 'A31', fn: 'Check engine light' },
  'Step 2': { pin: 'A32', fn: 'Dash battery charge light' },
  'Step 3': { pin: 'A33', fn: 'Exhaust bypass valve' },
  // Step 4 / A34 is free — deliberately absent.

  // Ignition outputs repurposed as DPOs. IGN 1 and 2 are the real coil drives
  // (A3, A4) and already log under a meaningful name, so they are left alone.
  'IGN 3': { pin: 'A5', fn: 'Boost control — MAC valve' },
  'IGN 4': { pin: 'A6', fn: 'Dash speedometer signal' },

  /* Drive-by-wire H-bridges driven as plain outputs. These are two SEPARATE
   * bridges, one pin of each: DBW1 -> B25 idle valve, DBW2 -> B26 trans-brake.
   *
   * B25 is CONFIRMED as DBW1 Pin 1 from data: in PCLog_2026-09-13_1230pm,
   * `Drive By Wire 1 Pin 1 Duty Cycle` tracks the ECU's `Idle Control Output`
   * to within 2% on 1495 of 1511 samples (the 16 that miss are all in the first
   * two seconds). DBW1 Pin 2 is flat zero across that whole file, which is
   * exactly right — it is the bridge's unused leg, wired to nothing, so it is
   * deliberately NOT listed here and stays generic in the picker.
   *
   * DBW2 is not logged at all yet, on any log held. Pin 1 is assumed by
   * symmetry with DBW1; the trans-brake's real behaviour is visible on
   * `Trans-Brake Output Duty Cycle` regardless, so nothing depends on this
   * being right today. If DBW2 is ever logged and Pin 2 is the leg that moves,
   * change the key below and nothing else. */
  'DBW1 Pin 1': { pin: 'B25', fn: 'Idle control valve' },
  'DBW2 Pin 1': { pin: 'B26', fn: 'Trans-brake solenoid' },
};

/** Log-name prefix -> the ECU_PINS key it denotes. First match wins. The
 *  builder is called with (firstGroup, wholeMatch) — most families need only
 *  the one number, DBW needs both its bridge number and its pin number. */
const PIN_FAMILIES = [
  [/^AVI\s*(\d+)\b/i,                      n => 'AVI ' + n],
  [/^Synced\s+Pulse\s+Input\s*(\d+)\b/i,   n => 'SPI ' + n],
  [/^Digital\s+Pulse\s+Output\s*(\d+)\b/i, n => 'DPO ' + n],
  [/^Stepper\s+1\s+Pin\s*(\d+)\b/i,        n => 'Step ' + n],
  [/^Ignition\s*(\d+)\s+Output\s+State/i,  n => 'IGN ' + n],
  [/^Drive\s+By\s+Wire\s+(\d+)\s+Pin\s*(\d+)\b/i, (_b, m) => 'DBW' + m[1] + ' Pin ' + m[2]],
];

/**
 * Resolve a logged channel name to the wire behind it.
 * Returns { generic, pin, fn, raw } or null when the name is not a generic
 * resource, or is one with no assignment.
 */
export function pinFor(channelName) {
  const raw = String(channelName == null ? '' : channelName).trim();
  for (const [re, key] of PIN_FAMILIES) {
    const m = re.exec(raw);
    if (!m) continue;
    const generic = key(m[1], m);
    const e = ECU_PINS[generic];
    return e ? { generic, pin: e.pin, fn: e.fn, raw } : null;
  }
  return null;
}

/**
 * Display name for a channel: the function it performs, with the ECU's own
 * name and the pin kept in parentheses.
 *
 *   "AVI2 Switch State" -> "Surge tank level (AVI2 Switch State · A16)"
 *
 * The raw name stays because every cross-check goes back to NSP, where this
 * channel is still called AVI2 and nothing else. Unmapped names pass through.
 */
export function channelLabel(channelName) {
  const p = pinFor(channelName);
  return p ? p.fn + ' (' + p.raw + ' · ' + p.pin + ')' : String(channelName == null ? '' : channelName).trim();
}

/* ---------------------------------------------------------------- dyno curves */

/*
 * Measured torque against engine speed, from the JT Performance runs of
 * 2026-07-17 (Mainline ProHub controller, session "New Motor 98", SAE J607).
 *
 * It is a HUB dyno. These numbers are hub torque referred to engine rpm
 * through the 4.1 drive ratio, so gearbox and driveline losses are ALREADY
 * inside them. That is the torque which actually accelerates the car, which is
 * exactly what a shift-point calculation wants — do not subtract a drivetrain
 * loss from these, and do not compare them to a flywheel figure.
 *
 * Two maps, because the tune switches on fuel. Below 80% ethanol the petrol
 * map is in play, above it the E85 map:
 *     98 octane   520.5 Nm @ 4450     452.6 hp @ 7693
 *     E85         883.2 Nm @ 4563     624.9 hp @ 7972
 *
 * Provenance matters here. The tables were read off PHOTOGRAPHS of the dyno
 * screen: traces extracted by colour, each plot rectified for rotation and —
 * on the 98 shot — for keystone, then scaled by a piecewise gain (never more
 * than 2%) to land exactly on the values the dyno itself printed. They are
 * good to a couple of percent. They are not a measurement.
 *
 * And they are a dyno RAMP. A log sample at the same rpm and throttle only
 * makes this torque if it is also making the same boost, and boost on the road
 * lags a controlled ramp badly — most of all just after a shift. Read this as
 * the reference the car was tuned to, not as a prediction of what it made.
 */
export const DYNO = {
  source: 'JT Performance · Mainline ProHub hub dyno · 2026-07-17 · SAE J607',
  from: 3500,             // first rpm in both tables
  rpmStep: 100,
  ethanolSwitchPct: 80,   // above this the E85 map runs
  wotThrottlePct: 95,     // below this the curves mean nothing — they are WOT ramps
  petrol98: {
    label: '98 octane', peakNm: 520.5, peakNmRpm: 4450, peakHp: 452.6, peakHpRpm: 7693,
    nm: [250, 257, 276, 313, 356, 390, 423, 465, 503, 518, 517, 509, 503, 495, 489, 482,
         481, 480, 476, 468, 463, 459, 454, 455, 457, 455, 453, 450, 449, 448, 451, 450,
         449, 447, 445, 440, 436, 432, 429, 426, 423, 420, 418, 411, 403, 398],
  },
  e85: {
    label: 'E85', peakNm: 883.2, peakNmRpm: 4563, peakHp: 624.9, peakHpRpm: 7972,
    nm: [211, 211, 229, 259, 312, 408, 487, 583, 718, 851, 872, 877, 854, 844, 830, 817,
         807, 789, 776, 768, 758, 747, 736, 726, 715, 702, 691, 677, 669, 661, 648, 637,
         635, 631, 627, 624, 619, 617, 611, 607, 600, 593, 585, 572, 561, 550],
  },
};

/** Which dyno map the ECU is running on, for a given ethanol reading. */
export function dynoCurveFor(ethanolPct) {
  return (Number.isFinite(ethanolPct) && ethanolPct > DYNO.ethanolSwitchPct) ? DYNO.e85 : DYNO.petrol98;
}

/**
 * Dyno torque (Nm) at an engine speed, on whichever map that ethanol reading
 * selects. NaN outside the rpm range the ramp actually covered — the curve is
 * not extrapolated, because below 3500 the engine is off boost and nothing in
 * the data says what it makes there.
 */
export function dynoTorqueNm(rpm, ethanolPct) {
  if (!Number.isFinite(rpm)) return NaN;
  const c = dynoCurveFor(ethanolPct);
  const i = (rpm - DYNO.from) / DYNO.rpmStep;
  if (i < 0 || i > c.nm.length - 1) return NaN;
  const a = Math.floor(i), b = Math.min(a + 1, c.nm.length - 1);
  return c.nm[a] + (c.nm[b] - c.nm[a]) * (i - a);
}

/**
 * Extract a tidy, tuning-relevant sample series from a parsed log.
 * Each sample: { t, rpm, load(kPa abs), boostPsi, target(lambda), measured(lambda),
 *   afrTarget, afrMeasured, throttle%, injDuty%, ign(deg), iat, clt, stoich,
 *   knock, loadDeriv }
 */
export function extractSamples(log, opts = {}) {
  const c = {
    rpm: col(log, 'RPM', 'Filtered RPM'),
    load: col(log, 'Fuel - Load', 'Manifold Pressure'),
    map: col(log, 'Manifold Pressure'),
    target: col(log, 'Target Lambda'),
    measured: col(log, 'Wideband O2 1', 'Wideband Maximum'),
    throttle: col(log, 'Throttle Position'),
    injDuty: col(log, 'Injector 1 Duty Cycle'),
    ign: col(log, 'Ignition Angle'),
    iat: col(log, 'Intake Air Temperature'),
    clt: col(log, 'Coolant Temperature'),
    stoich: col(log, 'Fuel Tuning Current Stoichiometry'),
    knock: col(log, 'Knock Sensor 1 Knock Level', 'Knock Input 1 FFT.'),
    knockCount: col(log, 'Knock Sensor 1 Knock Count', 'Knock Count'),
    knockRetard: col(log, 'Knock Control Bank 1 Ignition Correction',
      'Knock Control Ignition Correction'),
    boostTarget: col(log, 'Boost Control Target Pressure'),
    fuelPress: col(log, 'Fuel Pressure', 'Fuel Pressure 1', 'Fuel Pressure Sensor'),
    // The ECU's own 1:1 model of where the rail should be. When present this is a
    // direct target for the differential and removes every inference below.
    fuelExpected: col(log, 'Fuel Pressure Expected', 'Fuel Pressure Target'),
    battery: col(log, 'Battery Voltage'),
    ethanol: col(log, 'Ethanol Content', 'Flex Fuel Ethanol Content', 'Fuel Composition'),
    emap: col(log, 'Exhaust Manifold Pressure', 'Exhaust Back Pressure'),
  };
  const samples = [];
  let prevLoad = null, prevT = null;
  for (const row of log.rows) {
    const rpm = val(row, c.rpm);
    const load = val(row, c.load);
    const stoich = c.stoich >= 0 && Number.isFinite(val(row, c.stoich)) ? val(row, c.stoich) : 14.7;
    const target = val(row, c.target);
    const measured = val(row, c.measured);
    let loadDeriv = 0;
    if (prevLoad != null && prevT != null && row.t > prevT) loadDeriv = (load - prevLoad) / (row.t - prevT);
    prevLoad = load; prevT = row.t;
    samples.push({
      t: row.t,
      rpm,
      load,
      boostPsi: kpaToPsi(load),
      target,
      measured,
      afrTarget: lambdaToAfr(target, stoich),
      afrMeasured: lambdaToAfr(measured, stoich),
      throttle: val(row, c.throttle),
      injDuty: val(row, c.injDuty),
      ign: val(row, c.ign),
      iat: val(row, c.iat),
      clt: val(row, c.clt),
      stoich,
      knock: val(row, c.knock),
      knockCount: val(row, c.knockCount),
      knockRetard: val(row, c.knockRetard),
      loadDeriv,
      map: c.map >= 0 ? val(row, c.map) : load,
      fuelPress: val(row, c.fuelPress),
      fuelExpected: val(row, c.fuelExpected),
      battery: val(row, c.battery),
      ethanol: val(row, c.ethanol),
      emap: val(row, c.emap),
      fuelDiff: NaN,       // filled by resolveFuelReference() below
      fuelDiffTarget: NaN, // what the differential should have been, same reference
      fuelDevPct: NaN,     // signed % departure of actual from target
    });
  }
  const fuel = resolveFuelReference(samples, opts.vehicle || VEHICLE);
  return { samples, columns: c, fuel };
}

/**
 * Establish the injector pressure differential and what it SHOULD have been, so
 * that any departure can be judged as a percentage rather than guessed at.
 *
 * There are two ways to get the target, and they are not equally good.
 *
 * DIRECT (preferred). The ECU logs `Fuel Pressure Expected` — its own 1:1 model of
 * where the rail belongs. Because expected and actual are the same quantity in the
 * same units, the shortfall is just `actual - expected` and the manifold term
 * cancels: no reference guess, no regulator inference, no boost gate. Use it
 * whenever the channel is in the log.
 *
 * INFERRED (fallback). Without that channel we must answer two questions first:
 *
 *  1. Reference. The NSP decoder yields kPa, but whether the sensor is referenced
 *     to vacuum (absolute) or atmosphere (gauge) depends on how it was set up.
 *     Getting it wrong shifts every differential by one atmosphere (~101 kPa).
 *     Inferred off-boost by picking whichever reading lands nearer the base.
 *
 *     Note the trap: that test asks "which interpretation looks healthy?", so on a
 *     genuinely low rail it is biased toward the one that adds an atmosphere and
 *     hides ~15 psi of the fault. When the expected channel is present we resolve
 *     the reference from IT instead — a model can't be biased by a sick pump.
 *
 *  2. Regulator type. A 1:1 manifold-referenced regulator holds a CONSTANT
 *     differential, so rail pressure rises with boost (slope ~1 against MAP).
 *     A fixed regulator holds constant rail pressure, so the differential
 *     COLLAPSES under boost (slope ~0) — which is by design, not starvation.
 *     Enforcing the starvation check against a fixed regulator would condemn
 *     every boosted sample in the log, so we detect it and refuse to enforce.
 *
 *     The slope is fitted on off-boost samples ONLY. Fitting it over the whole log
 *     was circular: a rail collapsing under boost flattens the slope into the
 *     'unknown' dead band, so the check disabled itself on exactly the logs where
 *     starvation was the whole story. Off boost, a healthy supply can hold the rail
 *     regardless of pump capacity, so the slope there reports regulator type rather
 *     than pump health.
 *
 * Mutates each sample's `fuelDiff` (kPa across the injector), `fuelDiffTarget`
 * (what it should have been) and `fuelDevPct` (signed % departure).
 */
export function resolveFuelReference(samples, vehicle = VEHICLE) {
  const clear = () => {
    for (const s of samples) s.fuelDiff = s.fuelDiffTarget = s.fuelDevPct = NaN;
  };
  const usable = samples.filter(s =>
    Number.isFinite(s.fuelPress) && Number.isFinite(s.map) && s.rpm >= vehicle.minRunningRpm);
  if (!usable.length) {
    clear();
    /* Two very different reasons land here and the advice differs, so say which:
     * a missing/misnamed channel is something to fix in NSP, whereas a key-on log
     * with the engine never running has nothing to measure in the first place. */
    const anyPressure = samples.some(s => Number.isFinite(s.fuelPress));
    const anyRunning = samples.some(s => Number.isFinite(s.rpm) && s.rpm >= vehicle.minRunningRpm);
    return {
      present: false, direct: false, reference: null, regulator: 'unknown',
      slope: NaN, baseDiff: NaN, enforceable: false,
      reason: !anyRunning ? 'engine-never-ran' : !anyPressure ? 'no-channel' : 'no-overlap',
    };
  }

  /* The expected channel is only trustworthy where it is actually populated: it
   * reads zero on some exports and at key-on, and a zeroed target would read as a
   * total collapse. Demand a real pressure on a decent share of running samples. */
  const withExpected = usable.filter(s => Number.isFinite(s.fuelExpected) && s.fuelExpected > 50);
  const direct = withExpected.length >= 20 && withExpected.length >= 0.5 * usable.length;

  // --- 1. absolute vs gauge ---
  // Judged off boost, and off the expected channel when we have it (see above).
  const offBoost = usable.filter(s => s.map < vehicle.baroKpa);
  /* Off boost only matters for the actual-pressure basis: `expected - map` is
   * constant at every MAP by construction, so the whole pool serves. */
  const pool = direct ? withExpected : (offBoost.length ? offBoost : usable);
  const read = direct ? (s => s.fuelExpected) : (s => s.fuelPress);
  const basis = pool;
  const asAbs = median(basis.map(s => read(s) - s.map));
  const asGauge = median(basis.map(s => (read(s) + vehicle.baroKpa) - s.map));
  const reference = Math.abs(asAbs - vehicle.fuelBaseDiffKpa) <= Math.abs(asGauge - vehicle.fuelBaseDiffKpa)
    ? 'absolute' : 'gauge';
  const offset = reference === 'gauge' ? vehicle.baroKpa : 0;

  // --- 2. the differential, and what it should have been ---
  for (const s of samples) {
    s.fuelDiff = (s.fuelPress + offset) - s.map;
    const target = direct && Number.isFinite(s.fuelExpected) && s.fuelExpected > 50
      ? (s.fuelExpected + offset) - s.map
      : (direct ? NaN : vehicle.fuelBaseDiffKpa);
    s.fuelDiffTarget = target;
    s.fuelDevPct = Number.isFinite(s.fuelDiff) && Number.isFinite(target) && target > 0
      ? 100 * (s.fuelDiff - target) / target
      : NaN;
  }

  // --- 3. does rail pressure track manifold pressure? (fallback path only) ---
  const fit = offBoost.length >= 3 ? offBoost : usable;
  const slope = leastSquaresSlope(fit.map(s => s.map), fit.map(s => s.fuelPress));
  const mapRange = Math.max(...fit.map(s => s.map)) - Math.min(...fit.map(s => s.map));
  let regulator = 'unknown';
  if (mapRange >= 50 && Number.isFinite(slope)) {
    if (slope >= 0.7) regulator = 'manifold';
    else if (slope <= 0.3) regulator = 'fixed';
  }

  return {
    present: true, direct, reference, regulator, slope,
    slopeBasis: offBoost.length >= 3 ? 'off-boost' : 'all-running',
    baseDiff: reference === 'gauge' ? asGauge : asAbs,
    /* With the ECU's own target in hand there is nothing left to infer, so the
     * check always applies. Without it, it is only meaningful against a 1:1
     * regulator that the spec says should be holding a constant differential. */
    enforceable: direct || (regulator === 'manifold' && vehicle.fuelRegulator === 'manifold'),
  };
}

/** Slope of y over x by least squares. NaN if degenerate. */
function leastSquaresSlope(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? NaN : num / den;
}

/* ------------------------------------------------------------------------
 * Hard-limit enforcement
 * ---------------------------------------------------------------------- */

/**
 * Find the moments a throttle lift COMMENCES, as elapsed-time seconds.
 *
 * A lift is a fall of more than `fuelTransientLiftDropPct` percentage points.
 * Commencement is the top of that fall, not the crossing at the bottom and not
 * the last time throttle touched its session maximum — both of those were tried
 * and both are wrong by enough to matter against a 0.6 s window:
 *
 *   - Anchoring to the session maximum put commencement seconds early (Log3132's
 *     throttle last touched 100% at t=1.5 and the lift is at t=7.1).
 *   - Walking back through a plateau with a noise tolerance is just as bad: the
 *     throttle wanders 94-97% for a second before Log3132's lift, and a 2-point
 *     tolerance swallowed the whole stretch, anchoring 0.67 s early.
 *
 * So: detect the crossing (throttle more than DROP below its recent peak), then
 * walk back while the trace is STRICTLY falling. Strictness is what stops the
 * walk at the plateau, and it biases commencement late — the safe direction,
 * because late only ever narrows what the suppression window covers.
 */
export function throttleLifts(samples, vehicle = VEHICLE) {
  const drop = vehicle.fuelTransientLiftDropPct;
  const lookback = 1.0;              // a lift completes well inside this
  const out = [];
  let armed = true;
  for (let k = 1; k < samples.length; k++) {
    const tps = samples[k].throttle;
    if (!Number.isFinite(tps)) continue;
    let top = tps, topI = k;
    for (let j = k - 1; j >= 0 && samples[k].t - samples[j].t <= lookback; j--) {
      if (Number.isFinite(samples[j].throttle) && samples[j].throttle > top) {
        top = samples[j].throttle; topI = j;
      }
    }
    // Re-arm only once throttle is back within `drop` of its peak, so one lift
    // registers once instead of on every sample it stays shut for.
    if (top - tps <= drop) { armed = true; continue; }
    if (!armed) continue;
    let c = k;
    while (c > topI && samples[c - 1].throttle >= samples[c].throttle) c--;
    out.push({ t: samples[c].t, from: samples[c].throttle, to: tps, crossedAt: samples[k].t });
    armed = false;
  }
  return out;
}

/* burstsOf() / sampleRateHz() lived here briefly, to turn a sample count into an
 * episode count and a timestamp for the lift-transient warning. That warning is
 * gone (see checkLimits), so they went with it rather than sit unused.
 *
 * The lesson they encoded is still live and applies to any finding that quotes a
 * count: a SAMPLE COUNT IS NOT AN EVENT COUNT. These logs run at ~170 Hz, so one
 * 0.18 s spike is 28 consecutive samples, and "28 samples" reads as 28 separate
 * events against a graph showing a single peak. If a warning ever needs to quote
 * a count again, give the episode count and the time alongside it. */

/**
 * Dismiss injector-differential excursions that are the regulator recovering
 * from a throttle lift rather than a fuel-supply fault.
 *
 * Sets `fuelTransient` on the samples of every out-of-band run that is BOTH
 *   - shorter than `fuelTransientMaxS`, and
 *   - started within `fuelTransientWindowS` of a lift commencing,
 * and clears `fuelStarved` / `fuelOverPressure` on them. `fuelDevPct` is left
 * untouched, so the excursion still draws on the graph — this suppresses the
 * VERDICT, not the evidence.
 *
 * Both tests are required. Duration alone would hide the 0.44 s -22.8% dropout in
 * Log3044, which is the real air-locked-pump starvation. Lift-linkage alone would
 * hide anything that happens to begin just after a lift, however long it lasts.
 *
 * Measured across 90 logs: every lift spike is +13% to +33%, lasts 0.15-0.47 s,
 * and starts 0.03-0.53 s after commencement — so 0.6 s clears the observed worst
 * case on both axes, but not by a wide margin.
 *
 * KNOWN GAP: this keys on the throttle, and the throttle is not the only thing
 * that collapses fuel demand. In Log3131 the same spike is triggered by the 1-2
 * SHIFT — rpm 6082 -> 4537 and duty 85% -> 34% with the throttle still at 97% —
 * and it starts 0.17 s BEFORE the throttle moves, so nothing here suppresses it.
 */
export function markFuelLiftTransients(samples, vehicle = VEHICLE) {
  const tol = vehicle.fuelDiffTolerancePct;
  const maxS = vehicle.fuelTransientMaxS;
  const winS = vehicle.fuelTransientWindowS;
  for (const s of samples) s.fuelTransient = false;
  const lifts = throttleLifts(samples, vehicle);
  if (!lifts.length) return { suppressed: 0, runs: 0, lifts: 0 };

  const near = t => lifts.some(l => t >= l.t && t <= l.t + winS);
  /* Deliberately does NOT read s.running: detectEvents() marks transients on raw
   * extractSamples() output, where annotateLimits() has not run and that flag does
   * not exist yet. Deriving it here keeps both call sites agreeing. */
  const out = s => Number.isFinite(s.rpm) && s.rpm >= vehicle.minRunningRpm
    && Number.isFinite(s.fuelDevPct) && Math.abs(s.fuelDevPct) > tol;

  let suppressed = 0, runs = 0;
  let i = 0;
  while (i < samples.length) {
    if (!out(samples[i])) { i++; continue; }
    let j = i;
    while (j + 1 < samples.length && out(samples[j + 1])) j++;
    const dur = samples[j].t - samples[i].t;
    if (dur < maxS && near(samples[i].t)) {
      runs++;
      for (let k = i; k <= j; k++) {
        const s = samples[k];
        s.fuelTransient = true;
        // Only unset flags that were actually set — see the note above about
        // running ahead of annotateLimits().
        if (s.fuelStarved === true) s.fuelStarved = false;
        if (s.fuelOverPressure === true) s.fuelOverPressure = false;
        if (typeof s.trustworthy === 'boolean') {
          s.trustworthy = !(s.mapClipped || s.dutyMaxed || s.implausible);
        }
        suppressed++;
      }
    }
    i = j + 1;
  }
  return { suppressed, runs, lifts: lifts.length };
}

/**
 * Tag each sample against the vehicle's hard limits.
 *
 * Three of these flags are DISQUALIFYING for fuel analysis, because in each case
 * the lambda reading describes a hardware limit rather than a calibration error:
 *   mapClipped  - sensor is pegged; the load axis value is a floor, not a value,
 *                 so we do not even know which cell this sample belongs in.
 *   dutyMaxed   - injectors are out of pulse width; they physically cannot add
 *                 the fuel a correction would ask for.
 *   fuelStarved - rail pressure has fallen off the regulator; flow is below what
 *                 the pulse width implies, and the fix is pumps/plumbing.
 * The rest are advisory and do not remove the sample.
 */
export function annotateLimits(samples, vehicle = VEHICLE, fuel = null) {
  const ceil = mapCeilingKpa(vehicle);
  const clipAt = ceil - vehicle.mapClipMarginKpa;
  const maxBoostKpa = psiToKpa(vehicle.maxBoostPsi) + vehicle.baroKpa;
  const sane = vehicle.sane;
  const inRange = (v, [lo, hi]) => !Number.isFinite(v) || (v >= lo && v <= hi);
  // Direct against the ECU's own target, or inferred — see resolveFuelReference().
  const fuelCheck = fuel ? fuel.enforceable : true;
  const tol = vehicle.fuelDiffTolerancePct;

  for (const s of samples) {
    // Key-on and cranking data trips every plausibility bound (0% ethanol,
    // 4 V battery, no MAP signal). None of it says anything about the tune.
    s.running = Number.isFinite(s.rpm) && s.rpm >= vehicle.minRunningRpm;
    if (!s.running) {
      s.mapClipped = s.dutyMaxed = s.fuelStarved = s.implausible = false;
      s.fuelOverPressure = false;
      s.overBoost = s.overRev = s.iatHigh = s.cltHigh = false;
      s.trustworthy = true; // excluded later by the minRpm gate, not by limits
      continue;
    }
    const boosted = s.map > vehicle.baroKpa;

    // disqualifying
    s.mapClipped = Number.isFinite(s.map) && s.map >= clipAt;
    s.dutyMaxed = Number.isFinite(s.injDuty) && s.injDuty >= vehicle.maxInjDutyPct;
    /* The regulator's job is to hold the differential constant, so a departure is
     * a fault at ANY load — the old boost gate meant a rail 25 psi down at idle or
     * cruise was structurally unreportable. Judged as a percentage of target so the
     * same rule works against the ECU's expected value and the spec base alike. */
    s.fuelStarved = fuelCheck && Number.isFinite(s.fuelDevPct) && s.fuelDevPct < -tol;
    s.fuelOverPressure = fuelCheck && Number.isFinite(s.fuelDevPct) && s.fuelDevPct > tol;

    // advisory
    s.overBoost = Number.isFinite(s.map) && s.map > maxBoostKpa;
    s.overRev = Number.isFinite(s.rpm) && s.rpm > vehicle.redlineRpm;
    s.iatHigh = Number.isFinite(s.iat) && s.iat > vehicle.maxIatC;
    s.cltHigh = Number.isFinite(s.clt) && s.clt > vehicle.maxCltC;

    // a 5V reference fault shows as several sensors leaving their physical range
    s.implausible = !inRange(s.map, sane.mapKpa) || !inRange(s.throttle, sane.tpsPct)
      || !inRange(s.fuelPress, sane.fuelKpa) || !inRange(s.battery, sane.batteryV);

    /* --- what the injectors can actually pass, versus what is being asked ---
     * flowAtPressure is the sheet curve evaluated at THIS sample's differential.
     * flowLossPct is how much of the rated flow the pressure alone is costing.
     * deliveredCcMin is that flow at the commanded duty; impliedHp turns it into
     * a number that can be sanity-checked against what the engine could be
     * making. A commanded flow far above plausible power WHILE the mixture reads
     * lean means the fuel model and the delivered fuel disagree — which is a
     * different fault from "the injectors are too small". */
    s.flowAtPressure = injectorFlowCcMin(s.fuelDiff, vehicle);
    s.flowLossPct = Number.isFinite(s.flowAtPressure)
      ? (1 - s.flowAtPressure / vehicle.injectorCcMin) * 100 : NaN;
    s.deliveredCcMin = (Number.isFinite(s.flowAtPressure) && Number.isFinite(s.injDuty))
      ? s.flowAtPressure * (s.injDuty / 100) * vehicle.injectorCount : NaN;
    s.impliedHp = ccMinToHp(s.deliveredCcMin, vehicle);

    s.trustworthy = !(s.mapClipped || s.dutyMaxed || s.fuelStarved || s.implausible);
  }
  /* Needs the whole series (run lengths, lift timing), so it runs as a second
   * pass rather than inside the per-sample loop above. It only ever CLEARS fuel
   * flags, so nothing downstream sees a sample it would not have seen before. */
  markFuelLiftTransients(samples, vehicle);
  return samples;
}

/**
 * Roll annotated samples up into human-readable warnings, most severe first.
 * `blocking: true` means fuel recommendations in that region were suppressed.
 */
export function checkLimits(allSamples, vehicle = VEHICLE, fuel = null) {
  const w = [];
  // Every check below is about how the engine behaved, so only running data counts.
  const samples = allSamples.filter(s => s.running);
  const n = samples.length || 1;
  const pct = k => (100 * k / n);
  const count = f => samples.filter(f).length;
  const peak = (f, sel) => samples.filter(f).reduce((m, s) => Math.max(m, sel(s)), -Infinity);
  const low = (f, sel) => samples.filter(f).reduce((m, s) => Math.min(m, sel(s)), Infinity);

  const add = (id, severity, blocking, hits, title, detail) => {
    if (hits > 0) w.push({ id, severity, blocking, hits, pctOfLog: +pct(hits).toFixed(1), title, detail });
  };

  // --- blocking ---
  const clipped = count(s => s.mapClipped);
  add('map-clipped', 'critical', true, clipped,
    `MAP sensor saturated at ${mapCeilingPsi(vehicle).toFixed(1)} psi`,
    `The ${vehicle.mapSensorBar} bar sensor pegged on ${clipped} samples. Actual boost was higher `
    + `than logged, so the load axis is wrong and those cells cannot be tuned. Fit a larger sensor.`);

  const maxed = count(s => s.dutyMaxed);
  add('inj-duty-ceiling', 'critical', true, maxed,
    `Injector duty reached the ${vehicle.maxInjDutyPct}% ceiling`,
    `${maxed} samples at or above the ceiling (peak ${peak(s => s.dutyMaxed, s => s.injDuty).toFixed(1)}%). `
    + `Any lean reading here is fuel-system capacity, not calibration — adding fuel in the map will not help.`);

  /* --- injector pressure differential, in both directions ---
   * The tolerance is tight (±5% of ~400 kPa is only ~3 psi), so every figure below
   * is reported with the median and the worst case alongside the % of log: a blip
   * reads as 0.1% of samples, a real fault reads as tens of percent.
   *
   * We deliberately do NOT suppress fast-MAP samples. That filter was specified on
   * the theory that the flags are tip-in transients where the rail lags the
   * manifold, and the logs of 2026-09-13 refute it: on the two healthy logs the
   * flagged samples' |dMAP/dt| distribution is indistinguishable from the clean
   * ones (p90 16 vs 17 kPa/s), a 50 kPa/s gate removed 2 of 179 flags, and the
   * same gate discarded 28% of the samples on a log whose rail was genuinely
   * collapsed. It would have cost real evidence to hide nothing.
   *
   * What DOES separate them is fuel demand: on those logs every flagged sample sat
   * under 5% injector duty — sustained idle sag, not noise. So demand is reported
   * rather than filtered on. A sag at idle is still a fault; it is just a different
   * one from a sag at load, and the reader needs to see which. */
  const tolPct = vehicle.fuelDiffTolerancePct;
  const src = fuel && fuel.direct
    ? `the ECU's own Fuel Pressure Expected channel`
    : `the ${vehicle.fuelBaseDiffKpa} kPa spec base (no Fuel Pressure Expected channel in this log)`;
  const devOf = f => median(samples.filter(f).map(s => s.fuelDevPct));
  const diffPsi = f => kpaToPsiDiff(median(samples.filter(f).map(s => s.fuelDiff)));
  const tgtPsi = f => kpaToPsiDiff(median(samples.filter(f).map(s => s.fuelDiffTarget)));
  /* Where the sag sits in fuel demand — the discriminator that matters. A rail
   * that only sags at idle points somewhere different (regulator control at low
   * flow, pump staging) from one that sags when the injectors are actually asking
   * for fuel, which is the supply-capacity case. `demandDuty` matches the event
   * detector's threshold so the two agree about what counts as under load. */
  const demandDuty = 15;
  const underLoad = f => samples.filter(s => f(s) && Number.isFinite(s.injDuty)
    && s.injDuty >= demandDuty).length;
  const where = (f, n) => {
    const hasDuty = samples.filter(s => f(s) && Number.isFinite(s.injDuty)).length;
    if (!hasDuty) return `Injector duty was not logged, so demand cannot be established. `;
    const ld = underLoad(f);
    if (!ld) return `All of them sit below ${demandDuty}% injector duty (median `
      + `${median(samples.filter(f).map(s => s.injDuty)).toFixed(1)}%) — the engine was idling or `
      + `on overrun, not asking for fuel. That points at rail control at low flow or pump staging `
      + `rather than supply capacity, but it is still the regulator failing to hold its target. `;
    return `${ld} of them (${(100 * ld / n).toFixed(0)}%) are at or above ${demandDuty}% injector `
      + `duty — the engine was asking for fuel and did not get the pressure. That is the supply-capacity `
      + `case: pumps, filter, feed restriction. `;
  };

  const starved = count(s => s.fuelStarved);
  add('fuel-pressure-low', 'critical', true, starved,
    `Injector pressure differential more than ${tolPct}% below target`,
    `${starved} samples low against ${src}. Median ${diffPsi(s => s.fuelStarved).toFixed(1)} psi `
    + `across the injector where ${tgtPsi(s => s.fuelStarved).toFixed(1)} psi was called for `
    + `(${devOf(s => s.fuelStarved).toFixed(1)}%), worst `
    + `${kpaToPsiDiff(low(s => s.fuelStarved, s => s.fuelDiff)).toFixed(1)} psi at `
    + `${low(s => s.fuelStarved, s => s.fuelDevPct).toFixed(1)}%. `
    + where(s => s.fuelStarved, starved)
    + `A lean reading here is a supply problem, not a calibration one, and the injectors cannot `
    + `pass rated flow at this differential.`);

  const overP = count(s => s.fuelOverPressure);
  add('fuel-pressure-high', 'warn', false, overP,
    `Injector pressure differential more than ${tolPct}% above target`,
    `${overP} samples high against ${src}. Median ${diffPsi(s => s.fuelOverPressure).toFixed(1)} psi `
    + `across the injector where ${tgtPsi(s => s.fuelOverPressure).toFixed(1)} psi was called for `
    + `(+${devOf(s => s.fuelOverPressure).toFixed(1)}%), peak `
    + `${kpaToPsiDiff(peak(s => s.fuelOverPressure, s => s.fuelDiff)).toFixed(1)} psi. `
    + `A stuck regulator or a restricted return line — the injectors are flowing more than the `
    + `pulse width implies, so the mixture reads rich and the fuel model is off in that direction. `
    + `Not blocking: flow is computed at the actual differential, so the correction grid still holds.`);

  /* Reported, not swallowed. A suppressed excursion is still a thing that
   * happened, and Danie reads these back against the trace — if the graph shows
   * a spike the warnings do not mention, the tool looks broken rather than
   * careful. Info severity: it is an observation, not a fault. */
  /* There is deliberately NO warning for lift-recovery transients.
   *
   * They were reported at `info` for one version and Danie had it removed: a
   * dismissed excursion needs no attention, so a card saying "28 samples were
   * dismissed" is noise in a panel he reads for things to act on. The rule for
   * this panel is now explicit — EVERY finding here must require attention or
   * action. `info` has no place in it, and `fuel-lift-transient` is the only
   * finding that was ever that severity.
   *
   * The suppression itself still happens in markFuelLiftTransients(); the
   * samples keep `fuelTransient` and still draw on the graph. It is only the
   * verdict card that is gone. artifact/check.mjs asserts it stays gone. */

  const bad = count(s => s.implausible);
  add('sensor-implausible', 'critical', true, bad,
    'Sensor readings outside physical range',
    `${bad} samples with MAP, TPS, fuel pressure or battery voltage outside plausible bounds. `
    + `Classic signature of a 5V reference or sensor-ground fault (cf. P0641/P0642). `
    + `Data from this log should not be trusted until that is resolved.`);

  // --- advisory ---
  const ob = count(s => s.overBoost);
  add('over-boost', 'warn', false, ob,
    `Boost exceeded the ${vehicle.maxBoostPsi} psi target`,
    `Peak ${kpaToPsi(peak(s => s.overBoost, s => s.map)).toFixed(1)} psi. `
    + `Sensor ceiling is ${mapCeilingPsi(vehicle).toFixed(1)} psi — overshoot risks clipping.`);

  const or = count(s => s.overRev);
  add('over-rev', 'warn', false, or,
    `RPM exceeded the ${vehicle.redlineRpm} limit`,
    `Peak ${Math.round(peak(s => s.overRev, s => s.rpm))} rpm.`);

  const hot = count(s => s.iatHigh);
  add('iat-high', 'warn', false, hot,
    `Intake air temp above ${vehicle.maxIatC} °C`,
    `Peak ${peak(s => s.iatHigh, s => s.iat).toFixed(0)} °C post-intercooler. Knock margin is reduced.`);

  const boil = count(s => s.cltHigh);
  add('clt-high', 'warn', false, boil,
    `Coolant above ${vehicle.maxCltC} °C`,
    `Peak ${peak(s => s.cltHigh, s => s.clt).toFixed(0)} °C.`);

  // ethanol instability — flex sensor noise moves stoich and therefore fuelling
  const eth = samples.map(s => s.ethanol).filter(Number.isFinite);
  if (eth.length > 20) {
    const spread = stddev(eth);
    if (spread > 2) {
      w.push({
        id: 'ethanol-unstable', severity: 'warn', blocking: false, hits: eth.length,
        pctOfLog: 100,
        title: `Flex fuel reading is unstable (±${spread.toFixed(1)}% ethanol)`,
        detail: `Content swung between ${Math.min(...eth).toFixed(0)}% and ${Math.max(...eth).toFixed(0)}% `
          + `within one log. Stoich and the fuel multiplier move with it, so lambda error may be `
          + `chasing the sensor rather than the tune. Check sensor wiring and supply.`,
      });
    }
  }

  // battery sag — dead times are voltage-referenced (1260 µs @12V, 940 µs @14V)
  const volts = samples.map(s => s.battery).filter(Number.isFinite);
  if (volts.length) {
    const lo = Math.min(...volts);
    if (lo < 12.0) {
      w.push({
        id: 'voltage-sag', severity: 'warn', blocking: false, hits: count(s => s.battery < 12),
        pctOfLog: +pct(count(s => s.battery < 12)).toFixed(1),
        title: `Battery voltage sagged to ${lo.toFixed(1)} V`,
        detail: 'Injector dead time is characterised at 12 V and 14 V; below that range the '
          + 'delivered pulse width is shorter than commanded and low-load fuelling drifts lean.',
      });
    }
  }

  /* --- commanded fuel versus plausible power ---------------------------------
   * The injector sheet says four of these pass ~1170 hp of E85 at 4 bar, so at
   * this car's 800 hp target duty should sit near 70%. If the ECU is commanding
   * a flow that implies far more power than the engine could be making, AND the
   * wideband still reads lean, the fuel actually entering the cylinder is well
   * short of what the model believes. That is a delivery or modelling fault —
   * emphatically NOT "the injectors are too small", which is the wrong repair
   * and an expensive one. */
  const overCommand = samples.filter(s =>
    Number.isFinite(s.impliedHp) && s.impliedHp > vehicle.powerGoalHp * 1.25
    && Number.isFinite(s.measured) && Number.isFinite(s.target) && s.measured > s.target);
  if (overCommand.length) {
    const worst = overCommand.reduce((m, s) => (s.impliedHp > m.impliedHp ? s : m));
    w.push({
      id: 'fuel-model-over-commands', severity: 'critical', blocking: false,
      hits: overCommand.length, pctOfLog: +pct(overCommand.length).toFixed(1),
      title: 'Commanded fuel implies more power than the engine can be making — while lean',
      detail: `Peak commanded flow is ${Math.round(worst.deliveredCcMin)} cc/min at `
        + `${Math.round(worst.rpm)} rpm / ${kpaToPsi(worst.map).toFixed(0)} psi — about `
        + `${Math.round(worst.impliedHp)} hp of fuel against a ${vehicle.powerGoalHp} hp target, `
        + `and lambda still reads ${worst.measured.toFixed(3)} vs ${worst.target.toFixed(3)}. `
        + `Far less fuel is reaching the cylinder than the model believes. Check indicated vs `
        + `actual rail differential, injector condition and drive mode, and the airflow model — `
        + `injector SIZE is not the constraint here.`,
    });
  }

  // Which signal actually excluded overrun. Silence here used to mean "duty was
  // never logged, so nothing was excluded", which is the worst of the three.
  const anyDuty = samples.some(s => Number.isFinite(s.injDuty));
  const anyTps = samples.some(s => Number.isFinite(s.throttle));
  if (!anyDuty) {
    w.push(anyTps ? {
      id: 'overrun-gate-fallback', severity: 'info', blocking: false,
      hits: samples.length, pctOfLog: null,
      title: 'Overrun excluded by throttle position, not injector duty',
      detail: 'Injector duty is not logged, so closed-throttle above 1500 rpm was used to drop '
        + 'decel samples. That is a proxy: it cannot see a fuel cut that leaves the throttle open, '
        + 'and it removes nothing at idle. Log Injector 1 Duty Cycle for the direct test.',
    } : {
      id: 'overrun-gate-unavailable', severity: 'warn', blocking: false,
      hits: samples.length, pctOfLog: null,
      title: 'Overrun could not be excluded',
      detail: 'Neither injector duty nor throttle position is logged, so fuel-cut and decel samples '
        + 'cannot be identified. Any low-load correction from this log is suspect — a wideband '
        + 'recovering from a pull reads rich against an overrun target and looks like a rich cell.',
    });
  }

  /* Report when the differential check could not be applied, rather than silently
   * skipping it or — worse — condemning the whole log on a bad premise. These are
   * `warn`, not `info`: "I could not verify your fuel pressure" is not a footnote,
   * and as info it sorted below over-boost and IAT notes where nobody read it. */
  const unavailable = (detail) => w.push({
    id: 'fuel-check-unavailable', severity: 'warn', blocking: false,
    hits: samples.length, pctOfLog: null,
    title: 'Injector pressure differential NOT checked', detail,
  });

  if (fuel && !fuel.present) {
    /* Previously silent: this branch was gated on fuel.present, so a log whose rail
     * channel did not match one of the accepted names produced no finding at all —
     * indistinguishable from a clean bill of health. */
    unavailable(
      (fuel.reason === 'engine-never-ran'
        ? `The engine never ran in this log (no sample at or above ${vehicle.minRunningRpm} rpm), `
          + `so there was no differential to measure. `
        : fuel.reason === 'no-channel'
          ? `No fuel pressure channel in this log — looked for 'Fuel Pressure', 'Fuel Pressure 1' `
            + `and 'Fuel Pressure Sensor'. Check the channel is enabled in NSP and named as one of `
            + `those. `
          : `The fuel pressure and manifold pressure channels never carried a reading at the same `
            + `time while the engine was running. `)
      + `Nothing about the fuel supply was verified — absence of a warning here is not a pass.`);
  } else if (fuel && fuel.present && !fuel.enforceable) {
    unavailable(fuel.regulator === 'fixed'
      ? `Rail pressure stays flat as manifold pressure rises (slope ${fuel.slope.toFixed(2)} off boost), `
        + `which is a FIXED regulator. The spec declares a 1:1 manifold-referenced regulator holding `
        + `${vehicle.fuelBaseDiffKpa} kPa. Either this log is from a different setup, or the regulator `
        + `is not referenced. The differential check was NOT applied. Logging `
        + `'Fuel Pressure Expected' would settle this — with the ECU's own target the check needs `
        + `no assumption about the regulator at all.`
      : `Could not establish how the regulator behaves (slope `
        + `${Number.isFinite(fuel.slope) ? fuel.slope.toFixed(2) : 'n/a'} off boost) — usually too `
        + `little load range in the log. The differential check was NOT applied. Add `
        + `'Fuel Pressure Expected' to the logged channels and this check becomes direct.`);
  }

  const rank = { critical: 0, warn: 1, info: 2 };
  return w.sort((a, b) => rank[a.severity] - rank[b.severity] || b.hits - a.hits);
}

/**
 * Overrun / fuel-cut rejection.
 *
 * Injector duty is the direct signal, but logs recorded before that channel was
 * enabled have `injDuty` = NaN, and the old test (`!isFinite(duty) || duty >= min`)
 * then passed UNCONDITIONALLY. Decel data — target lambda 1.000 against a wideband
 * still reading rich from the pull it just finished — sailed through and binned as
 * a confident "remove 35% fuel" across the vacuum cells.
 *
 * Closed throttle is the proxy that works on every log. It is only applied above
 * `overrunRpm`, because closed throttle at low rpm is idle, which is legitimate
 * fuelling data we do want to keep.
 */
function notOverrun(s, o) {
  // Closed throttle above idle is overrun whatever the duty channel says — this
  // car does not always cut fuel on decel, so duty can sit well above minInjDuty
  // while the engine is being driven by the wheels. Both tests apply.
  if (Number.isFinite(s.throttle) && s.throttle < o.minTpsPct
      && Number.isFinite(s.rpm) && s.rpm > o.overrunRpm) return false;
  if (Number.isFinite(s.injDuty)) return s.injDuty >= o.minInjDuty;
  return true;                                        // nothing left to test against
}

/** Default validity gate for using a sample in fuel-correction analysis. */
export function defaultFilter(opts = {}) {
  const o = {
    minRpm: 500,
    minClt: 60,            // warm engine only (degC)
    minInjDuty: 2,         // exclude fuel cut / overrun (%)
    minTpsPct: 5,          // fallback overrun gate when duty is not logged (%)
    overrunRpm: 1500,      // closed throttle above this is overrun, below it is idle
    lambdaMin: 0.6,        // exclude sensor error / free air
    lambdaMax: 1.3,
    maxLoadDeriv: 80,      // kPa/s — exclude hard transients (AFR lags)
    enforceLimits: true,   // drop samples disqualified by annotateLimits()
    ...opts,
  };
  return s =>
    (!o.enforceLimits || s.trustworthy !== false) &&
    Number.isFinite(s.rpm) && s.rpm >= o.minRpm &&
    Number.isFinite(s.load) &&
    Number.isFinite(s.target) && Number.isFinite(s.measured) &&
    s.measured >= o.lambdaMin && s.measured <= o.lambdaMax &&
    s.target >= o.lambdaMin && s.target <= o.lambdaMax &&
    (!Number.isFinite(s.clt) || s.clt >= o.minClt) &&
    notOverrun(s, o) &&
    Math.abs(s.loadDeriv) <= o.maxLoadDeriv;
}

/* ---------------------------------------------------------------- drag splits
 * Distance is not logged, so it is integrated from vehicle speed. The channel
 * updates at ~36 Hz in 0.1 km/h steps on this car, which is ample for
 * trapezoidal integration — the error that matters is not numerical.
 *
 * The trap is the START. A drag 60-foot time is measured from a standing launch;
 * measuring from the first row of a log that opened at 80 km/h produces a
 * confident number that is not a 60-foot time and cannot be compared to a track
 * slip. So the launch is DETECTED, and if the car was already moving the result
 * is flagged `rollingStart` and the marks are reported as elapsed-from-log-start
 * rather than silently passed off as drag splits. */
const FT_PER_M = 1 / 0.3048;
export const DRAG_MARKS = [
  { name: '60 ft', ft: 60 },
  { name: '330 ft', ft: 330 },
  { name: '1/8 mile', ft: 660 },
  { name: '1000 ft', ft: 1000 },
  { name: '1/4 mile', ft: 1320 },
];

/**
 * Recover the instant speed left zero, by fitting the initial ramp rather than
 * taking the first sample above a threshold. Returns a time, clamped so it can
 * never land outside the pair of samples that straddle the launch.
 */
function refineLaunch(rows, spd, start, ceilKmh) {
  const pts = [];
  for (let i = start; i < rows.length; i++) {
    const v = spd[i];
    if (!Number.isFinite(v)) continue;
    if (v > ceilKmh) break;
    pts.push([rows[i].t, v]);
  }
  if (pts.length < 3) return rows[start].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const n = pts.length, den = n * sxx - sx * sx;
  if (den === 0) return rows[start].t;
  const slope = (n * sxy - sx * sy) / den;
  if (slope <= 0) return rows[start].t;              // not actually accelerating
  const t0 = (sy - slope * sx) / n / -slope;         // where the fitted line crosses 0
  const hi = rows[Math.min(start + 1, rows.length - 1)].t;
  return Math.min(Math.max(t0, rows[start].t - 1), hi);
}

/**
 * Integrate vehicle speed into distance and report the time and speed at each
 * drag mark. Returns { available, reason?, rollingStart, startSpeedKmh,
 * distanceFt[] (aligned to log.rows, null before launch), totalFt, marks[] }.
 */
export function dragSplits(log, opts = {}) {
  const launchKmh = opts.launchKmh ?? 2;    // "stopped" — GPS speed rarely reads a clean 0
  const movingKmh = opts.movingKmh ?? 20;   // proof the car actually left, not sensor noise

  const keys = Object.keys(log.byName);
  const find = (...names) => {
    for (const want of names) {
      const w = want.trim().toLowerCase();
      const hit = keys.find(k => k.trim().toLowerCase() === w);
      if (hit !== undefined) return log.byName[hit];
    }
    return -1;
  };
  const col = find('Vehicle Speed', 'Vehicle Speed GPS', 'Ground Speed');
  if (col < 0) return { available: false, reason: 'no vehicle speed channel in this log' };

  const rows = log.rows;
  const spd = rows.map(r => r.values[col]);
  if (!spd.some(Number.isFinite)) return { available: false, reason: 'vehicle speed channel is empty' };

  /* Last stationary sample that is actually followed by a run. Scanning backwards
   * matters: a log can contain a return-to-staging, and the run we want is the
   * last one. Requiring movingKmh AFTER the candidate stops a car that merely
   * rolled to a halt at the end of the log from being read as a launch. */
  let start = -1, maxAfter = -Infinity;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Number.isFinite(spd[i]) && spd[i] <= launchKmh && maxAfter >= movingKmh) { start = i; break; }
    if (Number.isFinite(spd[i]) && spd[i] > maxAfter) maxAfter = spd[i];
  }
  const rollingStart = start < 0;
  if (rollingStart) start = 0;

  /* The threshold that identifies "stopped" also biases the launch LATE. At
   * launchKmh = 2 a 0.6 g car is already ~94 ms into the run before it trips,
   * which shortens EVERY split by that much — verified against a closed-form
   * synthetic launch, where the raw threshold read 60 ft 89 ms early. So recover
   * the real launch instant by least-squares fitting the initial speed ramp and
   * solving for zero, instead of trusting the first sample over the line. */
  const launchTime = rollingStart ? rows[0].t : refineLaunch(rows, spd, start, movingKmh);

  // trapezoidal integration, km/h -> m/s
  const distanceFt = rows.map(() => null);
  let metres = 0;
  distanceFt[start] = 0;
  for (let i = start + 1; i < rows.length; i++) {
    const a = spd[i - 1], b = spd[i];
    if (Number.isFinite(a) && Number.isFinite(b))
      metres += (a / 3.6 + b / 3.6) / 2 * (rows[i].t - rows[i - 1].t);
    distanceFt[i] = metres * FT_PER_M;
  }
  /* Integration still starts at the first stationary sample, not at launchTime:
   * the distance missed in that sliver is 1/2*a*t^2 = 0.09 ft at 0.6 g, three
   * orders below the 60 ft mark, and starting there needs no extrapolated speed. */
  const t0 = launchTime;

  const marks = DRAG_MARKS.map(m => {
    let k = -1;
    for (let i = start + 1; i < rows.length; i++) if (distanceFt[i] >= m.ft) { k = i; break; }
    if (k < 0) return { name: m.name, ft: m.ft, reached: false };
    // interpolate within the straddling pair rather than snapping to a sample
    const d0 = distanceFt[k - 1], d1 = distanceFt[k];
    const fr = d1 === d0 ? 0 : (m.ft - d0) / (d1 - d0);
    const t = rows[k - 1].t + fr * (rows[k].t - rows[k - 1].t) - t0;
    const v = spd[k - 1] + fr * (spd[k] - spd[k - 1]);
    return { name: m.name, ft: m.ft, reached: true, t, speedKmh: v, mph: v * 0.621371 };
  });

  return {
    available: true, rollingStart, startIndex: start, startTime: launchTime,
    /* A standing start is zero BY DEFINITION — launchTime is the instant the
     * fitted ramp crosses zero, so reporting spd[start] here would show the
     * ~1.9 km/h of the last sample under the threshold instead. */
    startSpeedKmh: rollingStart ? (Number.isFinite(spd[0]) ? spd[0] : NaN) : 0,
    totalFt: metres * FT_PER_M,
    channel: log.channels[col].name.trim(),
    distanceFt, marks,
  };
}

/**
 * The three-line run summary: where movement starts, 60 ft, 1/4 mile.
 *
 * The clock zero differs by launch type and that is the whole point of the first
 * row. Standing start: time zero is the detected launch and the speed there is 0
 * by definition. Rolling start: time zero is the first row of the log and the
 * speed is whatever the log opened at — distance still starts at 0 ft, so the
 * marks are distances travelled from the start of the recording, not track
 * positions. A mark the run never reached reads NA rather than being omitted,
 * so a short log is visibly short instead of quietly missing a row.
 *
 * Formatting lives here so the dashboard and the artifact cannot drift into
 * showing the same run with different precision.
 */
export function dragTable(log) {
  const d = dragSplits(log);
  if (!d.available) return { available: false, reason: d.reason };

  const raw = [{ dist: '0 ft', t: 0, kmh: d.startSpeedKmh, reached: true }];
  for (const name of ['60 ft', '1/4 mile']) {
    const m = d.marks.find(x => x.name === name);
    raw.push({ dist: name, t: m.t, kmh: m.speedKmh, reached: m.reached });
  }
  return {
    available: true,
    rollingStart: d.rollingStart,
    startSpeedKmh: d.startSpeedKmh,
    totalFt: d.totalFt,
    channel: d.channel,
    rows: raw.map(r => ({
      dist: r.dist,
      time: r.reached && Number.isFinite(r.t) ? r.t.toFixed(3) : 'NA',
      speed: r.reached && Number.isFinite(r.kmh) ? r.kmh.toFixed(1) : 'NA',
    })),
  };
}

/**
 * Sort key for "most recent" from a log's FILENAME, in ms.
 *
 * Filename order is not recency — NSP writes both `2026-08-08_0453pm_Log3056.csv`
 * and `PCLog_2026-01-17_0906pm.csv`, and a plain string sort puts every PCLog
 * above every dated log. Nor is mtime trustworthy: these live in OneDrive, which
 * rewrites mtimes on sync. So parse the stamp out of the name and return 0 when
 * there isn't one, letting the caller decide its own fallback.
 *
 * This lives in core.js because THREE surfaces order logs by it — serve.mjs,
 * embed-logs.mjs, and the artifact picking which bundled log to open on load.
 * Three copies of a date parser is how the dashboard and the published page
 * start disagreeing about which log is newest.
 */
export function logStamp(file) {
  const m = /(\d{4})-(\d{2})-(\d{2})[_-](\d{2})(\d{2})\s*(am|pm)/i.exec(file);
  if (m) {
    let h = Number(m[4]) % 12;
    if (/pm/i.test(m[6])) h += 12;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], h, +m[5]);
  }
  const d = /(\d{4})-(\d{2})-(\d{2})/.exec(file);
  return d ? Date.UTC(+d[1], +d[2] - 1, +d[3]) : 0;
}
/* NB: that reads a LOCAL wall-clock stamp as if it were UTC. Every log goes
 * through the same rule so ordering is unaffected, but the number is not a real
 * instant — do not render it as a date without deciding a timezone first. */

/**
 * The ECU's own log number from a filename, or null for a PC log.
 *
 * The HIGHEST number in the name, because `2026-08-15_1006am_Logs3065to3085.csv`
 * is a combined export spanning up to 3085 and its recency is that of its newest
 * member, not its oldest.
 */
export function logNumber(file) {
  const n = [...String(file).matchAll(/(?:Logs?|to)(\d{3,})/gi)].map(m => +m[1]);
  return n.length ? Math.max(...n) : null;
}

/**
 * Order logs newest-run-first. Used by serve.mjs, embed-logs.mjs and the
 * artifact's folder picker, so all three agree on which log is "most recent".
 *
 * **File mtime is not the answer, and neither is the download time alone.**
 * Measured against the real log folder on 2026-08-15: mtimes are intact (they
 * are NOT rewritten by OneDrive, contrary to an earlier note here), but they
 * record when NSP *extracted* a log, not when the car ran — and NSP walks the
 * ECU newest-first, so within a download batch the mtimes run BACKWARDS
 * relative to the recording order. 7 of 8 multi-log batches were inverted.
 * Ordering by mtime put Log3060 above Log3062 when 3062 is the later run.
 * The filename stamp has the same defect across batches: extracting 3083-3085
 * at 09:59 and 3069-3078 at 10:00 made the older runs look newer.
 *
 * The ECU's log number is the recording sequence, so that is the key. PC logs
 * carry no number but their filename stamp IS their recording time, so they
 * keep it. The two groups are compared by stamp where they meet, which is exact
 * whenever they fall in different minutes and arbitrary-but-stable when they do
 * not — the only case this ordering cannot resolve.
 */
export function sortLogs(list, nameOf = x => x.file) {
  const DAY = 86400e3;
  const key = x => {
    const f = nameOf(x);
    const stamp = x.when !== undefined ? x.when : logStamp(f);
    return { day: Math.floor(stamp / DAY), stamp, num: logNumber(f), f };
  };
  const keyed = list.map(x => ({ x, k: key(x) }));
  keyed.sort((a, b) =>
    b.k.day - a.k.day
    || (a.k.num !== null && b.k.num !== null ? b.k.num - a.k.num : b.k.stamp - a.k.stamp)
    || b.k.f.localeCompare(a.k.f));
  return keyed.map(e => e.x);
}

/* ======================================================== check engine light
 *
 * The ECU logs three separate things about the light and they answer different
 * questions:
 *   `Check Engine Light Cause`        a small enum, DisplayMaxMin 8,0
 *   `Check Engine Light Output State` 0/1 — is the lamp actually driven
 *   `Latest flagged DTC`              the numeric trouble code, 0 when none
 *
 * **The cause enum's labels are not published anywhere.** They live in the
 * `.hdef` definition file, which is encrypted (magic `HEPS`, ~8 bits/byte of
 * entropy) exactly like the `.nexmap` tune files, and NSP.dll carries no copy
 * of the strings. Haltech's knowledge base documents the DTC index and the
 * engine-limiting enums but not this one. So do NOT invent names for cause
 * codes — the same failure class as the missing `Speed` scale factor.
 *
 * What IS recoverable is far more useful: `Latest flagged DTC` names the actual
 * fault. Its value is a standard two-byte OBD-II DTC (verified 2026-08-15:
 * 1601 = 0x641 = P0641, and the RealDash community mapping 272 = 0x110 = P0110
 * agrees), so it resolves to a code string and then to a description from
 * Haltech's published index. A cause code with a DTC beside it renders as the
 * fault; one without renders as the bare code number and nothing more.
 */

/**
 * Numeric DTC -> code string, e.g. 1601 -> 'P0641'.
 *
 * Standard OBD-II packing: bits 15-14 select the system letter, the remaining
 * 14 bits are the four hex characters. Returns null for 0 (the ECU's "no code"
 * value) and for anything out of range, so a missing channel can never be
 * mistaken for code P0000.
 */
export function dtcCode(n) {
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  if (v <= 0 || v > 0xffff) return null;
  return 'PCBU'[(v >> 14) & 3] + (v & 0x3fff).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Descriptions from Haltech's published DTC index, fetched 2026-08-15 from
 * support.haltech.com/portal/en/kb/articles/diagnostic-trouble-code-dtc-index.
 * A code absent from this table renders as the bare code — never as a guess.
 */
const DTC_INDEX = `
P0003 Fuel Flow Sensor Raw Min
P0004 Fuel Flow Sensor Raw Max
P0070 Ambient Air Temperature Sensor Operating Min
P0071 Ambient Air Temperature Sensor Operating Max
P0072 Ambient Air Temperature Sensor Raw Min
P0073 Ambient Air Temperature Sensor Raw Max
P0087 Fuel Flow Return Sensor Raw Min
P0088 Fuel Flow Return Sensor Raw Max
P00F2 Humidity Sensor Raw Min
P00F3 Humidity Sensor Raw Max
P00F5 Humidity Sensor Operating Max
P0100 MAF Sensor 1 Raw Min
P0101 MAF Sensor Circuit Range
P0102 MAF Sensor 2 Raw Min
P0103 MAF Sensor 2 Raw Max
P0104 MAF Sensor 1 Raw Max
P0105 MAP Sensor Operating Min
P0106 MAP Sensor Operating Max
P0107 MAP Sensor Raw Min
P0108 MAP Sensor Raw Max
P0109 MAP Hose Failure
P0110 Intake Air Temperature Sensor Operating Min
P0111 Intake Air Temperature Sensor Operating Max
P0112 Intake Air Temperature Sensor Raw Min
P0113 Intake Air Temperature Sensor Raw Max
P0115 Coolant Pressure Sensor Operating Min
P0116 Engine Coolant Temperature Sensor Operating Max
P0117 Engine Coolant Temperature Sensor Raw Min
P0118 Engine Coolant Temperature Sensor Raw Max
P0122 Throttle Position Sensor Switch Raw Min
P0123 Throttle Position Sensor Switch Raw Max
P0128 Coolant Pressure Sensor Operating Max
P0131 Wideband O2 Sensor 1 Raw Min
P0132 Wideband O2 Sensor 1 Raw Max
P0137 Wideband O2 Sensor 3 Raw Min
P0138 Wideband O2 Sensor 3 Raw Max
P0143 Narrowband O2 Sensor 1 Raw Min
P0144 Narrowband O2 Sensor 1 Raw Max
P0151 Wideband O2 Sensor 2 Raw Min
P0152 Wideband O2 Sensor 2 Raw Max
P0157 Wideband O2 Sensor 4 Raw Min
P0158 Wideband O2 Sensor 4 Raw Max
P0163 Narrowband O2 Sensor 2 Raw Min
P0164 Narrowband O2 Sensor 2 Raw Max
P0178 Fuel Composition Sensor Raw Min
P0179 Fuel Composition Sensor Raw Max
P0182 Fuel Temperature Sensor 1 Raw Min
P0183 Fuel Temperature Sensor 1 Raw Max
P0191 Fuel Pressure Sensor Operating
P0192 Fuel Pressure Sensor Raw Min
P0193 Fuel Pressure Sensor Raw Max
P0195 Oil Temperature Sensor Operating Min
P0196 Oil Temperature Sensor Operating Max
P0197 Oil Temperature Sensor Raw Min
P0198 Oil Temperature Sensor Raw Max
P0227 DBW Throttle 1 Throttle Position Sensor 1 Voltage Low
P0228 DBW Throttle 1 Throttle Position Sensor 1 Voltage High
P0237 Boost Pressure Sensor Raw Min
P0238 Boost Pressure Sensor Raw Max
P0242 Turbocharger Speed Sensor 2 Raw Max
P0243 Wastegate 1 Output 1 Over-current
P0244 Wastegate 1 Output 2 Over-current
P0245 Wastegate 1 Output 1 I/O Error
P0246 Wastegate 1 Output 2 I/O Error
P0247 Wastegate 2 Output 1 Over-current
P0248 Wastegate 2 Output 2 Over-current
P0249 Wastegate 2 Output 1 I/O Error
P0250 Wastegate 2 Output 2 I/O Error
P0261 Injector Output 1 Open Circuit (Not Connected)
P0262 Injector Output 1 Short Circuit
P0264 Injector Output 2 Open Circuit (Not Connected)
P0265 Injector Output 2 Short Circuit
P0267 Injector Output 3 Open Circuit (Not Connected)
P0268 Injector Output 3 Short Circuit
P0270 Injector Output 4 Open Circuit (Not Connected)
P0271 Injector Output 4 Short Circuit
P0273 Injector Output 5 Open Circuit (Not Connected)
P0274 Injector Output 5 Short Circuit
P0276 Injector Output 6 Open Circuit (Not Connected)
P0277 Injector Output 6 Short Circuit
P0279 Injector Output 7 / Aux Inj 1 Open Circuit (Not Connected)
P0280 Injector Output 7 / Aux Inj 1 Short Circuit
P0282 Injector Output 8 / Aux Inj 2 Open Circuit (Not Connected)
P0283 Injector Output 8 / Aux Inj 2 Short Circuit
P0285 Injector Output 9 / Aux Inj 3 Open Circuit (Not Connected)
P0286 Injector Output 9 / Aux Inj 3 Short Circuit
P0288 Injector Output 10 / Aux Inj 4 Open Circuit (Not Connected)
P0289 Injector Output 10 / Aux Inj 4 Short Circuit
P0328 Knock Sensor 1 Disconnected
P0332 Knock Sensor 2 Disconnected
P0373 Engine Position Error
P0462 Fuel Level Sensor Raw Min
P0463 Fuel Level Sensor Raw Max
P0470 Exhaust Pressure Sensor Malfunction
P0471 Exhaust Pressure Sensor Range/Performance
P0472 Exhaust Pressure Sensor Low
P0473 Exhaust Pressure Sensor High
P0500 Drive Train Speed Diagnostic
P0521 Oil Pressure Sensor Operating
P0522 Oil Pressure Sensor Raw Min
P0523 Oil Pressure Sensor Raw Max
P0524 Oil Pressure Switch
P0532 Air Conditioning Refrigerant Pressure Sensor Raw Min
P0533 Air Conditioning Refrigerant Pressure Sensor Raw Max
P0545 Exhaust Gas Temperature Sensor 1 Raw Min
P0546 Exhaust Gas Temperature Sensor 1 Raw Max
P0548 Exhaust Gas Temperature Sensor 2 Raw Min
P0549 Exhaust Gas Temperature Sensor 2 Raw Max
P0552 Power Steering Pressure Sensor Raw Min
P0553 Power Steering Pressure Sensor Raw Max
P0562 Battery Voltage Operating Min
P0563 Battery Voltage Operating Max
P0601 Internal Memory Check Sum Error Setting Journal First Entry Not Valid
P0602 Setting Journal Last Entry Not CRC
P0603 Setting Bad CRC Encountered
P0604 External RAM Bus Error
P0605 Setting Corruption
P0606 Coolant Level Sensor Raw Min
P0607 Coolant Level Sensor Raw Max
P0608 Oil Level Sensor Raw Min
P0609 Oil Level Sensor Raw Max
P0610 Coolant Level Low
P0611 Oil Level Low
P0612 Brake Fluid Level Low
P0613 Coolant Flow Not Detected
P061F DBW Throttle 1 Controller Performance
P0641 Sensor Reference Voltage ratio ref
P0642 Sensor Reference Voltage abs ref
P0643 Sensor Reference Voltage FPGA ref 1
P0651 Sensor Reference Voltage FPGA ref 2
P0652 Sensor Reference Voltage VREF neg 5V
P0653 Sensor Reference Voltage VREF neg 12V
P0668 ECU Temperature Low
P0669 ECU Temperature High
P0697 Sensor Reference Voltage VDD ref
P0698 Sensor Reference Voltage VAN 5V ref
P06A3 +5V Sensor Supply A Error
P06A4 +5V Sensor Supply B Error
P0711 Transmission Fluid Temperature Sensor Operating Max
P0712 Transmission Fluid Temperature Sensor Raw Min
P0713 Transmission Fluid Temperature Sensor Raw Max
P0831 Clutch Pressure Raw Min
P0832 Clutch Pressure Raw Max
P0841 Gearbox Line Pressure Operating Min
P0842 Gearbox Line Pressure Raw Min
P0843 Gearbox Line Pressure Raw Max
P0844 Gearbox Line Pressure Operating Max
P0846 Gearbox Torque Converter Pressure Operating Min
P0847 Gearbox Torque Converter Pressure Raw Min
P0848 Gearbox Torque Converter Pressure Raw Max
P0849 Gearbox Torque Converter Pressure Operating Max
P0933 Transfer Case Pressure Raw Min
P0934 Transfer Case Pressure Raw Max
P0935 Transfer Case Pressure Operating Max
P1164 ECU Internal Failure
P1165 Single Wideband Rx Timeout
P1166 Dual Wideband Box A Rx Timeout
P1167 ECU Internal Failure
P1168 ECU Internal Failure
P1169 ECU Internal Failure
P1170 ECU Internal Failure
P1171 ECU Internal Failure
P1172 ECU Internal Failure
P1276 Wideband 1 AFR Lean Trip
P1277 Wideband 2 AFR Lean Trip
P1278 Wideband 3 AFR Lean Trip
P1279 Wideband 4 AFR Lean Trip
P1300 Trigger Sync Error
P1301 Trigger Reference Error
P1302 No Home Error
P1303 Kill Switch Configuration Error
P1304 Flat Shift Configuration Error
P1305 Unknown Trigger Pattern
P1321 Exhaust Gas Temperature Sensor 1 Operating Max
P1322 Exhaust Gas Temperature Sensor 2 Operating Max
P1323 Exhaust Gas Temperature Sensor 3 Operating Max
P1324 Exhaust Gas Temperature Sensor 4 Operating Max
P1325 Exhaust Gas Temperature Sensor 5 Operating Max
P1326 Exhaust Gas Temperature Sensor 6 Operating Max
P1327 Exhaust Gas Temperature Sensor 7 Operating Max
P1328 Exhaust Gas Temperature Sensor 8 Operating Max
P1329 Exhaust Gas Temperature Sensor 9 Operating Max
P1330 Exhaust Gas Temperature Sensor 10 Operating Max
P1331 Exhaust Gas Temperature Sensor 11 Operating Max
P1332 Exhaust Gas Temperature Sensor 12 Operating Max
P1333 Exhaust Gas Temperature Sensor 6 Raw Min
P1334 Exhaust Gas Temperature Sensor 6 Raw Max
P1335 Exhaust Gas Temperature Sensor 7 Raw Min
P1336 Exhaust Gas Temperature Sensor 7 Raw Max
P1337 Exhaust Gas Temperature Sensor 8 Raw Min
P1338 Exhaust Gas Temperature Sensor 8 Raw Max
P1339 Exhaust Gas Temperature Sensor 9 Raw Min
P1340 Exhaust Gas Temperature Sensor 9 Raw Max
P1341 Exhaust Gas Temperature Sensor 10 Raw Min
P1342 Exhaust Gas Temperature Sensor 10 Raw Max
P1343 Exhaust Gas Temperature Sensor 11 Raw Min
P1344 Exhaust Gas Temperature Sensor 11 Raw Max
P1345 Exhaust Gas Temperature Sensor 12 Raw Min
P1346 Exhaust Gas Temperature Sensor 12 Raw Max
P1347 Nitrous Pressure Sensor 1 Raw Min
P1348 Nitrous Pressure Sensor 1 Raw Max
P1349 Real Time Clock Battery Circuit Low
P1350 Wastegate Pressure Sensor Raw Min
P1351 Wastegate Pressure Sensor Raw Max
P1352 Airconditioner Temperature Sensor Raw Min
P1353 Airconditioner Temperature Sensor Raw Max
P1354 Tumble Generator Valve 1 Sensor Raw Min
P1355 Tumble Generator Valve 1 Sensor Raw Max
P1356 Tumble Generator Valve 2 Sensor Raw Min
P1357 Tumble Generator Valve 2 Sensor Raw Max
P1358 Nitrous Pressure Sensor 2 Raw Min
P1359 Nitrous Pressure Sensor 2 Raw Max
P1360 Nitrous Pressure Sensor 3 Raw Min
P1361 Nitrous Pressure Sensor 3 Raw Max
P1362 Nitrous Pressure Sensor 4 Raw Min
P1363 Nitrous Pressure Sensor 4 Raw Max
P1370 Nitrous Controller 1 Initialisation Fault
P1371 Nitrous Controller 2 Initialisation Fault
P1372 Nitrous Controller 3 Initialisation Fault
P1373 Nitrous Controller 4 Initialisation Fault
P1374 Nitrous Controller 5 Initialisation Fault
P1375 Nitrous Controller 6 Initialisation Fault
P1376 CO2 Bottle Pressure Sensor - Voltage Low
P1377 CO2 Bottle Pressure Sensor - Voltage High
P1378 CO2 Bottle Pressure Sensor - Pressure Low
P1379 CO2 Bottle Pressure Sensor - Pressure High
P1380 Wideband O2 Sensor 5 Raw Min
P1381 Wideband O2 Sensor 5 Raw Max
P1382 Wideband 5 AFR Lean Trip
P1383 Wideband O2 Sensor 6 Raw Min
P1384 Wideband O2 Sensor 6 Raw Max
P1385 Wideband 6 AFR Lean Trip
P1386 Wideband O2 Sensor 7 Raw Min
P1387 Wideband O2 Sensor 7 Raw Max
P1388 Wideband 7 AFR Lean Trip
P1389 Wideband O2 Sensor 8 Raw Min
P1390 Wideband O2 Sensor 8 Raw Max
P1391 Wideband 8 AFR Lean Trip
P1392 Wideband O2 Sensor 9 Raw Min
P1393 Wideband O2 Sensor 9 Raw Max
P1394 Wideband 9 AFR Lean Trip
P1395 Wideband O2 Sensor 10 Raw Min
P1396 Wideband O2 Sensor 10 Raw Max
P1397 Wideband 10 AFR Lean Trip
P1398 Wideband O2 Sensor 11 Raw Min
P1399 Wideband O2 Sensor 11 Raw Max
P1400 Wideband 11 AFR Lean Trip
P1401 Wideband O2 Sensor 12 Raw Min
P1402 Wideband O2 Sensor 12 Raw Max
P1403 Wideband 12 AFR Lean Trip
P1404 Wastegate 1 Temperature Raw Min
P1405 Wastegate 1 Temperature Raw Max
P1406 Wastegate 1 Temperature Sensor Operating Max (too hot)
P1407 Wastegate 2 Temperature Raw Min
P1408 Wastegate 2 Temperature Raw Max
P1409 Wastegate 2 Temperature Sensor Operating Max (too hot)
P1410 Wastegate 1 Position Sensor I/O Error
P1411 Wastegate 2 Position Sensor I/O Error
P1412 Wastegate 1 Position Sensor voltage too low or too high
P1413 Wastegate 2 Position Sensor voltage too low or too high
P1414 Exhaust Cam sensor Bank 1 not detected
P1415 Exhaust Cam sensor Bank 2 not detected
P1416 Intake Cam sensor Bank 1 not detected
P1417 Intake Cam sensor Bank 2 not detected
P1534 Collision Detection (TAS) Signal Error
P1590 DBW Throttle 1 Throttle Position Sensor 1 Voltage Mismatch
P1591 DBW Throttle 1 Throttle Position Sensor 2 Voltage Mismatch
P1592 DBW Throttle 1 Pedal Position Sensor 1 Voltage Mismatch
P1593 DBW Throttle 1 Pedal Position Sensor 2 Voltage Mismatch
P1680 Oil Metering Pump Stepper Motor Malfunction - Low Flow
P1682 Oil Metering Pump Stepper Motor Malfunction - High Flow
P1684 Oil Metering Pump Sensor Raw Min
P1686 Oil Metering Pump Sensor Raw Max
P1687 Transfer Case Initialisation Fault
P1690 Injection Stage 1 90% Duty Cycle Exceeded
P1691 Injection Stage 2 90% Duty Cycle Exceeded
P1692 Injection Stage 3 90% Duty Cycle Exceeded
P1693 Injection Stage 4 90% Duty Cycle Exceeded
P1694 Crank Case Pressure Sensor Raw voltage too low
P1695 Crank Case Pressure Sensor Raw voltage too high
P1696 Crank Case Pressure Sensor Value too low
P1697 Crank Case Pressure Sensor Value too high
P1698 Main Setup (F4) Page Error
P1699 Transmission Input RPM Operating Max
P1700 Dual Wideband Box C Rx Timeout
P1701 Dual Wideband Box D Rx Timeout
P1702 Dual Wideband Box B Rx Timeout
P1800 Fuel Corrections can't be applied
P1900 Differential Temperature Sensor Raw Min
P1901 Differential Temperature Sensor Raw Max
P1910 Coolant Pressure Sensor Raw Min
P1911 Coolant Pressure Sensor Raw Max
P1912 IGN 1 Over Current
P1913 IGN 2 Over Current
P1914 IGN 3 Over Current
P1915 IGN 4 Over Current
P1916 IGN 5 Over Current
P1917 IGN 6 Over Current
P1918 IGN 7 Over Current
P1919 IGN 8 Over Current
P191A IGN 9 Over Current
P191B IGN 10 Over Current
P191C IGN 11 Over Current
P191D IGN 12 Over Current
P191E DPO 1 Over Current
P191F DPO 2 Over Current
P1920 DPO 3 Over Current
P1921 DPO 4 Over Current
P1922 DPO 5 Over Current
P1923 DPO 6 Over Current
P1924 DPO 7 Over Current
P1925 DPO 8 Over Current
P1926 HBO 1 Over Current
P1927 HBO 2 Over Current
P1928 HBO 3 Over Current
P1929 HBO 4 Over Current
P192A HBO 1 Max Retries Reached
P192B HBO 2 Max Retries Reached
P192C HBO 3 Max Retries Reached
P192D HBO 4 Max Retries Reached
P192E HCO8 1 Over Current
P192F HCO8 2 Over Current
P1930 HCO8 3 Over Current
P1931 HCO8 4 Over Current
P1932 HCO8 5 Over Current
P1933 HCO8 6 Over Current
P1934 HCO8 7 Over Current
P1935 HCO8 8 Over Current
P1936 HCO8 9 Over Current
P1937 HCO8 10 Over Current
P1938 HCO8 11 Over Current
P1939 HCO8 12 Over Current
P193A 8A High Current Output 1 Maximum Number of Retries Reached - Output Disabled
P193B 8A High Current Output 2 Maximum Number of Retries Reached - Output Disabled
P193C 8A High Current Output 3 Maximum Number of Retries Reached - Output Disabled
P193D 8A High Current Output 4 Maximum Number of Retries Reached - Output Disabled
P193E 8A High Current Output 5 Maximum Number of Retries Reached - Output Disabled
P193F 8A High Current Output 6 Maximum Number of Retries Reached - Output Disabled
P1940 8A High Current Output 7 Maximum Number of Retries Reached - Output Disabled
P1941 8A High Current Output 8 Maximum Number of Retries Reached - Output Disabled
P1942 8A High Current Output 9 Maximum Number of Retries Reached - Output Disabled
P1943 8A High Current Output 10 Maximum Number of Retries Reached - Output Disabled
P1944 8A High Current Output 11 Maximum Number of Retries Reached - Output Disabled
P1945 8A High Current Output 12 Maximum Number of Retries Reached - Output Disabled
P1946 25A High Current Output 1 Overcurrent
P1947 25A High Current Output 2 Overcurrent
P1948 25A High Current Output 3 Overcurrent
P1949 25A High Current Output 4 Overcurrent
P194A 25A High Current Output 1 Maximum Number of Retries Reached - Output Disabled
P194B 25A High Current Output 2 Maximum Number of Retries Reached - Output Disabled
P194C 25A High Current Output 3 Maximum Number of Retries Reached - Output Disabled
P194D 25A High Current Output 4 Maximum Number of Retries Reached - Output Disabled
P194E PDM Comms Error
P194F PDM Comms Error
P1950 PDM Comms Error
P1951 PDM Hardware Error - Battery Voltage Low
P1952 PDM Hardware Error - Battery Voltage High
P1953 PDM Hardware Error - Loss of Main Rail Saturation
P1954 PDM Hardware Error - SEPIC Voltage Low
P1955 PDM Hardware Error - SEPIC Voltage High
P1956 PDM Hardware Error - ECU Voltage Low
P1957 PDM Hardware Error - ECU Voltage High
P1958 PDM Hardware Error - ECU Current High
P1959 PDM Hardware Error - Boost Voltage Low
P195A PDM Hardware Error - Bandgap Voltage Low
P195B PDM Hardware Error - Bandgap Voltage High
P195C PDM Hardware Error - UVLO Flagged
P195D PDM Hardware Error - CPU Temp Low
P195E PDM Hardware Error - CPU Temp High
P195F PDM Hardware Error - TVS Temp Low
P1960 PDM Hardware Error - TVS Temp High
P1961 PDM Hardware Error - Rail Temp Low
P1962 PDM Hardware Error - Rail Temp High
P1963 PDM Hardware Error - HCO25 Pins 1 and 2 Temp Low
P1964 PDM Hardware Error - HCO25 Pins 1 and 2 Temp High
P1965 PDM Hardware Error - HCO25 Pins 3 and 4 Temp Low
P1966 PDM Hardware Error - HCO25 Pins 3 and 4 Temp High
P1967 PDM Hardware Error - Ambient Board Temp Low
P1968 PDM Hardware Error - Ambient Board Temp High
P1969 PDM Hardware Error - Reverse Polarity Protection Failure
P196A Internal Wideband Comms Error
P196B Internal Wideband Comms Error
P196C Internal Wideband Comms Error
P196D PD-16 Box A - Timeout
P196E PD-16 Box A - Battery Voltage Low
P196F PD-16 Box A - Battery Voltage High
P1970 PD-16 Box A - SEPIC Voltage Low
P1971 PD-16 Box A - Exceeded Maximum Current
P1972 PD-16 Box A - Boost Voltage Low
P1973 PD-16 Box A - Internal Temperature Warning
P1974 PD-16 Box A - Internal Temperature Shutdown
P1995 PD-16 Box B - Timeout
P1996 PD-16 Box B - Battery Voltage Low
P1997 PD-16 Box B - Battery Voltage High
P1998 PD-16 Box B - SEPIC Voltage Low
P1999 PD-16 Box B - Exceeded Maximum Current
P199A PD-16 Box B - Boost Voltage Low
P199B PD-16 Box B - Internal Temperature Warning
P199C PD-16 Box B - Internal Temperature Shutdown
P19BD PD-16 Box C - Timeout
P19BE PD-16 Box C - Battery Voltage Low
P19BF PD-16 Box C - Battery Voltage High
P19C0 PD-16 Box C - SEPIC Voltage Low
P19C1 PD-16 Box C - Exceeded Maximum Current
P19C2 PD-16 Box C - Boost Voltage Low
P19C3 PD-16 Box C - Internal Temperature Warning
P19C4 PD-16 Box C - Internal Temperature Shutdown
P19E5 PD-16 Box D - Timeout
P19E6 PD-16 Box D - Battery Voltage Low
P19E7 PD-16 Box D - Battery Voltage High
P19E8 PD-16 Box D - SEPIC Voltage Low
P19E9 PD-16 Box D - Exceeded Maximum Current
P19EA PD-16 Box D - Boost Voltage Low
P19EB PD-16 Box D - Internal Temperature Warning
P19EC PD-16 Box D - Internal Temperature Shutdown
P1A15 Sensor ground loop detected
P1A53 External dash timeout
P2032 Exhaust Gas Temperature Sensor 3 Raw Min
P2033 Exhaust Gas Temperature Sensor 3 Raw Max
P2035 Exhaust Gas Temperature Sensor 4 Raw Min
P2036 Exhaust Gas Temperature Sensor 4 Raw Max
P2109 DBW Throttle 1 Disabled
P2113 DBW Throttle 1 TPS Tracking Error
P2114 DBW Throttle 1 ECU Demand Error
P2116 DBW Throttle 1 TPS Tracking Error Redundancy
P2122 DBW Throttle 1 Throttle Position Sensor 2 Voltage Low
P2123 DBW Throttle 1 Throttle Position Sensor 2 Voltage High
P2127 DBW Throttle 1 Pedal Position Sensor 1 Voltage Low
P2128 DBW Throttle 1 Pedal Position Sensor 1 Voltage High
P2132 DBW Throttle 1 Pedal Position Sensor 2 Voltage Low
P2133 DBW Throttle 1 Pedal Position Sensor 2 Voltage High
P2135 DBW Throttle 1 Throttle Position Sensor Voltage Correlation
P2136 DBW Throttle 1 Throttle Position Sensor Voltage Correlation Redundancy
P2138 DBW Throttle 1 Pedal Position Sensor Voltage Correlation
P2139 DBW Throttle 1 Pedal Position Sensor Voltage Correlation Redundancy
P2146 Injector Output 11 / Aux Inj 5 Open Circuit (Not Connected)
P2147 Injector Output 11 Short Circuit
P2148 Aux Inj 5 Short Circuit
P2149 Injector Output 12 / Aux Inj 6 Open Circuit (Not Connected)
P2150 Injector Output 12 Short Circuit
P2151 Aux Inj 6 Short Circuit
P2152 Injector Output 13 / Aux Inj 7 Open Circuit (Not Connected)
P2153 Injector Output 13 Short Circuit
P2154 Aux Inj 7 Short Circuit
P2155 Injector Output 14 / Aux Inj 8 Open Circuit (Not Connected)
P2156 Injector Output 14 Short Circuit
P2157 Aux Inj 8 Short Circuit
P2163 DBW Throttle 1 Relaxed TPS Tracking PPS Settings
P2164 DBW Throttle 1 Relaxed TPS Modifiers Settings
P2165 DBW Throttle 1 Relaxed Sensor Mismatch Settings
P2166 DBW Throttle 1 Redundancy Flag
P2167 DBW Throttle 1 Redundancy Data Error
P2168 DBW Throttle 1 Redundancy Pedal Position Error
P2169 DBW Throttle 1 Redundancy Idle Offset Error
P216A Injector Output 15 Open Circuit (Not Connected)
P216B Injector Output 15 Short Circuit
P216D Injector Output 16 Open Circuit (Not Connected)
P216E Injector Output 16 Short Circuit
P217A Injector Output 17 Open Circuit (Not Connected)
P217B Injector Output 17 Short Circuit
P217D Injector Output 18 Open Circuit (Not Connected)
P217E Injector Output 18 Short Circuit
P2228 Barometric Pressure Sensor Raw Min
P2229 Barometric Pressure Sensor Raw Max
P242C Exhaust Gas Temperature Sensor 5 Raw Min
P242D Exhaust Gas Temperature Sensor 5 Raw Max
P2581 Turbocharger Speed Sensor 1 Raw Max
P2A00 Wideband 1 Sensor Failure
P2A01 Wideband 2 Sensor Failure
P2A02 Wideband 3 Sensor Failure
P2A03 Wideband 4 Sensor Failure
P2A04 Wideband 5 Sensor Failure
P2A05 Wideband 6 Sensor Failure
P2A06 Wideband 7 Sensor Failure
P2A07 Wideband 8 Sensor Failure
P2A08 Wideband 9 Sensor Failure
P2A09 Wideband 10 Sensor Failure
P2A10 Wideband 11 Sensor Failure
P2A11 Wideband 12 Sensor Failure
P2A20 DBW Throttle 2 Throttle Position Sensor 1 Voltage Low
P2A21 DBW Throttle 2 Throttle Position Sensor 1 Voltage High
P2A22 DBW Throttle 2 Throttle Position Sensor 2 Voltage Low
P2A23 DBW Throttle 2 Throttle Position Sensor 2 Voltage High
P2A24 DBW Throttle 2 Throttle Position Sensor Voltage Correlation
P2A25 DBW Throttle 2 Throttle Position Sensor Voltage Correlation Redundancy
P2A26 DBW Throttle 2 Motor Duty Cycle Constant 100%
P2A27 DBW Throttle 2 Throttle Position Sensor 1 Voltage Mismatch
P2A28 DBW Throttle 2 Throttle Position Sensor 2 Voltage Mismatch
P2A29 DBW Throttle 2 TPS Tracking Error
C0615 Shock Travel Sensor Front Left Raw Low
C0620 Shock Travel Sensor Front Right Raw Low
C0625 Shock Travel Sensor Rear Left Raw Low
C0630 Shock Travel Sensor Rear Right Raw Low
C1020 Brake Pressure Sensor Raw Min
C1021 Brake Pressure Sensor Raw Max
C1022 Right Front Wheel Speed Error
C1024 Left Front Wheel Speed Error
C1026 Right Rear Wheel Speed Error
C1028 Left Rear Wheel Speed Error
C1029 Wheel Speed Mismatch
C1030 Steering Angle Sensor Raw Min
C1031 Steering Angle Sensor Raw Max
C1032 Yaw Sensor Raw Min
C1033 Yaw Sensor Raw Max
C1034 Lateral G Sensor Raw Min
C1035 Lateral G Sensor Raw Max
C1036 Fuel Tank Pressure Sensor Raw Min
C1037 Fuel Tank Pressure Sensor Raw Max
C1038 Longitudinal G Sensor Raw Min
C1039 Longitudinal G Sensor Raw Max
C1040 Knock Light Initialisation Error
C1050 Driveshaft RPM Sensor Operating Max
C1292 Brake Pressure Rear Sensor Raw Min
C1296 Brake Pressure Rear Sensor Raw Max
C1760 Shock Travel Sensor Front Left Raw High
C1761 Shock Travel Sensor Front Right Raw High
C1762 Shock Travel Sensor Rear Left Raw High
C1763 Shock Travel Sensor Rear Right Raw High
C1800 Ride Height Sensor Front Raw Low
C1801 Ride Height Sensor Front Raw High
C1802 Ride Height Sensor Rear Raw Low
C1803 Ride Height Sensor Rear Raw High
U1020 I/O-12 (Box A) - Comms Error (RX)
U1021 I/O-12 (Box A) - Comms Error (TX)
U1022 I/O-12 (Box B) - Comms Error (RX)
U1023 I/O-12 (Box B) - Comms Error (TX)
U1026 TCA-2 (Box A) - Comms Error (RX)
U1027 TCA-2 (Box B) - Comms Error (RX)
U1028 TCA-4 (Box A) - Comms Error (RX)
U1029 TCA-4 (Box B) - Comms Error (RX)
U1030 I/O-12 (Box A) - Duplicate ID Error
U1031 I/O-12 (Box A) - Hardware Failure
U1032 I/O-12 (Box A) - Firmware Erased Error
U1033 I/O-12 (Box A) - Internal Error
U1034 I/O-12 (Box A) - Internal Error
U1040 I/O-12 (Box B) - Duplicate ID Error
U1041 I/O-12 (Box B) - Hardware Failure
U1042 I/O-12 (Box B) - Firmware Erased Error
U1043 I/O-12 (Box B) - Internal Error
U1044 I/O-12 (Box B) - Internal Error
U1050 TCA-2 (Box A) - Duplicate ID Error
U1051 TCA-2 (Box A) - Hardware Failure
U1052 TCA-2 (Box A) - Firmware Erased Error
U1053 TCA-2 (Box A) - Internal Error
U1054 TCA-2 (Box A) - Internal Error
U1060 TCA-2 (Box B) - Duplicate ID Error
U1061 TCA-2 (Box B) - Hardware Failure
U1062 TCA-2 (Box B) - Firmware Erased Error
U1063 TCA-2 (Box B) - Internal Error
U1064 TCA-2 (Box B) - Internal Error
U1070 TCA-4 (Box A) - Duplicate ID Error
U1071 TCA-4 (Box A) - Hardware Failure
U1072 TCA-4 (Box A) - Firmware Erased Error
U1073 TCA-4 (Box A) - Internal Error
U1074 TCA-4 (Box A) - Internal Error
U1080 TCA-4 (Box B) - Duplicate ID Error
U1081 TCA-4 (Box B) - Hardware Failure
U1082 TCA-4 (Box B) - Firmware Erased Error
U1083 TCA-4 (Box B) - Internal Error
U1084 TCA-4 (Box B) - Internal Error
U1130 Wideband (Box A) - Duplicate ID Error
U1131 Wideband (Box A) - Comms Error (RX)
U1132 RTC Failure
U1133 Wideband (Single Channel) - Comms Error (RX)
U1134 ECU Internal Failure
U1135 ECU Internal Failure
U1136 ECU Internal Failure
U1137 ECU Internal Failure
U1138 ECU Internal Failure
U1140 ECU Internal Failure
U1141 ECU Internal Failure
U1145 ECU Internal Failure
U1146 ECU Internal Failure
U1147 ECU Internal Failure
U1150 ECU Internal Failure
U1151 ECU Internal Failure
U1152 ECU Internal Failure
U1154 ECU Internal Failure
U1157 CAN bus initialisation error
U1159 ECU Internal Failure
U1160 ECU Internal Failure
U1161 ECU Internal Failure
U1162 ECU Internal Failure
U1163 ECU Internal Failure
U1164 Traction Control Initialisation Failure
U1165 Rolling Anti-lag Initialisation Failure
U1174 Race Expansion Module Injection Driver RX 1 Not Connected
U1175 Race Expansion Module Injection Driver RX 2 Not Connected
U1176 Race Expansion Module Injection Driver RX 3 Not Connected
U1177 Race Expansion Module Injection Driver RX 1 Bad Event
U1178 Race Expansion Module Injection Driver RX 2 Bad Event
U1179 Race Expansion Module Injection Driver RX 3 Bad Event
U1180 Race Expansion Module Injector 1 Pulse Collision
U1181 Race Expansion Module Injector 2 Pulse Collision
U1182 Race Expansion Module Injector 3 Pulse Collision
U1183 Race Expansion Module Injector 4 Pulse Collision
U1184 Race Expansion Module Injector 5 Pulse Collision
U1185 Race Expansion Module Injector 6 Pulse Collision
U1186 Race Expansion Module Injector 7 Pulse Collision
U1187 Race Expansion Module Injector 8 Pulse Collision
U1188 Torque Management Initialisation Failure
U1189 Race Expansion Module Initialisation Failure
U1190 Race Expansion Module Not Found
U1191 Race Expansion Module Comms Timeout - ECU to REM
U1192 Race Expansion Module Comms Timeout - REM to ECU
U1193 Race Expansion Module Watchdog Signal Lost
U1194 Race Expansion Module Injector Output 1 Open Circuit (Not Connected)
U1195 Race Expansion Module Injector Output 1 Short Circuit
U1196 Race Expansion Module Injector Output 2 Open Circuit (Not Connected)
U1197 Race Expansion Module Injector Output 2 Short Circuit
U1198 Race Expansion Module Injector Output 3 Open Circuit (Not Connected)
U1199 Race Expansion Module Injector Output 3 Short Circuit
U1200 Race Expansion Module Injector Output 4 Open Circuit (Not Connected)
U1201 Race Expansion Module Injector Output 4 Short Circuit
U1202 Race Expansion Module Injector Output 5 Open Circuit (Not Connected)
U1203 Race Expansion Module Injector Output 5 Short Circuit
U1204 Race Expansion Module Injector Output 6 Open Circuit (Not Connected)
U1205 Race Expansion Module Injector Output 6 Short Circuit
U1206 Race Expansion Module Injector Output 7 Open Circuit (Not Connected)
U1207 Race Expansion Module Injector Output 7 Short Circuit
U1208 Race Expansion Module Injector Output 8 Open Circuit (Not Connected)
U1209 Race Expansion Module Injector Output 8 Short Circuit
U1210 Race Expansion Module Firmware Update Required via USB
U1211 Datalogger Memory Error
U1212 Cruise Control Initialisation Failure
U1213 Cruise Control Redundancy Error
U1214 ECU Internal Failure
U1215 TCA-8 Box - Hardware Failure
U1216 TCA-8 Box - Firmware Erased Error
U1217 TCA-8 Box - Internal Error
U1218 TCA-8 Box - Internal Error
U1219 TCA-8 Box - Duplicate ID Error
U1220 TCA-8 Box - Comms Error (RX)
U1221 TMS-4 Rx Timeout
`;

export const DTC_NAMES = Object.fromEntries(
  DTC_INDEX.trim().split('\n').map(line => {
    const i = line.indexOf(' ');
    return [line.slice(0, i), line.slice(i + 1)];
  }));

/** 'P0641 — Sensor Reference Voltage ratio ref', or just 'P0641' if unlisted. */
export function dtcLabel(n) {
  const code = dtcCode(n);
  if (!code) return null;
  return DTC_NAMES[code] ? code + ' — ' + DTC_NAMES[code] : code;
}

const CEL_SOLID_S = 1.0;   // an episode this long or longer reads as a steady lamp

/* Cause codes that have never once driven the lamp, used ONLY when a log omits
 * `Check Engine Light Output State` — the ECU-download `Log####.csv` files all
 * do, and they are the only logs that cover a run rather than a bench session.
 *
 * This is not a guess and not a meaning: it is a tally. Every log on hand that
 * carries BOTH channels was swept on 2026-08-22 — 23 logs, 13 of which use
 * these codes — and codes 0 and 1 came to 43,921 samples with the lamp dark and
 * not one sample with it lit. Codes 2, 4 and 5 never appear dark. Code 5 is
 * worth noting as the reason this is a per-code set and not a per-sample rule:
 * its lamp BLINKS, ~22% duty inside a single unbroken code-5 run, so a code can
 * be dark in a given sample and still be a fault.
 *
 * Re-run the sweep before adding to this — a code belongs here only once a log
 * that can actually see the lamp has watched it stay dark. */
export const CEL_DARK_CODES = new Set([0, 1]);

/* Cause codes named from evidence rather than from the ECU. NSP ships the cause
 * enum's labels encrypted, so celCauses() normally names an episode from the DTC
 * channel and falls back to a bare code number when nothing was flagged. These
 * are the codes identified instead from what the engine was doing at the time.
 *
 *   2 — engine off. Confirmed on AutoLog_2026-08-15_0319pm.csv: the lamp lights
 *       the instant the engine stops (524 of that episode's 525 samples at 0 rpm,
 *       Engine Running Time 0, throttle 0, MAP atmospheric, battery decaying
 *       12.7 -> 11.8 V on a key-on) and on AutoLog_2026-08-15_1239pm.csv it goes
 *       out the instant the engine restarts. With the ECU's CEL activation
 *       criteria set to Current DTCs only, a stopped engine genuinely has current
 *       faults — no engine position, the wideband not reporting — so this is
 *       ordinary key-on lamp behaviour and not a fault to chase.
 *
 *   7 — Wideband 1 AFR lean trip, P1276, AND an active engine-protection
 *       state. Named from Danie's NSP readout on 2026-08-22: NSP showed P1276
 *       "Wideband 1 AFR Lean Trip" for that session, and code 7 is the only
 *       cause code the session's logs carry besides the idle 1. It appears
 *       twice, Log3097 t=1.063 s and Log3101 t=1.865 s.
 *
 *       **The ECU intervenes on the same sample, on three actuators at once**,
 *       and the numbers are configured ones, identical to the digit in both:
 *         Ignition Correction Total      -5.00 deg, in ONE sample
 *         Target Lambda                  -0.070 (0.782 -> 0.712)
 *         Boost Control Solenoid Duty    60-64% -> 0.0%, target pressure
 *                                        unchanged at 336 kPa
 *       Knock correction is 0.0 either side and knock level 0.0, so the retard
 *       is not knock control. Those are exactly the three levers the
 *       `Engine Protection Ignition Retard` / `Lambda Fuel Enrichment` /
 *       `Boost Correction` channels report — and the retard and the boost cut
 *       then HOLD, -5.0 deg and 0.0% to the last sample of both logs, latched
 *       in lockstep with the code. Searching all 16 of the day's logs for that
 *       three-actuator step finds it twice, both at a code-7 onset.
 *
 *       Careful with the direction of that. The enrichment is the protection
 *       RESPONSE to a lean reading, not a commanded change the wideband failed
 *       to follow — an earlier reading of this note had it backwards. Measured
 *       against the pre-step target the engine was +0.077 (Log3097) and +0.117
 *       (Log3101) lambda lean of target.
 *
 *       No 448-channel log covers those runs, so `Latest flagged DTC` never saw
 *       it and the name cannot be read out of the data; this is the readout
 *       plus that correlation, gated below like the engine-off name is.
 *
 *   4 — the sensor 5V reference, P0641 / P0642. Every code-4 episode in every
 *       log that ALSO carries the DTC channels is one of those two and nothing
 *       else: 9 episodes across the four 2026-08-15 logs, each either flagging
 *       or clearing P0641 "Sensor Reference Voltage ratio ref" or P0642
 *       "...abs ref", or too short to capture either. All are flickers, 4-19
 *       samples. Both codes watch the same rail — one the ratiometric check,
 *       one the absolute — so which of the pair fired is NOT recoverable
 *       without the DTC channel, and the label names both rather than guessing.
 *       In Log3097 the rail steps 5.116 -> 5.122 V one sample before the code,
 *       and sits 108-128 mV above nominal all log against P0641's published
 *       +/-10 mV window. See [[haltune-p0641-root-cause]] for the chase. */
export const CEL_CAUSE_NAMES = {
  2: 'Engine off',
  4: 'Sensor 5V reference (P0641/P0642)',
  7: 'Wideband 1 AFR lean trip (P1276)',
};

/* A name we claim for a cause code still has to survive the log it is printed
 * against. "Engine off" beside a trace sitting at 3,000 rpm would be worse than
 * the bare number, which is at least honest about not knowing — so the name is
 * applied only where the log's own RPM agrees, and the table says so when it
 * does not. One stale sample as the engine dies is expected: RPM and Engine
 * Running Time both lag the cause code by a sample at shutdown. */
const CEL_STOPPED_RPM = 50;      // below this the engine is not turning
const CEL_STOPPED_SHARE = 0.9;   // of an episode's samples, to accept the name

/* The lean gate for code 7 works on the sample the code FIRST appears on, not
 * on the episode: a lean trip latches, so the excursion that set it is at the
 * front and everything after it is whatever the driver did next — in both
 * 08-22 episodes the lamp stays on through the lift, where the wideband runs
 * to lambda 1.7 on overrun and would flatter any whole-episode test.
 *
 * 0.10 lambda is a SANITY BOUND, not a detector. Idle-code stretches in the
 * same logs reach +0.15 lambda transiently, so this cannot tell a lean trip
 * from ordinary transient error and is not trying to; it exists to withhold
 * the name if code 7 ever turns up over an engine running AT or RICHER than
 * target, which would mean the code means something else.
 *
 * Read at that first sample the two real trips measure +0.144 and +0.187
 * lambda — but note WHAT that is measured against: protection has already
 * enriched the target by 0.070 on the same sample, so the gate is reading the
 * post-intervention target and is a weaker filter than those figures suggest.
 * Against the pre-step target the excursions were +0.077 and +0.117. The
 * threshold is deliberately not tightened onto either pair; the specific test
 * for this code is the three-actuator protection signature below. */
const CEL_LEAN_LAMBDA = 0.10;

/* Engine protection inferred from what the ECU DID, for logs that carry no
 * `Engine Protection *` channels — which is every ECU-download Log####.csv,
 * i.e. every log that covers an actual run. Without this the Engine prot.
 * column reads "—" on precisely the row where protection demonstrably fired.
 *
 * The signature is one sample in which three unrelated actuators all move the
 * protective way at once: ignition pulled, boost solenoid dropped, target
 * lambda enriched. Any one alone is ordinary — across the 16 logs of
 * 2026-08-22 the ignition step alone hits 11 samples and the boost collapse 18
 * — but all three together hit exactly 2, both at a code-7 onset. Thresholds
 * sit well inside the observed steps (-5.00 deg, -0.070 lambda, 60% -> 0%) so
 * a softer intervention still registers. */
const PROT_IGN_DROP = 3.0;        // deg of total ignition correction, one sample
const PROT_BOOST_FROM = 30;       // % solenoid duty before
const PROT_BOOST_TO = 5;          // % solenoid duty after
const PROT_LAMBDA_ENRICH = 0.03;  // lambda, richer

/* The gate for code 4: is the sensor 5V reference actually off nominal. The
 * tolerance is P0641's own published trip window, +/-10 mV about 5.000 V. On
 * this car the rail never comes inside it, so in practice the gate always
 * passes here — it is a sanity bound like the lean one, there to withhold the
 * name on a car whose reference is healthy, not to detect the fault. */
const REF_RAIL_NOMINAL = 5.0;
const REF_RAIL_TOL = 0.010;

/**
 * Which check-engine-light causes fired, how often, and whether the lamp
 * flickered or sat on. Returns finished display strings so this table and the
 * artifact's cannot disagree, the same contract as dragTable().
 *
 * Rows are grouped by (cause code, the DTCs seen during it) and **only causes
 * that actually lit the lamp are listed**. The idle code is not dropped by
 * hardcoding a value — it is whatever code the Output State channel says never
 * lit anything, and it goes in the footnote. Hardcoding 0 as "no cause" would
 * have been wrong here: this ECU never emits 0, and its no-fault code is 1.
 *
 * Events are EPISODES, one contiguous run of a code — never samples. At ~18 Hz
 * a fault held for two seconds would otherwise tally as thirty-odd faults.
 */
export function celCauses(log) {
  const cause = col(log, 'Check Engine Light Cause');
  if (cause < 0) return { available: false, reason: 'no Check Engine Light Cause channel in this log' };
  const rows = log.rows;
  if (!rows.length) return { available: false, reason: 'log has no rows' };

  /* Seconds from the start of the log, to three places — the SAME axis every
   * graph on both surfaces is drawn against, so an event time can be read
   * straight across to a trace. An earlier version showed the ECU wall clock
   * here; it is the more useful number inside NSP but it does not line up with
   * anything on this page, which is where someone is actually reading it. The
   * clock is still reported once, in the footnote, so the NSP crossover is not
   * lost. */
  const clock0 = Number.isFinite(log.startClock) ? log.startClock : null;
  const at = t => t.toFixed(3) + ' s';
  const hhmmss = s => {
    const v = ((s % 86400) + 86400) % 86400;
    return String(Math.floor(v / 3600)).padStart(2, '0') + ':'
      + String(Math.floor((v % 3600) / 60)).padStart(2, '0') + ':'
      + (v % 60).toFixed(1).padStart(4, '0');
  };

  const light = col(log, 'Check Engine Light Output State');
  const flagged = col(log, 'Latest flagged DTC');
  const clearedCol = col(log, 'Latest cleared DTC');
  const epSev = col(log, 'Engine Protection Severity Level');
  const epCause = col(log, 'Engine Protection Cause');
  const hasProt = epSev >= 0 || epCause >= 0;
  const rpmCol = col(log, 'RPM');
  const wbCol = col(log, 'Wideband O2 1', 'Wideband Maximum');
  const tgtCol = col(log, 'Target Lambda');
  const railCol = col(log, 'Diagnostic Analogue 5V rail');
  const ignCorrCol = col(log, 'Ignition Correction Total');
  const bstDutyCol = col(log, 'Boost Control Solenoid Duty Cycle');

  /* Samples during which engine protection is intervening, derived from the
   * actuators when the ECU's own protection channels are absent. See
   * PROT_IGN_DROP for why all three levers together are the test.
   *
   * Once engaged it is treated as HELD until the ECU visibly gives it back —
   * boost control resuming AND the ignition correction climbing back to where
   * it was — because that is what both 08-22 logs show: -5.0 deg and 0.0% duty
   * unbroken from the trip to the last sample, through the lift, the overrun
   * and back down to idle. A step-only test would have marked one sample. */
  const canDeriveProt = !hasProt && ignCorrCol >= 0 && bstDutyCol >= 0 && tgtCol >= 0;
  const protSamples = (() => {
    if (!canDeriveProt) return null;
    const active = new Array(rows.length).fill(false);
    let held = false, baseIgn = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1].values, b = rows[i].values;
      const step = b[ignCorrCol] - a[ignCorrCol] <= -PROT_IGN_DROP
        && a[bstDutyCol] > PROT_BOOST_FROM && b[bstDutyCol] < PROT_BOOST_TO
        && b[tgtCol] - a[tgtCol] <= -PROT_LAMBDA_ENRICH;
      if (step) { held = true; baseIgn = a[ignCorrCol]; }
      else if (held && b[bstDutyCol] > PROT_BOOST_FROM && b[ignCorrCol] >= baseIgn) held = false;
      active[i] = held;
    }
    return active;   // all-false is a real answer — "checked, nothing intervened"
  })();

  // contiguous runs of one code
  const eps = [];
  for (let i = 0, s = 0; i <= rows.length; i++) {
    if (i === rows.length || rows[i].values[cause] !== rows[s].values[cause]) {
      eps.push({ code: rows[s].values[cause], i0: s, i1: i - 1, t0: rows[s].t, t1: rows[i - 1].t });
      s = i;
    }
  }

  const samplesOf = e => rows.slice(e.i0, e.i1 + 1);

  function faultFor(e, rs) {
    if (flagged < 0) return { dtcs: [], inferred: false };
    const seen = [...new Set(rs.map(r => r.values[flagged]).filter(v => Number.isFinite(v) && v > 0))];
    if (seen.length) return { dtcs: seen.sort((a, b) => a - b), inferred: false };
    if (clearedCol < 0) return { dtcs: [], inferred: false };
    const before = e.i0 > 0 ? rows[e.i0 - 1].values[clearedCol] : NaN;
    const window = rows.slice(e.i0, Math.min(e.i1 + 2, rows.length)).map(r => r.values[clearedCol]);
    const moved = [...new Set(window.filter(v => Number.isFinite(v) && v > 0 && v !== before))];
    if (moved.length) return { dtcs: moved.sort((a, b) => a - b), inferred: false };
    if (Number.isFinite(before) && before > 0 && window.every(v => v === before))
      return { dtcs: [before], inferred: true };
    return { dtcs: [], inferred: false };
  }

  for (const e of eps) {
    const rs = samplesOf(e);
    e.n = rs.length;
    e.seconds = e.t1 - e.t0;
    e.atEnd = e.i1 === rows.length - 1;
    e.lit = light >= 0 ? rs.some(r => r.values[light] === 1) : null;
    /* Attributed to an episode by its FIRST sample, or by a majority of it —
     * not by "any sample", which would blame the wrong code. In Log3097 the
     * intervention lands on the last of code 4's four samples, one before
     * code 7 begins; "any" would report protection against code 4, which held
     * for 16 ms and did nothing, as well as against the code that owns it. */
    e.protection = hasProt
      ? rs.some(r => (epSev >= 0 && r.values[epSev] > 0) || (epCause >= 0 && r.values[epCause] !== 0))
      : protSamples
        ? protSamples[e.i0] || protSamples.slice(e.i0, e.i1 + 1).filter(Boolean).length * 2 > rs.length
        : null;
    /* Which fault lit the lamp, in order of how directly the log says so.
     *
     * 1. A DTC flagged INSIDE the episode. Only inside: a code flagged a sample
     *    earlier while the lamp was still dark could be a fault that cleared
     *    just before the lamp lit, and would be blamed for the wrong event.
     *
     * 2. Failing that, `Latest cleared DTC`. The lamp going out means the fault
     *    cleared, and that channel latches the most recent clear — verified on
     *    2026-08-15, where it moved 1602 -> 1601 exactly when P0641 cleared and
     *    at no other point in a 174 s log. So if it CHANGED across the episode,
     *    the value it changed to is the fault.
     *
     * 3. If it did not change and already held a code, that code is still the
     *    answer, by elimination: any OTHER fault clearing would have moved it.
     *    This is how a fault that flags and clears between two log samples is
     *    still named. Marked inferred, because it is a deduction from what did
     *    not happen rather than a reading. */
    const d = faultFor(e, rs);
    e.dtcs = d.dtcs;
    e.inferred = d.inferred;
  }

  /* Without the Output State channel there is nothing IN THE LOG to say which
   * code means "nothing wrong", so it comes from the reference set above.
   *
   * This used to take the code holding the most samples as the idle one, and
   * that is exactly backwards for a LATCHING fault: it lights partway through
   * and holds to the end, so it owns most of the log and the real idle code
   * owns the short lead-in. On 2026-08-22 that inverted the table on the two
   * ECU-download logs that mattered — code 7 held 915 and 953 samples and was
   * written off as the idle state, while the genuinely quiet code 1 was tabled
   * as the fault, and a check-engine light Danie had watched NSP report simply
   * did not appear. The most-common rule survives only where the reference set
   * recognises nothing in the log, which is the one case it is the only signal
   * available. */
  let assumedIdle = false, refIdle = false;
  if (light < 0) {
    const codes = [...new Set(eps.map(e => e.code))];
    if (codes.some(c => CEL_DARK_CODES.has(c))) {
      for (const e of eps) e.lit = !CEL_DARK_CODES.has(e.code);
      refIdle = true;
    } else {
      const tally = new Map();
      for (const e of eps) tally.set(e.code, (tally.get(e.code) || 0) + e.n);
      const idle = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for (const e of eps) e.lit = e.code !== idle;
      assumedIdle = true;
    }
  }

  /* ONE ROW PER CAUSE CODE — the same thing the graph steps between.
   *
   * This used to key on (code, DTC), which split one code across two rows when
   * only some of its events could be named, and produced a table that read as
   * two different faults where the trace plainly showed one code firing twice.
   * The graph is the thing being explained; a table that cannot be laid over it
   * is worse than a coarser one. Faults found across the group's events are
   * listed together in the label instead. */
  const groups = new Map();
  for (const e of eps.filter(x => x.lit)) {
    if (!groups.has(e.code)) groups.set(e.code, { code: e.code, eps: [] });
    groups.get(e.code).eps.push(e);
  }

  /* A name in CEL_CAUSE_NAMES still has to survive the log it is printed
   * against, so each named code carries a gate. A gate returns true (the log
   * agrees), false (the log contradicts it — withhold the name and say so) or
   * **null**, which means the log carries nothing to check it with. Null and
   * false are not the same answer: only a contradiction should cost the name.
   * A code with no gate is accepted as named. */

  /* Share of a group's samples with the engine not turning — the engine-off
   * gate. One stale sample as the engine dies is expected, so it is a share and
   * not an all-must-agree test. */
  const stoppedGate = eps2 => {
    if (rpmCol < 0) return null;
    let n = 0, stopped = 0;
    for (const e of eps2)
      for (let i = e.i0; i <= e.i1; i++) {
        const v = rows[i].values[rpmCol];
        if (!Number.isFinite(v)) continue;
        n++;
        if (v < CEL_STOPPED_RPM) stopped++;
      }
    return n ? stopped / n >= CEL_STOPPED_SHARE : null;
  };

  /* Was the engine actually lean where the code appeared — the lean-trip gate.
   * Read at each episode's FIRST sample, because a lean trip latches: the
   * excursion that set it is at the front, and the rest of the episode is
   * whatever happened next. One qualifying episode is enough; the row covers
   * the code, not any single event. See CEL_LEAN_LAMBDA for why this is a
   * sanity bound rather than a detector. */
  const leanGate = eps2 => {
    if (wbCol < 0 || tgtCol < 0) return null;
    let checked = 0;
    for (const e of eps2) {
      const wb = rows[e.i0].values[wbCol], tgt = rows[e.i0].values[tgtCol];
      if (!Number.isFinite(wb) || !Number.isFinite(tgt) || tgt <= 0) continue;
      checked++;
      if (wb - tgt >= CEL_LEAN_LAMBDA) return true;
    }
    return checked ? false : null;
  };

  /* Was the 5V reference off nominal anywhere in the group — the code-4 gate.
   * Any sample, not just the first: these episodes are 4-19 samples long and
   * the rail is what the ECU is complaining about throughout. */
  const railGate = eps2 => {
    if (railCol < 0) return null;
    let checked = 0;
    for (const e of eps2)
      for (let i = e.i0; i <= e.i1; i++) {
        const v = rows[i].values[railCol];
        if (!Number.isFinite(v) || v <= 0) continue;
        checked++;
        if (Math.abs(v - REF_RAIL_NOMINAL) > REF_RAIL_TOL) return true;
      }
    return checked ? false : null;
  };

  const CEL_CAUSE_GATES = { 2: stoppedGate, 4: railGate, 7: leanGate };

  const out = [...groups.values()].map(g => {
    const longest = Math.max(...g.eps.map(e => e.seconds));
    const solid = longest >= CEL_SOLID_S || g.eps.some(e => e.atEnd);
    const dtcs = [...new Set(g.eps.flatMap(e => e.dtcs))].sort((a, b) => a - b);
    const unnamed = g.eps.filter(e => !e.dtcs.length).length;
    /* A DTC captured during the episode always wins: it is the ECU's own answer.
     * CEL_CAUSE_NAMES only fills in where nothing was flagged, which is the case
     * that used to render as a bare, faintly alarming code number. */
    const known = CEL_CAUSE_NAMES[g.code] || null;
    const gate = CEL_CAUSE_GATES[g.code];
    const agrees = known && !dtcs.length && gate ? gate(g.eps) : null;
    /* `!dtcs.length` belongs in `fits`, not only in the label below: a code
     * whose row was named from a captured DTC must not also report a
     * knownCause, or the row claims two provenances for one name. Latent until
     * code 4 got a name in CEL_CAUSE_NAMES — it is the one code seen both with
     * and without its DTC. */
    const fits = !!known && !dtcs.length && agrees !== false;
    const label = dtcs.length
      ? dtcs.map(dtcLabel).join(' · ')
      : fits
        ? 'Code ' + g.code + ' — ' + known
        /* Say WHICH kind of nothing this is. A row reading just "Code 4" beside
         * one reading "Code 7 — …" looks like the analyzer gave up on one and
         * not the other, when the real difference is that no name has been
         * established for that code yet. The two cases are different work:
         * "not captured" means log more of the run, the other means the log
         * cannot answer at all until the DTC channel is enabled in NSP. */
        : 'Code ' + g.code + (flagged >= 0 ? ' — DTC not captured' : ' — no DTC channel logged');
    /* Every event's time, not just the first — two flickers 76 s apart is a
     * different story from two in the same second, and a row that showed only
     * the first would hide which. Long lists truncate rather than wrap the
     * column to three lines. */
    // sort the NUMBERS then format: "155.865 s" sorts before "79.880 s" as text
    const times = g.eps.map(e => e.t0).sort((a, b) => a - b).map(at);
    return {
      code: g.code,
      cause: label,
      named: dtcs.length > 0 || fits,
      knownCause: fits ? known : null,
      /* The name exists for this code but the engine was turning, so it was not
       * used. Surfaced rather than swallowed: it means either the code has a
       * second meaning or something is genuinely odd about the episode. */
      causeMismatch: !!known && !dtcs.length && !fits,
      inferred: g.eps.some(e => e.inferred),
      unnamedEvents: unnamed,
      /* 'Yes' either way, so the cell still highlights — where it came from is
       * a property of the whole log, not of one row, so it goes in the note. */
      protection: g.eps.some(e => e.protection) ? 'Yes' : (hasProt || canDeriveProt) ? 'No' : '—',
      protectionDerived: canDeriveProt && g.eps.some(e => e.protection),
      events: g.eps.length,
      occurrence: solid ? 'Solid' : 'Flicker',
      when: times.slice(0, 3).join(', ') + (times.length > 3 ? ' +' + (times.length - 3) + ' more' : ''),
      times,
      seconds: g.eps.reduce((a, e) => a + e.seconds, 0),
      firstAt: Math.min(...g.eps.map(e => e.t0)),
    };
  }).sort((a, b) => b.events - a.events || a.firstAt - b.firstAt);

  // codes that never lit anything — the ECU's idle state, footnoted not tabled
  const quiet = [...new Set(eps.filter(e => !e.lit).map(e => e.code))].sort((a, b) => a - b);
  const litSeconds = out.reduce((a, r) => a + r.seconds, 0);

  const notes = [];
  if (quiet.length)
    notes.push('Code ' + quiet.join(', ') + ' never lit the lamp — the no-fault idle state, not listed above.');
  if (out.length)
    notes.push('Lamp lit for ' + litSeconds.toFixed(2) + ' s over '
      + out.reduce((a, r) => a + r.events, 0) + ' event' + (out.reduce((a, r) => a + r.events, 0) === 1 ? '' : 's') + '.');
  if (out.length)
    notes.push('Times are seconds from the start of the log, the same axis as the graphs'
      + (clock0 === null ? '.' : ' — the log clock started at ' + hhmmss(clock0) + '.'));
  if (out.some(r => r.inferred))
    notes.push('One or more events flagged and cleared their fault between log samples; the fault '
      + 'is named from Latest cleared DTC, which no other fault clearing would have left unchanged.');
  /* Why an engine-off row is in the table at all. Without this the row reads as
   * a 29-second unexplained solid lamp, which is how it was first reported —
   * wrongly — on 2026-08-15. */
  if (out.some(r => r.knownCause === 'Engine off'))
    notes.push('Code 2 is the lamp with the key on and the engine stopped. It lights the moment the '
      + 'engine dies and goes out the moment it restarts: with CEL activation set to Current DTCs '
      + 'only, a stopped engine has current faults. Normal, not something to chase.');
  /* Why a lean-trip row is in the table at all, and what it does NOT rest on:
   * no log that covers one of these runs carries the DTC channels, so the name
   * is Danie's NSP readout matched to the only cause code those logs show. */
  if (out.some(r => r.code === 4 && r.knownCause))
    notes.push('Code 4 is read as the sensor 5V reference. Every code-4 episode in a log that also '
      + 'carries the DTC channels — 9 of them — was P0641 or P0642 and nothing else; this log has no '
      + 'DTC channel, so which of the pair fired is not recoverable from it.');
  if (out.some(r => r.code === 7 && r.knownCause))
    notes.push('Code 7 is read as the wideband lean trip, P1276. The runs it appears in were logged '
      + 'to ECU memory, which carries no DTC channel, so the name comes from NSP\'s own readout for '
      + 'that session and from the code latching on the sample the target lambda steps richer while '
      + 'the wideband does not follow — not from this log.');
  for (const r of out.filter(x => x.causeMismatch))
    notes.push('Code ' + r.code + ' normally means "' + CEL_CAUSE_NAMES[r.code] + '", but '
      + (r.code === 7
        ? 'the wideband was not lean of target where the code appeared'
        : r.code === 4
          ? 'the 5V reference was within tolerance throughout'
          : 'RPM says the engine was running through this episode')
      + ', so it is left as a raw code.');
  if (out.some(r => !r.named && flagged >= 0))
    notes.push('A cause shown as a raw code number lit the lamp without any DTC being captured.');
  if (flagged < 0)
    notes.push('No Latest flagged DTC channel in this log, so causes show as raw code numbers. '
      + 'Enable it in NSP to get fault names.');
  if (refIdle)
    notes.push('No Check Engine Light Output State channel in this log, so lit-vs-idle comes from the '
      + 'other logs: code ' + [...CEL_DARK_CODES].join(' and ') + ' have never once driven the lamp '
      + 'across every log that can see it, and any other code is taken as lit. Enable that channel in '
      + 'NSP to have the log answer for itself.');
  if (assumedIdle)
    notes.push('No Check Engine Light Output State channel, and no code in this log has been seen '
      + 'against one before — the most-common code is assumed to be the idle state.');
  if (!hasProt && out.some(r => r.protectionDerived))
    notes.push('This log has no engine-protection channels, so that column is read off the actuators: '
      + 'ignition correction, boost solenoid duty and target lambda all stepping the protective way '
      + 'in one sample, then holding. Ignition and boost stay pulled until the ECU gives them back.');
  else if (canDeriveProt)
    notes.push('This log has no engine-protection channels; the column is read off the actuators, '
      + 'and none of them show an intervention.');
  else if (!hasProt)
    notes.push('No engine-protection channels in this log, so that column is unknown.');

  return {
    available: true,
    rows: out,
    everLit: out.length > 0,
    startClock: clock0 === null ? null : hhmmss(clock0),
    quietCodes: quiet,
    litSeconds,
    note: notes.join(' '),
  };
}

/** Build evenly-spaced axis breakpoints covering [lo,hi] snapped to `step`. */
export function makeAxis(lo, hi, step) {
  const a = [];
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  for (let v = start; v <= end + 1e-9; v += step) a.push(Math.round(v));
  return a;
}

function binIndex(axis, v) {
  // nearest breakpoint (cells centered on breakpoints, Haltech-style)
  let best = 0, bestD = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i] - v);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Core analysis: bin valid samples into an RPM x Load grid and compute, per cell,
 * mean measured/target lambda, recommended fuel % change, sample count, spread.
 * Also produce a ranked list of danger cells (lean under boost).
 */
export function analyze(log, opts = {}) {
  const vehicle = opts.vehicle || VEHICLE;
  const { samples, fuel } = extractSamples(log, opts);
  annotateLimits(samples, vehicle, fuel);
  const warnings = checkLimits(samples, vehicle, fuel);

  const filter = opts.filter || defaultFilter(opts);
  const valid = samples.filter(filter);

  // Why samples were thrown away — so the UI can say "this log is unusable" rather
  // than silently analysing whatever survived.
  const excluded = {
    mapClipped: samples.filter(s => s.mapClipped).length,
    dutyMaxed: samples.filter(s => s.dutyMaxed).length,
    fuelStarved: samples.filter(s => s.fuelStarved).length,
    implausible: samples.filter(s => s.implausible).length,
  };
  const running = samples.filter(s => s.running);
  const boosted = running.filter(s => s.map > vehicle.baroKpa);
  const boostedBlocked = boosted.filter(s => !s.trustworthy).length;
  const blockedShare = boosted.length ? boostedBlocked / boosted.length : 0;
  const implausibleShare = running.length ? excluded.implausible / running.length : 0;
  const dataQuality = {
    runningSamples: running.length,
    boostedSamples: boosted.length,
    boostedBlocked,
    blockedPct: +(blockedShare * 100).toFixed(1),
    implausiblePct: +(implausibleShare * 100).toFixed(1),
    // Below half the boosted data surviving, corrections are fitted to scraps.
    // Sustained implausible readings mean the sensing itself is untrustworthy.
    usable: blockedShare < 0.5 && implausibleShare < 0.01,
  };

  // Axes: default Haltech-ish. Load axis in kPa absolute.
  const loads = valid.map(s => s.load).filter(Number.isFinite);
  const rpms = valid.map(s => s.rpm).filter(Number.isFinite);
  // Axes span the vehicle's declared envelope, but never past the MAP sensor's
  // ceiling — there is no measurable data above it.
  const targetLoadKpa = psiToKpa(vehicle.maxBoostPsi) + vehicle.baroKpa;
  const rpmAxis = opts.rpmAxis
    || makeAxis(Math.min(500, ...rpms), Math.max(vehicle.redlineRpm, ...rpms), opts.rpmStep || 500);
  const loadAxis = opts.loadAxis
    || makeAxis(Math.min(20, ...loads),
                Math.min(mapCeilingKpa(vehicle), Math.max(targetLoadKpa, ...loads)),
                opts.loadStep || 20);

  const R = rpmAxis.length, L = loadAxis.length;
  const cells = Array.from({ length: L }, () => Array.from({ length: R }, () => null));

  for (const s of valid) {
    const ri = binIndex(rpmAxis, s.rpm);
    const li = binIndex(loadAxis, s.load);
    let cell = cells[li][ri];
    if (!cell) cell = cells[li][ri] = { n: 0, sMeas: 0, sTgt: 0, meas: [], sKnock: 0, sInj: 0 };
    cell.n++;
    cell.sMeas += s.measured;
    cell.sTgt += s.target;
    cell.sInj += Number.isFinite(s.injDuty) ? s.injDuty : 0;
    cell.sKnock += Number.isFinite(s.knock) ? s.knock : 0;
    cell.meas.push(s.measured);
  }

  const minSamples = opts.minSamples ?? 4;
  const grid = [];
  const danger = [];
  const stoich = median(valid.map(s => s.stoich)) || 14.7;

  for (let li = 0; li < L; li++) {
    for (let ri = 0; ri < R; ri++) {
      const cell = cells[li][ri];
      if (!cell || cell.n < minSamples) continue;
      const meanMeas = cell.sMeas / cell.n;
      const meanTgt = cell.sTgt / cell.n;
      const spread = stddev(cell.meas);
      // fuel change to move measured lambda onto target: more fuel => lower lambda
      const pctChange = (meanMeas / meanTgt - 1) * 100;
      const leanErrPct = (meanMeas / meanTgt - 1) * 100; // >0 == leaner than target
      const boostPsi = kpaToPsi(loadAxis[li]);
      const meanInjDuty = cell.sInj / cell.n;
      // Can the injectors actually deliver the correction we are about to suggest?
      const dutyAfter = meanInjDuty * (1 + pctChange / 100);
      const rec = {
        rpm: rpmAxis[ri], load: loadAxis[li], boostPsi,
        n: cell.n,
        measured: meanMeas, target: meanTgt,
        afrMeasured: lambdaToAfr(meanMeas, stoich), afrTarget: lambdaToAfr(meanTgt, stoich),
        pctChange, leanErrPct, spread,
        injDuty: meanInjDuty,
        dutyAfter,
        dutyLimited: dutyAfter > vehicle.maxInjDutyPct,
        confidence: confidence(cell.n, spread),
      };
      grid.push(rec);
      // Danger: lean beyond threshold while in positive boost
      const leanThresh = opts.leanThreshPct ?? 3;
      if (boostPsi > 1 && leanErrPct > leanThresh) {
        rec.severity = severity(leanErrPct, boostPsi);
        // A lean cell the injectors cannot fix is a capacity problem, not a map problem.
        rec.cause = rec.dutyLimited ? 'capacity' : 'calibration';
        danger.push(rec);
      }
    }
  }
  danger.sort((a, b) => b.severity - a.severity);

  const limitedCells = grid.filter(g => g.dutyLimited);
  if (limitedCells.length) {
    const worst = limitedCells.reduce((m, g) => (g.dutyAfter > m.dutyAfter ? g : m));
    warnings.push({
      id: 'correction-exceeds-injectors', severity: 'critical', blocking: true,
      hits: limitedCells.length, pctOfLog: null,
      title: `${limitedCells.length} correction${limitedCells.length > 1 ? 's' : ''} would exceed injector capacity`,
      detail: `Applying the suggested fuel change would push duty to ${worst.dutyAfter.toFixed(0)}% at `
        + `${worst.rpm} rpm / ${worst.boostPsi.toFixed(0)} psi, past the ${vehicle.maxInjDutyPct}% ceiling. `
        + `Raise fuel pressure or fit larger injectors before chasing these cells.`,
    });
  }

  const rank = { critical: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    meta: log.meta,
    vehicle,
    counts: { total: samples.length, valid: valid.length },
    stoich,
    rpmAxis, loadAxis,
    grid,
    danger,
    warnings,
    excluded,
    dataQuality,
    fuel,
    summary: {
      ...summarize(grid, valid),
      ...knockSummary(running),
      ...flowSummary(running, vehicle),
    },
  };
}

/**
 * Knock over the whole running log — deliberately NOT over the filtered set.
 *
 * Every other figure here is computed from samples that survived the validity
 * gate, because a correction must not be fitted to junk. Knock is the opposite
 * case: an event during a MAP-clipped or duty-maxed sample is still an event,
 * and those are exactly the samples the gate throws away. Counting only "valid"
 * knock would report zero on precisely the pulls most likely to have knocked.
 *
 * The count channel is a running total, so events-in-this-log is max - min.
 * Retard is logged as a negative correction; report it as a positive magnitude.
 */
/** Peak flow demand and what the pressure sag is costing, over running samples. */
function flowSummary(running, vehicle) {
  const loss = running.map(s => s.flowLossPct).filter(Number.isFinite);
  const hp = running.map(s => s.impliedHp).filter(Number.isFinite);
  const cc = running.map(s => s.deliveredCcMin).filter(Number.isFinite);
  const diffs = running.map(s => s.fuelDiff).filter(Number.isFinite);
  return {
    flowLossMaxPct: loss.length ? Math.max(...loss) : null,
    flowAtMinDiffCcMin: diffs.length
      ? injectorFlowCcMin(Math.min(...diffs), vehicle) : null,
    peakDeliveredCcMin: cc.length ? Math.max(...cc) : null,
    peakImpliedHp: hp.length ? Math.max(...hp) : null,
    injectorCeilingHp: ccMinToHp(vehicle.injectorCcMin * vehicle.injectorCount, vehicle),
  };
}

function knockSummary(running) {
  const counts = running.map(s => s.knockCount).filter(Number.isFinite);
  const retards = running.map(s => s.knockRetard).filter(Number.isFinite);
  const levels = running.map(s => s.knock).filter(Number.isFinite);
  return {
    knockLogged: counts.length > 0 || retards.length > 0,
    knockEvents: counts.length ? Math.max(...counts) - Math.min(...counts) : null,
    knockCountEnd: counts.length ? Math.max(...counts) : null,
    knockRetardMax: retards.length ? Math.max(0, -Math.min(...retards)) : null,
    knockLevelMax: levels.length ? Math.max(...levels) : null,
  };
}

function severity(leanErrPct, boostPsi) {
  // scale lean error by boost — leaner + more boost = more dangerous
  return leanErrPct * (1 + boostPsi / 10);
}
function confidence(n, spread) {
  const nScore = Math.min(1, n / 15);
  const sScore = Math.max(0, 1 - spread / 0.05); // tight spread => confident
  return Math.round((0.6 * nScore + 0.4 * sScore) * 100);
}
function summarize(grid, valid) {
  const boosted = grid.filter(g => g.boostPsi > 1);
  const lean = boosted.filter(g => g.leanErrPct > 3);
  // The blend the corrections belong to. It travels with the numbers because a
  // table derived at E76 must not be applied to an E89 map, and a percentage on
  // its own carries no clue which fuel produced it.
  const eth = valid.map(s => s.ethanol).filter(Number.isFinite);
  return {
    cellsCovered: grid.length,
    boostedCells: boosted.length,
    leanBoostedCells: lean.length,
    maxBoostPsi: valid.reduce((m, s) => Math.max(m, s.boostPsi), -Infinity),
    maxRpm: valid.reduce((m, s) => Math.max(m, s.rpm), -Infinity),
    worstLeanPct: lean.reduce((m, g) => Math.max(m, g.leanErrPct), 0),
    ethMean: eth.length ? eth.reduce((a, b) => a + b, 0) / eth.length : null,
    ethLo: eth.length ? Math.min(...eth) : null,
    ethHi: eth.length ? Math.max(...eth) : null,
  };
}

function median(a) {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (!x.length) return NaN;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
function stddev(a) {
  const x = a.filter(Number.isFinite);
  if (x.length < 2) return 0;
  const mean = x.reduce((s, v) => s + v, 0) / x.length;
  return Math.sqrt(x.reduce((s, v) => s + (v - mean) ** 2, 0) / x.length);
}

/* ======================================================= time-resolved events
 *
 * Everything above answers "what does the map look like across the whole log".
 * A driveability complaint is the opposite question: something happened at ONE
 * MOMENT, and averaging is precisely what hides it. A 200 ms stumble is a
 * handful of samples out of thousands — far too few to move a cell mean, and
 * the only thing the driver actually felt.
 *
 * detectEvents() walks the log at full sample rate looking for signatures worth
 * a timestamp, and reports each one with what EVERY other channel was doing at
 * that instant. The correlation is the diagnosis, not the dip on its own:
 *   rpm dip + lean spike + injector differential collapse -> fuel supply
 *   rpm dip + ignition retard + knock count stepping      -> ECU pulling timing
 *   rpm dip + 5V reference dip                            -> sensor/wiring, which
 *                                                            can fake either one
 * so every episode carries the same snapshot block and invites that comparison.
 *
 * Thresholds are deliberately loose. This feeds a diagnosis, where a missed
 * event costs more than one to dismiss, so each episode reports how far past
 * its threshold it went and the reader discounts the marginal ones.
 *
 * Nothing here is silently capped: `counts` is the true episode count per kind
 * even when `events` carries only the worst few, and `dropped` says how many
 * were left out.
 */

/** Per-kind severity and display label. Order here is the report order. */
const EVENT_KINDS = [
  ['knock',        'critical', 'Knock detected'],
  ['fuel-starve',  'critical', 'Injector pressure differential below target'],
  ['duty-ceiling', 'critical', 'Injector duty at ceiling'],
  ['fuel-overpressure', 'warn', 'Injector pressure differential above target'],
  ['rail-dip',     'critical', '5V sensor reference dipped'],
  ['stumble',      'warn',     'RPM fell while the throttle was open'],
  ['lean-spike',   'warn',     'Lean of target'],
  ['boost-drop',   'warn',     'Manifold pressure collapsed at throttle'],
  ['ign-retard',   'warn',     'Ignition pulled without a knock flag'],
  ['volt-sag',     'warn',     'Battery voltage sagged'],
  ['rich-dump',    'info',     'Rich of target'],
  ['gear-shift',   'info',     'Gear change'],
  ['map-clip',     'info',     'MAP sensor saturated'],
  ['rev-limit',    'info',     'At or above redline'],
  ['iat-high',     'info',     'Intake air temperature above limit'],
  ['clt-high',     'info',     'Coolant temperature above limit'],
];

/** Merge flagged samples into episodes, bridging gaps shorter than maxGapS. */
function evEpisodes(hit, ts, maxGapS = 0.25) {
  const out = [];
  let start = -1, last = -1;
  for (let i = 0; i < hit.length; i++) {
    if (!hit[i]) continue;
    if (start < 0) { start = i; last = i; continue; }
    if (ts[i] - ts[last] <= maxGapS) { last = i; continue; }
    out.push([start, last]);
    start = i; last = i;
  }
  if (start >= 0) out.push([start, last]);
  return out;
}

const evN = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

/**
 * One line describing every channel at an instant. Identical for every event
 * kind on purpose: reading two episodes side by side is how a cause separates
 * from a symptom, and that only works if the columns line up.
 */
function evSnapshot(r) {
  return [
    'rpm ' + evN(r.rpm, 0),
    'tps ' + evN(r.throttle, 0) + '%',
    'MAP ' + evN(r.map, 0) + 'kPa (' + evN(kpaToPsi(r.map), 1) + 'psi)',
    'lambda ' + evN(r.measured, 3) + '/' + evN(r.target, 3) + ' tgt',
    'duty ' + evN(r.injDuty, 1) + '%',
    'ign ' + evN(r.ign, 1) + 'deg',
    'knockRetard ' + evN(r.knockRetard, 1) + 'deg',
    'fuelDiff ' + evN(r.fuelDiff, 0) + 'kPa (target ' + evN(r.fuelDiffTarget, 0)
      + ', ' + evN(r.fuelDevPct, 1) + '%)',
    'batt ' + evN(r.battery, 2) + 'V',
    'IAT ' + evN(r.iat, 0) + 'C',
    'CLT ' + evN(r.clt, 0) + 'C',
    '5Vref ' + evN(r.railV, 2) + 'V',
    'speed ' + evN(r.speedKmh, 0) + 'km/h',
  ].join(' | ');
}

/**
 * @param {object} log    parseLog() output
 * @param {object} opts   { vehicle, t0, t1, perKind, total }
 *   t0/t1 restrict the scan to a time window (seconds from log start) — the
 *   published page passes the window the viewer has dragged to, so asking about
 *   a stutter you have zoomed in on does not drown in events from the rest of
 *   the log.
 */
export function detectEvents(log, opts = {}) {
  const vehicle = opts.vehicle || VEHICLE;
  const none = reason => ({ available: false, reason, events: [], counts: {}, dropped: 0 });
  if (!log || !log.rows || !log.rows.length) return none('log has no rows');

  const { samples } = extractSamples(log, { vehicle });
  // Sets fuelTransient before the window slice below copies samples into rows,
  // so the fuel scans see it. detectEvents does not run annotateLimits().
  markFuelLiftTransients(samples, vehicle);
  const cRail = col(log, 'Diagnostic Analogue 5V rail');
  const cSpeed = col(log, 'Vehicle Speed', 'Vehicle Speed GPS', 'Ground Speed');

  const first = samples[0].t, lastT = samples[samples.length - 1].t;
  const t0 = Number.isFinite(opts.t0) ? Math.max(first, opts.t0) : first;
  const t1 = Number.isFinite(opts.t1) ? Math.min(lastT, opts.t1) : lastT;

  const rows = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.t < t0 || s.t > t1) continue;
    rows.push({
      ...s,
      railV: cRail >= 0 ? val(log.rows[i], cRail) : NaN,
      speedKmh: cSpeed >= 0 ? val(log.rows[i], cSpeed) : NaN,
    });
  }
  if (rows.length < 4) return none('fewer than 4 samples in the window');

  const T = rows.map(r => r.t);
  const span = T[T.length - 1] - T[0];
  const hz = span > 0 ? (rows.length - 1) / span : null;

  /* Extreme of f over the preceding `secs`, ignoring gaps in the channel. The
   * look-back is in SECONDS, never samples: NSP logs the same car at 20 Hz and
   * at 200 Hz, and a threshold in samples would mean a different thing in each. */
  const back = (i, secs, f, want) => {
    let best = NaN;
    for (let j = i; j >= 0 && T[i] - T[j] <= secs; j--) {
      const v = f(rows[j]);
      if (!Number.isFinite(v)) continue;
      best = !Number.isFinite(best) ? v : (want === 'max' ? Math.max(best, v) : Math.min(best, v));
    }
    return best;
  };

  /* Values of f over a window expressed as OFFSETS from sample i, in seconds.
   * Negative offsets look back, positive look forward; the scan is bounded from
   * i outward so cost is the window, not the log. */
  const winVals = (i, a, b, f) => {
    const out = [];
    for (let j = i; j < rows.length; j++) {
      const dt = T[j] - T[i];
      if (dt > b) break;
      if (dt >= a) out.push(f(rows[j]));
    }
    for (let j = i - 1; j >= 0; j--) {
      const dt = T[j] - T[i];
      if (dt < a) break;
      if (dt <= b) out.push(f(rows[j]));
    }
    return out.filter(Number.isFinite);
  };

  /* An upshift and a stumble are the SAME shape in rpm alone: both drop engine
   * speed with the throttle still open, and asking "how big was the drop" cannot
   * separate them — the biggest drops in a pull are always the shifts. What
   * separates them is the ratio of engine rpm to road speed. A shift steps that
   * ratio down and keeps it down; a stumble leaves it where it was, because the
   * car is still in the same gear. Without a road speed channel the question is
   * unanswerable from the log, and the caller is told so rather than guessed at. */
  const gearRatio = (i, a, b) =>
    median(winVals(i, a, b, r => (r.speedKmh > 5 ? r.rpm / r.speedKmh : NaN)));
  const haveSpeed = rows.some(r => Number.isFinite(r.speedKmh) && r.speedKmh > 5);
  const isShift = i => {
    if (!haveSpeed) return false;
    const before = gearRatio(i, -0.6, -0.25);
    const after = gearRatio(i, 0.25, 0.6);
    return Number.isFinite(before) && Number.isFinite(after) && after < before * 0.85;
  };

  /* The rpm-drop test both the stumble and the shift detector start from. */
  const rpmDropAt = (r, i) => {
    r._rpmFrom = NaN; r._rpmDrop = 0;
    if (!(r.rpm >= 1200) || !(r.throttle >= 15)) return false;
    const tpsBack = back(i, 0.3, x => x.throttle, 'max');
    if (Number.isFinite(tpsBack) && tpsBack - r.throttle >= 12) return false;   // a lift
    const rpmBack = back(i, 0.2, x => x.rpm, 'max');
    if (!Number.isFinite(rpmBack) || rpmBack - r.rpm < (opts.stumbleRpm ?? 120)) return false;
    r._rpmFrom = rpmBack; r._rpmDrop = rpmBack - r.rpm;
    return true;
  };

  const events = [];
  const counts = {};
  const ceilingKpa = mapCeilingKpa(vehicle);

  /* scan(kind, hit, rank, describe)
   *   hit(r, i)  -> is this sample flagged
   *   rank(r)    -> magnitude used to pick the worst sample and to rank episodes
   *   describe(worst, ep) -> the sentence, given the worst sample in the episode
   * minDur drops single-sample blips for the signals where one sample is noise;
   * the count channels and the limit flags keep minDur 0, where one is real. */
  const scan = (kind, { hit, rank, describe, minDur = 0, gap = 0.25 }) => {
    const flags = rows.map((r, i) => {
      try { return !!hit(r, i); } catch (e) { return false; }
    });
    const eps = evEpisodes(flags, T, gap);
    const kept = [];
    for (const [a, b] of eps) {
      const dur = T[b] - T[a];
      if (dur < minDur) continue;        // minDur > 0 also drops the lone-sample blips
      let worst = rows[a];
      for (let i = a; i <= b; i++) if (rank(rows[i]) > rank(worst)) worst = rows[i];
      // tWorst, not t: the snapshot is the worst sample in the episode, and
      // labelling it with the episode's start time would put every channel
      // reading at an instant it was never measured at.
      kept.push({ t: T[a], tEnd: T[b], tWorst: worst.t, durS: dur, worst, mag: rank(worst) });
    }
    counts[kind] = kept.length;
    if (!kept.length) return;
    kept.sort((x, y) => y.mag - x.mag);
    const perKind = opts.perKind ?? 5;
    for (const k of kept.slice(0, perKind)) {
      events.push({
        kind,
        severity: (EVENT_KINDS.find(e => e[0] === kind) || [, 'info'])[1],
        label: (EVENT_KINDS.find(e => e[0] === kind) || [, , kind])[2],
        t: k.t, tEnd: k.tEnd, tWorst: k.tWorst, durS: k.durS,
        detail: describe(k.worst, k),
        at: evSnapshot(k.worst),
      });
    }
  };

  const running = r => Number.isFinite(r.rpm) && r.rpm >= vehicle.minRunningRpm;

  /* --- knock ------------------------------------------------------------
   * The count channel is a running total, so an EVENT is an increment. Retard
   * is logged as a negative correction and reported as a positive magnitude. */
  let prevCount = NaN;
  scan('knock', {
    hit: (r, i) => {
      const c = r.knockCount;
      const stepped = Number.isFinite(c) && Number.isFinite(prevCount) && c > prevCount;
      if (Number.isFinite(c)) prevCount = c;
      return stepped || (Number.isFinite(r.knockRetard) && r.knockRetard <= -1);
    },
    rank: r => (Number.isFinite(r.knockRetard) ? Math.abs(r.knockRetard) : 0) + 1,
    gap: 0.5,
    describe: r => 'knock flagged at ' + evN(r.rpm, 0) + ' rpm / ' + evN(kpaToPsi(r.map), 1)
      + ' psi; ignition pulled ' + evN(Math.abs(r.knockRetard), 1) + ' deg, knock level '
      + evN(r.knock, 1),
  });

  /* --- fuel supply ------------------------------------------------------
   * Judged on the % departure of the differential from target, matching
   * annotateLimits(). minDur is raised to 0.1 s here because the tolerance is
   * tight enough that a tip-in, where the rail legitimately lags the manifold for
   * a few tens of ms, would otherwise post an episode on every throttle stab. */
  scan('fuel-starve', {
    hit: r => running(r) && Number.isFinite(r.fuelDevPct) && r.injDuty >= 15
      && !r.fuelTransient && r.fuelDevPct < -vehicle.fuelDiffTolerancePct,
    rank: r => -r.fuelDevPct,
    minDur: 0.1,
    describe: r => 'differential fell to ' + evN(r.fuelDiff, 0) + ' kPa against a target of '
      + evN(r.fuelDiffTarget, 0) + ' (' + evN(r.fuelDevPct, 1) + '%, tolerance +/-'
      + vehicle.fuelDiffTolerancePct + '%), which is '
      + evN(injectorFlowCcMin(r.fuelDiff, vehicle), 0) + ' cc/min per injector vs '
      + evN(injectorFlowCcMin(r.fuelDiffTarget, vehicle), 0) + ' at target — '
      + 'the injectors flow less than the map assumes while this lasts',
  });

  scan('fuel-overpressure', {
    hit: r => running(r) && Number.isFinite(r.fuelDevPct) && r.injDuty >= 15
      && !r.fuelTransient && r.fuelDevPct > vehicle.fuelDiffTolerancePct,
    rank: r => r.fuelDevPct,
    minDur: 0.1,
    describe: r => 'differential rose to ' + evN(r.fuelDiff, 0) + ' kPa against a target of '
      + evN(r.fuelDiffTarget, 0) + ' (+' + evN(r.fuelDevPct, 1) + '%, tolerance +/-'
      + vehicle.fuelDiffTolerancePct + '%) — stuck regulator or restricted return; '
      + 'the injectors flow more than the map assumes while this lasts',
  });

  scan('duty-ceiling', {
    hit: r => running(r) && Number.isFinite(r.injDuty) && r.injDuty >= vehicle.maxInjDutyPct,
    rank: r => r.injDuty,
    describe: r => 'injector duty ' + evN(r.injDuty, 1) + '% at ' + evN(r.rpm, 0) + ' rpm / '
      + evN(kpaToPsi(r.map), 1) + ' psi (ceiling ' + vehicle.maxInjDutyPct + '%)',
  });

  /* --- electrical -------------------------------------------------------
   * The 5V reference feeds every analogue sensor, so a dip here moves MAP, TPS
   * and fuel pressure together and can imitate a mechanical fault on all three. */
  scan('rail-dip', {
    hit: r => Number.isFinite(r.railV) && r.railV < 4.8,
    rank: r => 5 - r.railV,
    minDur: 0.01,
    describe: r => '5V sensor reference fell to ' + evN(r.railV, 2) + ' V (nominal 5.00). '
      + 'Every analogue sensor reads low while this lasts — MAP, TPS and fuel pressure '
      + 'all shift together',
  });

  scan('volt-sag', {
    hit: r => running(r) && Number.isFinite(r.battery) && r.battery < 12,
    rank: r => 12 - r.battery,
    minDur: 0.05,
    describe: r => 'battery ' + evN(r.battery, 2) + ' V with the engine running; injector '
      + 'dead time and coil dwell are voltage-compensated, so a sag changes delivered fuel '
      + 'and spark energy',
  });

  /* --- the driveability complaint itself --------------------------------
   * An rpm drop with the throttle still open. Two false positives are screened
   * out: a lift (the throttle itself came back) and the limiter (rpm is meant
   * to fall there). A clutched upshift with the throttle held CANNOT be
   * screened out from rpm alone — it looks identical — so road speed rides in
   * the snapshot: through a shift the car keeps accelerating, through a stumble
   * it does not. */
  scan('stumble', {
    hit: (r, i) => rpmDropAt(r, i) && !isShift(i),
    rank: r => r._rpmDrop || 0,
    minDur: 0.01,
    describe: r => 'rpm fell from ' + evN(r._rpmFrom, 0) + ' to ' + evN(r.rpm, 0) + ' ('
      + evN(r._rpmDrop, 0) + ' rpm lost inside 0.2 s) with the throttle at '
      + evN(r.throttle, 0) + '%'
      + (haveSpeed
        ? ', and the rpm-to-road-speed ratio came back to where it was — the car did NOT '
          + 'change gear here'
        : ', but this log has no road speed channel, so a gear change cannot be ruled out '
          + 'from the data alone')
      + (r._rpmFrom >= vehicle.redlineRpm - 100
        ? '. It started at the redline, so consider the rev limiter too' : ''),
  });

  /* Reported because the shape of the run is context: a lean spike 0.2 s after a
   * shift is a transient, the same spike mid-gear is the tune. */
  scan('gear-shift', {
    hit: (r, i) => rpmDropAt(r, i) && isShift(i),
    rank: r => r._rpmDrop || 0,
    minDur: 0,
    gap: 0.4,
    describe: r => 'upshift: rpm ' + evN(r._rpmFrom, 0) + ' -> ' + evN(r.rpm, 0)
      + ' at ' + evN(r.speedKmh, 0) + ' km/h with the throttle at ' + evN(r.throttle, 0)
      + '% (engine-rpm-to-road-speed ratio steps down and stays down)',
  });

  /* --- mixture ----------------------------------------------------------
   * Tighter under boost, where being lean of target is the expensive kind. */
  const leanGate = r => (r.boostPsi > 3 ? 0.04 : 0.06);
  /* Closed throttle is excluded from BOTH mixture detectors. On overrun the ECU
   * cuts fuel and the wideband reads whatever is left in the pipe — pegged lean
   * or dumping rich, and neither means anything about the tune. 5% is the same
   * gate defaultFilter() uses to spot overrun. */
  const mixtureLive = r => running(r) && r.rpm >= 1500 && r.injDuty >= 3 && r.throttle >= 5;
  scan('lean-spike', {
    hit: r => mixtureLive(r)
      && Number.isFinite(r.measured) && Number.isFinite(r.target)
      && r.measured - r.target >= leanGate(r),
    rank: r => r.measured - r.target,
    minDur: 0.08,
    describe: r => 'lambda ' + evN(r.measured, 3) + ' against a target of ' + evN(r.target, 3)
      + ' (' + evN((r.measured / r.target - 1) * 100, 1) + '% lean) at ' + evN(r.rpm, 0)
      + ' rpm / ' + evN(kpaToPsi(r.map), 1) + ' psi, duty ' + evN(r.injDuty, 0) + '%',
  });

  scan('rich-dump', {
    hit: r => mixtureLive(r)
      && Number.isFinite(r.measured) && Number.isFinite(r.target)
      && r.measured - r.target <= -0.12,
    rank: r => r.target - r.measured,
    minDur: 0.1,
    describe: r => 'lambda ' + evN(r.measured, 3) + ' against a target of ' + evN(r.target, 3)
      + ' at ' + evN(r.rpm, 0) + ' rpm, duty ' + evN(r.injDuty, 0) + '%',
  });

  /* --- air path --------------------------------------------------------- */
  scan('boost-drop', {
    hit: (r, i) => {
      r._mapFrom = NaN; r._mapDrop = 0;
      if (!(r.throttle >= 50) || !running(r)) return false;
      const mapBack = back(i, 0.25, x => x.map, 'max');
      if (!Number.isFinite(mapBack) || mapBack - r.map < 40) return false;
      r._mapFrom = mapBack; r._mapDrop = mapBack - r.map;
      return true;
    },
    rank: r => r._mapDrop || 0,
    minDur: 0.01,
    describe: r => 'manifold pressure fell from ' + evN(r._mapFrom, 0) + ' to ' + evN(r.map, 0)
      + ' kPa (' + evN(kpaToPsi(r._mapFrom), 1) + ' -> ' + evN(kpaToPsi(r.map), 1)
      + ' psi) inside 0.25 s with the throttle at ' + evN(r.throttle, 0) + '%',
  });

  scan('ign-retard', {
    hit: (r, i) => {
      r._ignFrom = NaN; r._ignDrop = 0;
      if (!(r.throttle >= 40) || !running(r)) return false;
      if (Number.isFinite(r.knockRetard) && r.knockRetard <= -1) return false;  // knock owns it
      const ignBack = back(i, 0.2, x => x.ign, 'max');
      if (!Number.isFinite(ignBack) || !Number.isFinite(r.ign) || ignBack - r.ign < 6) return false;
      r._ignFrom = ignBack; r._ignDrop = ignBack - r.ign;
      return true;
    },
    rank: r => r._ignDrop || 0,
    minDur: 0.01,
    describe: r => 'ignition angle went from ' + evN(r._ignFrom, 1) + ' to ' + evN(r.ign, 1)
      + ' deg with no knock correction logged — a protection strategy or a table edge, '
      + 'not knock control',
  });

  /* --- envelope --------------------------------------------------------- */
  scan('map-clip', {
    hit: r => Number.isFinite(r.map) && r.map >= ceilingKpa - vehicle.mapClipMarginKpa,
    rank: r => r.map,
    describe: r => 'MAP ' + evN(r.map, 0) + ' kPa against a ' + vehicle.mapSensorBar
      + ' bar sensor (' + evN(ceilingKpa, 0) + ' kPa ceiling) — boost above this is not measured, '
      + 'so fuel and timing are being looked up at the edge of the table',
  });

  scan('rev-limit', {
    hit: r => Number.isFinite(r.rpm) && r.rpm >= vehicle.redlineRpm,
    rank: r => r.rpm,
    describe: r => evN(r.rpm, 0) + ' rpm against a ' + vehicle.redlineRpm + ' rpm redline',
  });

  scan('iat-high', {
    hit: r => running(r) && Number.isFinite(r.iat) && r.iat > vehicle.maxIatC,
    rank: r => r.iat,
    minDur: 0.1,
    describe: r => 'intake air ' + evN(r.iat, 0) + ' C (limit ' + vehicle.maxIatC + ') — '
      + 'charge temperature this high costs timing and moves knock threshold',
  });

  scan('clt-high', {
    hit: r => running(r) && Number.isFinite(r.clt) && r.clt > vehicle.maxCltC,
    rank: r => r.clt,
    minDur: 0.1,
    describe: r => 'coolant ' + evN(r.clt, 0) + ' C (limit ' + vehicle.maxCltC + ')',
  });

  const order = EVENT_KINDS.map(e => e[0]);
  events.sort((a, b) => (order.indexOf(a.kind) - order.indexOf(b.kind)) || (a.t - b.t));
  for (const r of rows) {
    delete r._rpmFrom; delete r._rpmDrop; delete r._mapFrom;
    delete r._mapDrop; delete r._ignFrom; delete r._ignDrop;
  }

  const total = opts.total ?? 40;
  const dropped = Object.values(counts).reduce((s, n) => s + n, 0) - events.length;
  return {
    available: true,
    window: { t0, t1 },
    sampleHz: hz,
    samples: rows.length,
    events: events.slice(0, total),
    counts,
    dropped: Math.max(0, dropped) + Math.max(0, events.length - total),
  };
}

/* ========================================================== evidence brief
 *
 * One plain-text digest of a log, written to be READ BY A MODEL that has the
 * log's numbers and nothing else — no filesystem, no tools, no earlier turn.
 * The published page sends it with the viewer's question.
 *
 * The hard constraint is size: the sampling call takes 64 KiB of UTF-8 and a
 * log is megabytes, so this is a lossy projection and the choice of what
 * survives IS the design:
 *   - Every DERIVED conclusion the page already draws (warnings, limits, grid,
 *     splits, check-engine causes) — it is small and it is the analysis.
 *   - Every time-resolved EVENT at full sample rate — the transient is what a
 *     driveability complaint is about, and decimation is exactly what loses it.
 *   - A decimated TRACE for shape and context, explicitly labelled as
 *     decimated so nothing concludes "no dip here" from a gap between samples.
 *   - The FULL channel list, so an answer can say what to log next knowing what
 *     the ECU is already recording.
 * Sections carry a priority and the lowest ones are dropped whole if the budget
 * is tight, each leaving a line saying it was dropped. Silent truncation would
 * read to the model as absence of evidence.
 */

/** UTF-8 byte length without TextEncoder — the artifact's check harness runs
 *  this inside a bare vm context where that global does not exist. */
function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }   // surrogate pair
    else n += 3;
  }
  return n;
}

const briefN = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

/**
 * @param {object} log   parseLog() output
 * @param {object} opts  { res, events, fileName, t0, t1, vehicle, maxBytes,
 *                         traceRows, gridRows, question }
 * @returns {{ text, bytes, sections, droppedSections, events, res }}
 */
export function buildLogBrief(log, opts = {}) {
  const vehicle = opts.vehicle || VEHICLE;
  const maxBytes = opts.maxBytes ?? 44000;
  const res = opts.res || analyze(log, { vehicle });
  const rows = log.rows || [];
  const firstT = rows.length ? rows[0].t : 0;
  const lastT = rows.length ? rows[rows.length - 1].t : 0;
  const t0 = Number.isFinite(opts.t0) ? Math.max(firstT, opts.t0) : firstT;
  const t1 = Number.isFinite(opts.t1) ? Math.min(lastT, opts.t1) : lastT;
  const windowed = t0 > firstT + 1e-9 || t1 < lastT - 1e-9;
  const ev = opts.events || detectEvents(log, { vehicle, t0, t1 });

  const inWin = r => r.t >= t0 && r.t <= t1;
  const winRows = windowed ? rows.filter(inWin) : rows;
  const S = [];                                  // {name, priority, text}
  const add = (name, priority, lines) => {
    const body = (Array.isArray(lines) ? lines.filter(Boolean).join('\n') : lines) || '';
    if (body.trim()) S.push({ name, priority, text: '## ' + name + '\n' + body });
  };

  /* ---- 1. what this log is ---- */
  const hz = winRows.length > 1 ? (winRows.length - 1) / (t1 - t0) : null;
  add('LOG', 1, [
    'file: ' + (opts.fileName || log.meta?.FileName || 'unnamed'),
    'duration: ' + briefN(lastT - firstT, 2) + ' s over ' + rows.length + ' samples'
      + (hz ? ' (' + briefN(hz, 0) + ' Hz)' : ''),
    windowed
      ? 'WINDOW UNDER EXAMINATION: ' + briefN(t0, 2) + ' s to ' + briefN(t1, 2) + ' s ('
        + briefN(t1 - t0, 2) + ' s, ' + winRows.length + ' samples). The viewer has zoomed the '
        + 'page to this window, so it is the part they are asking about. Everything below '
        + 'except the whole-log analysis is computed over this window.'
      : 'window: the whole log',
    'all times below are SECONDS FROM THE START OF THE LOG, which is what the page\'s graphs '
      + 'use on their x-axis.',
  ]);

  /* ---- 2. the car ---- */
  const f = res.fuel || {};
  add('CAR AND CONFIGURATION', 1, [
    vehicle.name,
    'injectors: ' + vehicle.injectorCount + ' x ' + vehicle.injectorCcMin + ' cc/min @ '
      + vehicle.injectorRatedBar + ' bar, duty ceiling ' + vehicle.maxInjDutyPct + '%',
    'fuel: regulator configured ' + vehicle.fuelRegulator + ' (1:1 with manifold pressure), '
      + 'base differential ' + vehicle.fuelBaseDiffKpa + ' kPa, injector pressure differential '
      + 'must stay within +/-' + vehicle.fuelDiffTolerancePct + '% of target in BOTH directions; '
      + 'density ' + vehicle.fuelDensityGperCc + ' g/cc',
    'fuel reference resolved FROM THIS LOG: ' + (f.present
      ? 'rail sensor reads ' + f.reference + ', differential target taken from '
        + (f.direct
            ? "the ECU's own Fuel Pressure Expected channel (direct — no regulator inference used)"
            : 'the spec base of ' + vehicle.fuelBaseDiffKpa + ' kPa (Fuel Pressure Expected absent), '
              + 'regulator behaves ' + f.regulator + ' (slope ' + briefN(f.slope, 2)
              + ' kPa rail per kPa MAP, fitted ' + f.slopeBasis + ')')
        + ', measured base differential ' + briefN(f.baseDiff, 0) + ' kPa, differential check '
        + (f.enforceable ? 'APPLIED' : 'NOT applied — do not call anything starvation')
      : 'NO usable fuel pressure channel in this log — the differential was not checked at all, '
        + 'so say nothing about fuel supply either way'),
    'limits: redline ' + vehicle.redlineRpm + ' rpm, MAP sensor ' + vehicle.mapSensorBar
      + ' bar (' + briefN(mapCeilingKpa(vehicle), 0) + ' kPa = '
      + briefN(mapCeilingPsi(vehicle), 1) + ' psi gauge ceiling), boost target ceiling '
      + vehicle.maxBoostPsi + ' psi, IAT ' + vehicle.maxIatC + ' C, CLT ' + vehicle.maxCltC + ' C',
    'stoichiometric AFR in this log: ' + briefN(res.stoich, 2)
      + ' (so lambda 1.00 = AFR ' + briefN(res.stoich, 2) + '); '
      + (res.summary.ethMean === null ? 'no ethanol channel'
        : 'ethanol ' + briefN(res.summary.ethMean, 1) + '% (range '
          + briefN(res.summary.ethLo, 1) + '-' + briefN(res.summary.ethHi, 1) + '%)'),
  ]);

  /* ---- 3. what the page already concluded ---- */
  const s = res.summary, q = res.dataQuality;
  add('WHOLE-LOG ANALYSIS (computed by the page, not by you)', 1, [
    'samples used for fuel analysis: ' + res.counts.valid + ' of ' + res.counts.total
      + ' (the rest failed the validity gate: ' + Object.entries(res.excluded)
        .map(([k, v]) => k + ' ' + v).join(', ') + ')',
    'peak: ' + (Number.isFinite(s.maxRpm) ? briefN(s.maxRpm, 0) + ' rpm' : 'no valid rpm')
      + ', ' + (Number.isFinite(s.maxBoostPsi) ? briefN(s.maxBoostPsi, 1) + ' psi' : 'no valid boost'),
    'map coverage: ' + s.cellsCovered + ' cells, ' + s.boostedCells + ' of them in boost, '
      + s.leanBoostedCells + ' of those lean of target (worst ' + briefN(s.worstLeanPct, 1) + '%)',
    'knock: ' + (s.knockLogged
      ? s.knockEvents + ' events, peak retard ' + briefN(s.knockRetardMax, 1)
        + ' deg, peak level ' + briefN(s.knockLevelMax, 1)
      : 'no knock channel logged'),
    'injector flow: peak ' + briefN(s.peakDeliveredCcMin, 0) + ' cc/min delivered ('
      + briefN(s.peakImpliedHp, 0) + ' hp implied at ' + vehicle.bsfcLbPerHpHr + ' BSFC), '
      + 'worst pressure-driven flow loss ' + briefN(s.flowLossMaxPct, 1) + '%, '
      + 'injector ceiling ' + briefN(s.injectorCeilingHp, 0) + ' hp',
    'data quality: ' + q.runningSamples + ' running samples, ' + q.boostedSamples + ' boosted, '
      + q.boostedBlocked + ' of those blocked (' + briefN(q.blockedPct, 1) + '%), '
      + briefN(q.implausiblePct, 1) + '% implausible; usable=' + q.usable,
  ]);

  const warn = res.warnings || [];
  add('ANALYZER WARNINGS (' + warn.length + ')', 1,
    warn.length
      ? warn.map(w => '- [' + w.severity + (w.blocking ? '/blocking' : '') + '] ' + w.id + ': '
          + w.title + ' — ' + w.detail
          + (w.hits ? ' (' + w.hits + ' samples'
            + (w.pctOfLog === null ? '' : ', ' + briefN(w.pctOfLog, 1) + '% of log') + ')' : ''))
      : ['none']);

  /* ---- 4. the transients ---- */
  const evLines = [];
  if (!ev.available) {
    evLines.push('not available: ' + ev.reason);
  } else {
    evLines.push('Detected at FULL sample rate over the window, not decimated. Each line: '
      + 'time, what triggered it, then every channel AT THAT INSTANT so causes can be told '
      + 'apart from symptoms.');
    const tally = Object.entries(ev.counts).filter(([, n]) => n > 0)
      .map(([k, n]) => k + ' ' + n).join(', ');
    evLines.push('episode counts across the window: ' + (tally || 'none'));
    if (ev.dropped) evLines.push('(' + ev.dropped + ' further episodes exist and are NOT '
      + 'listed below — the worst few per kind are shown. Absence from this list is not '
      + 'absence from the log.)');
    evLines.push('');
    if (!ev.events.length) evLines.push('no episodes crossed any threshold in this window');
    for (const e of ev.events) {
      evLines.push('* ' + briefN(e.t, 3) + '-' + briefN(e.tEnd, 3) + ' s [' + e.severity + '] '
        + e.kind + ' — ' + e.label + ': ' + e.detail);
      evLines.push('    worst at ' + briefN(e.tWorst, 3) + ' s: ' + e.at);
    }
    evLines.push('');
    evLines.push('Reading note: an rpm drop with the throttle held can be a stumble OR a '
      + 'clutched upshift; road speed in the snapshot separates them — through a shift the '
      + 'car keeps accelerating. Wideband lambda lags the event that caused it by the '
      + 'exhaust transport delay, so a lean spike belongs slightly EARLIER than its timestamp.');
  }
  add('TIME-RESOLVED EVENTS', 1, evLines);

  /* ---- 5. check engine light ---- */
  const cel = celCauses(log);
  add('CHECK ENGINE LIGHT', 2, cel.available
    ? (cel.rows.length
        ? cel.rows.map(r => '- ' + r.cause + ' | code ' + r.code + ' | ' + r.events
            + ' episode(s), ' + briefN(r.seconds, 2) + ' s, ' + r.occurrence
            + ', first at ' + briefN(r.firstAt, 3) + ' s'
            + (r.protection !== '—' ? ', engine protection ' + r.protection : '')
            + ' | times: ' + r.when)
          .concat(cel.note ? ['note: ' + cel.note] : [])
        : ['lamp never lit in this log'])
    : ['not available: ' + cel.reason]);

  /* ---- 6. drag splits ---- */
  const drag = dragTable(log);
  add('RUN SUMMARY', 3, drag.available
    ? [(drag.rollingStart
        ? 'ROLLING START — the log opens at ' + briefN(drag.startSpeedKmh, 1) + ' km/h, so these '
          + 'are times to travel that far from the start of the recording, NOT drag splits'
        : 'standing start, timing from first movement')
      + ' (speed channel: ' + drag.channel + ', ' + briefN(drag.totalFt, 0) + ' ft travelled)']
      .concat(drag.rows.map(r => '- ' + r.dist + ': ' + r.time + ' s at ' + r.speed + ' km/h'))
    : ['not available: ' + drag.reason]);

  /* ---- 7. the fuel map itself ---- */
  const gridRows = opts.gridRows ?? 80;
  const grid = (res.grid || []).slice().sort((a, b) => a.rpm - b.rpm || a.load - b.load);
  add('MEASURED VS TARGET BY CELL (rpm x manifold kPa)', 2, [
    'columns: rpm | load kPa | boost psi | samples | measured lambda | target lambda | '
      + 'lean% (>0 = leaner than target) | mean duty% | duty% after the suggested correction | '
      + 'confidence%. Positive lean% means ADD that much fuel.',
    ...grid.slice(0, gridRows).map(g => [
      g.rpm, briefN(g.load, 0), briefN(g.boostPsi, 1), g.n, briefN(g.measured, 3),
      briefN(g.target, 3), briefN(g.leanErrPct, 1), briefN(g.injDuty, 1),
      briefN(g.dutyAfter, 1) + (g.dutyLimited ? ' OVER-CEILING' : ''), g.confidence,
    ].join(' | ')),
    grid.length > gridRows ? '(' + (grid.length - gridRows) + ' further cells not listed)' : '',
  ]);

  /* ---- 8. the trace ---- */
  const traceRows = opts.traceRows ?? 90;
  const pick = (...names) => col(log, ...names);
  const traceCols = [
    ['rpm', pick('RPM', 'Filtered RPM'), 0],
    ['tps%', pick('Throttle Position'), 0],
    ['MAPkPa', pick('Manifold Pressure'), 0],
    ['lambda', pick('Wideband O2 1', 'Wideband Maximum'), 3],
    ['tgtLambda', pick('Target Lambda'), 3],
    ['duty%', pick('Injector 1 Duty Cycle'), 1],
    ['ignDeg', pick('Ignition Angle'), 1],
    ['knockRet', pick('Knock Control Bank 1 Ignition Correction', 'Knock Control Ignition Correction'), 1],
    ['knockLvl', pick('Knock Sensor 1 Knock Level', 'Knock Input 1 FFT.'), 1],
    ['railkPa', pick('Fuel Pressure', 'Fuel Pressure 1', 'Fuel Pressure Sensor'), 0],
    ['battV', pick('Battery Voltage'), 2],
    ['5Vref', pick('Diagnostic Analogue 5V rail'), 2],
    ['IATc', pick('Intake Air Temperature'), 0],
    ['CLTc', pick('Coolant Temperature'), 0],
    ['kmh', pick('Vehicle Speed', 'Vehicle Speed GPS', 'Ground Speed'), 0],
    ['bstDuty%', pick('Boost Control Solenoid Duty Cycle'), 0],
  ].filter(c => c[1] >= 0);

  const step = Math.max(1, Math.ceil(winRows.length / traceRows));
  const traceLines = [];
  for (let i = 0; i < winRows.length; i += step) {
    const r = winRows[i];
    traceLines.push([briefN(r.t, 3)]
      .concat(traceCols.map(c => briefN(r.values[c[1]], c[2]))).join(','));
  }
  add('TRACE (DECIMATED — every ' + step + (step === 1 ? 'st' : 'th') + ' sample)', 4, [
    'For shape and context only. It is decimated: a dip shorter than '
      + briefN(step / (hz || 1), 3) + ' s can fall between two of these rows, so never '
      + 'conclude "nothing happened here" from it — the EVENTS section above is the '
      + 'full-rate view.',
    't,' + traceCols.map(c => c[0]).join(','),
    ...traceLines,
  ]);

  /* ---- 9. what else the ECU is logging ---- */
  const names = (log.channels || []).map(c => c.name);
  /* Generic resource names carry no meaning on their own, and the answer is
   * wrong if AVI2 is read as "some input" when it is the surge tank float.
   * One line per RESOURCE, not per channel — AVI2 has three channels. */
  const wired = [];
  const seenPins = new Set();
  for (const n of names) {
    const p = pinFor(n);
    if (!p || seenPins.has(p.generic)) continue;
    seenPins.add(p.generic);
    wired.push(p.generic + ' = ' + p.fn + ' (pin ' + p.pin + ')');
  }
  add('CHANNELS LOGGED (' + names.length + ')', 5, [
    'Every channel in this file. Anything NOT in this list was not recorded, so if the '
      + 'answer needs it, say so and say to add it to the log list.',
    names.join(', '),
    wired.length
      ? 'WHAT THE GENERIC ONES ARE WIRED TO (from the car\'s pin map — a raw pin channel '
        + 'is the same wire as its functional channel, read before the ECU\'s channel setup '
        + 'is applied): ' + wired.join('; ') + '.'
      : '',
  ]);

  /* ---- assemble, dropping the cheapest sections first if over budget ---- */
  const dropped = [];
  let parts = S.slice();
  const render = list => list.map(x => x.text).join('\n\n');
  while (utf8Len(render(parts)) > maxBytes && parts.length > 1) {
    const worst = parts.reduce((m, x) => (x.priority > m.priority ? x : m), parts[0]);
    if (worst.priority <= 1) break;             // never drop the analysis itself
    parts = parts.filter(x => x !== worst);
    dropped.push(worst.name);
  }
  let text = render(parts);
  if (dropped.length) {
    text += '\n\n## SECTIONS OMITTED FOR SIZE\n'
      + dropped.join(', ') + ' — omitted to fit the prompt budget, not because they were empty.';
  }
  return {
    text,
    bytes: utf8Len(text),
    sections: parts.map(p => p.name),
    droppedSections: dropped,
    events: ev,
    res,
  };
}
