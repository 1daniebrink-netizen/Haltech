# Vehicle Specification — Haltune subject car

Fill in what you know. Leave `?` where unknown — an honest `?` is more useful than a
guess, because it tells me which conclusions to hedge.

**[H]** = high leverage: changes the analysis the most.
**[L]** = context: useful, rarely changes a recommendation.

---

## 1. Identity & base engine

| Field | Value |
|---|---|
| Engine code / variant **[H]** | Gen 2, 7 bolt, Mitsubishi 4g63T with stroker crank |
| Displacement / bore × stroke | 85.5mm x 100mm |
| Static compression ratio **[H]** | 8.5 |
| Head gasket thickness | 1.3mm Athena cut ring|
| Pistons / rods **[H]** | Carrillo forged pistons - part number SC7253, Nitto forged conrods, 150mm |
| Head work / valve sizes | Intake, 34mm, Exhaust, 30.5mm - Ferrea F6026 and F6025 stainless steel valves |
| Cams — duration, lift, LSA **[H]** | Kelford part number 4-TX272R, duration at 0.1mm = 272 degrees, net valve lift  = 11.75mm |
| Adjustable cam gears / VVT **[L]** | Adjustable, not VVT. Intake centreline at 107 ATDC and exhaust at 113 BTDC |
| Rebuilt when / mileage since **[L]** | 1000km |

## 2. Airflow & boost

| Field | Value |
|---|---|
| Turbo model + comp/turbine housing A/R **[H]** | Turbosmart, TS-2, T4 twin scroll, 6466, externally waste gated, 1.00 AR , SKU TS-2-6466B-D4100E |
| Manifold — log / tubular, material **[L]** | tubular, schedule 10 stainless steel, 4 to 2 to 1 merge, 42mmØ|
| Wastegate — internal / external, spring pressure **[H]** | External, 2 x 40mm Turbosmart waste gates, 14 psi springs|
| Boost control — solenoid type, open or closed loop **[H]** | Mac valve, closed loop|
| Intercooler — type, core size | Fenix, 600 x 300 x 100 mm |
| **IAT sensor location [H]** | post-intercooler |
| MAP sensor range **[H]** | 4 bar absolute |
| Intake / filter, MAF deleted? | No MAF - calculates speed density |
| Exhaust — dump pipe Ø, full system Ø, catted? | dump pipe 89mmØ, full system 89mmØ, no cat |

## 3. Fuel system

| Field | Value |
|---|---|
| Injectors — make, model, rated cc @ pressure **[H]** | **Bosch 1550cc high-impedance, MSEL `INJBOS1550S`, 8.8 Ω, peak/hold 4.00.** Flow vs differential (MSEL sheet, 2026-08-09): 3 bar 1584 · **4 bar 1840** · 5 bar 2056 · 6 bar 2236 cc/min. Pure √ΔP from 1584 @ 3 bar, so `flow(ΔP bar) = 1584 × √(ΔP/3)`. |
| Injector characterisation loaded in ECU? **[H]** | 940 µs dead time at 14 V / 4 bar — matches the MSEL sheet. Full table (µs), rows 3/4/5/6 bar: 10 V 1460/1700/2100/2680 · 12 V 1060/1260/1400/1600 · **14 V 820/940/1060/1200** · 15 V 680/780/880/1000 |
| Fuel pump(s) + wiring upgrade **[H]** | 2 x 370 LPH at 3 bar (8 bar max) 12V pumps, second pump activates with Ethanol and boost limits |
| Base fuel pressure + FPR type **[H]** | +4 bar relative to manifold pressure |
| Fuel pressure *sensor* logged? **[H]** | Honeywell sensor, logged |
| Line sizes, return / returnless | AN 8 feed and AN 6 return |
| Fuel — pump 98 / E85 / blend; measured ethanol % **[H]** | Continental flex fuel sensor, runs pump 95 up to ethanol blend, ~E85 |
| Stoich value configured in ECU **[H]** | ~9.7 for E85 |
| Flex fuel sensor fitted? | yes |

## 4. ECU & sensors

| Field | Value |
|---|---|
| Haltech model **[H]** | Elite 1500 |
| Firmware / NSP version **[L]** | NSP |
| Wideband controller + sensor **[H]** | WB1 - LSU 4.9 |
| Wideband sensor location in exhaust **[H]** | 500mm after turbo |
| Knock detection — module, sensors, or external **[H]** | block mounted knock sensor |
| Trigger setup **[H]** | Factory 4G63 Crank and Cam angle sensors |
| Other logged sensors | engine oil press, Transmission oil pressure, engine coolant temp, Transmission oil temp, Exhaust manifold pressure, coolant system pressure, TPS, GPS vehicle speed |


## 5. Drivetrain & operating context

| Field | Value |
|---|---|
| Gearbox + final drive **[L]** | FTI level 5 Powerglide, 3,727:1 final drive |
| Tyre size **[L]** | 295x50r15 |
| Vehicle weight **[L]** | 1600kg |
| Dyno access + type **[H]** | no |
| Intended use **[H]** | drag |

## 6. Targets & hard limits

The numbers recommendations are held against.

| Field | Value |
|---|---|
| Power goal **[H]** | 800hp |
| Max boost target **[H]** | 36psi |
| Redline **[H]** | ~8000 |
| Max injector duty cycle **[H]** | 95% |
| Max IAT before pulling timing / boost | ? |
| Max ECT | 105 |
| Min fuel pressure differential | **±5% of target** (target = ECU `Fuel Pressure Expected`, else 400 kPa base). Set 2026-09-13: the regulator's job is to hold the differential constant, so a departure either way is a fault. Low = starvation, high = stuck regulator / blocked return. |
| Max EGT (if measured) | ? |

