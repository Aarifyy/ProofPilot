// Base class for every simulation. Subclasses implement:
//   init()            set initial state from this.p / this.opt
//   step(h)           advance state by a fixed sub-step h (seconds)
//   bounds()          world rectangle to frame
//   draw(r)           render with primitives
//   readouts()        [{sym, value, unit, digits}]
//   series()          [{key, label, unit, color, get()}]   — sampled for graphs
//   equations()       [{title, tex}]
//   derived()         {key: {label, value, unit}}           — shared with the tutor
//   predictions()     prediction cards (see predict.js)
export class Scene {
  constructor(spec, entry) {
    this.spec = spec;
    this.entry = entry;
    this.p = { ...spec.params };
    this.opt = { ...spec.options };
    this.h = 1 / 1200;          // integrator sub-step
    this.sampleEvery = 1 / 30;  // graph sampling period
    this.maxTime = 120;
    // reset() is called by createScene() once subclass fields exist.
  }

  reset() {
    this.t = 0;
    this.finished = false;
    this.measured = {};
    this.history = [];
    this.trail = [];
    this.banners = [];
    this._nextSample = 0;
    this._acc = 0;
    this._pending = null;
    this.init();
    this._sample();
  }

  advance(dt) {
    if (this.finished) return;
    this._acc += dt;
    let guard = 0;
    while (this._acc >= this.h && !this.finished && guard++ < 20000) {
      this.step(this.h);
      this.t += this.h;
      this._acc -= this.h;
      if (this._pending) { const [m, c] = this._pending; this._pending = null; this.finish(m, c); }
      if (this.t >= this._nextSample) this._sample();
      if (this.t >= this.maxTime) this.finish('Time limit reached');
    }
  }

  _sample() {
    const row = { t: this.t };
    for (const s of this.series()) row[s.key] = s.get();
    this.history.push(row);
    if (this.history.length > 6000) this.history.splice(0, 1000);
    this._nextSample = this.t + this.sampleEvery;
    this.onSample?.();
  }

  finish(message, color) {
    if (this.finished) return;
    this.finished = true;
    this._sample();
    if (message) this.banner(message, color);
  }

  // Call from step(): finishes once the current sub-step's time has been added.
  finishAfterStep(message, color) { this._pending = [message, color]; }

  banner(text, color) { this.banners.push({ text, color, at: performance.now() }); }

  pushTrail(p, max = 900) {
    this.trail.push(p);
    if (this.trail.length > max) this.trail.shift();
  }

  // Standard energy series used by most scenes.
  energySeries(fn) {
    return [
      { key: 'KE', label: 'Kinetic energy', unit: 'J', color: '#4fd1ff', get: () => fn().KE },
      { key: 'PE', label: 'Potential energy', unit: 'J', color: '#ffb547', get: () => fn().PE },
      { key: 'E', label: 'Total energy', unit: 'J', color: '#e8edf2', get: () => fn().KE + fn().PE },
    ];
  }

  defaultGraph() { return ['KE', 'PE', 'E']; }
  readouts() { return []; }
  equations() { return []; }
  derived() { return {}; }
  predictions() { return []; }
}

export const fmt = (v, d = 3) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return (+v.toPrecision(d)).toString().replace('-', '−');
};
