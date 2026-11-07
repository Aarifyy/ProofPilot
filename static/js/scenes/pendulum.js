import { Scene, fmt } from './base.js';
import { rk4, rad, deg, ellipticK } from '../physics/rk4.js';
import * as P from '../render/primitives.js';

// Full non-linear pendulum. θ measured from the downward vertical, CCW positive.
// A string can go slack (tension < 0): the bob then flies freely until the
// string snaps taut again (radial velocity removed — an inelastic jerk).
export class Pendulum extends Scene {
  init() {
    this.mode = 'taut';
    this.th = rad(this.p.theta0);
    this.w = this.p.omega0;
    this.free = null;
    this.h = 1 / 2000;
    this.lastCross = null;
    this.periods = [];
    this.slackEvents = 0;
    this.trailClock = 0;
  }

  get isString() { return this.opt.connector !== 'rod'; }

  ftaut = (t, s) => [s[1], -(this.p.g / this.p.L) * Math.sin(s[0]) - this.p.b * s[1]];
  ffree = (t, s) => [s[2], s[3], -this.p.b * s[2], -this.p.g - this.p.b * s[3]];

  tension() {
    if (this.mode !== 'taut') return 0;
    const { m, L, g } = this.p;
    return m * (L * this.w * this.w + g * Math.cos(this.th));
  }

  pos() {
    if (this.mode === 'free') return [this.free[0], this.free[1]];
    return [this.p.L * Math.sin(this.th), -this.p.L * Math.cos(this.th)];
  }
  vel() {
    if (this.mode === 'free') return [this.free[2], this.free[3]];
    const { L } = this.p;
    return [L * this.w * Math.cos(this.th), L * this.w * Math.sin(this.th)];
  }

  step(h) {
    const { L } = this.p;
    if (this.mode === 'taut') {
      const prevTh = this.th;
      [this.th, this.w] = rk4(this.ftaut, this.t, [this.th, this.w], h);
      // period: successive upward crossings of θ = 0 (mod 2π)
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      const a0 = wrap(prevTh), a1 = wrap(this.th);
      // period from successive zero crossings (either direction): T = 2·Δt
      if (Math.sign(a0) !== Math.sign(a1) && a0 !== 0 && Math.abs(a1 - a0) < 1) {
        const tc = this.t + h * (-a0 / (a1 - a0));
        const full = Math.abs(wrap(this.th)) < 1 && Math.abs(this.w) * Math.sqrt(this.p.L / this.p.g) > 2; // looping over the top
        if (this.lastCross !== null) {
          this.periods.push(full ? tc - this.lastCross : 2 * (tc - this.lastCross));
          this.measured.T ??= this.periods[0];
        }
        this.lastCross = tc;
      }
      if (this.isString && this.tension() < 0) {
        const [x, y] = this.pos(), [vx, vy] = this.vel();
        this.free = [x, y, vx, vy];
        this.mode = 'free';
        this.slackEvents++;
        this.lastCross = null;
        if (this.slackEvents <= 3) this.banner('String went slack — tension would be negative, so the bob is now in free fall', P.C.tension);
      }
    } else {
      const n = rk4(this.ffree, this.t, this.free, h);
      const r = Math.hypot(n[0], n[1]);
      if (r >= L) {
        const ux = n[0] / r, uy = n[1] / r;
        let vx = n[2], vy = n[3];
        const vr = vx * ux + vy * uy;
        if (vr > 0) { vx -= vr * ux; vy -= vr * uy; }
        this.th = Math.atan2(ux, -uy);
        const tx = Math.cos(this.th), ty = Math.sin(this.th);
        this.w = (vx * tx + vy * ty) / L;
        this.mode = 'taut';
        this.free = null;
      } else this.free = n;
    }
    this.trailClock += h;
    if (this.trailClock > 1 / 60) { this.trailClock = 0; this.pushTrail(this.pos(), 420); }
  }

  energy() {
    const { m, g, L } = this.p;
    const [, y] = this.pos(), [vx, vy] = this.vel();
    return { KE: 0.5 * m * (vx * vx + vy * vy), PE: m * g * (y + L) };
  }

