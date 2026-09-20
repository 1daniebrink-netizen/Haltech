/*
 * Haltune chart layer — panel rendering, the graph picker and the hover /
 * zoom / overlay interaction.
 *
 * NOT a module. It is inlined verbatim into src/dashboard.html by
 * tools/serve.mjs and into the published artifact by tools/build-artifact.mjs,
 * because two copies of a chart engine drift exactly the way two copies of the
 * analysis engine did.
 *
 * The host page must provide, before this runs:
 *   S   — { data, i0, i1, hover, mode, overlay, picked }
 *         where data = { t:[], panels:[{key,label,unit,limits,series,modes?}],
 *                        defaultPanels:[] }
 *   $   — querySelector shorthand
 *   el  — (tag, className) => HTMLElement
 * and these containers: #picker #charts #tip, optionally #tslider #range #reset
 * #table #tabledet.
 *
 * Styling comes from CSS custom properties the host defines: --s1 --s2 --ovl,
 * --good --warn --crit, --ink --ink-2 --ink-3, --grid --axis --panel --edge.
 */

/* A panel may carry alternate units (lambda vs AFR). Everything downstream —
 * scales, hover, tooltip, table — reads the active one through here, so the
 * toggle can never leave one of them showing the other unit. */
function view(p){
  if (!p.modes || !p.modes.length) return { series:p.series, unit:p.unit, note:p.note || null };
  const i = Math.min(S.mode[p.key] || 0, p.modes.length - 1);
  const m = p.modes[i];
  return { series:m.series, unit:m.unit, note:m.note || null };
}

const SER = ['var(--s1)','var(--s2)'];               // fixed order, never cycled
const STATUS = { good:'var(--good)', warning:'var(--warn)', critical:'var(--crit)' };

// r is the right gutter that holds limit labels, series end-labels and the
// overlay label. It has to fit the longest of those, not the average.
const M = { l:64, r:158, t:12, b:26, w:1000, h:150 };
const MAXLAB = 22;
const clip = s => (s.length > MAXLAB ? s.slice(0, MAXLAB - 1) + '…' : s);
const PW = M.w - M.l - M.r, PH = M.h - M.t - M.b;

function niceTicks(lo, hi, n){
  n = n || 4;
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
const fmt = v => (v === null || v === undefined || !isFinite(v)) ? '—'
  : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString()
  : Math.abs(v) >= 100 ? v.toFixed(0)
  : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/,'').replace(/\.$/,'');

