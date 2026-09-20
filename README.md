# Haltune

Browser-based analyzer for Haltech NSP datalogs (`.csv` exports from a Nexus / Elite ECU).
Drop a log on the page and everything runs client-side — parsing, decoding, AFR/boost
correction grid, hardware-limit gating, drag splits, check-engine-light table and channel graphs.

Subject car: 4G63T 2.3 stroker, Haltech Elite 1500, FTI Powerglide. See `docs/vehicle-spec.md`.

## Layout

| path | what it is |
|---|---|
| `src/core.js` | the analysis engine — parse, decode, limits, corrections, events. No imports, no DOM, so it runs in Node and in the browser unchanged. **Single source of truth.** |
| `src/panels.js`, `src/charts.js` | graph panels and the shared chart engine |
| `src/app.js`, `src/template.html` | the standalone single-file build |
| `src/dashboard.html` | local dev dashboard (`node tools/serve.mjs`) |
| `tools/` | build, test and one-off analysis scripts |
| `artifact/haltune.html` | the published page; **generated — never hand-edit the engine section** |
| `artifact/check.mjs` | pre-publish gate: syntax, engine parity, boots against a stub DOM, asserts charts/splits/decoding |
| `docs/vehicle-spec.md` | vehicle hard limits, the source for `VEHICLE` in `core.js` |
| `*.jpeg` | primary evidence — dyno sheets and the injector spec sheet, cited by name in `core.js` comments |

## Build

```
node tools/build-artifact.mjs      # inline src/*.js into artifact/haltune.html
node tools/embed-logs.mjs --n 1 --keep Log3056   # re-bundle logs (only needed if TYPE_SCALE changed)
node artifact/check.mjs            # the gate — must exit 0 before publishing
```

`node build.mjs` produces the older standalone `dist/Haltune.html`.
`node tools/test.mjs <log.csv>` runs the engine over a real log and prints the analysis.

Edit `src/core.js` and rebuild. Editing the engine inside `artifact/haltune.html` makes it
drift from source, and `check.mjs` fails the build when it does.
