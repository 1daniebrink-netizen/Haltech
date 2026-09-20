// Node test harness: validate the core engine against a real NSP log.
import { readFileSync } from 'node:fs';
import { parseLog, extractSamples, analyze, lambdaToAfr } from '../src/core.js';

const path = process.argv[2];
const text = readFileSync(path, 'latin1');
const log = parseLog(text);

console.log('=== META ===');
console.log(log.meta);
console.log(`channels=${log.channels.length} rows=${log.rows.length}`);

const { samples } = extractSamples(log);
const running = samples.filter(s => s.rpm > 1500);
console.log(`\n=== sanity: a few running samples ===`);
for (const s of running.filter((_, i) => i % Math.ceil(running.length / 6) === 0).slice(0, 6)) {
  console.log(
    `t=${s.t.toFixed(1)}s rpm=${s.rpm|0} load=${s.load.toFixed(0)}kPa boost=${s.boostPsi.toFixed(1)}psi ` +
    `tgtλ=${s.target.toFixed(2)} measλ=${s.measured.toFixed(2)} AFRtgt=${s.afrTarget.toFixed(1)} AFRmeas=${s.afrMeasured.toFixed(1)} ` +
    `tps=${s.throttle.toFixed(0)}% inj=${s.injDuty.toFixed(0)}% ign=${s.ign.toFixed(1)} clt=${s.clt.toFixed(0)}C iat=${s.iat.toFixed(0)}C`
  );
}

const res = analyze(log);
console.log(`\n=== ANALYSIS ===`);
console.log('counts', res.counts, 'stoich', res.stoich.toFixed(1));
console.log('summary', res.summary);

console.log(`\n=== HARDWARE LIMITS (${res.vehicle.name}) ===`);
console.log('excluded', res.excluded);
console.log('dataQuality', res.dataQuality);
if (!res.dataQuality.usable) {
  console.log('\n  ** LOG NOT SUITABLE FOR TUNING — fix the blocking faults and re-log **');
}
for (const w of res.warnings) {
  const tag = (w.blocking ? 'BLOCK' : w.severity === 'info' ? 'info ' : 'warn ').padEnd(5);
  console.log(`\n  [${tag}] ${w.title}  (${w.hits} samples${w.pctOfLog != null ? `, ${w.pctOfLog}%` : ''})`);
  console.log(`          ${w.detail}`);
}
if (!res.warnings.length) console.log('  (none — all samples within the declared envelope)');

console.log(`\n=== TOP DANGER CELLS (lean under boost) ===`);
for (const d of res.danger.slice(0, 12)) {
  console.log(
    `${String(d.rpm).padStart(5)}rpm @ ${d.boostPsi.toFixed(1).padStart(5)}psi (${d.load|0}kPa)  ` +
    `measλ=${d.measured.toFixed(3)} tgtλ=${d.target.toFixed(3)}  ` +
    `AFR ${d.afrMeasured.toFixed(1)} vs ${d.afrTarget.toFixed(1)}  ` +
    `LEAN +${d.leanErrPct.toFixed(1)}%  -> add ${d.pctChange.toFixed(1)}% fuel  ` +
    `[n=${d.n} conf=${d.confidence}% sev=${d.severity.toFixed(1)} ${d.cause}` +
    `${d.dutyLimited ? ` DUTY->${d.dutyAfter.toFixed(0)}%` : ''}]`
  );
}
if (!res.danger.length) console.log('(none — no lean-under-boost cells found)');

console.log(`\n=== FULL CORRECTION GRID (cells needing >3% change) ===`);
const big = res.grid.filter(g => Math.abs(g.pctChange) > 3).sort((a,b)=>Math.abs(b.pctChange)-Math.abs(a.pctChange));
for (const g of big.slice(0, 20)) {
  const dir = g.pctChange > 0 ? 'LEAN add' : 'RICH cut';
  console.log(`${String(g.rpm).padStart(5)}rpm ${(g.load|0).toString().padStart(3)}kPa: measλ ${g.measured.toFixed(3)} vs tgt ${g.target.toFixed(3)} -> ${dir} ${Math.abs(g.pctChange).toFixed(1)}% [n=${g.n}]`);
}