/* ------ y-domain for a panel over the visible window (one source of truth) */
function domainFor(p){
  let lo = Infinity, hi = -Infinity;
  for (const s of view(p).series)
    for (let i = S.i0; i <= S.i1; i++){
      const v = s.values[i];
      if (v !== null && isFinite(v)){ if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  for (const L of p.limits){ if (L.v < lo) lo = L.v; if (L.v > hi) hi = L.v; }
  if (!isFinite(lo)){ lo = 0; hi = 1; }
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.1;
  return { lo: lo - pad, hi: hi + pad };
}
const xAt = i => M.l + (S.i1 === S.i0 ? 0 : (i - S.i0) / (S.i1 - S.i0)) * PW;
const yAt = (v, d) => M.t + PH - ((v - d.lo) / (d.hi - d.lo)) * PH;

/* ---- overlay -------------------------------------------------------------
 * A second channel drawn on a panel it does not share units with. It is INDEXED
 * to its own visible range and drawn against the panel height, never given a
 * second y-axis: two scales on one frame let you manufacture any correlation you
 * like by choosing them. The shape carries the timing, the crosshair tooltip
 * carries the numbers, and the range is printed under the title so the shape is
 * interpretable. */
function overlayOptions() {
  const out = [];
  for (const p of S.data.panels) {
    const v = view(p);
    v.series.forEach((s, k) => out.push({
      id: p.key + '::' + k,
      label: v.series.length > 1 ? p.label + ' · ' + s.name : p.label,
      unit: v.unit, values: s.values,
    }));
  }
  return out;
}
const overlayById = id => overlayOptions().find(o => o.id === id) || null;

/** Min/max of an overlay over the visible window; null if it has no data there. */
function overlayDomain(values) {
  let lo = Infinity, hi = -Infinity;
  for (let i = S.i0; i <= S.i1; i++) {
    const v = values[i];
    if (v !== null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!isFinite(lo)) return null;
  return { lo, hi: hi === lo ? lo + 1 : hi };
}

/* ============================================================ graph picker */
/* Which graphs to draw, in the order they were chosen. Logs now expose every
 * channel they carry — 40+ on a fully-instrumented one — so rendering them all
 * is unreadable. The selection persists, and is filtered to what THIS log has,
 * so switching to an older log quietly drops panels it cannot draw instead of
 * erroring. */
function pickedKeys(){
  const have = new Set(S.data.panels.map(p => p.key));
  const chosen = (S.picked || []).filter(k => have.has(k));
  if (chosen.length) return chosen;
  return (S.data.defaultPanels || []).filter(k => have.has(k));
}
function savePicked(keys){
  S.picked = keys;
  try { localStorage.setItem('haltune.picked', JSON.stringify(keys)); } catch (e) {}
  renderPicker(); renderCharts(); renderTable();
}

/* The filter text, kept across the re-render that adding a graph triggers.
 * Adding one channel of a pin usually means adding its neighbours too — filter
 * "AVI2", take Voltage, then Switch State — and a box that cleared itself on
 * every pick would make that the worst case instead of the easy one. */
let pickFilter = '';

/** Every whitespace-separated term must appear. Matches the label, which
 *  carries both the function and the ECU's own name, and the key. */
function panelMatches(p, q){
  if (!q) return true;
  const hay = (p.label + ' ' + p.key + ' ' + (p.unit || '')).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t));
}

function renderPicker(){
  const host = $('#picker'), keys = pickedKeys();
  const byKey = k => S.data.panels.find(p => p.key === k);
  /* Was the filter box focused before this re-render tore it down? Feature-
   * tested rather than assumed: restoring focus is a convenience, and it must
   * not be the thing that stops the picker rendering at all. */
  const active = document.activeElement;
  const hadFocus = !!(active && host.contains && host.contains(active)
    && active.classList && active.classList.contains('pk-find'));
  host.innerHTML = '';

  host.appendChild(Object.assign(el('div','pk-l'), { textContent:'Graphs' }));

  const avail = S.data.panels.filter(p => !keys.includes(p.key));

  /* A 444-entry native dropdown is not a list you can read, it is a list you
   * scroll past. The filter is the only practical way in once a log carries
   * every channel the ECU has. */
  const wrap = el('div','pk-add');
  const find = document.createElement('input');
  find.type = 'search'; find.className = 'pk-find';
  find.placeholder = 'Filter ' + avail.length + ' graphs…';
  find.setAttribute('aria-label', 'Filter the list of graphs');
  find.value = pickFilter;
  find.disabled = !avail.length;

  const sel = document.createElement('select');
  sel.disabled = !avail.length;

  /* Options are built as nodes, not innerHTML. Labels now carry the raw NSP
   * channel name, which is whatever the ECU config put there; the two host
   * pages do not both define an escaper, and textContent needs none. */
  const opt = (text, value) => {
    const o = document.createElement('option');
    o.textContent = text; o.value = value;
    return o;
  };
  const fill = () => {
    const hits = avail.filter(p => panelMatches(p, pickFilter));
    const head = !pickFilter ? '+ add a graph…'
      : hits.length ? '+ add one of ' + hits.length + '…'
      : 'no graph matches "' + pickFilter + '"';
    sel.textContent = '';
    sel.appendChild(opt(head, ''));
    for (const p of hits) {
      sel.appendChild(opt(
        p.label + (p.discovered ? ' ·' : '') + (p.unit ? '  (' + p.unit + ')' : ''), p.key));
    }
    return hits;
  };
  fill();

  find.oninput = () => { pickFilter = find.value; fill(); };
  find.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const hits = avail.filter(p => panelMatches(p, pickFilter));
    // Enter commits only when the filter has resolved to a single graph;
    // otherwise it would silently add whichever happened to sort first.
    if (hits.length === 1) { pickFilter = ''; savePicked([...keys, hits[0].key]); }
  };
  sel.onchange = () => { if (sel.value) savePicked([...keys, sel.value]); };

  wrap.appendChild(find);
  wrap.appendChild(sel);
  host.appendChild(wrap);
  if (hadFocus) {
    find.focus();
    // caret to the end, so the next keystroke extends the filter rather than
    // replacing a browser-selected value
    if (find.setSelectionRange) find.setSelectionRange(find.value.length, find.value.length);
  }

  const chips = el('div','chips');
  keys.forEach((k, i) => {
    const p = byKey(k); if (!p) return;
    const c = el('div','chip');
    c.innerHTML = '<span class="n">' + (i + 1) + '</span><span>' + p.label + '</span>';
    if (i > 0){
      const up = document.createElement('button');
      up.className = 'mv'; up.textContent = '↑'; up.title = 'Move up';
      up.onclick = () => { const n = [...keys]; [n[i-1], n[i]] = [n[i], n[i-1]]; savePicked(n); };
      c.appendChild(up);
    }
    const x = document.createElement('button');
    x.textContent = '×'; x.title = 'Remove';
    x.onclick = () => savePicked(keys.filter(v => v !== k));
    c.appendChild(x);
    chips.appendChild(c);
  });
  if (!keys.length) chips.appendChild(Object.assign(el('div','none'),
    { textContent:'No graphs selected — pick one to begin.' }));
  host.appendChild(chips);

  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.title = 'Back to the default set';
  reset.onclick = () => savePicked([]);
  host.appendChild(reset);
}

