import { Scene, fmt } from './base.js';
import { rk4, rad, deg } from '../physics/rk4.js';
import * as P from '../render/primitives.js';

const D = 3.2;      // distance between the end supports (m)
const RAIL_Y = 0;   // underside of the ceiling rail

// Cart M on a frictionless overhead rail between two springs (k each), with a
// rigid pendulum (length L, bob m) hanging from it. Generalised coordinates x, θ.
//   (M+m)ẍ + mL θ̈ cosθ − mL θ̇² sinθ + 2kx = 0
//   L θ̈ + ẍ cosθ + g sinθ = 0
export class CartPendulum extends Scene {
  init() {
    this.y = [this.p.x0, 0, rad(this.p.theta0), 0];
    this.h = 1 / 2000;
    this.cw = 0.62; this.ch = 0.26;
    this.trailClock = 0;
  }

  f = (t, s) => {
    const { M, m, k, L, g } = this.p;
    const [x, xd, th, thd] = s;
    const c = Math.cos(th), sn = Math.sin(th);
    const r1 = m * L * thd * thd * sn - 2 * k * x;
    const r2 = -g * sn;
    const det = L * (M + m * sn * sn);
    const xdd = (r1 * L - m * L * c * r2) / det;
    const thdd = ((M + m) * r2 - c * r1) / det;
    return [xd, xdd, thd, thdd];
  };

  step(h) {
    this.y = rk4(this.f, this.t, this.y, h);
    this.trailClock += h;
    if (this.trailClock > 1 / 60) { this.trailClock = 0; this.pushTrail(this.bobPos(), 360); }
  }

  pivot() { return [this.y[0], RAIL_Y - this.ch - 0.06]; }
  bobPos() { const [px, py] = this.pivot(); const th = this.y[2]; return [px + this.p.L * Math.sin(th), py - this.p.L * Math.cos(th)]; }

  energy() {
    const { M, m, k, L, g } = this.p;
    const [x, xd, th, thd] = this.y;
    const KE = 0.5 * (M + m) * xd * xd + m * L * xd * thd * Math.cos(th) + 0.5 * m * L * L * thd * thd;
    const PE = k * x * x + m * g * L * (1 - Math.cos(th));
    return { KE, PE };
  }

  modes() {
    const { M, m, k, L, g } = this.p;
    // λ² M L − λ(2kL + (M+m)g) + 2kg = 0, λ = ω²
    const A = M * L, B = -(2 * k * L + (M + m) * g), Cc = 2 * k * g;
    const disc = Math.sqrt(Math.max(0, B * B - 4 * A * Cc));
    const l1 = (-B - disc) / (2 * A), l2 = (-B + disc) / (2 * A);
    return [Math.sqrt(l1), Math.sqrt(l2)];
  }

  bounds() {
    const { L } = this.p;
    return { xmin: -D / 2 - 0.45, xmax: D / 2 + 0.55, ymin: -this.ch - 0.06 - L - 0.45, ymax: 0.95 };
  }

  draw(r) {
    const { view, show } = r;
    const { L, m } = this.p;
    const [x, , th] = this.y;
    const left = -D / 2, right = D / 2;
    const cy = RAIL_Y - this.ch / 2 - 0.035;

    // ceiling rail with end supports
    P.drawCeiling(r, left - 0.15, right + 0.15, RAIL_Y);
    const postBottom = cy - 0.12;
    P.drawHatchedLine(r, [left, RAIL_Y], [left, postBottom], { side: 'left', depthPx: 7 });
    P.drawHatchedLine(r, [right, RAIL_Y], [right, postBottom], { side: 'right', depthPx: 7 });

    // springs from supports to cart sides
    const cl = x - this.cw / 2, cr = x + this.cw / 2;
    const stretchL = (cl - left) / (D / 2 - this.cw / 2) - 1;
    const stretchR = (right - cr) / (D / 2 - this.cw / 2) - 1;
    P.drawSpring(r, [left, cy], [cl, cy], { coils: 9, radiusPx: 7, label: show.labels ? 'k' : null, labelSide: 1, stress: stretchL });
    P.drawSpring(r, [cr, cy], [right, cy], { coils: 9, radiusPx: 7, label: show.labels ? 'k' : null, labelSide: 1, stress: stretchR });

    // rollers on top of the cart, touching the rail
    const { ctx } = r;
    for (const s of [-1, 1]) {
      const [wx, wy] = view.pt([x + s * this.cw * 0.28, RAIL_Y - 0.035]);
      const R = view.px(0.035);
      ctx.save(); ctx.fillStyle = '#12171d'; ctx.strokeStyle = P.C.ink; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(wx, wy, Math.max(3, R), 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    P.drawBlock(r, x, cy, this.cw, this.ch, { label: show.labels ? 'M' : null });

    const piv = this.pivot(), bob = this.bobPos();
    P.drawDashed(r, piv, [piv[0], piv[1] - L * 0.55]);
    if (show.trail) P.drawTrace(r, this.trail, { color: P.C.inkSoft, widthPx: 1.4, alpha: 0.6 });
    P.drawRod(r, piv, bob, { widthPx: 6 });
    P.drawPivot(r, piv, { fixed: false, sizePx: 5.5 });
    P.drawBob(r, bob, 10 + 5 * Math.cbrt(m), { label: show.labels ? 'm' : null, labelOffset: [bob[0] >= piv[0] ? 1 : -1, -0.3] });

    if (show.labels) {
      if (Math.abs(th) > rad(1.5)) P.drawAngleArc(r, piv, -Math.PI / 2, -Math.PI / 2 + th, 44, '\\theta');
      P.drawDimension(r, piv, bob, 'L', { offsetPx: th >= 0 ? -24 : 24 });
      P.drawDimension(r, [left, RAIL_Y + 0.62], [right, RAIL_Y + 0.62], 'D');
      P.drawDimension(r, [left, RAIL_Y + 0.3], [x, RAIL_Y + 0.3], 'x_M');
      P.drawDashed(r, [x, RAIL_Y + 0.36], [x, cy + this.ch / 2], { color: 'rgba(232,237,242,0.25)', dash: [3, 4] });
      P.drawLabel(r, [right - 0.35, RAIL_Y + 0.3], '\\mu = 0', { size: 17 });
      P.drawArrow(r, [right + 0.38, cy - 0.15], 0, -34, { color: P.C.ink, label: 'g', widthPx: 1.6 });
      P.drawAxesTriad(r, view.sx(left) + 6, view.sy(-L * 0.55 - 0.4), { labels: ['\\hat{e}_1', '\\hat{e}_2'] });
    }

    if (show.forces) {
      const fs = 45 / Math.max(this.p.k * 0.5, m * this.p.g, 1e-6);
      P.drawArrow(r, [x, cy - this.ch / 2], P.arrowPx(-2 * this.p.k * x, fs, 120), 0, { color: P.C.spring, label: '-2kx' });
      P.drawArrow(r, bob, 0, -m * this.p.g * fs, { color: P.C.gravity, label: 'mg' });
    }
    if (show.velocity) {
      const xd = this.y[1];
      const vs = 50 / Math.max(0.2, Math.abs(this.p.x0) * this.modes()[1] + 0.5);
      P.drawArrow(r, [x, RAIL_Y + 0.14], P.arrowPx(xd, vs, 110), 0, { color: P.C.velocity, label: '\\dot x' , widthPx: 2 });
    }
  }

  readouts() {
    const [x, xd, th, thd] = this.y;
    const e = this.energy();
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: 'x_M', value: x, unit: 'm' },
      { sym: '\\dot x', value: xd, unit: 'm/s' },
      { sym: '\\theta', value: deg(th), unit: '°' },
      { sym: '\\dot\\theta', value: thd, unit: 'rad/s' },
      { sym: 'E', value: e.KE + e.PE, unit: 'J', label: 'total' },
    ];
  }