## 7. Current state & known issues

Free text. What's in the tune now, what's misbehaving, what's already been ruled out.
Worth writing down: lean spike at a specific RPM/load, boost creep above X, fuel
pressure drop at high RPM, a cylinder that always reads different.

- The flex fuel sensor appears to fluctuate periodically
- The engine, when accelerated hard on E85, triggers an engine protection. 
- The ECU reports a voltage error on the 5V circuit - P0641 and P0642

---

## 8. Log channel checklist

Beyond specs, the biggest single lever on analysis quality is **which channels are
enabled in the NSP log**. Confirm these are being logged:

- [ ] RPM, Manifold Pressure, Throttle Position
- [ ] Lambda (measured) **and** Lambda Target — both are needed to compute a correction
- [ ] Injector Duty Cycle / Pulse Width
- [ ] Ignition Angle
- [ ] **Fuel Pressure** — distinguishes a lean tune from a fuel system running out
- [ ] IAT and ECT
- [ ] Knock level / retard, if available
- [ ] Battery Voltage — affects injector dead time
- [ ] Gear or vehicle speed — separates steady-state from transient pulls

---

## 9. Derived figures (computed from section 1–6, 2026-07-27)

Not user input — calculated, and recalculated whenever the spec above changes.

| Figure | Value | Method |
|---|---|---|
| Displacement | **2296.6 cc** | π/4 × 85.5² × 100 × 4 |
| Cam LSA | **110°** | (107 + 113) / 2 |
| Cam install | **3° advanced** vs straight-up 110/110 | |
| Valve events @ 0.1mm | IO 29° BTDC, IC 63° ABDC, EO 69° BBDC, EC 23° ATDC | centreline ± half-duration |
| Overlap @ 0.1mm | **52°** | 29 + 23 |
| Rod ratio | **1.50** (was 1.70 stock) | 150 mm rod / 100 mm stroke |
| MAP sensor ceiling | **43.4 psi gauge** (400 kPa abs − 101 baro) | |
| MAP headroom at 36 psi target | **7.3 psi** — adequate | |
| Injector duty at 800 hp | **68–74%** (BSFC 0.65–0.70, E85 ρ 0.782) | 800 × BSFC / 4 / 190 lb/hr-per-inj |
| Rail pressure at 36 psi boost | **~94 psi / 6.5 bar** | 4 bar base + 36 psi manifold |
| Fuel demand at 800 hp | **~302 L/hr** | 5027 cc/min total |
| Pump headroom at 6.5 bar | pumps rated 370 L/hr @ **3 bar**; flow at 6.5 bar unknown | needs the pump's flow curve |
| Mean piston speed at 8000 rpm | **26.7 m/s** | 2 × 0.1 m × 8000 / 60 |

Two notes on the derived numbers:

- **Rod ratio 1.50 is low** (stock 4G63 is 1.70). Combined with 26.7 m/s mean piston
  speed at 8000 rpm, that means high piston side-load and thrust-face wear. Fine for
  drag duty in short bursts; it is a reason not to extend the rev limit further.
- **Pump margin is the remaining unknown.** 370 L/hr is a 3 bar rating and the rail
  sits near 6.5 bar at target boost, well down the curve. Demand is ~302 L/hr, so two
  pumps should cover it — but only if both stage and voltage holds. You log fuel
  pressure, so this is directly measurable rather than assumed.

## 10. Open questions

- [ ] Second-pump staging thresholds (ethanol % and boost/pressure trigger points) —
      relevant to the engine-protection fault
- [ ] Fuel pump flow curve at 6–7 bar (rated figure is at 3 bar)
- [ ] Section 8 checklist — none ticked; confirm what is actually being logged.
      Note IAT and battery voltage are not in the section 4 sensor list
- [ ] Max IAT, min fuel pressure differential, max EGT still `?`

Answered 2026-07-27: rod length (Nitto 150 mm), final drive (3.727), pump rating
(370 L/hr @ 3 bar), stoich (9.7 for E85), boost target revised 40 → 36 psi.

## 11. Limits wired into the analyzer

`src/core.js` exports a `VEHICLE` constant carrying the hard limits from sections 2, 3
and 6. Samples that violate a **blocking** limit are excluded from fuel corrections,
because a lean reading at a hardware limit is not a calibration error:

| Limit | Source | Effect |
|---|---|---|
| MAP ceiling 400 kPa abs | §2 sensor range | blocking — load axis value is a floor, not a value |
| Injector duty 95% | §6 | blocking — injectors cannot deliver the correction |
| Fuel differential more than 5% **below** target | §3 base pressure, or the ECU's `Fuel Pressure Expected` channel when logged | blocking — starvation; enforced at every load, not just on boost |
| Fuel differential more than 5% **above** target | as above | advisory — stuck regulator or restricted return |
| Sensor plausibility bounds | §7 5V fault | blocking — MAP/TPS/fuel/battery outside physical range |
| Boost > 36 psi, RPM > 8000, IAT > 60 °C, ECT > 105 °C | §6 | advisory |
| Flex sensor instability, battery sag | §7 | advisory |

Changing a number in section 2/3/6 above means changing `VEHICLE` in `src/core.js` to
match — they are not yet auto-linked.
