import { Scene, fmt } from './base.js';
import * as P from '../render/primitives.js';

const TRACK = 12; // m

// Two carts on a frictionless track; exact event-driven collision with restitution e.
export class Collision extends Scene {
  init() {
    const { m1, m2, u1, u2 } = this.p;
    this.w1 = 0.7 + 0.6 * Math.cbrt(m1 / 2); this.w2 = 0.7 + 0.6 * Math.cbrt(m2 / 2);
    this.hh1 = 0.38 + 0.3 * Math.cbrt(m1 / 2); this.hh2 = 0.38 + 0.3 * Math.cbrt(m2 / 2);
    this.x1 = 3.5; this.x2 = 8.5;
    this.v1 = u1; this.v2 = u2;
    this.collided = false;
    this.flash = 0;
    this.joined = false;
    this.h = 1 / 1000;
  }

  after() {
    const { m1, m2, u1, u2, e } = this.p;
    const P0 = m1 * u1 + m2 * u2, M = m1 + m2;
    return { v1: (P0 + m2 * e * (u2 - u1)) / M, v2: (P0 + m1 * e * (u1 - u2)) / M };
  }

  step(h) {
    const gap = () => (this.x2 - this.w2 / 2) - (this.x1 + this.w1 / 2);
    if (!this.collided && this.v1 > this.v2) {
      const g0 = gap();
      const tc = g0 / (this.v1 - this.v2);
      if (tc <= h) {
        this.x1 += this.v1 * tc; this.x2 += this.v2 * tc;
        const { v1, v2 } = this.after();
        this.v1 = v1; this.v2 = v2;
        this.collided = true;
        this.joined = this.p.e === 0;
        this.flash = 0.35;
        this.measured.v1 = v1; this.measured.v2 = v2;
        this.measured.tc = this.t + tc;
        this.x1 += this.v1 * (h - tc); this.x2 += this.v2 * (h - tc);
        this.banner(this.p.e === 0 ? 'Perfectly inelastic — the carts stick together' : `Collision! v₁ → ${fmt(v1)} m/s, v₂ → ${fmt(v2)} m/s`, P.C.gravity);
        return;
      }
    }
    this.x1 += this.v1 * h; this.x2 += this.v2 * h;
    this.flash = Math.max(0, this.flash - h);
    const out = this.x1 - this.w1 / 2 < 0 || this.x2 + this.w2 / 2 > TRACK || this.x1 + this.w1 / 2 > TRACK || this.x2 - this.w2 / 2 < 0;
    if (out) this.finishAfterStep(this.collided ? 'A cart reached the end of the track' : 'The carts never meet — cart 1 is not catching cart 2', P.C.inkSoft);
    else if (!this.collided && this.v1 <= this.v2 && this.t > 4) this.finishAfterStep('The carts never meet — cart 1 is not catching cart 2', P.C.inkSoft);
  }

  momentum() { return this.p.m1 * this.v1 + this.p.m2 * this.v2; }
  energy() { return { KE: 0.5 * this.p.m1 * this.v1 ** 2 + 0.5 * this.p.m2 * this.v2 ** 2, PE: 0 }; }

  bounds() { return { xmin: -0.4, xmax: TRACK + 0.4, ymin: -2.9, ymax: 2.0 }; }

