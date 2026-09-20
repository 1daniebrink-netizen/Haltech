import { readFileSync } from "node:fs";
import { parseLog, buildLogBrief } from "../src/core.js";
const files = process.argv.slice(2);
for (const f of files) {
  try {
    const log = parseLog(readFileSync(f, "latin1"));
    const b = buildLogBrief(log, { fileName: f.split(/[\\/]/).pop() });
    const ctrl = [...b.text].filter(c => { const n = c.charCodeAt(0); return n < 32 && c !== "\n" && c !== "\t"; });
    const lone = [...b.text].filter(c => { const n = c.charCodeAt(0); return n >= 0xd800 && n <= 0xdfff; });
    const hi = [...new Set([...b.text].filter(c => c.charCodeAt(0) > 126))].slice(0, 12);
    console.log(b.bytes.toString().padStart(7), "B |", String(ctrl.length).padStart(4), "ctrl |",
      String(lone.length).padStart(3), "lone-surrogate |", JSON.stringify(hi.join("")), "|", f.split(/[\\/]/).pop());
    if (ctrl.length) console.log("      ctrl codes:", [...new Set(ctrl.map(c => c.charCodeAt(0)))].join(","));
  } catch (e) { console.log("FAILED", f.split(/[\\/]/).pop(), e.message); }
}
