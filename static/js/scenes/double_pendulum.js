import { Scene, fmt } from './base.js';
import { rk4, rad, deg } from '../physics/rk4.js';
import * as P from '../render/primitives.js';

// Double pendulum with rigid massless rods and point masses. Angles from the
// downward vertical. A "ghost" copy starts 0.001° away to show chaos.
export class DoublePendulum extends Scene {
  init() {
    const { theta1, theta2 } = this.p;
    this.y = [rad(theta1), 0, rad(theta2), 0];
    this.ghost = this.opt.ghost === 'on' ? [rad(theta1 + 0.001), 0, rad(theta2), 0] : null;
    this.h = 1 / 2000;
    this.trailClock = 0;
    this.ghostTrail = [];
    this.E0 = this.energyOf(this.y).KE + this.energyOf(this.y).PE;
  }

  f = (t, s) => {
    const { m1, m2, L1, L2, g } = this.p;
    const [a1, w1, a2, w2] = s;
    const d = a1 - a2;
    const den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
    const dw1 = (-g * (2 * m1 + m2) * Math.sin(a1) - m2 * g * Math.sin(a1 - 2 * a2)
      - 2 * Math.sin(d) * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(d))) / (L1 * den);
    const dw2 = (2 * Math.sin(d) * (w1 * w1 * L1 * (m1 + m2) + g * (m1 + m2) * Math.cos(a1)
      + w2 * w2 * L2 * m2 * Math.cos(d))) / (L2 * den);
    return [w1, dw1, w2, dw2];
  };

  step(h) {
    this.y = rk4(this.f, this.t, this.y, h);
    if (this.ghost) this.ghost = rk4(this.f, this.t, this.ghost, h);
    this.trailClock += h;
    if (this.trailClock > 1 / 60) {
      this.trailClock = 0;
      this.pushTrail(this.positions(this.y)[1], 700);
      if (this.ghost) { this.ghostTrail.push(this.positions(this.ghost)[1]); if (this.ghostTrail.length > 700) this.ghostTrail.shift(); }
      if (this.ghost && this.measured.diverge === undefined) {
        const a = this.positions(this.y)[1], b = this.positions(this.ghost)[1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.1 * (this.p.L1 + this.p.L2)) {
          this.measured.diverge = this.t;
          this.banner(`Chaos: the ghost (started 0.001° away) has visibly diverged after ${fmt(this.t)} s`, P.C.ghost);
        }
      }
    }
  }

  positions(s) {
    const { L1, L2 } = this.p;
    const p1 = [L1 * Math.sin(s[0]), -L1 * Math.cos(s[0])];
    const p2 = [p1[0] + L2 * Math.sin(s[2]), p1[1] - L2 * Math.cos(s[2])];
    return [p1, p2];
  }

  energyOf(s) {
    const { m1, m2, L1, L2, g } = this.p;
    const [a1, w1, a2, w2] = s;
    const KE = 0.5 * m1 * (L1 * w1) ** 2 + 0.5 * m2 * ((L1 * w1) ** 2 + (L2 * w2) ** 2 + 2 * L1 * L2 * w1 * w2 * Math.cos(a1 - a2));
    const [p1, p2] = this.positions(s);
    const PE = m1 * g * (p1[1] + L1 + L2) + m2 * g * (p2[1] + L1 + L2);
    return { KE, PE };
  }
  energy() { return this.energyOf(this.y); }

  bounds() {
    const R = this.p.L1 + this.p.L2;
    return { xmin: -R * 1.12, xmax: R * 1.12, ymin: -R * 1.1, ymax: R * 1.08 };
  }

  draw(r) {
    const { show, view } = r;
    const { m1, m2 } = this.p;
    const R = this.p.L1 + this.p.L2;
    P.drawCeiling(r, -R * 0.25, R * 0.25, 0);
    P.drawDashed(r, [0, 0], [0, -this.p.L1 * 0.7]);

    if (show.trail) {
      if (this.ghost) P.drawTrace(r, this.ghostTrail, { color: P.C.ghost, widthPx: 1.2, alpha: 0.45 });
      P.drawTrace(r, this.trail, { color: P.C.trace, widthPx: 1.6, alpha: 0.85 });
    }

    if (this.ghost) {
      const [g1, g2] = this.positions(this.ghost);
      P.drawRod(r, [0, 0], g1, { widthPx: 5, ghost: true });
      P.drawRod(r, g1, g2, { widthPx: 5, ghost: true });
      P.drawBob(r, g2, 8 + 4 * Math.cbrt(m2), { ghost: true });
    }

    const [p1, p2] = this.positions(this.y);
    P.drawRod(r, [0, 0], p1, { widthPx: 7 });
    P.drawRod(r, p1, p2, { widthPx: 7 });
    P.drawPivot(r, [0, 0], { fixed: false, sizePx: 6 });
    P.drawBob(r, p1, 9 + 5 * Math.cbrt(m1), { label: show.labels ? 'm_1' : null, labelOffset: [p1[0] >= 0 ? 1 : -1, 0.4] });
    P.drawPivot(r, p1, { fixed: false, sizePx: 3.5 });
    P.drawBob(r, p2, 9 + 5 * Math.cbrt(m2), { label: show.labels ? 'm_2' : null, labelOffset: [p2[0] >= p1[0] ? 1 : -1, -0.4] });

    if (show.labels) {
      const [a1, , a2] = this.y;
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      if (Math.abs(wrap(a1)) > rad(2)) P.drawAngleArc(r, [0, 0], -Math.PI / 2, -Math.PI / 2 + wrap(a1), 40, '\\theta_1');
      P.drawDashed(r, p1, [p1[0], p1[1] - this.p.L2 * 0.6]);
      if (Math.abs(wrap(a2)) > rad(2)) P.drawAngleArc(r, p1, -Math.PI / 2, -Math.PI / 2 + wrap(a2), 34, '\\theta_2');
      P.drawLabel(r, [(p1[0]) / 2, (p1[1]) / 2], 'L_1', { dx: 16, dy: 8, size: 15, color: P.C.inkSoft });
      P.drawLabel(r, [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], 'L_2', { dx: 16, dy: 8, size: 15, color: P.C.inkSoft });
      if (this.ghost) P.drawTag(r, [R * 1.1, R * 1.0], 'ghost: θ₁ + 0.001°', { color: P.C.ghost, align: 'right' });
      P.drawArrow(r, [-R * 1.0, R * 0.85], 0, -36, { color: P.C.inkSoft, label: 'g', widthPx: 1.6 });
    }
    if (show.forces) {
      const fs = 40 / (Math.max(m1, m2) * this.p.g);
      P.drawArrow(r, p1, 0, -m1 * this.p.g * fs, { color: P.C.gravity, label: 'm_1g', widthPx: 2 });
      P.drawArrow(r, p2, 0, -m2 * this.p.g * fs, { color: P.C.gravity, label: 'm_2g', widthPx: 2 });
    }
    if (show.velocity) {
      const [a1, w1, a2, w2] = this.y;
      const v2 = [this.p.L1 * w1 * Math.cos(a1) + this.p.L2 * w2 * Math.cos(a2), this.p.L1 * w1 * Math.sin(a1) + this.p.L2 * w2 * Math.sin(a2)];
      const vref = Math.sqrt(2 * this.p.g * R) + 0.1;
      const [dx, dy] = P.vecPx(v2[0], v2[1], 60 / vref, 120);
      P.drawArrow(r, p2, dx, dy, { color: P.C.velocity, label: 'v_2', widthPx: 2 });
    }
    void view;
  }

  separation() {
    if (!this.ghost) return null;
    const a = this.positions(this.y)[1], b = this.positions(this.ghost)[1];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  readouts() {
    const e = this.energy();
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: '\\theta_1', value: deg(Math.atan2(Math.sin(this.y[0]), Math.cos(this.y[0]))), unit: '°' },
      { sym: '\\theta_2', value: deg(Math.atan2(Math.sin(this.y[2]), Math.cos(this.y[2]))), unit: '°' },
      { sym: 'E', value: e.KE + e.PE, unit: 'J', label: 'total' },
      { sym: '\\Delta E/E_0', value: ((e.KE + e.PE - this.E0) / Math.max(1e-9, Math.abs(this.E0))) * 100, unit: '%', label: 'drift', digits: 2 },
      ...(this.ghost ? [{ sym: '|\\Delta r|', value: this.separation(), unit: 'm', label: 'ghost gap' }] : []),
    ];
  }

  series() {
    return [
      { key: 'theta1', label: 'θ₁', unit: '°', color: '#4fd1ff', get: () => deg(Math.atan2(Math.sin(this.y[0]), Math.cos(this.y[0]))) },
      { key: 'theta2', label: 'θ₂', unit: '°', color: '#ff8fd0', get: () => deg(Math.atan2(Math.sin(this.y[2]), Math.cos(this.y[2]))) },
      { key: 'sep', label: 'Ghost separation', unit: 'm', color: '#ffb547', get: () => this.separation() ?? 0 },
      ...this.energySeries(() => this.energy()),
    ];
  }
  defaultGraph() { return this.ghost ? ['sep'] : ['theta1', 'theta2']; }

  derived() {
    const e = this.energy();
    return {
      E_total: { label: 'Total energy', value: e.KE + e.PE, unit: 'J' },
      ghost_separation: { label: 'Distance between bob 2 and its ghost', value: this.separation(), unit: 'm' },
      diverge_time: { label: 'Time until ghost visibly diverged', value: this.measured.diverge ?? null, unit: 's' },
    };
  }

  equations() {
    return [
      { title: 'Lagrangian', tex: `\\mathcal L = \\tfrac12(m_1+m_2)L_1^2\\dot\\theta_1^2 + \\tfrac12 m_2L_2^2\\dot\\theta_2^2 + m_2L_1L_2\\dot\\theta_1\\dot\\theta_2\\cos(\\theta_1-\\theta_2) + (m_1+m_2)gL_1\\cos\\theta_1 + m_2gL_2\\cos\\theta_2` },
      { title: 'Equation for θ₁', tex: `\\ddot\\theta_1 = \\frac{-g(2m_1+m_2)\\sin\\theta_1 - m_2 g\\sin(\\theta_1-2\\theta_2) - 2\\sin\\Delta\\, m_2(\\dot\\theta_2^2L_2 + \\dot\\theta_1^2L_1\\cos\\Delta)}{L_1(2m_1+m_2-m_2\\cos 2\\Delta)}` },
      { title: 'Equation for θ₂', tex: `\\ddot\\theta_2 = \\frac{2\\sin\\Delta\\,\\big(\\dot\\theta_1^2L_1(m_1+m_2) + g(m_1+m_2)\\cos\\theta_1 + \\dot\\theta_2^2L_2m_2\\cos\\Delta\\big)}{L_2(2m_1+m_2-m_2\\cos 2\\Delta)},\\quad \\Delta = \\theta_1-\\theta_2` },
      { title: 'Energy (conserved — a check on the RK4 integrator)', tex: `E = ${fmt(this.E0, 5)}\\ \\text{J}` },
    ];
  }

  predictions() {
    return [
      { id: 'chaos', kind: 'choice', question: 'The ghost starts only 0.001° away. After about 20 seconds, the two pendulums will be…', choices: ['still almost identical', 'slightly apart', 'completely different'],
        answer: Math.abs(this.p.theta1) + Math.abs(this.p.theta2) > 60 ? 'completely different' : 'still almost identical',
        explanation: Math.abs(this.p.theta1) + Math.abs(this.p.theta2) > 60
          ? 'At large angles the double pendulum is chaotic: tiny differences grow exponentially, so long-term prediction is impossible in practice.'
          : 'At small angles the motion is nearly linear and regular, so small differences stay small. Try large angles to see chaos.',
        suggest: { theta1: 120, theta2: -20 } },
      { id: 'energy', kind: 'choice', question: 'Even though the motion looks random, the total energy will…', choices: ['stay constant', 'fluctuate randomly', 'decrease'],
        answer: 'stay constant', explanation: 'There is no friction, so energy is conserved exactly — chaos is not randomness. Watch the energy drift readout stay tiny.' },
    ];
  }
}
