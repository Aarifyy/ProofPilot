import { Scene, fmt } from './base.js';
import * as P from '../render/primitives.js';

// Ideal Atwood machine: light inextensible rope over a massless frictionless pulley.
// s = distance m1 has moved DOWN (m2 moves up by the same amount).
export class Atwood extends Scene {
  init() {
    this.R = 0.22;
    const { h } = this.p;
    this.pulleyY = h + 1.35;
    const sz = (m) => 0.16 + 0.12 * Math.cbrt(m);
    this.b1 = sz(this.p.m1); this.b2 = sz(this.p.m2);
    this.s = 0; this.v = 0;
    this.h = 1 / 2000;
  }

  get a() { const { m1, m2, g } = this.p; return ((m1 - m2) * g) / (m1 + m2); }
  get T() { const { m1, m2, g } = this.p; return (2 * m1 * m2 * g) / (m1 + m2); }

  // bottom of each block (world y)
  y1(s = this.s) { return this.p.h - s; }
  y2(s = this.s) { return this.p.h + s; }

  limit() {
    // travel until a block hits the floor or its top reaches just below the pulley
    const top1 = (s) => this.y1(s) + this.b1, top2 = (s) => this.y2(s) + this.b2;
    const maxDown = Math.min(this.p.h, this.pulleyY - this.R - 0.12 - this.b2 - this.p.h);
    const maxUp = Math.min(this.p.h, this.pulleyY - this.R - 0.12 - this.b1 - this.p.h);
    void top1; void top2;
    return { maxDown: Math.max(0, maxDown), maxUp: Math.max(0, maxUp) };
  }

  step(h) {
    const a = this.a;
    if (Math.abs(a) < 1e-12) { this.finishAfterStep('Balanced: equal masses, zero net force — nothing accelerates', P.C.normal); return; }
    const { maxDown, maxUp } = this.limit();
    const ns = this.s + this.v * h + 0.5 * a * h * h;
    const nv = this.v + a * h;
    if (ns >= maxDown || ns <= -maxUp) {
      const target = ns >= maxDown ? maxDown : -maxUp;
      const tHit = Math.sqrt((2 * (target - this.s)) / a + (this.v / a) ** 2) - this.v / a;
      this.v += a * tHit; this.s = target;
      this.measured.t_end = this.t + tHit;
      this.measured.v_end = Math.abs(this.v);
      this.measured.a = Math.abs(this.v) / (this.t + tHit);
      this.t += tHit - h;
      this.finishAfterStep(`Stopped after ${fmt(this.measured.t_end)} s — measured a = ${fmt(this.measured.a)} m/s²`, P.C.velocity);
      return;
    }
    this.s = ns; this.v = nv;
    if (this.t > 0.2 && this.measured.a === undefined) this.measured.a_live = Math.abs(this.v) / (this.t + h);
  }

  energy() {
    const { m1, m2, g } = this.p;
    return { KE: 0.5 * (m1 + m2) * this.v * this.v, PE: m1 * g * (this.y1() - this.p.h) + m2 * g * (this.y2() - this.p.h) };
  }

  bounds() { return { xmin: -1.6, xmax: 1.6, ymin: -0.3, ymax: this.pulleyY + 0.55 }; }

