import { Scene, fmt } from './base.js';
import { rk4 } from '../physics/rk4.js';
import * as P from '../render/primitives.js';

const WALL_X = -1.3;
const L0 = 1.0; // spring natural length (m)

// Horizontal mass–spring with viscous damping (−bv) and Coulomb friction (μmg).
export class Spring extends Scene {
  init() {
    this.x = this.p.x0;
    this.v = this.p.v0;
    this.h = 1 / 4000;
    this.stuck = false;
    this.turns = this.p.v0 === 0 ? [0] : []; // release from rest is a turning point
    const s = Math.cbrt(this.p.m);
    this.bw = 0.3 * s; this.bh = 0.24 * s;
    this.E0 = this.energy().KE + this.energy().PE;
  }

  frictionForce(x, v) {
    const { mu, m, g, k } = this.p;
    if (mu === 0) return 0;
    const fmax = mu * m * g;
    if (Math.abs(v) > 1e-9) return -Math.sign(v) * fmax;
    const spring = -k * x;
    return Math.abs(spring) <= fmax ? -spring : -Math.sign(spring) * fmax;
  }

  force(x, v) { return -this.p.k * x - this.p.b * v + this.frictionForce(x, v); }

  step(h) {
    const { m } = this.p;
    if (this.stuck) return;
    if (this.v === 0 && this.p.mu > 0 && Math.abs(this.p.k * this.x) <= this.p.mu * m * this.p.g) {
      this.stuck = true;
      this.measured.restX = this.x;
      this.finishAfterStep('Static friction holds the block: |kx| ≤ μmg, so it never moves', P.C.friction);
      return;
    }
    const v0 = this.v;
    const sgn = Math.sign(v0) || Math.sign(-this.x);
    const f = (t, s) => {
      // freeze the friction direction during the sub-step to avoid chattering
      const fr = this.p.mu ? -sgn * this.p.mu * m * this.p.g : 0;
      return [s[1], (-this.p.k * s[0] - this.p.b * s[1] + (Math.abs(v0) > 1e-9 || Math.abs(this.p.k * s[0]) > this.p.mu * m * this.p.g ? fr : 0)) / m];
    };
    let [x, v] = rk4(f, this.t, [this.x, this.v], h);
    // turning point: velocity changed sign → record, and check for sticking
    if (v0 !== 0 && Math.sign(v) !== Math.sign(v0)) {
      const tc = this.t + h * (v0 / (v0 - v));
      this.turns.push(tc);
      if (this.turns.length >= 2) this.measured.T ??= 2 * (this.turns[1] - this.turns[0]);
      if (this.p.mu > 0) {
        v = 0;
        if (Math.abs(this.p.k * x) <= this.p.mu * m * this.p.g) {
          this.stuck = true;
          this.x = x; this.v = 0;
          this.measured.restX = x;
          this.finishAfterStep(`Stuck at x = ${fmt(x)} m — static friction balances the spring (|kx| ≤ μmg)`, P.C.friction);
          return;
        }
      }
    }
    this.x = x; this.v = v;
    if (this.p.b > 0 && Math.abs(x) < 1e-4 && Math.abs(v) < 1e-4) this.finishAfterStep('Oscillation has died away', P.C.inkSoft);
  }

  energy() {
    const { m, k } = this.p;
    return { KE: 0.5 * m * this.v * this.v, PE: 0.5 * k * this.x * this.x };
  }

  omega() { return Math.sqrt(this.p.k / this.p.m); }
  periodTheory() {
    const { b, m } = this.p;
    const w0 = this.omega(), gamma = b / (2 * m);
    if (gamma >= w0) return null;
    return (2 * Math.PI) / Math.sqrt(w0 * w0 - gamma * gamma);
  }
  amplitude() { return Math.hypot(this.p.x0, this.p.v0 / this.omega()); }

  bounds() {
    const A = this.amplitude();
    const right = WALL_X + L0 + A + this.bw + 0.35;
    return { xmin: WALL_X - 0.25, xmax: Math.max(right, 1.1), ymin: -0.35, ymax: Math.max(0.9, this.bh + 0.6) };
  }

  draw(r) {
    const { show } = r;
    const { k, m, g, mu, b } = this.p;
    const floorY = 0;
    const vis = r.view.visible();
    const blockLeft = WALL_X + L0 + this.x;
    const cx = blockLeft + this.bw / 2, cy = floorY + this.bh / 2;
    const eqX = WALL_X + L0 + this.bw / 2;

    P.drawWall(r, WALL_X, floorY, floorY + Math.max(0.65, this.bh * 2.2), 'left');
    P.drawGround(r, WALL_X, vis.xmax, floorY);
    if (mu > 0) P.drawRoughness(r, [WALL_X + 0.05, floorY], [vis.xmax, floorY]);
    P.drawDashed(r, [eqX, floorY - 0.12], [eqX, floorY + this.bh + 0.35]);
    if (show.labels) {
      P.drawLabel(r, [eqX, floorY + this.bh + 0.35], 'x = 0', { dy: 12, size: 14, color: P.C.inkSoft });
      P.drawLabel(r, [vis.xmax, floorY], mu > 0 ? `\\mu = ${fmt(mu)}` : '\\mu = 0', { dx: -40, dy: 20, size: 17 });
      if (b > 0) P.drawTag(r, [vis.xmax, floorY + 0.65], `damping b = ${fmt(b)} kg/s`, { dx: -6, align: 'right' });
    }

    const springLen = blockLeft - WALL_X;
    const stress = (this.x / L0) * 1.5;
    P.drawSpring(r, [WALL_X, cy], [blockLeft, cy], { coils: 12, radiusPx: Math.max(7, Math.min(14, r.view.px(this.bh) * 0.3)), label: show.labels ? 'k' : null, labelSide: -1, stress });

    P.drawBlock(r, cx, cy, this.bw, this.bh, { label: show.labels ? 'm' : null });

    if (show.labels && Math.abs(this.x) > 0.01) {
      P.drawDimension(r, [eqX, floorY + this.bh + 0.18], [cx, floorY + this.bh + 0.18], 'x');
    }
    if (show.forces) {
      const fs = 55 / Math.max(k * this.amplitude(), m * g * 0.6, 1e-6);
      const Fs = -k * this.x;
      P.drawArrow(r, [Fs >= 0 ? blockLeft + this.bw : blockLeft, cy + this.bh * 0.28], P.arrowPx(Fs, fs, 140), 0, { color: P.C.spring, label: 'F_s' });
      if (mu > 0) {
        const Ff = this.frictionForce(this.x, this.v);
        P.drawArrow(r, [cx, floorY], P.arrowPx(Ff, fs, 120), 0, { color: P.C.friction, label: 'f' });
      }
      const wpx = Math.min(34, m * g * fs);
      P.drawArrow(r, [cx + this.bw * 0.28, cy], 0, -wpx, { color: P.C.gravity, label: 'mg', widthPx: 1.8 });
      P.drawArrow(r, [cx - this.bw * 0.28, cy], 0, wpx, { color: P.C.normal, label: 'N', widthPx: 1.8 });
    }
    if (show.velocity) {
      const vs = 60 / Math.max(0.2, this.amplitude() * this.omega());
      P.drawArrow(r, [cx, floorY + this.bh + 0.06], P.arrowPx(this.v, vs, 120), 0, { color: P.C.velocity, label: 'v' });
    }
    void springLen;
  }