  draw(r) {
    const { ctx, view, show } = r;
    const { m1, m2, u1, u2 } = this.p;
    // rail + end stops
    P.drawGround(r, -0.3, TRACK + 0.3, 0);
    ctx.save(); ctx.strokeStyle = 'rgba(232,237,242,0.35)'; ctx.lineWidth = 1;
    const ry = view.sy(0.035);
    ctx.beginPath(); ctx.moveTo(view.sx(0), ry); ctx.lineTo(view.sx(TRACK), ry); ctx.stroke(); ctx.restore();
    P.drawWall(r, 0, 0, 0.35, 'left'); P.drawWall(r, TRACK, 0, 0.35, 'right');
    if (show.labels) P.drawTag(r, [TRACK / 2, 0], `frictionless track · restitution e = ${fmt(this.p.e)}`, { dy: -22 });

    const wheel = 0.13;
    const c1y = wheel * 2 + this.hh1 / 2, c2y = wheel * 2 + this.hh2 / 2;
    P.drawCart(r, this.x1, c1y, this.w1, this.hh1, { label: show.labels ? 'm_1' : null, accent: P.C.velocity });
    P.drawCart(r, this.x2, c2y, this.w2, this.hh2, { label: show.labels ? 'm_2' : null, accent: P.C.gravity });

    if (this.flash > 0 && show.forces) {
      const xc = this.x1 + this.w1 / 2, yc = Math.min(c1y, c2y);
      const a = this.flash / 0.35;
      ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = 'rgba(255,181,71,0.25)';
      const [sx, sy] = view.pt([xc, yc]); ctx.beginPath(); ctx.arc(sx, sy, 30, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      P.drawArrow(r, [xc, yc], -60 * a, 0, { color: P.C.friction, label: 'F_{21}' });
      P.drawArrow(r, [xc, yc], 60 * a, 0, { color: P.C.friction, label: 'F_{12}' });
    }

    if (show.velocity) {
      const vs = 50 / Math.max(0.5, Math.abs(u1), Math.abs(u2));
      P.drawArrow(r, [this.x1, c1y + this.hh1 / 2 + 0.15], P.arrowPx(this.v1, vs, 130), 0, { color: P.C.velocity, label: 'v_1' });
      P.drawArrow(r, [this.x2, c2y + this.hh2 / 2 + 0.15], P.arrowPx(this.v2, vs, 130), 0, { color: P.C.velocity, label: 'v_2' });
    }

    // momentum and energy bars
    if (show.labels) this._bars(r, m1, m2);
  }

  _bars(r, m1, m2) {
    const { ctx, view } = r;
    const p1 = m1 * this.v1, p2 = m2 * this.v2, pt = p1 + p2;
    const KE0 = 0.5 * m1 * this.p.u1 ** 2 + 0.5 * m2 * this.p.u2 ** 2;
    const KE = this.energy().KE;
    const pmax = Math.max(1e-6, Math.abs(m1 * this.p.u1) + Math.abs(m2 * this.p.u2), Math.abs(p1) + Math.abs(p2));
    const zeroX = view.sx(TRACK * 0.5);
    const half = view.px(TRACK) * 0.34;
    const scale = half / pmax;
    const labelX = view.sx(TRACK * 0.5) - half - 18;
    const caption = (text, y) => {
      ctx.save(); ctx.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = P.C.inkDim;
      ctx.textAlign = 'center'; ctx.fillText(text, zeroX, y); ctx.restore();
    };
    const value = (text, x, y) => {
      ctx.save(); ctx.font = '12px Inter, "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = P.C.inkSoft;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(text, x, y); ctx.restore();
    };
    let y = view.sy(-1.05);
    caption('MOMENTUM  p = mv  (kg·m/s)   ← left · right →', y - 16);
    ctx.save(); ctx.strokeStyle = 'rgba(232,237,242,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(zeroX, y - 9); ctx.lineTo(zeroX, y + 3 * 20 - 10); ctx.stroke(); ctx.restore();
    for (const [sym, val, col] of [['p_1', p1, P.C.velocity], ['p_2', p2, P.C.gravity], ['p_{\\text{tot}}', pt, P.C.ink]]) {
      const w = val * scale;
      ctx.save(); ctx.fillStyle = col; ctx.globalAlpha = 0.85;
      ctx.fillRect(Math.min(zeroX, zeroX + w), y - 6, Math.abs(w), 12); ctx.restore();
      drawRowLabel(r, sym, labelX, y);
      value(fmt(val), zeroX + Math.max(0, w) + 8, y);
      y += 20;
    }
    y += 26;
    caption('KINETIC ENERGY  (J)', y - 16);
    const ew = half / Math.max(1e-6, KE0);
    ctx.save();
    ctx.fillStyle = 'rgba(232,237,242,0.14)'; ctx.fillRect(zeroX, y - 6, KE0 * ew, 12);
    ctx.fillStyle = P.C.normal; ctx.fillRect(zeroX, y - 6, KE * ew, 12);
    ctx.restore();
    drawRowLabel(r, 'K', labelX, y);
    value(`${fmt(KE)} of ${fmt(KE0)} J${KE < KE0 - 1e-9 ? `   (${fmt(KE0 - KE)} J → heat & sound)` : ''}`, zeroX + KE0 * ew + 8, y);
  }

  readouts() {
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: 'v_1', value: this.v1, unit: 'm/s' },
      { sym: 'v_2', value: this.v2, unit: 'm/s' },
      { sym: 'p', value: this.momentum(), unit: 'kg·m/s', label: 'total' },
      { sym: 'K', value: this.energy().KE, unit: 'J', label: 'total' },
    ];
  }

  series() {
    return [
      { key: 'x1', label: 'Position x₁', unit: 'm', color: '#4fd1ff', get: () => this.x1 },
      { key: 'x2', label: 'Position x₂', unit: 'm', color: '#ffb547', get: () => this.x2 },
      { key: 'v1', label: 'Velocity v₁', unit: 'm/s', color: '#4fd1ff', get: () => this.v1 },
      { key: 'v2', label: 'Velocity v₂', unit: 'm/s', color: '#ffb547', get: () => this.v2 },
      { key: 'p', label: 'Total momentum', unit: 'kg·m/s', color: '#e8edf2', get: () => this.momentum() },
      { key: 'KE', label: 'Total kinetic energy', unit: 'J', color: '#5fe3a1', get: () => this.energy().KE },
    ];
  }
  defaultGraph() { return ['v1', 'v2', 'p']; }

  derived() {
    const { m1, m2, u1, u2 } = this.p;
    const { v1, v2 } = this.after();
    const KE0 = 0.5 * m1 * u1 ** 2 + 0.5 * m2 * u2 ** 2, KE1 = 0.5 * m1 * v1 ** 2 + 0.5 * m2 * v2 ** 2;
    return {
      will_collide: { label: 'Carts collide', value: u1 > u2 },
      v1: { label: 'v₁ after (theory)', value: v1, unit: 'm/s' },
      v2: { label: 'v₂ after (theory)', value: v2, unit: 'm/s' },
      p_total: { label: 'Total momentum', value: m1 * u1 + m2 * u2, unit: 'kg·m/s' },
      KE_before: { label: 'KE before', value: KE0, unit: 'J' },
      KE_after: { label: 'KE after', value: KE1, unit: 'J' },
      KE_lost: { label: 'KE lost', value: KE0 - KE1, unit: 'J' },
    };
  }

  equations() {
    const { m1, m2, u1, u2, e } = this.p;
    const { v1, v2 } = this.after();
    return [
      { title: 'Conservation of momentum', tex: `m_1u_1 + m_2u_2 = m_1v_1 + m_2v_2 = ${fmt(m1 * u1 + m2 * u2)}\\ \\text{kg m/s}` },
      { title: 'Restitution (relative speed after / before)', tex: `v_2 - v_1 = e\\,(u_1 - u_2),\\quad e = ${fmt(e)}` },
      { title: 'Solving both', tex: `v_1 = \\frac{m_1u_1 + m_2u_2 + m_2 e (u_2 - u_1)}{m_1+m_2} = ${fmt(v1)},\\quad v_2 = \\frac{m_1u_1 + m_2u_2 + m_1 e (u_1 - u_2)}{m_1+m_2} = ${fmt(v2)}` },
      { title: 'Kinetic energy lost', tex: `\\Delta K = \\tfrac12\\frac{m_1m_2}{m_1+m_2}(1-e^2)(u_1-u_2)^2 = ${fmt(this.derived().KE_lost.value)}\\ \\text{J}` },
    ];
  }

  predictions() {
    const { e } = this.p;
    const collide = this.p.u1 > this.p.u2;
    return [
      ...(collide ? [{ id: 'v2', kind: 'number', question: 'What will cart 2’s velocity be just after the collision? (right is positive)', sym: 'v_2', unit: 'm/s', measuredKey: 'v2',
        theory: this.after().v2, hint: 'Use conservation of momentum together with v₂ − v₁ = e(u₁ − u₂).' }] : []),
      { id: 'ke', kind: 'choice', question: 'Will the total kinetic energy be the same after the collision?', choices: ['Yes, conserved', 'No, some is lost', 'No, it increases'],
        answer: e === 1 ? 'Yes, conserved' : 'No, some is lost',
        explanation: e === 1 ? 'With e = 1 the collision is perfectly elastic, so kinetic energy is conserved (as well as momentum).'
          : `With e = ${fmt(e)} < 1 some kinetic energy becomes heat, sound and deformation. Momentum is still conserved.` },
      { id: 'p', kind: 'choice', question: 'Compared with before the collision, the total momentum afterwards is…', choices: ['larger', 'the same', 'smaller', 'zero'],
        answer: 'the same', explanation: 'The carts push on each other with equal and opposite forces (Newton’s 3rd law) and there is no external horizontal force, so total momentum is conserved in every collision.' },
    ];
  }
}

import { drawMath } from '../render/mathtext.js';
function drawRowLabel(r, sym, x, y) { drawMath(r.ctx, sym, x, y, { size: 14, align: 'right' }); }