  series() {
    return [
      { key: 'x', label: 'Cart position', unit: 'm', color: '#4fd1ff', get: () => this.y[0] },
      { key: 'theta', label: 'Angle θ', unit: '°', color: '#ff8fd0', get: () => deg(this.y[2]) },
      ...this.energySeries(() => this.energy()),
    ];
  }
  defaultGraph() { return ['x', 'theta']; }

  derived() {
    const [w1, w2] = this.modes();
    const e = this.energy();
    return {
      omega_mode1: { label: 'Normal mode ω₁ (small oscillations)', value: w1, unit: 'rad/s' },
      omega_mode2: { label: 'Normal mode ω₂ (small oscillations)', value: w2, unit: 'rad/s' },
      T_mode1: { label: 'Mode 1 period', value: 2 * Math.PI / w1, unit: 's' },
      T_mode2: { label: 'Mode 2 period', value: 2 * Math.PI / w2, unit: 's' },
      E_total: { label: 'Total energy', value: e.KE + e.PE, unit: 'J' },
    };
  }

  equations() {
    const [w1, w2] = this.modes();
    return [
      { title: 'Lagrangian (generalised coordinates x_M, θ)', tex: `\\mathcal{L} = \\tfrac12(M+m)\\dot x^2 + mL\\dot x\\dot\\theta\\cos\\theta + \\tfrac12 mL^2\\dot\\theta^2 - kx^2 + mgL\\cos\\theta` },
      { title: 'Cart equation', tex: `(M+m)\\ddot x + mL\\ddot\\theta\\cos\\theta - mL\\dot\\theta^2\\sin\\theta + 2kx = 0` },
      { title: 'Pendulum equation', tex: `L\\ddot\\theta + \\ddot x\\cos\\theta + g\\sin\\theta = 0` },
      { title: 'Small-oscillation normal modes', tex: `\\omega^4 ML - \\omega^2\\big(2kL + (M+m)g\\big) + 2kg = 0 \\Rightarrow \\omega_1 = ${fmt(w1)},\\ \\omega_2 = ${fmt(w2)}\\ \\text{rad/s}` },
    ];
  }

  predictions() {
    return [
      { id: 'energy', kind: 'choice', question: 'Over time, the total mechanical energy of cart + pendulum will…', choices: ['stay constant', 'slowly decrease', 'keep growing'],
        answer: 'stay constant', explanation: 'The rail is frictionless and the springs and gravity are conservative forces, so energy only moves between kinetic, spring and gravitational forms.' },
      { id: 'momentum', kind: 'choice', question: 'Is the total horizontal momentum of cart + bob conserved?', choices: ['Yes', 'No'],
        answer: 'No', explanation: 'The springs are attached to the fixed supports, so they exert an external horizontal force on the system. Set k very small to approach momentum conservation.',
        suggest: { k: 1 } },
      { id: 'modes', kind: 'choice', question: 'Start with the cart at the centre and only the pendulum displaced. The cart will…', choices: ['stay still', 'start moving', 'move only if M < m'],
        answer: 'start moving', explanation: 'The swinging pendulum pulls sideways on the pivot (the rod tension has a horizontal component), which pushes the cart back and forth.',
        suggest: { x0: 0, theta0: 25 } },
    ];
  }
}
