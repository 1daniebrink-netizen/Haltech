/* Haltune UI. Depends on core.js functions (in scope after bundling):
   parseLog, extractSamples, analyze, lambdaToAfr, kpaToPsi, makeAxis  */

const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

const state = {
  log: null,          // parsed log
  fileName: '',
  res: null,          // analysis result
  display: 'lambda',  // 'lambda' | 'afr'
  opts: { minSamples: 4, leanThreshPct: 3, minClt: 60 },
};

// ---------- theme ----------
$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const now = root.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
});

// ---------- file handling ----------
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
$('#fileTop').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); });

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const log = parseLog(reader.result);
      if (!log.rows.length) throw new Error('No data rows found — is this a Haltech NSP CSV log?');
      state.log = log; state.fileName = file.name;
      $('#err').classList.add('hidden');
      run();
    } catch (err) {
      $('#app').classList.add('hidden');
      const e = $('#err'); e.classList.remove('hidden');
      e.textContent = 'Could not read log: ' + err.message;
    }
  };
  reader.readAsText(file, 'latin1');
}

// ---------- run analysis + render ----------
function run() {
  state.res = analyze(state.log, { ...state.opts });
  render();
}

// ---------- color scale (diverging: rich<->target<->lean) ----------
// input: lean error % (measured/target-1)*100. negative=rich, positive=lean.
function afrColor(leanPct) {
  const stops = [
    [-8, [58, 160, 255]],   // rich  (blue)
    [0,  [53, 196, 106]],   // on target (green)
    [4,  [255, 176, 32]],   // warn  (amber)
    [10, [255, 77, 77]],    // crit  (red)
  ];
  const x = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], leanPct));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (x >= a && x <= b) {
      const t = (x - a) / (b - a);
      const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(53,196,106)';
}

const fmtLambda = v => v.toFixed(3);
const fmtAfr = (lambda, stoich) => (lambda * stoich).toFixed(1);
const boostLabel = kpa => { const p = kpaToPsi(kpa); return (p >= 0 ? '+' : '') + p.toFixed(0); };

function render() {
  const res = state.res, app = $('#app');
  app.classList.remove('hidden');
  app.innerHTML = '';

  app.appendChild(controlsBlock());
  if (res.warnings.length) app.appendChild(warningsBlock(res));
  app.appendChild(statsBlock(res));
  if (res.danger.length) app.appendChild(dangerBlock(res));
  app.appendChild(heatmapBlock(res));
  app.appendChild(recTableBlock(res));
  app.appendChild(scatterBlock(res));

  $('#foot').textContent = `${state.fileName}  ·  ${res.counts.valid}/${res.counts.total} samples used  ·  fuel stoich ${res.stoich.toFixed(2)}  ·  analysis is advisory — verify before committing to the ECU`;
  wireTooltips();
}