/* =================================================================== charts */
function renderCharts(){
  wireReset();
  const host = $('#charts');
  if (!host) return;
  host.innerHTML = '';
  const byKey = k => S.data.panels.find(p => p.key === k);
  for (const k of pickedKeys()){
    const p = byKey(k);
    if (p) host.appendChild(panelNode(p));
  }
  updateRangeLabel();
  renderSlider();
}

function panelNode(p){
  const t = S.data.t, v = view(p), d = domainFor(p);

  const wrap = el('div','panel');
  const head = el('div','ptitle');
  head.innerHTML = '<h2>' + p.label + '</h2><span class="u">' + v.unit + '</span>';

  if (p.modes && p.modes.length > 1){
    const cur = Math.min(S.mode[p.key] || 0, p.modes.length - 1);
    const seg = el('div','seg');
    p.modes.forEach((m,i) => {
      const b = document.createElement('button');
      b.textContent = m.label;
      b.setAttribute('aria-pressed', i === cur ? 'true' : 'false');
      b.title = 'Show ' + m.label;
      b.onclick = () => {
        S.mode[p.key] = i;
        try { localStorage.setItem('haltune.mode', JSON.stringify(S.mode)); } catch (e) {}
        renderCharts(); renderTable(); paintHover();
      };
      seg.appendChild(b);
    });
    head.appendChild(seg);
  }

  const right = el('div','phead-r');
  if (v.series.length > 1){
    const lg = el('div','legend');
    lg.innerHTML = v.series.map((s,k) =>
      '<span><i style="background:' + SER[k] + '"></i>' + s.name + '</span>').join('');
    right.appendChild(lg);
  }

  // overlay picker — any other channel, drawn indexed to this panel's height
  const ovlId = S.overlay[p.key] || '';
  const opts = overlayOptions().filter(o => !o.id.startsWith(p.key + '::'));
  const sel = document.createElement('select');
  sel.className = 'ovl' + (ovlId ? ' on' : '');
  sel.title = 'Overlay another channel on this chart';
  sel.innerHTML = '<option value="">+ overlay channel…</option>' +
    opts.map(o => '<option value="' + o.id + '"' + (o.id === ovlId ? ' selected' : '') + '>'
      + o.label + '</option>').join('');
  sel.onchange = () => {
    if (sel.value) S.overlay[p.key] = sel.value; else delete S.overlay[p.key];
    try { localStorage.setItem('haltune.overlay', JSON.stringify(S.overlay)); } catch (e) {}
    renderCharts(); paintHover();
  };
  right.appendChild(sel);
  head.appendChild(right);
  wrap.appendChild(head);

  const ovl = ovlId ? overlayById(ovlId) : null;
  const ovlDom = ovl ? overlayDomain(ovl.values) : null;

  const notes = [];
  if (v.note) notes.push(v.note);
  if (ovl) {
    notes.push(ovlDom
      ? '<span class="ovlnote">overlay: ' + ovl.label + ' — shape only, ranging '
        + fmt(ovlDom.lo) + '–' + fmt(ovlDom.hi) + ' ' + ovl.unit
        + '. Read exact values from the crosshair.</span>'
      : '<span class="ovlnote">overlay: ' + ovl.label + ' — no data in this window</span>');
  }
  if (notes.length){
    const n = el('div','pnote');
    n.innerHTML = notes.join(' &nbsp;·&nbsp; ');
    wrap.appendChild(n);
  }

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox','0 0 ' + M.w + ' ' + M.h);
  svg.setAttribute('preserveAspectRatio','none');
  svg.dataset.key = p.key;
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    svg.appendChild(n); return n;
  };

  // recessive grid + y ticks
  for (const v of niceTicks(d.lo, d.hi, 4)){
    const y = yAt(v, d);
    add('line', { x1:M.l, x2:M.l+PW, y1:y, y2:y, class:'gridline', 'vector-effect':'non-scaling-stroke' });
    add('text', { x:M.l-9, y:y+3.5, class:'tick y' }, fmt(v));
  }
  // x ticks (seconds)
  const span = t[S.i1] - t[S.i0];
  for (const tv of niceTicks(t[S.i0], t[S.i1], 6)){
    let idx = S.i0, best = Infinity;
    for (let i = S.i0; i <= S.i1; i++){ const dd = Math.abs(t[i]-tv); if (dd < best){ best = dd; idx = i; } }
    add('text', { x:xAt(idx), y:M.h-8, class:'tick x' },
      span < 4 ? tv.toFixed(1) + 's' : Math.round(tv) + 's');
  }
  add('line', { x1:M.l, x2:M.l+PW, y1:M.t+PH, y2:M.t+PH, class:'axisline', 'vector-effect':'non-scaling-stroke' });

  // limit lines — status colour, always labelled
  for (const L of p.limits){
    if (L.v < d.lo || L.v > d.hi) continue;
    const y = yAt(L.v, d), c = STATUS[L.status] || 'var(--ink-3)';
    add('line', { x1:M.l, x2:M.l+PW, y1:y, y2:y, class:'lim', stroke:c, 'vector-effect':'non-scaling-stroke' });
    add('text', { x:M.l+PW+7, y:y+3.5, class:'limlab', fill:c }, clip(L.label));
  }

  // series
  v.series.forEach((s,k) => {
    let dstr = '', pen = false;
    for (let i = S.i0; i <= S.i1; i++){
      const v = s.values[i];
      if (v === null || !isFinite(v)){ pen = false; continue; }
      dstr += (pen ? 'L' : 'M') + xAt(i).toFixed(2) + ' ' + yAt(v, d).toFixed(2) + ' ';
      pen = true;
    }
    add('path', { d:dstr, class:'line', stroke:SER[k], 'vector-effect':'non-scaling-stroke' });

    if (v.series.length > 1){
      let last = null;
      for (let i = S.i1; i >= S.i0; i--){
        const v = s.values[i];
        if (v !== null && isFinite(v)){ last = v; break; }
      }
      if (last !== null)
        add('text', { x:M.l+PW+7, y:yAt(last, d)+3.5, class:'endlab', fill:SER[k] }, s.name);
    }
  });

  // overlay — drawn under the hover furniture, above the series
  if (ovl && ovlDom){
    const oy = val => M.t + PH - ((val - ovlDom.lo) / (ovlDom.hi - ovlDom.lo)) * PH;
    let ds = '', pen = false;
    for (let i = S.i0; i <= S.i1; i++){
      const val = ovl.values[i];
      if (val === null || !isFinite(val)){ pen = false; continue; }
      ds += (pen ? 'L' : 'M') + xAt(i).toFixed(2) + ' ' + oy(val).toFixed(2) + ' ';
      pen = true;
    }
    add('path', { d:ds, class:'ovlline', 'vector-effect':'non-scaling-stroke' });
    let last = null;
    for (let i = S.i1; i >= S.i0; i--){
      const val = ovl.values[i];
      if (val !== null && isFinite(val)){ last = val; break; }
    }
    if (last !== null){
      const t = add('text', { x:M.l+PW+7, y:oy(last)+3.5, class:'ovllab' }, clip(ovl.label));
      t.appendChild(document.createElementNS(NS,'title')).textContent = ovl.label;
    }
  }

  // hover + zoom furniture
  add('line', { x1:0, x2:0, y1:M.t, y2:M.t+PH, class:'xhair' });
  v.series.forEach((s,k) => add('circle', { r:4, class:'focus', fill:SER[k],
    stroke:'var(--panel)', 'stroke-width':2 }));
  if (ovl && ovlDom) add('circle', { r:3.5, class:'focus ovlfocus', fill:'var(--ovl)',
    stroke:'var(--panel)', 'stroke-width':2 });
  add('rect', { class:'selrect', x:0, y:M.t, width:0, height:PH, opacity:0 });
  const hit = add('rect', { class:'hitarea', x:M.l, y:M.t, width:PW, height:PH });

  wireInteraction(hit, svg);
  wrap.appendChild(svg);
  return wrap;
}