  bounds() {
    const { L, g, theta0, omega0 } = this.p;
    const E = g * L * (1 - Math.cos(rad(theta0))) + 0.5 * (L * omega0) ** 2; // per unit mass, from bottom
    const reachTop = E > g * L * 0.98 || Math.abs(theta0) > 90;
    return { xmin: -L * 1.3, xmax: L * 1.3, ymin: -L * 1.25, ymax: reachTop ? L * 1.25 : L * 0.28 };
  }

  draw(r) {
    const { view, show } = r;
    const { L, m, g } = this.p;
    const pivot = [0, 0];
    const bob = this.pos();
    const bw = Math.max(0.6, L * 0.55);
    P.drawCeiling(r, -bw, bw, 0.0001 + 12 / view.scale * 0);
    P.drawDashed(r, pivot, [0, -L * 1.12]);

    if (show.trail) P.drawTrace(r, this.trail, { color: P.C.trace, widthPx: 1.6, alpha: 0.7 });

    if (this.isString) {
      P.drawRope(r, pivot, bob, { length: L });
    } else {
      P.drawRod(r, pivot, bob, { widthPx: 7 });
    }
    P.drawPivot(r, pivot, { fixed: false, sizePx: 6 });

    const ang = Math.atan2(bob[0], -bob[1]);
    if (show.labels) {
      if (Math.abs(ang) > rad(1.5)) P.drawAngleArc(r, pivot, -Math.PI / 2, -Math.PI / 2 + ang, Math.min(64, view.px(L) * 0.32), '\\theta');
      const side = ang >= 0 ? -1 : 1;
      P.drawDimension(r, pivot, bob, 'L', { offsetPx: 26 * side });
      P.drawTag(r, [bw, 0], this.isString ? 'light inextensible string' : 'rigid massless rod', { dx: -4, dy: -18, align: 'right' });
      P.drawArrow(r, [bw * 1.12, -L * 0.15], 0, -36, { color: P.C.inkSoft, label: 'g', widthPx: 1.6 });
    }

    const rPx = 9 + 5 * Math.cbrt(m);
    P.drawBob(r, bob, rPx, { label: show.labels ? 'm' : null, labelOffset: [bob[0] >= 0 ? 1 : -1, -0.2] });

    const fs = 46 / (m * g);
    if (show.forces) {
      P.drawArrow(r, bob, 0, -m * g * fs, { color: P.C.gravity, label: 'mg' });
      const T = this.tension();
      if (Math.abs(T) > 1e-6) {
        const ux = -bob[0] / Math.hypot(...bob), uy = -bob[1] / Math.hypot(...bob);
        const Tl = P.arrowPx(T, fs, 140);
        P.drawArrow(r, bob, ux * Tl, uy * Tl, { color: P.C.tension, label: T >= 0 ? 'T' : 'C' });
      }
    }
    if (show.velocity) {
      const [vx, vy] = this.vel();
      const vmax = Math.sqrt(2 * g * L * 2) + Math.abs(this.p.omega0 * L);
      const [dx, dy] = P.vecPx(vx, vy, 70 / Math.max(0.5, vmax * 0.6), 130);
      P.drawArrow(r, bob, dx, dy, { color: P.C.velocity, label: 'v' });
    }
  }