  readouts() {
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: 'x', value: this.x, unit: 'm' },
      { sym: 'v', value: this.v, unit: 'm/s' },
      { sym: 'a', value: this.force(this.x, this.v) / this.p.m, unit: 'm/s²' },
      { sym: 'F_s', value: -this.p.k * this.x, unit: 'N' },
      { sym: 'T_{\\text{meas}}', value: this.measured.T ?? NaN, unit: 's', label: 'period' },
    ];
  }

  series() {
    return [
      { key: 'x', label: 'Displacement x', unit: 'm', color: '#4fd1ff', get: () => this.x },
      { key: 'v', label: 'Velocity v', unit: 'm/s', color: '#c6f36b', get: () => this.v },
      { key: 'a', label: 'Acceleration a', unit: 'm/s²', color: '#ff8fd0', get: () => this.force(this.x, this.v) / this.p.m },
      ...this.energySeries(() => this.energy()),
    ];
  }
  defaultGraph() { return ['x', 'v']; }

  derived() {
    return {
      T: { label: 'Period 2π√(m/k)', value: 2 * Math.PI / this.omega(), unit: 's' },
      T_damped: { label: 'Damped period', value: this.periodTheory(), unit: 's' },
      omega: { label: 'Natural angular frequency', value: this.omega(), unit: 'rad/s' },
      A: { label: 'Amplitude', value: this.amplitude(), unit: 'm' },
      E0: { label: 'Initial energy', value: this.E0, unit: 'J' },
      T_measured: { label: 'Measured period', value: this.measured.T ?? null, unit: 's' },
    };
  }

  equations() {
    const { m, k, b, mu } = this.p;
    const eq = [
      { title: "Hooke's law", tex: `F_s = -kx = -${fmt(k)}\\,x` },
      { title: "Newton's second law", tex: `m\\ddot x = -kx${b > 0 ? ' - b\\dot x' : ''}${mu > 0 ? ' - \\mu m g\\,\\mathrm{sgn}(\\dot x)' : ''}` },
      { title: 'Angular frequency & period', tex: `\\omega = \\sqrt{\\frac{k}{m}} = ${fmt(this.omega())}\\ \\text{rad/s},\\quad T = 2\\pi\\sqrt{\\frac{m}{k}} = ${fmt(2 * Math.PI / this.omega())}\\ \\text{s}` },
      { title: 'Solution (undamped)', tex: `x(t) = A\\cos(\\omega t + \\phi),\\quad A = ${fmt(this.amplitude())}\\ \\text{m}` },
      { title: 'Energy', tex: `E = \\tfrac12 m v^2 + \\tfrac12 k x^2 = ${fmt(this.E0)}\\ \\text{J}` },
    ];
    if (b > 0) eq.push({ title: 'Damped period', tex: `T_d = \\frac{2\\pi}{\\sqrt{\\omega^2 - (b/2m)^2}} = ${this.periodTheory() ? fmt(this.periodTheory()) + '\\ \\text{s}' : '\\text{overdamped}'}` });
    void m;
    return eq;
  }

  predictions() {
    return [
      { id: 'period', kind: 'number', question: 'How long will one full oscillation take?', sym: 'T', unit: 's', measuredKey: 'T',
        theory: this.periodTheory(), hint: 'For a mass on a spring T = 2π√(m/k). Amplitude does not matter.' },
      { id: 'amp', kind: 'choice', question: 'If you pull the block twice as far before releasing it, the period will…', choices: ['double', 'stay the same', 'halve', 'increase by √2'],
        answer: 'stay the same', explanation: 'In simple harmonic motion the period is independent of amplitude: twice the distance, but twice the speed.',
        suggest: { x0: Math.max(-0.6, Math.min(0.6, this.p.x0 * 2 || 0.4)) } },
      { id: 'mass', kind: 'choice', question: 'If the mass is made 4× larger, the period becomes…', choices: ['4× longer', '2× longer', 'the same', '2× shorter'],
        answer: '2× longer', explanation: 'T ∝ √m, and √4 = 2.', suggest: { m: Math.min(20, this.p.m * 4) } },
    ];
  }
}