/* ============================================================== interaction */
let drag = null;

function idxFromEvent(svg, e){
  const r = svg.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * M.w;      // viewBox units are proportional
  const rel = Math.max(0, Math.min(1, (px - M.l) / PW));
  return Math.round(S.i0 + rel * (S.i1 - S.i0));
}

function wireInteraction(hit, svg){
  hit.addEventListener('mousemove', e => {
    const i = idxFromEvent(svg, e);
    if (drag) drawSelection(svg, drag.i, i);
    S.hover = i; paintHover(); showTip(e, i);
  });
  hit.addEventListener('mouseleave', () => {
    S.hover = null; paintHover(); $('#tip').style.opacity = 0;
  });
  hit.addEventListener('mousedown', e => {
    drag = { i: idxFromEvent(svg, e), svg }; e.preventDefault();
  });
}

window.addEventListener('mouseup', e => {
  if (!drag) return;
  const j = idxFromEvent(drag.svg, e);
  const a = Math.min(drag.i, j), b = Math.max(drag.i, j);
  drag = null;
  document.querySelectorAll('.selrect').forEach(r => r.setAttribute('opacity', 0));
  if (b - a >= 4){ S.i0 = a; S.i1 = b; $('#reset').disabled = false; renderCharts(); renderTable(); }
});