  readouts() {
    const [vx, vy] = this.vel();
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: '\\theta', value: deg(Math.atan2(this.pos()[0], -this.pos()[1])), unit: '°' },
      { sym: '\\omega', value: this.mode === 'taut' ? this.w : NaN, unit: 'rad/s' },
      { sym: '|v|', value: Math.hypot(vx, vy), unit: 'm/s' },
      { sym: 'T', value: this.tension(), unit: 'N', label: 'tension' },
      { sym: 'T_{\\text{meas}}', value: this.measured.T ?? NaN, unit: 's', label: 'period' },
    ];
  }

  series() {
    return [
      { key: 'theta', label: 'Angle θ', unit: '°', color: '#4fd1ff', get: () => deg(Math.atan2(this.pos()[0], -this.pos()[1])) },
      { key: 'omega', label: 'Angular velocity ω', unit: 'rad/s', color: '#c6f36b', get: () => (this.mode === 'taut' ? this.w : 0) },
      { key: 'speed', label: 'Bob speed |v|', unit: 'm/s', color: '#4fd1ff', get: () => Math.hypot(...this.vel()) },
      { key: 'vx', label: 'Horizontal velocity v_x', unit: 'm/s', color: '#9fb4ff', get: () => this.vel()[0] },
      { key: 'vy', label: 'Vertical velocity v_y', unit: 'm/s', color: '#ff9fd8', get: () => this.vel()[1] },
      { key: 'tension', label: 'Tension', unit: 'N', color: '#b79cff', get: () => this.tension() },
      ...this.energySeries(() => this.energy()),
    ];
  }
  defaultGraph() { return ['theta']; }

  smallT() { return 2 * Math.PI * Math.sqrt(this.p.L / this.p.g); }
  exactT() {
    const t0 = Math.abs(rad(this.p.theta0));
    if (this.p.omega0 !== 0 || t0 >= Math.PI) return null;
    return 4 * Math.sqrt(this.p.L / this.p.g) * ellipticK(Math.sin(t0 / 2));
  }

  derived() {
    return {
      T_small: { label: 'Small-angle period 2π√(L/g)', value: this.smallT(), unit: 's' },
      T_exact: { label: 'Exact large-amplitude period', value: this.exactT(), unit: 's' },
      T_measured: { label: 'Measured period', value: this.measured.T ?? null, unit: 's' },
      connector: { label: 'Connector', value: this.opt.connector },
      slack_events: { label: 'Times string went slack', value: this.slackEvents },
    };
  }

  equations() {
    const { L, g, b, theta0 } = this.p;
    const Te = this.exactT();
    return [
      { title: 'Equation of motion (no small-angle approximation)', tex: `\\ddot\\theta = -\\frac{g}{L}\\sin\\theta${b > 0 ? ' - b\\dot\\theta' : ''}` },
      { title: 'Small-angle period', tex: `T_0 = 2\\pi\\sqrt{\\frac{L}{g}} = 2\\pi\\sqrt{\\frac{${fmt(L)}}{${fmt(g)}}} = ${fmt(this.smallT())}\\ \\text{s}` },
      ...(Te ? [{ title: `Exact period for θ₀ = ${fmt(theta0)}°`, tex: `T = 4\\sqrt{\\frac{L}{g}}\\,K\\!\\left(\\sin\\frac{\\theta_0}{2}\\right) = ${fmt(Te, 4)}\\ \\text{s}` }] : []),
      { title: 'Tension (string can only pull: T ≥ 0)', tex: `T = m\\left(L\\dot\\theta^2 + g\\cos\\theta\\right)` },
      { title: 'Energy conservation', tex: `\\tfrac12 m v^2 + mgL(1-\\cos\\theta) = \\text{const}` },
    ];
  }

  predictions() {
    return [
      { id: 'period', kind: 'number', question: 'How long will one complete swing (the period) take?', sym: 'T', unit: 's', measuredKey: 'T',
        theory: this.exactT() ?? this.smallT(),
        hint: Math.abs(this.p.theta0) > 20
          ? 'T₀ = 2π√(L/g) assumes small angles. At large amplitudes the real period is noticeably longer.'
          : 'Use T = 2π√(L/g). Notice that the mass does not appear.' },
      { id: 'mass', kind: 'choice', question: 'If you double the mass of the bob, the period will…', choices: ['double', 'increase a little', 'stay the same', 'halve'],
        answer: 'stay the same', explanation: 'Both the restoring force (mg sin θ) and the inertia (m) are proportional to mass, so m cancels from the equation of motion.',
        suggest: { m: Math.min(20, this.p.m * 2) } },
      { id: 'length', kind: 'choice', question: 'If you make the pendulum 4× longer, the period becomes…', choices: ['the same', '2× longer', '4× longer', '16× longer'],
        answer: '2× longer', explanation: 'T ∝ √L, so 4× the length gives √4 = 2× the period.', suggest: { L: Math.min(10, this.p.L * 4) } },
    ];
  }
}