// ---------- controls ----------
function controlsBlock() {
  const wrap = el('div', 'controls');
  // display toggle
  const seg = el('div', 'ctl');
  seg.appendChild(el('label', 'label', 'Display'));
  const sw = el('div', 'seg');
  ['lambda', 'afr'].forEach(m => {
    const b = el('button', state.display === m ? 'on' : '', m === 'lambda' ? 'λ Lambda' : 'AFR');
    b.onclick = () => { state.display = m; render(); };
    sw.appendChild(b);
  });
  seg.appendChild(sw);
  wrap.appendChild(seg);

  wrap.appendChild(slider('Min samples / cell', 'minSamples', 1, 12, 1, state.opts.minSamples));
  wrap.appendChild(slider('Lean warning ≥ %', 'leanThreshPct', 1, 8, 0.5, state.opts.leanThreshPct));
  wrap.appendChild(slider('Warm engine ≥ °C', 'minClt', 0, 90, 5, state.opts.minClt));
  return wrap;
}
function slider(labelText, key, min, max, step, value) {
  const c = el('div', 'ctl');
  c.appendChild(el('label', 'label', labelText));
  const row = el('div'); row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '8px';
  const inp = el('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  const val = el('span', 'val', String(value));
  inp.oninput = () => { val.textContent = inp.value; };
  inp.onchange = () => { state.opts[key] = Number(inp.value); run(); };
  row.appendChild(inp); row.appendChild(val);
  c.appendChild(row);
  return c;
}

// ---------- stats ----------
function statsBlock(res) {
  const s = res.summary;
  const sec = section('Session summary', '');
  const g = el('div', 'stats');
  const add = (k, unit, label, cls) => {
    const st = el('div', 'stat' + (cls ? ' ' + cls : ''));
    st.appendChild(el('div', 'k', `${k}${unit ? `<small>${unit}</small>` : ''}`));
    st.appendChild(el('div', 'l label', label));
    g.appendChild(st);
  };
  add(s.maxBoostPsi.toFixed(1), 'psi', 'Peak boost');
  add(Math.round(s.maxRpm), 'rpm', 'Max RPM');
  add(res.stoich.toFixed(1), '', 'Fuel stoich', 'good');
  add(s.cellsCovered, '', 'Cells covered');
  add(res.danger.length, '', 'Lean-boost warnings', res.danger.length ? 'alert' : 'good');
  add(s.worstLeanPct ? '+' + s.worstLeanPct.toFixed(1) : '0', '%', 'Worst lean error', s.worstLeanPct > 4 ? 'alert' : '');
  sec.appendChild(g);
  return sec;
}

// ---------- hardware limits / data integrity ----------
function warningsBlock(res) {
  const crit = res.warnings.filter(w => w.severity === 'critical');
  const sec = section('Hardware limits & data integrity',
    `${res.vehicle.name} · ${res.warnings.length} finding${res.warnings.length > 1 ? 's' : ''}`);

  // If the log itself is untrustworthy, say so before anything else on the page.
  if (!res.dataQuality.usable) {
    const stop = el('div', 'card');
    stop.style.setProperty('--sev', 'var(--crit)');
    stop.style.marginBottom = '10px';
    stop.innerHTML =
      `<span class="pill crit">do not tune off this log</span>
       <div class="detail" style="margin-top:6px">
         ${res.dataQuality.blockedPct}% of boosted samples failed a hardware sanity check
         (${res.dataQuality.boostedBlocked} of ${res.dataQuality.boostedSamples}).
         Fuel corrections below are fitted to what survived and should be treated as
         indicative only — fix the faults listed here, re-log, then re-analyse.
       </div>`;
    sec.appendChild(stop);
  }

  const cards = el('div', 'cards');
  res.warnings.forEach(w => {
    const isCrit = w.severity === 'critical';
    const c = el('div', 'card');
    c.style.setProperty('--sev', isCrit ? 'var(--crit)' : 'var(--warn)');
    const share = w.pctOfLog != null ? ` · ${w.pctOfLog}% of log` : '';
    c.innerHTML =
      `<span class="pill ${isCrit ? 'crit' : 'warn'}">${w.blocking ? 'blocking' : 'advisory'}</span>
       <div class="cond" style="margin-top:6px">${w.title}</div>
       <div class="detail">${w.detail}</div>
       <div class="fix">${w.hits} sample${w.hits === 1 ? '' : 's'} affected${share}</div>`;
    cards.appendChild(c);
  });
  sec.appendChild(cards);
  if (crit.length) {
    const note = el('div', 'legend');
    note.innerHTML = `<span>Samples flagged <b>blocking</b> are excluded from the fuel corrections below — `
      + `a lean reading at a hardware limit is not a calibration error.</span>`;
    sec.appendChild(note);
  }
  return sec;
}

// ---------- danger ----------
function dangerBlock(res) {
  const sec = section('Lean-under-boost warnings', res.danger.length + ' cell' + (res.danger.length > 1 ? 's' : ''));
  const cards = el('div', 'cards');
  res.danger.slice(0, 9).forEach(d => {
    const crit = d.leanErrPct >= 5;
    const c = el('div', 'card');
    c.style.setProperty('--sev', crit ? 'var(--crit)' : 'var(--warn)');
    const disp = state.display === 'afr'
      ? `AFR ${fmtAfr(d.measured, res.stoich)} vs ${fmtAfr(d.target, res.stoich)} target`
      : `λ ${fmtLambda(d.measured)} vs ${fmtLambda(d.target)} target`;
    c.innerHTML =
      `<span class="pill ${crit ? 'crit' : 'warn'}">${crit ? 'critical' : 'caution'}</span>
       <div class="cond" style="margin-top:6px">${d.rpm} rpm @ ${boostLabel(d.load)} psi</div>
       <div class="detail">${disp}<br>lean by ${d.leanErrPct.toFixed(1)}% · ${d.n} samples · ${d.confidence}% conf.</div>
       <div class="fix">${d.cause === 'capacity'
         ? `Needs <b>${d.pctChange.toFixed(1)}% fuel</b> — but that is ${d.dutyAfter.toFixed(0)}% duty, past the ${res.vehicle.maxInjDutyPct}% limit`
         : `Add <b>${d.pctChange.toFixed(1)}% fuel</b> to this zone`}</div>`;
    cards.appendChild(c);
  });
  sec.appendChild(cards);
  return sec;
}

// ---------- heatmap ----------
function heatmapBlock(res) {
  const sec = section('AFR map — measured vs target', 'RPM × manifold pressure');
  const panel = el('div', 'panel');
  // lookup by rpm,load
  const map = new Map();
  res.grid.forEach(g => map.set(g.rpm + ':' + g.load, g));
  const R = res.rpmAxis, L = [...res.loadAxis].reverse(); // high boost at top

  const hm = el('div', 'hm');
  hm.style.gridTemplateColumns = `auto repeat(${R.length}, 1fr)`;

  // corner
  const corner = el('div', 'axis corner');
  corner.innerHTML = `<span>kPa \\ RPM</span>`;
  hm.appendChild(corner);
  R.forEach(rpm => hm.appendChild(el('div', 'axis', String(rpm))));

  L.forEach(load => {
    const rh = el('div', 'axis corner');
    rh.innerHTML = `<span>${load}</span><span style="color:var(--faint)">${boostLabel(load)}psi</span>`;
    hm.appendChild(rh);
    R.forEach(rpm => {
      const g = map.get(rpm + ':' + load);
      if (!g) { hm.appendChild(el('div', 'cell empty', '·')); return; }
      const cell = el('div', 'cell');
      cell.style.background = afrColor(g.leanErrPct);
      const main = state.display === 'afr' ? fmtAfr(g.measured, res.stoich) : fmtLambda(g.measured);
      const delta = (g.pctChange > 0 ? '+' : '') + g.pctChange.toFixed(1) + '%';
      cell.innerHTML = `<span>${main}</span><span class="v2">${delta}</span>`;
      cell._data = g;
      hm.appendChild(cell);
    });
  });
  panel.appendChild(hm);
  const legend = el('div', 'legend');
  legend.innerHTML = `<span>Rich</span><span class="bar"></span><span>Lean →</span>
    <span style="margin-left:14px">cell = measured ${state.display === 'afr' ? 'AFR' : 'λ'} · below = suggested fuel change</span>`;
  panel.appendChild(legend);
  sec.appendChild(panel);
  return sec;
}

// ---------- recommendation table + export ----------
function recTableBlock(res) {
  const sec = section('Suggested fuel corrections', '% change per cell');
  const head = sec.querySelector('.sec-head');
  const btn = el('button', '', '⤓ Export CSV');
  btn.onclick = () => exportCsv(res);
  head.appendChild(btn);

  const panel = el('div', 'panel');
  const map = new Map();
  res.grid.forEach(g => map.set(g.rpm + ':' + g.load, g));
  const R = res.rpmAxis, L = [...res.loadAxis].reverse();

  const t = el('table', 'grid');
  const thead = el('tr');
  thead.appendChild(el('th', 'rowh', 'kPa \\ RPM'));
  R.forEach(rpm => thead.appendChild(el('th', '', String(rpm))));
  t.appendChild(thead);
  L.forEach(load => {
    const tr = el('tr');
    tr.appendChild(el('td', 'rowh', `${load}`));
    R.forEach(rpm => {
      const g = map.get(rpm + ':' + load);
      const td = el('td');
      if (g) {
        td.textContent = (g.pctChange > 0 ? '+' : '') + g.pctChange.toFixed(1);
        td.style.color = afrColor(g.leanErrPct);
      } else { td.textContent = '·'; td.style.color = 'var(--faint)'; }
      tr.appendChild(td);
    });
    t.appendChild(tr);
  });
  panel.appendChild(t);
  sec.appendChild(panel);
  return sec;
}

function exportCsv(res) {
  const R = res.rpmAxis, L = res.loadAxis;
  const map = new Map(); res.grid.forEach(g => map.set(g.rpm + ':' + g.load, g));
  let out = 'FuelCorrection%,,' + R.join(',') + '\nLoad_kPa\\RPM\n';
  L.forEach(load => {
    const row = [load, ''];
    R.forEach(rpm => { const g = map.get(rpm + ':' + load); row.push(g ? g.pctChange.toFixed(1) : ''); });
    out += row.join(',') + '\n';
  });
  const blob = new Blob([out], { type: 'text/csv' });
  const a = el('a'); a.href = URL.createObjectURL(blob);
  a.download = state.fileName.replace(/\.csv$/i, '') + '_fuel-corrections.csv';
  a.click();
}

// ---------- scatter: measured vs target lambda by boost ----------
function scatterBlock(res) {
  const sec = section('Measured vs target — across the boost range', 'each point = one sample under load');
  const panel = el('div', 'panel');
  const cv = el('canvas'); cv.width = 1100; cv.height = 360; cv.style.width = '100%';
  panel.appendChild(cv);
  sec.appendChild(panel);
  // defer draw until in DOM for correct sizing
  requestAnimationFrame(() => drawScatter(cv, res));
  return sec;
}
function drawScatter(cv, res) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = { l: 54, r: 16, t: 16, b: 40 };
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue('--line').trim();
  const muted = css.getPropertyValue('--muted').trim();
  const { samples } = extractSamples(state.log);
  const pts = samples.filter(s => s.boostPsi > 0 && s.measured > 0.6 && s.measured < 1.3 && s.injDuty > 2 && s.clt > state.opts.minClt);
  const xMax = Math.max(6, ...pts.map(p => p.boostPsi)) * 1.05;
  const yMin = 0.68, yMax = 1.05;
  const X = v => pad.l + (v / xMax) * (W - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.font = '12px ui-monospace, monospace'; ctx.lineWidth = 1;
  // grid + y labels (lambda)
  for (let l = 0.70; l <= 1.05; l += 0.05) {
    const y = Y(l); ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(l.toFixed(2), 12, y + 4);
  }
  // x labels (psi)
  for (let p = 0; p <= xMax; p += 5) { const x = X(p); ctx.fillText(p + '', x - 6, H - pad.b + 18); }
  ctx.fillText('boost (psi) →', W - 110, H - 6);
  ctx.save(); ctx.translate(14, pad.t + 8); ctx.rotate(-Math.PI / 2); ctx.fillText('← λ  (measured)', -120, 0); ctx.restore();

  // target points (hollow) then measured (colored)
  pts.forEach(p => {
    const col = afrColor((p.measured / p.target - 1) * 100);
    ctx.fillStyle = 'rgba(139,152,165,.35)';
    ctx.beginPath(); ctx.arc(X(p.boostPsi), Y(p.target), 2, 0, 7); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(X(p.boostPsi), Y(p.measured), 2.6, 0, 7); ctx.fill();
  });
  // legend
  ctx.fillStyle = muted; ctx.fillText('grey = target λ    colour = measured λ (rich→lean)', pad.l, pad.t + 4);
}

// ---------- helpers ----------
function section(title, count) {
  const sec = el('section');
  const h = el('div', 'sec-head');
  h.appendChild(el('div', 'rule')); // placeholder replaced below
  h.innerHTML = `<h3>${title}</h3>${count ? `<span class="count">${count}</span>` : ''}<div class="rule"></div>`;
  sec.appendChild(h);
  return sec;
}

function wireTooltips() {
  const tip = $('#tip');
  document.querySelectorAll('.hm .cell').forEach(cell => {
    if (!cell._data) return;
    cell.addEventListener('mousemove', e => {
      const g = cell._data, res = state.res;
      tip.style.opacity = 1;
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
      tip.innerHTML =
        `<div class="t-h">${g.rpm} rpm · ${g.load} kPa (${boostLabel(g.load)} psi)</div>
         <div class="t-r"><span>measured</span><b>λ ${fmtLambda(g.measured)} · AFR ${fmtAfr(g.measured, res.stoich)}</b></div>
         <div class="t-r"><span>target</span><b>λ ${fmtLambda(g.target)} · AFR ${fmtAfr(g.target, res.stoich)}</b></div>
         <div class="t-r"><span>error</span><b>${g.leanErrPct > 0 ? 'lean +' : 'rich '}${g.leanErrPct.toFixed(1)}%</b></div>
         <div class="t-r"><span>suggest</span><b>${g.pctChange > 0 ? '+' : ''}${g.pctChange.toFixed(1)}% fuel</b></div>
         <div class="t-r"><span>samples</span><b>${g.n} · ${g.confidence}% conf</b></div>`;
    });
    cell.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
  });
}
