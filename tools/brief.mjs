/*
 * Print the evidence brief the published page sends to Claude, for one log.
 *
 *   node tools/brief.mjs "<log.csv>" [--t0 3.2] [--t1 6.8] [--events] [--bytes]
 *
 * This is the same buildLogBrief() the artifact calls, so what prints here is
 * exactly what the model is asked to reason over — the point being that the
 * brief is inspectable OUTSIDE the browser, where it can be diffed against the
 * raw CSV. A question answered wrongly is usually a brief missing something,
 * not the model being stupid, and this is where you look first.
 */

import { readFileSync } from 'node:fs';
import { parseLog, buildLogBrief, detectEvents } from '../src/core.js';

const args = process.argv.slice(2);
const path = args.find(a => !a.startsWith('--'));
if (!path) {
  console.error('usage: node tools/brief.mjs "<log.csv>" [--t0 s] [--t1 s] [--events] [--bytes]');
  process.exit(1);
}
const numArg = name => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : undefined;
};

const log = parseLog(readFileSync(path, 'latin1'));
const t0 = numArg('t0'), t1 = numArg('t1');
const brief = buildLogBrief(log, { fileName: path.split(/[\\/]/).pop(), t0, t1 });

if (args.includes('--events')) {
  const ev = brief.events;
  console.log('events: available=' + ev.available + '  window '
    + ev.window?.t0.toFixed(2) + '-' + ev.window?.t1.toFixed(2) + ' s  '
    + (ev.sampleHz ? ev.sampleHz.toFixed(0) + ' Hz' : ''));
  console.log('counts: ' + JSON.stringify(ev.counts));
  console.log('listed: ' + ev.events.length + '  dropped: ' + ev.dropped);
  for (const e of ev.events) console.log('  ' + e.t.toFixed(3) + 's [' + e.severity + '] '
    + e.kind + ': ' + e.detail);
} else if (args.includes('--bytes')) {
  console.log('bytes: ' + brief.bytes);
  console.log('sections: ' + brief.sections.join(', '));
  if (brief.droppedSections.length) console.log('dropped: ' + brief.droppedSections.join(', '));
} else {
  console.log(brief.text);
  console.error('\n[' + brief.bytes + ' bytes, sections: ' + brief.sections.join(', ')
    + (brief.droppedSections.length ? '; dropped: ' + brief.droppedSections.join(', ') : '') + ']');
}