function drawSelection(svg, a, b){
  const r = svg.querySelector('.selrect');
  const x0 = xAt(Math.min(a,b)), x1 = xAt(Math.max(a,b));
  r.setAttribute('x', x0); r.setAttribute('width', Math.max(0, x1-x0)); r.setAttribute('opacity', 1);
}

function paintHover(){
  const i = S.hover, d = S.data;
  document.querySelectorAll('#charts svg').forEach(svg => {
    const p = d.panels.find(p => p.key === svg.dataset.key);
    if (!p) return;
    const xh = svg.querySelector('.xhair');
    const dots = svg.querySelectorAll('.focus');
    if (i === null){ xh.style.opacity = 0; dots.forEach(c => c.style.opacity = 0); return; }
    const x = xAt(i);
    xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.style.opacity = 1;
    const dom = domainFor(p);
    const own = view(p).series;
    own.forEach((s,k) => {
      const val = s.values[i], c = dots[k]; if (!c) return;
      if (val === null || !isFinite(val)){ c.style.opacity = 0; return; }
      c.setAttribute('cx', x); c.setAttribute('cy', yAt(val, dom)); c.style.opacity = 1;
    });
    const oc = dots[own.length];                       // overlay dot, if present
    if (oc){
      const ovl = overlayById(S.overlay[p.key] || '');
      const od = ovl ? overlayDomain(ovl.values) : null;
      const val = ovl ? ovl.values[i] : null;
      if (!od || val === null || !isFinite(val)) { oc.style.opacity = 0; }
      else {
        oc.setAttribute('cx', x);
        oc.setAttribute('cy', M.t + PH - ((val - od.lo) / (od.hi - od.lo)) * PH);
        oc.style.opacity = 1;
      }
    }
  });
}

