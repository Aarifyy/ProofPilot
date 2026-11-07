// Live time-series plot of scene.history (real computed values, sampled as the
// physics advances). Up to two y-axes (one per unit). Interactive:
//   hover        inspect every plotted value at that instant (works while paused)
//   cursor       a vertical line marks the current simulation time
//   wheel        zoom the time window, drag to pan, double-click to follow live
//   Compare      overlays the previous run (before the last parameter change), dashed
//   |v| ⇄ v_x,v_y switches between speed and velocity components
import { fmt } from '../scenes/base.js';

function niceStep(range, target = 5) {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';

export class Graph {
  constructor(canvas, legendEl, toolsEl = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.legendEl = legendEl;
    this.tools = toolsEl;
    this.scene = null;
    this.selected = [];
    this.window = 30;     // seconds shown
    this.offset = 0;      // seconds back from the latest sample (0 = follow live)
    this.fitAll = false;
    this.hoverX = null;
    this.compare = true;
    this.ghost = null;    // {rows} of the previous run
    new ResizeObserver(() => this.resize()).observe(canvas);
    this._bindInteraction();
    this._bindTools();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setScene(scene, prev = null) {
    const sameType = this._sameType;
    if (prev && sameType && prev.history.length > 1 && prev.history[prev.history.length - 1].t >= 1) this.ghost = { rows: prev.history };
    else if (!sameType) this.ghost = null;
    this.scene = scene;
    const keys = scene.series().map((s) => s.key);
    const keep = this.selected.filter((k) => keys.includes(k));
    this.selected = keep.length && sameType ? keep : scene.defaultGraph();
    this._sameType = false;
    if (!sameType) { this.offset = 0; this.fitAll = false; this.window = 30; }
    this.renderLegend();
    this._syncTools();
  }

  keepSelection() { this._sameType = true; }

  renderLegend() {
    const el = this.legendEl;
    el.innerHTML = '';
    for (const s of this.scene.series()) {
      const b = document.createElement('button');
      b.className = 'legend-item' + (this.selected.includes(s.key) ? ' on' : '');
      b.innerHTML = `<span class="sw" style="background:${s.color}"></span>${s.label}`;
      b.title = `${s.label}${s.unit ? ` (${s.unit})` : ''}`;
      b.onclick = () => {
        if (this.selected.includes(s.key)) this.selected = this.selected.filter((k) => k !== s.key);
        else {
          this.selected.push(s.key);
          // at most two units
          const meta = this._meta();
          let units = [...new Set(this.selected.map((k) => meta[k].unit))];
          while (units.length > 2) { this.selected.shift(); units = [...new Set(this.selected.map((k) => meta[k].unit))]; }
        }
        this.renderLegend(); this._syncTools(); this.draw();
      };
      el.appendChild(b);
    }
  }

  _meta() { return Object.fromEntries(this.scene.series().map((x) => [x.key, x])); }

  // ------------------------------------------------------------ toolbar
  _bindTools() {
    if (!this.tools) return;
    const btn = (k) => this.tools.querySelector(`[data-g=${k}]`);
    btn('compare').onclick = () => { this.compare = !this.compare; this._syncTools(); this.draw(); };
    btn('fit').onclick = () => { this.fitAll = !this.fitAll; this.offset = 0; this._syncTools(); this.draw(); };
    btn('reset').onclick = () => {
      if (!this.scene) return;
      this.scene.history.length = 0;
      this.scene._sample();
      this.offset = 0;
      this.draw();
    };
    btn('vtoggle').onclick = () => {
      const has = (k) => this.selected.includes(k);
      const others = this.selected.filter((k) => !['speed', 'vx', 'vy'].includes(k));
      this.selected = has('speed') || !(has('vx') || has('vy')) ? [...others.slice(0, 1), 'vx', 'vy'] : [...others.slice(0, 1), 'speed'];
      this.renderLegend(); this._syncTools(); this.draw();
    };
  }

  _syncTools() {
    if (!this.tools || !this.scene) return;
    const btn = (k) => this.tools.querySelector(`[data-g=${k}]`);
    const keys = this.scene.series().map((s) => s.key);
    btn('vtoggle').hidden = !(keys.includes('speed') && keys.includes('vx') && keys.includes('vy'));
    btn('compare').classList.toggle('on', this.compare);
    btn('compare').disabled = !this.ghost;
    btn('compare').title = this.ghost ? 'Show the previous run (before your last change) as dashed lines' : 'Change a parameter to compare against the previous run';
    btn('fit').classList.toggle('on', this.fitAll);
  }

  // ------------------------------------------------------------ interaction
  _bindInteraction() {
    const c = this.canvas;
    c.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (this._drag) {
        const dt = ((this._drag.x - x) / Math.max(1, this._pw)) * (this._span || this.window);
        this.offset = Math.max(0, this._drag.offset - dt);
        this.fitAll = false;
        this._syncTools();
      }
      this.hoverX = x;
      this.draw();
    });
    c.addEventListener('mouseleave', () => { this.hoverX = null; this._drag = null; this.draw(); });
    c.addEventListener('mousedown', (e) => { const r = c.getBoundingClientRect(); this._drag = { x: e.clientX - r.left, offset: this.offset }; });
    window.addEventListener('mouseup', () => { this._drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.fitAll) { this.window = Math.max(1, this._span || this.window); this.fitAll = false; }
      this.window = Math.min(600, Math.max(1, this.window * (e.deltaY > 0 ? 1.2 : 1 / 1.2)));
      this._syncTools();
      this.draw();
    }, { passive: false });
    c.addEventListener('dblclick', () => { this.offset = 0; this.window = 30; this.fitAll = false; this._syncTools(); this.draw(); });
  }

  // ------------------------------------------------------------ drawing
  draw() {
    const { ctx, w, h, scene } = this;
    if (!w || !scene) return;
    ctx.clearRect(0, 0, w, h);
    const hist = scene.history;
    const meta = this._meta();
    const sel = this.selected.filter((k) => meta[k]);
    const pad = { l: 58, r: 58, t: 26, b: 30 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    this._pw = pw;

    const latest = hist.length ? hist[hist.length - 1].t : 0;
    let tMin, tMax;
    if (this.fitAll) { tMin = hist.length ? hist[0].t : 0; tMax = Math.max(latest, tMin + 1); }
    else {
      tMax = Math.max(latest - this.offset, Math.min(this.window, 1));
      tMin = Math.max(0, tMax - this.window);
      if (tMax - tMin < 1e-6) tMax = tMin + 1;
    }
    this._span = tMax - tMin;
    const inRange = (r) => r.t >= tMin - 1e-9 && r.t <= tMax + 1e-9;
    const rows = hist.filter(inRange);
    const ghostRows = this.compare && this.ghost ? this.ghost.rows.filter(inRange) : [];
    const units = [...new Set(sel.map((k) => meta[k].unit))];
    const axes = units.map((u) => {
      let lo = Infinity, hi = -Infinity;
      for (const k of sel.filter((k) => meta[k].unit === u)) {
        for (const r of rows) { const v = r[k]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
        for (const r of ghostRows) { const v = r[k]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      }
      if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
      if (hi - lo < 1e-9) { const m = Math.abs(hi) || 1; lo -= m * 0.5; hi += m * 0.5; }
      const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
      const keys = sel.filter((k) => meta[k].unit === u);
      return { unit: u, lo, hi, keys };
    });
    const X = (t) => pad.l + ((t - tMin) / (tMax - tMin)) * pw;
    const T = (x) => tMin + ((x - pad.l) / pw) * (tMax - tMin);
    const Y = (v, ax) => pad.t + ph - ((v - ax.lo) / (ax.hi - ax.lo)) * ph;

    // grid + axes
    ctx.save();
    ctx.font = `11px ${FONT}`;
    ctx.strokeStyle = 'rgba(160,190,220,0.08)'; ctx.fillStyle = '#5d6873'; ctx.lineWidth = 1;
    const tStep = niceStep(tMax - tMin, 6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = Math.ceil(tMin / tStep) * tStep; t <= tMax + 1e-9; t += tStep) {
      const x = Math.round(X(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      ctx.fillText(`${+t.toFixed(2)}`, x, pad.t + ph + 7);
    }
    ctx.textAlign = 'right'; ctx.fillStyle = '#8b97a4'; ctx.font = `600 11px ${FONT}`;
    ctx.fillText('time t [s]', pad.l + pw, pad.t + ph + 18);
    ctx.font = `11px ${FONT}`;
    axes.forEach((ax, i) => {
      const step = niceStep(ax.hi - ax.lo, 4);
      ctx.fillStyle = '#5d6873';
      ctx.textAlign = i === 0 ? 'right' : 'left'; ctx.textBaseline = 'middle';
      for (let v = Math.ceil(ax.lo / step) * step; v <= ax.hi; v += step) {
        const y = Math.round(Y(v, ax)) + 0.5;
        if (i === 0) { ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke(); }
        ctx.fillText(fmt(Math.abs(v) < step * 1e-6 ? 0 : v), i === 0 ? pad.l - 8 : pad.l + pw + 8, y);
      }
      // axis title: quantity name when one series, otherwise just the unit
      ctx.save();
      ctx.textAlign = i === 0 ? 'left' : 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#8b97a4';
      ctx.font = `600 11px ${FONT}`;
      const u = ax.unit ? ` [${ax.unit}]` : '';
      const title = ax.keys.length === 1 ? `${meta[ax.keys[0]].label}${u}` : ax.unit ? `[${ax.unit}]` : '';
      const maxW = pw / (axes.length > 1 ? 2.1 : 1);
      let tt = title;
      while (tt.length > 4 && ctx.measureText(tt).width > maxW) tt = tt.slice(0, -2);
      if (tt !== title) tt += '…';
      ctx.fillText(tt, i === 0 ? pad.l - 50 : pad.l + pw + 50, pad.t - 8);
      ctx.restore();
      if (ax.lo < 0 && ax.hi > 0 && i === 0) {
        ctx.strokeStyle = 'rgba(232,237,242,0.22)';
        const y0 = Math.round(Y(0, ax)) + 0.5; ctx.beginPath(); ctx.moveTo(pad.l, y0); ctx.lineTo(pad.l + pw, y0); ctx.stroke();
        ctx.strokeStyle = 'rgba(160,190,220,0.08)';
      }
    });
    ctx.restore();

    const plot = (data, k, ax, color, dashed) => {
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1.6 : 2; ctx.lineJoin = 'round';
      if (dashed) { ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.5; }
      ctx.beginPath();
      let started = false;
      for (const r of data) {
        const v = r[k]; if (!Number.isFinite(v)) { started = false; continue; }
        const x = X(r.t), y = Y(v, ax);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.restore();
    };
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t - 2, pw, ph + 4); ctx.clip();
    for (const k of sel) if (ghostRows.length) plot(ghostRows, k, axes.find((a) => a.unit === meta[k].unit), meta[k].color, true);
    for (const k of sel) plot(rows, k, axes.find((a) => a.unit === meta[k].unit), meta[k].color, false);
    ctx.restore();

    if (!sel.length) {
      ctx.fillStyle = '#5d6873'; ctx.font = `13px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText('Pick a quantity below the title to plot it', w / 2, h / 2);
      return;
    }
    if (ghostRows.length) {
      ctx.save(); ctx.font = `10.5px ${FONT}`; ctx.fillStyle = '#6b7783'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('- - -  previous run', pad.l + 6, pad.t + 4); ctx.restore();
    }

    // cursor: hovered time, or the current simulation time
    const hovering = this.hoverX !== null && this.hoverX >= pad.l && this.hoverX <= pad.l + pw;
    const tc = hovering ? T(this.hoverX) : scene.t;
    if (tc < tMin - 1e-9 || tc > tMax + 1e-9 || !hist.length) return;
    let best = null;
    for (const r of hist) if (!best || Math.abs(r.t - tc) < Math.abs(best.t - tc)) best = r;
    const xc = Math.round(X(hovering ? best.t : Math.min(tc, latest))) + 0.5;
    ctx.save();
    ctx.strokeStyle = hovering ? 'rgba(232,237,242,0.55)' : 'rgba(255,181,71,0.55)'; ctx.setLineDash(hovering ? [3, 3] : []); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xc, pad.t); ctx.lineTo(xc, pad.t + ph); ctx.stroke();
    ctx.setLineDash([]);
    const lines = [`t = ${fmt(best.t, 4)} s`];
    for (const k of sel) {
      const s = meta[k], ax = axes.find((a) => a.unit === s.unit), v = best[k];
      if (!Number.isFinite(v)) { lines.push([s, '—']); continue; }
      ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(xc, Y(v, ax), 3.5, 0, Math.PI * 2); ctx.fill();
      lines.push([s, `${fmt(v, 4)}${s.unit ? ' ' + s.unit : ''}`]);
    }
    if (hovering || scene.finished || !this._isPlayingHint()) {
      ctx.font = `11.5px ${FONT}`;
      const rowsTxt = lines.map((l) => (typeof l === 'string' ? l : `${l[0].label}: ${l[1]}`));
      const bw = Math.max(...rowsTxt.map((t) => ctx.measureText(t).width)) + 26;
      const bh = rowsTxt.length * 16 + 10;
      let bx = xc + 10; if (bx + bw > pad.l + pw) bx = xc - 10 - bw;
      const by = pad.t + 6;
      ctx.fillStyle = 'rgba(12,16,21,0.92)'; ctx.strokeStyle = 'rgba(160,190,220,0.25)';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 7) : ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach((l, i) => {
        const y = by + 6 + i * 16;
        if (typeof l === 'string') { ctx.fillStyle = '#e8edf2'; ctx.font = `600 11.5px ${FONT}`; ctx.fillText(l, bx + 10, y); ctx.font = `11.5px ${FONT}`; return; }
        ctx.fillStyle = l[0].color; ctx.fillRect(bx + 10, y + 5, 8, 3);
        ctx.fillStyle = '#c9d2db'; ctx.fillText(`${l[0].label}: ${l[1]}`, bx + 22, y);
      });
    }
    ctx.restore();
  }

  _isPlayingHint() { return !!window.proofpilot?.playing; }
}