  draw(r) {
    const { show } = r;
    const { m1, m2, g } = this.p;
    const R = this.R, py = this.pulleyY;
    const cx1 = -R, cx2 = R;
    const y1 = this.y1(), y2 = this.y2();

    P.drawCeiling(r, -0.6, 0.6, py + 0.42);
    P.drawRod(r, [0, py + 0.42], [0, py], { widthPx: 6 });
    P.drawGround(r, -1.5, 1.5, 0);

    // rope: wraps over the top half of the pulley
    const { ctx, view } = r;
    ctx.save(); ctx.strokeStyle = P.C.rope; ctx.lineWidth = 1.8;
    const [pcx, pcy] = view.pt([0, py]);
    ctx.beginPath(); ctx.arc(pcx, pcy, view.px(R), Math.PI, 0); ctx.stroke(); ctx.restore();
    P.drawRope(r, [cx1, py], [cx1, y1 + this.b1]);
    P.drawRope(r, [cx2, py], [cx2, y2 + this.b2]);
    P.drawPulley(r, [0, py], R, -this.s / R);

    P.drawBlock(r, cx1 - 0.0, y1 + this.b1 / 2, this.b1 * 1.1, this.b1, { label: show.labels ? 'm_1' : null, accent: P.C.velocity });
    P.drawBlock(r, cx2 + 0.0, y2 + this.b2 / 2, this.b2 * 1.1, this.b2, { label: show.labels ? 'm_2' : null, accent: P.C.gravity });

    if (show.labels) {
      P.drawDimension(r, [cx1 - this.b1 * 0.55 - 0.25, 0], [cx1 - this.b1 * 0.55 - 0.25, y1], 'y_1');
      P.drawDimension(r, [cx2 + this.b2 * 0.55 + 0.25, 0], [cx2 + this.b2 * 0.55 + 0.25, y2], 'y_2');
      P.drawTag(r, [0, py + 0.42], 'massless, frictionless pulley', { dy: 20 });
      P.drawTag(r, [0, 0], 'light inextensible rope', { dy: -22 });
      P.drawArrow(r, [1.35, py - 0.2], 0, -36, { color: P.C.inkSoft, label: 'g', widthPx: 1.6 });
    }

    if (show.forces) {
      const fs = 75 / (Math.max(m1, m2) * g);
      const T = this.T;
      P.drawArrow(r, [cx1, y1 + this.b1], 0, T * fs, { color: P.C.tension, label: 'T', widthPx: 2 });
      P.drawArrow(r, [cx1, y1], 0, -m1 * g * fs, { color: P.C.gravity, label: 'm_1g' });
      P.drawArrow(r, [cx2, y2 + this.b2], 0, T * fs, { color: P.C.tension, label: 'T', widthPx: 2 });
      P.drawArrow(r, [cx2, y2], 0, -m2 * g * fs, { color: P.C.gravity, label: 'm_2g' });
    }
    if (show.velocity && Math.abs(this.v) > 1e-6) {
      const vmax = Math.sqrt(2 * Math.abs(this.a) * Math.max(0.1, this.p.h));
      const L = (this.v / vmax) * 70;
      P.drawArrow(r, [cx1 - this.b1 * 0.55 - 0.08, y1 + this.b1 / 2], 0, -L, { color: P.C.velocity, label: 'v', widthPx: 2 });
      P.drawArrow(r, [cx2 + this.b2 * 0.55 + 0.08, y2 + this.b2 / 2], 0, L, { color: P.C.velocity, label: 'v', widthPx: 2 });
    }
  }

  readouts() {
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: 'v', value: this.v, unit: 'm/s', label: 'm₁ down +' },
      { sym: 'a', value: this.a, unit: 'm/s²' },
      { sym: 'T', value: this.T, unit: 'N', label: 'tension' },
      { sym: 'y_1', value: this.y1(), unit: 'm' },
      { sym: 'y_2', value: this.y2(), unit: 'm' },
    ];
  }

  series() {
    return [
      { key: 'y1', label: 'Height y₁', unit: 'm', color: '#4fd1ff', get: () => this.y1() },
      { key: 'y2', label: 'Height y₂', unit: 'm', color: '#ffb547', get: () => this.y2() },
      { key: 'v', label: 'Speed v', unit: 'm/s', color: '#c6f36b', get: () => this.v },
      ...this.energySeries(() => this.energy()),
    ];
  }
  defaultGraph() { return ['y1', 'y2', 'v']; }

  derived() {
    return {
      a: { label: 'Acceleration (m₁ down +)', value: this.a, unit: 'm/s²' },
      T: { label: 'Rope tension', value: this.T, unit: 'N' },
      W1: { label: 'Weight of m₁', value: this.p.m1 * this.p.g, unit: 'N' },
      W2: { label: 'Weight of m₂', value: this.p.m2 * this.p.g, unit: 'N' },
      a_measured: { label: 'Measured acceleration', value: this.measured.a ?? this.measured.a_live ?? null, unit: 'm/s²' },
    };
  }

  equations() {
    const { m1, m2, g } = this.p;
    return [
      { title: 'Newton’s 2nd law for each mass (m₁ down positive)', tex: `m_1 a = m_1 g - T,\\qquad m_2 a = T - m_2 g` },
      { title: 'Add them: the rope tension cancels', tex: `a = \\frac{(m_1 - m_2)\\,g}{m_1 + m_2} = \\frac{(${fmt(m1)} - ${fmt(m2)})\\times ${fmt(g)}}{${fmt(m1 + m2)}} = ${fmt(this.a)}\\ \\text{m/s}^2` },
      { title: 'Tension', tex: `T = \\frac{2m_1m_2\\,g}{m_1+m_2} = ${fmt(this.T)}\\ \\text{N}` },
    ];
  }

  predictions() {
    const heavier = this.p.m1 >= this.p.m2 ? 'm₁' : 'm₂';
    return [
      { id: 'a', kind: 'number', question: 'What will the magnitude of the acceleration be?', sym: 'a', unit: 'm/s²', measuredKey: 'a',
        theory: Math.abs(this.a), hint: 'Treat both masses as one system: net force (m₁ − m₂)g accelerates total mass m₁ + m₂.' },
      { id: 'T', kind: 'choice', question: `Compared with the weight of the heavier mass (${heavier}), the rope tension is…`, choices: ['greater', 'equal', 'less'],
        answer: this.p.m1 === this.p.m2 ? 'equal' : 'less',
        explanation: 'If the tension equalled the heavier weight, there would be no net force on it and it couldn’t accelerate downward. So T lies between the two weights.' },
    ];
  }
}