function showTip(e, i){
  const d = S.data, tip = $('#tip');
  let rows = '';
  // Only the graphs on screen. Iterating every panel listed a fully-instrumented
  // log's 43 channels in one pane, which is unreadable and buries the handful you
  // actually chose to look at. The picker decides this, same as the charts.
  const shown = pickedKeys().map(k => d.panels.find(p => p.key === k)).filter(Boolean);
  for (const p of shown){
    const v = view(p);
    v.series.forEach((s,k) => {
      const nm = v.series.length > 1 ? p.label + ' · ' + s.name : p.label;
      rows += '<tr><td class="l"><i style="background:' + SER[k] + '"></i>' + nm +
        '</td><td class="n">' + fmt(s.values[i]) +
        ' <span style="color:var(--ink-3);font-weight:400">' + v.unit + '</span></td></tr>';
    });
  }
  tip.innerHTML = '<div class="th">t = ' + d.t[i].toFixed(3) + ' s</div><table>' + rows + '</table>';
  tip.style.opacity = 1;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 16, y = e.clientY + 16;
  if (x + w > innerWidth - 8) x = e.clientX - w - 16;
  if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

function updateRangeLabel(){
  const d = S.data, r = $('#range');
  if (!r) return;                       // the artifact hosts charts without this
  const full = S.i0 === 0 && S.i1 === d.t.length - 1;
  r.textContent = full
    ? 'Drag across any chart to zoom the time axis'
    : 'Showing ' + d.t[S.i0].toFixed(3) + '–' + d.t[S.i1].toFixed(3) + ' s  ·  ' +
      (S.i1 - S.i0 + 1).toLocaleString() + ' samples';
}

/* ====================================================== time-window slider */
/* A two-thumb range over the WHOLE log, mounted in #tslider by any host that
 * provides the container. It writes the same S.i0 / S.i1 that drag-to-zoom on a
 * chart writes, so the two are one zoom state and cannot disagree: zoom by
 * dragging across a trace and the bubbles move to match.
 *
 * Dragging re-renders live, coalesced to one render per animation frame —
 * a pointermove can fire several times per frame and each render rebuilds every
 * visible panel. The data table is deliberately left until the drag ENDS; it is
 * the expensive half and nobody reads 250 rows mid-drag. */
const TS_MIN_SPAN = 4;         // samples — the same floor drag-to-zoom enforces

let ts = null;                 // built DOM + the length it was built for
let tsDrag = null;             // 'a' | 'b' while a bubble is held
let tsRaf = 0;

function renderSlider(){
  const host = $('#tslider');
  if (!host || !S.data || !S.data.t || !S.data.t.length) return;   // hosts may omit it
  const n = S.data.t.length;
  if (ts && ts.host === host && ts.n === n){ tsPaint(); return; }

  host.innerHTML = '';
  const bar = el('div','ts-bar');
  const cap = el('div','ts-cap');
  cap.textContent = 'Time window';

  const track = el('div','ts-track');
  const fill = el('div','ts-fill');
  const a = el('div','ts-thumb'), b = el('div','ts-thumb');
  for (const [node, label] of [[a,'Window start'], [b,'Window end']]){
    node.setAttribute('role','slider');
    node.setAttribute('tabindex','0');
    node.setAttribute('aria-label', label);
  }
  track.appendChild(fill); track.appendChild(a); track.appendChild(b);

  const lab = el('div','ts-lab');
  const rst = document.createElement('button');
  rst.className = 'ts-reset';
  rst.textContent = 'Full log';
  rst.title = 'Show the whole log again';
  rst.onclick = () => { tsSetWindow(0, n - 1); tsCommit(); };

  bar.appendChild(cap); bar.appendChild(track); bar.appendChild(lab); bar.appendChild(rst);
  host.appendChild(bar);

  ts = { host, track, fill, a, b, lab, rst, n };
  tsGrab(a, 'a'); tsGrab(b, 'b');

  // Clicking the bare track jumps the nearer bubble there, then keeps dragging,
  // so a coarse window can be set in one gesture.
  track.addEventListener('pointerdown', e => {
    if (e.target !== track && e.target !== fill) return;            // a thumb handled it
    const i = tsIdxAt(e.clientX);
    const which = Math.abs(i - S.i0) <= Math.abs(i - S.i1) ? 'a' : 'b';
    tsDrag = which;
    if (track.setPointerCapture) track.setPointerCapture(e.pointerId);
    tsMove(which, i);
  });
  track.addEventListener('pointermove', e => { if (tsDrag) tsMove(tsDrag, tsIdxAt(e.clientX)); });
  const done = () => { if (tsDrag){ tsDrag = null; tsCommit(); } };
  track.addEventListener('pointerup', done);
  track.addEventListener('pointercancel', done);

  tsPaint();
}

/* Index under a client x, clamped to the log. The track is the full duration, so
 * this is a straight proportion — no zoom state involved. */
function tsIdxAt(cx){
  const r = ts.track.getBoundingClientRect();
  const rel = r.width ? (cx - r.left) / r.width : 0;
  return Math.round(Math.max(0, Math.min(1, rel)) * (ts.n - 1));
}

/* The bubbles never cross: each is clamped to leave TS_MIN_SPAN samples, which
 * is what keeps the panels from being asked to draw a zero-width window. */
function tsSetWindow(i0, i1){
  const n = S.data.t.length;
  S.i0 = Math.max(0, Math.min(i0, n - 1));
  S.i1 = Math.max(0, Math.min(i1, n - 1));
  if (S.hover !== null && (S.hover < S.i0 || S.hover > S.i1)) S.hover = null;
}

function tsMove(which, i){
  const n = S.data.t.length, span = Math.min(TS_MIN_SPAN, n - 1);
  if (which === 'a') tsSetWindow(Math.min(i, S.i1 - span), S.i1);
  else               tsSetWindow(S.i0, Math.max(i, S.i0 + span));
  tsPaint();
  tsSchedule();
}

/* One render per frame while dragging. Without this a fast drag queues a full
 * panel rebuild per pointermove and the bubble lags the pointer. */
function tsSchedule(){
  if (tsRaf) return;
  tsRaf = requestAnimationFrame(() => { tsRaf = 0; renderCharts(); });
}

function tsCommit(){
  if (tsRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(tsRaf);
  tsRaf = 0;
  renderCharts(); renderTable(); paintHover();
}

function tsPaint(){
  if (!ts || !S.data) return;
  const t = S.data.t, n = ts.n, last = n - 1;
  const pct = i => (last ? (i / last) * 100 : 0);
  const full = S.i0 === 0 && S.i1 === last;

  ts.a.style.left = pct(S.i0) + '%';
  ts.b.style.left = pct(S.i1) + '%';
  ts.fill.style.left = pct(S.i0) + '%';
  ts.fill.style.width = (pct(S.i1) - pct(S.i0)) + '%';

  const span = t[S.i1] - t[S.i0], p = span < 4 ? 3 : 1;
  ts.lab.textContent = t[S.i0].toFixed(p) + ' – ' + t[S.i1].toFixed(p) + ' s  ·  '
    + span.toFixed(p) + ' s  ·  ' + (S.i1 - S.i0 + 1).toLocaleString() + ' samples'
    + (full ? '  ·  whole log' : '');
  ts.rst.disabled = full;

  for (const [node, i] of [[ts.a, S.i0], [ts.b, S.i1]]){
    node.setAttribute('aria-valuemin', t[0].toFixed(3));
    node.setAttribute('aria-valuemax', t[last].toFixed(3));
    node.setAttribute('aria-valuenow', t[i].toFixed(3));
    node.setAttribute('aria-valuetext', t[i].toFixed(3) + ' seconds');
  }
  const rb = $('#reset');
  if (rb) rb.disabled = full;
  updateRangeLabel();
}

function tsGrab(node, which){
  node.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    tsDrag = which;
    if (node.setPointerCapture) node.setPointerCapture(e.pointerId);
    if (node.classList) node.classList.add('on');
  });
  node.addEventListener('pointermove', e => { if (tsDrag === which) tsMove(which, tsIdxAt(e.clientX)); });
  const end = () => {
    if (tsDrag !== which) return;
    tsDrag = null;
    if (node.classList) node.classList.remove('on');
    tsCommit();
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);

  // Keyboard: the bubbles are real sliders, so arrows have to move them. The
  // step is a two-hundredth of the log, which is roughly one pixel of track.
  node.addEventListener('keydown', e => {
    const n = S.data.t.length, base = Math.max(1, Math.round((n - 1) / 200));
    const step = e.shiftKey ? base * 10 : base;
    const cur = which === 'a' ? S.i0 : S.i1;
    let to = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = cur - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = cur + step;
    else if (e.key === 'PageDown') to = cur - base * 10;
    else if (e.key === 'PageUp') to = cur + base * 10;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    if (to === null) return;
    e.preventDefault();
    tsMove(which, to);
    tsCommit();
  });
}

