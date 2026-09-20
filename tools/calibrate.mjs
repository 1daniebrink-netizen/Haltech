// Calibration/inspection script for Haltech NSP CSV datalogs.
// Parses the channel definitions + data rows and dumps stats for key channels
// so we can work out the integer->real scaling per channel Type.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: node calibrate.mjs <log.csv>'); process.exit(1); }

const text = readFileSync(path, 'latin1');
const lines = text.split(/\r?\n/);

// --- Parse header: channel definitions in order ---
const channels = [];       // { name, id, type, dispMax, dispMin }
let cur = null;
let dataRows = [];
let inData = false;

for (const line of lines) {
  if (line.startsWith('Channel : ')) {
    if (cur) channels.push(cur);
    cur = { name: line.slice(10).trim(), id: null, type: null, dispMax: null, dispMin: null };
  } else if (line.startsWith('ID : ') && cur) {
    cur.id = Number(line.slice(5).trim());
  } else if (line.startsWith('Type : ') && cur) {
    cur.type = line.slice(7).trim();
  } else if (line.startsWith('DisplayMaxMin : ') && cur) {
    const [mx, mn] = line.slice(16).split(',').map(Number);
    cur.dispMax = mx; cur.dispMin = mn;
  } else if (/^\d{2}:\d{2}:\d{2}\.\d+,/.test(line)) {
    // a data row: HH:MM:SS.mmm,v0,v1,...
    if (cur) { channels.push(cur); cur = null; }  // flush last channel def
    inData = true;
    dataRows.push(line);
  }
}
if (cur) channels.push(cur);

console.log(`channels: ${channels.length}, dataRows: ${dataRows.length}`);

// Build column values matrix only for channels of interest
const KEY = {
  'Fuel - Load': 14,
  'Target Lambda': 31,
  'Ignition Angle': 47,
  'RPM': 61,
  'Injector 1 Duty Cycle': 92,
  'Wideband O2 1': 213,
  'Manifold Pressure': 216,
  'Intake Air Temperature': 224,
  'Coolant Temperature': 225,
  'Battery Voltage ': 230,
  'Boost Control Actual Pressure': 371,
  'Boost Control Target Pressure': 382,
  'Throttle Position': 16,
};

// Verify our column indices match the parsed channel order
console.log('\n--- verifying key channel indices ---');
for (const [name, idx] of Object.entries(KEY)) {
  const ch = channels[idx];
  const ok = ch && ch.name === name.trim();
  console.log(`col ${idx}: parsed="${ch ? ch.name : '?'}" type=${ch ? ch.type : '?'} ${ok ? 'OK' : '*** MISMATCH (want ' + name + ')'}`);
}

function stats(colIndex) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  const samples = [];
  for (const row of dataRows) {
    const parts = row.split(',');
    const v = Number(parts[colIndex + 1]); // +1 for leading timestamp
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n++;
    if (samples.length < 8 && n % 300 === 0) samples.push(v);
  }
  return { min, max, mean: n ? (sum / n) : NaN, samples };
}

console.log('\n--- raw integer stats for key channels ---');
for (const [name, idx] of Object.entries(KEY)) {
  const s = stats(idx);
  const ch = channels[idx];
  console.log(`${name.padEnd(32)} type=${(ch?.type||'').padEnd(16)} min=${s.min} max=${s.max} mean=${s.mean.toFixed(1)} samples=[${s.samples.join(', ')}]`);
}

// Distinct Types present (to design a scaling table)
const types = {};
for (const c of channels) types[c.type] = (types[c.type] || 0) + 1;
console.log('\n--- distinct channel Types (count) ---');
console.log(Object.entries(types).sort((a,b)=>b[1]-a[1]).map(([t,c])=>`${t}:${c}`).join('  '));
