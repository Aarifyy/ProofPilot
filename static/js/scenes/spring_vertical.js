import { Scene, fmt } from './base.js';
import { rk4 } from '../physics/rk4.js';
import * as P from '../render/primitives.js';

const L0 = 0.7; // natural length (m)

// Mass hanging from a vertical spring. y = displacement below equilibrium (down +).
export class SpringVertical extends Scene {
  init() {
    this.y = this.p.y0;
    this.v = this.p.v0;
    this.h = 1 / 4000;
    this.turns = this.p.v0 === 0 ? [0] : []; // release from rest is a turning point
    const s = Math.cbrt(this.p.m / 0.5);
    this.bw = 0.26 * s; this.bh = 0.2 * s;
  }

  get stretch0() { return (this.p.m * this.p.g) / this.p.k; }

  f = (t, s) => [s[1], (-this.p.k * s[0] - this.p.b * s[1]) / this.p.m];

  step(h) {
    const v0 = this.v;
    [this.y, this.v] = rk4(this.f, this.t, [this.y, this.v], h);
    if (v0 !== 0 && Math.sign(this.v) !== Math.sign(v0)) {
      this.turns.push(this.t + h * (v0 / (v0 - this.v)));
      if (this.turns.length >= 2) this.measured.T ??= 2 * (this.turns[1] - this.turns[0]);
    }
  }

  energy() {
    // Spring PE measured from natural length; gravitational PE from equilibrium height.
    const { m, k, g } = this.p;
    const ext = this.stretch0 + this.y;
    return { KE: 0.5 * m * this.v * this.v, PE: 0.5 * k * ext * ext - m * g * this.y - 0.5 * k * this.stretch0 ** 2 };
  }

  omega() { return Math.sqrt(this.p.k / this.p.m); }
  amplitude() { return Math.hypot(this.p.y0, this.p.v0 / this.omega()); }

  // world y of the block's top face (ceiling at y = 0)
  blockTop(y = this.y) { return -(L0 + this.stretch0 + y); }

  bounds() {
    const low = this.blockTop(this.amplitude()) - this.bh - 0.25;
    const span = Math.max(1.4, -low + 0.3);
    return { xmin: -span * 0.62, xmax: span * 0.62, ymin: low, ymax: 0.3 };
  }

  draw(r) {
    const { show } = r;
    const { m, g, k } = this.p;
    const top = this.blockTop();
    const cy = top - this.bh / 2;
    const vis = r.view.visible();
    P.drawCeiling(r, -0.45, 0.45, 0);

    const natY = -L0, eqY = this.blockTop(0);
    if (show.labels) {
      P.drawDashed(r, [-0.65, natY], [0.65, natY], { color: 'rgba(183,156,255,0.55)' });
      P.drawTag(r, [0.65, natY], 'natural length', { dx: 6, align: 'left', color: P.C.tension });
      P.drawDashed(r, [-0.65, eqY], [0.65, eqY], { color: 'rgba(95,227,161,0.6)' });
      P.drawTag(r, [0.65, eqY], 'equilibrium', { dx: 6, align: 'left', color: P.C.normal });
      if (this.stretch0 > 0.02) P.drawDimension(r, [-0.45, natY], [-0.45, eqY], 'mg/k', { offsetPx: 0 });
      if (Math.abs(this.y) > 0.01) P.drawDimension(r, [0.38, eqY], [0.38, top], 'y');
      P.drawArrow(r, [vis.xmin + 0.12, -0.2], 0, -36, { color: P.C.inkSoft, label: 'g', widthPx: 1.6 });
    }

    const ext = this.stretch0 + this.y;
    P.drawSpring(r, [0, 0], [0, top], { coils: 13, radiusPx: 11, label: show.labels ? 'k' : null, stress: (ext / L0) * 0.5 });
    P.drawBlock(r, 0, cy, this.bw, this.bh, { label: show.labels ? 'm' : null });

    if (show.forces) {
      const fs = 50 / (m * g);
      const Fs = k * ext; // upward on the block when stretched
      P.drawArrow(r, [-this.bw * 0.42, top], 0, P.arrowPx(Fs, fs, 150), { color: P.C.spring, label: 'F_s' });
      P.drawArrow(r, [this.bw * 0.25, cy - this.bh / 2], 0, -m * g * fs, { color: P.C.gravity, label: 'mg' });
    }
    if (show.velocity) {
      const vs = 55 / Math.max(0.1, this.amplitude() * this.omega());
      P.drawArrow(r, [this.bw / 2 + 0.06, cy], 0, P.arrowPx(-this.v, vs, 110), { color: P.C.velocity, label: 'v' });
    }
  }

  readouts() {
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: 'y', value: this.y, unit: 'm', label: 'below eq.' },
      { sym: 'v', value: this.v, unit: 'm/s' },
      { sym: 'F_s', value: this.p.k * (this.stretch0 + this.y), unit: 'N' },
      { sym: 's', value: this.stretch0, unit: 'm', label: 'static stretch' },
      { sym: 'T_{\\text{meas}}', value: this.measured.T ?? NaN, unit: 's', label: 'period' },
    ];
  }

  series() {
    return [
      { key: 'y', label: 'Displacement y', unit: 'm', color: '#4fd1ff', get: () => this.y },
      { key: 'v', label: 'Velocity v', unit: 'm/s', color: '#c6f36b', get: () => this.v },
      ...this.energySeries(() => this.energy()),
    ];
  }
  defaultGraph() { return ['y', 'v']; }

  derived() {
    return {
      T: { label: 'Period 2π√(m/k)', value: 2 * Math.PI / this.omega(), unit: 's' },
      static_stretch: { label: 'Static stretch mg/k', value: this.stretch0, unit: 'm' },
      A: { label: 'Amplitude', value: this.amplitude(), unit: 'm' },
      T_measured: { label: 'Measured period', value: this.measured.T ?? null, unit: 's' },
    };
  }

  equations() {
    const { m, k, g, b } = this.p;
    return [
      { title: 'Equilibrium: spring holds the weight', tex: `k s = mg \\Rightarrow s = \\frac{mg}{k} = \\frac{${fmt(m)}\\times${fmt(g)}}{${fmt(k)}} = ${fmt(this.stretch0)}\\ \\text{m}` },
      { title: 'Motion about equilibrium (gravity cancels)', tex: `m\\ddot y = mg - k(s + y)${b > 0 ? ' - b\\dot y' : ''} = -ky${b > 0 ? ' - b\\dot y' : ''}` },
      { title: 'Period', tex: `T = 2\\pi\\sqrt{\\frac{m}{k}} = ${fmt(2 * Math.PI / this.omega())}\\ \\text{s}` },
    ];
  }

  predictions() {
    return [
      { id: 'period', kind: 'number', question: 'What is the period of the oscillation?', sym: 'T', unit: 's', measuredKey: 'T',
        theory: this.p.b === 0 ? 2 * Math.PI / this.omega() : null, hint: 'Gravity only shifts the equilibrium; T = 2π√(m/k) just like a horizontal spring.' },
      { id: 'moon', kind: 'choice', question: 'If this experiment were done on the Moon (g = 1.62 m/s²), the period would…', choices: ['be longer', 'be the same', 'be shorter'],
        answer: 'be the same', explanation: 'g only changes how far the spring stretches at equilibrium (mg/k); the restoring force about equilibrium is still −ky.',
        suggest: { g: 1.62 } },
    ];
  }
}