/* Wired lazily, never at top level. This file is inlined ABOVE the host page's
 * own script, so `$` and `el` do not exist yet while it is being evaluated —
 * touching them here throws "Cannot access '$' before initialization" and takes
 * the whole page down. Everything else in this file is a declaration; this was
 * the one statement that ran immediately. */
let _resetWired = false;
function wireReset(){
  if (_resetWired) return;
  const rb = $('#reset');
  if (!rb) { _resetWired = true; return; }   // the artifact has no reset button
  rb.onclick = () => {
    S.i0 = 0; S.i1 = S.data.t.length - 1;
    rb.disabled = true; renderCharts(); renderTable();
  };
  _resetWired = true;
}

/* ==================================================================== table */
function renderTable(){
  const host = $('#table'), det = $('#tabledet');
  if (!host || !det) return;            // optional — the artifact has no table view
  const d = S.data, n = S.i1 - S.i0 + 1, step = Math.max(1, Math.ceil(n / 250));
  const cols = [];
  const shown = pickedKeys().map(k => d.panels.find(p => p.key === k)).filter(Boolean);
  for (const p of shown){
    const v = view(p);
    v.series.forEach(s => cols.push({
      head: (v.series.length > 1 ? p.label + ' · ' + s.name : p.label) + ' (' + v.unit + ')',
      v: s.values,
    }));
  }
  let html = '<thead><tr><th>t (s)</th>' + cols.map(c => '<th>' + c.head + '</th>').join('') +
             '</tr></thead><tbody>';
  for (let i = S.i0; i <= S.i1; i += step){
    html += '<tr><td>' + d.t[i].toFixed(3) + '</td>' +
      cols.map(c => '<td>' + fmt(c.v[i]) + '</td>').join('') + '</tr>';
  }
  host.innerHTML = html + '</tbody>';
  det.querySelector('summary').textContent =
    'Data table — ' + Math.ceil(n/step).toLocaleString() + ' of ' + n.toLocaleString() +
    ' samples' + (step > 1 ? ' (every ' + step + (step===2?'nd':step===3?'rd':'th') + ')' : '');
}
