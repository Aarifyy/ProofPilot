import { Scene, fmt } from './base.js';
import { rk4, rad } from '../physics/rk4.js';
import * as P from '../render/primitives.js';

export class Projectile extends Scene {
  init() {
    const { v0, angle, h0 } = this.p;
    const a = rad(angle);
    this.s = [0, h0, v0 * Math.cos(a), v0 * Math.sin(a)];
    this.peak = { x: 0, y: h0 };
    this.landed = null;
    this.h = 1 / 2000;
    this.trailClock = 0;
    this.trail = [[0, h0]];
    this.vacuumPath = this._vacuumPath();
    this.dragPath = this.p.drag > 0 ? this._simulatePath() : null;
  }

  accel(vx, vy) {
    const { g, drag, m } = this.p;
    const sp = Math.hypot(vx, vy);
    const c = drag / m;
    return [-c * sp * vx, -g - c * sp * vy];
  }

  f = (t, s) => { const [ax, ay] = this.accel(s[2], s[3]); return [s[2], s[3], ax, ay]; };

  step(h) {
    const prev = this.s;
    const next = rk4(this.f, this.t, prev, h);
    if (prev[3] > 0 && next[3] <= 0) {
      const fr = prev[3] / (prev[3] - next[3]);
      this.peak = { x: prev[0] + fr * (next[0] - prev[0]), y: prev[1] + fr * (next[1] - prev[1]) };
      this.measured.hmax = this.peak.y;
    }
    if (next[1] < 0 && (this.t > 0 || next[3] < 0)) {
      const fr = prev[1] / (prev[1] - next[1]);
      const land = prev.map((v, i) => v + fr * (next[i] - v));
      land[1] = 0;
      this.s = land;
      this.t += fr * h - h; // base adds h afterwards
      this.landed = { x: land[0], t: this.t + h };
      this.measured.range = land[0];
      this.measured.tof = this.t + h;
      if (this.measured.hmax === undefined) this.measured.hmax = Math.max(this.p.h0, this.peak.y);
      this.trail.push([land[0], 0]);
      this.finishAfterStep(`Landed — range ${fmt(land[0])} m after ${fmt(this.t + h)} s`, P.C.velocity);
      return;
    }
    this.s = next;
    this.trailClock += h;
    if (this.trailClock >= 1 / 60) { this.trailClock = 0; this.trail.push([next[0], next[1]]); }
  }

  theory() {
    const { v0, angle, h0, g } = this.p;
    const a = rad(angle);
    const vx = v0 * Math.cos(a), vy = v0 * Math.sin(a);
    const tof = (vy + Math.sqrt(vy * vy + 2 * g * h0)) / g;
    return { tof, R: vx * tof, H: h0 + (vy * vy) / (2 * g), vx, vy };
  }

  _vacuumPath() {
    const { tof, vx, vy } = this.theory();
    const pts = [];
    for (let i = 0; i <= 80; i++) { const t = (tof * i) / 80; pts.push([vx * t, this.p.h0 + vy * t - 0.5 * this.p.g * t * t]); }
    return pts;
  }

  _simulatePath() {
    let s = [...this.s];
    const pts = [[s[0], s[1]]];
    for (let i = 0, t = 0; i < 200000; i++, t += 1 / 400) {
      const n = rk4(this.f, t, s, 1 / 400);
      if (n[1] < 0) { const fr = s[1] / (s[1] - n[1]); pts.push([s[0] + fr * (n[0] - s[0]), 0]); break; }
      s = n; if (i % 4 === 0) pts.push([s[0], s[1]]);
    }
    return pts;
  }

  bounds() {
    const path = this.dragPath ?? this.vacuumPath;
    let xmax = 0, ymax = this.p.h0;
    for (const [x, y] of path) { xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); }
    if (this.dragPath) for (const [x, y] of this.vacuumPath) { xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); }
    xmax = Math.max(xmax, 1);
    ymax = Math.max(ymax, 0.5);
    const w = Math.max(xmax, ymax * 0.9);
    return { xmin: -0.12 * w - (this.p.h0 > 0 ? 0.05 * w : 0), xmax: w * 1.06, ymin: -0.1 * Math.max(w * 0.3, ymax), ymax: ymax * 1.12 };
  }

  energy() {
    const { m, g } = this.p;
    const [, y, vx, vy] = this.s;
    return { KE: 0.5 * m * (vx * vx + vy * vy), PE: m * g * y };
  }

  draw(r) {
    const { ctx, view, show } = r;
    const b = view.visible();
    const [x, y, vx, vy] = this.s;
    const { h0, m, g, drag, angle } = this.p;
    const th = this.theory();

    // terrain: platform/cliff if launched from height, else flat ground
    const groundX0 = h0 > 0 ? 0 : b.xmin;
    P.drawGround(r, groundX0, b.xmax, 0);
    if (h0 > 0) {
      const cliffW = Math.max(0.6, (b.xmax - b.xmin) * 0.06);
      ctx.save(); ctx.fillStyle = '#121820';
      const [cx0, cy0] = view.pt([b.xmin, h0]);
      const [cx1, cy1] = view.pt([0, 0]);
      ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
      ctx.restore();
      P.drawGround(r, b.xmin, 0, h0);
      P.drawWall(r, 0, h0, 0, 'left');
      P.drawDimension(r, [-cliffW * 0.0, 0], [-cliffW * 0.0, h0], 'h_0', { offsetPx: 34 });
    }
    P.drawRuler(r, 0, Math.max(th.R, x) * 1.02, 0);

    if (show.labels) {
      P.drawTag(r, [b.xmin, b.ymax], drag > 0 ? `air drag k = ${fmt(drag)} kg/m` : 'vacuum (no air resistance)', { dx: 16, dy: -48, align: 'left' });
      P.drawArrow(r, [b.xmax - (b.xmax - b.xmin) * 0.03, b.ymax - (b.ymax - b.ymin) * 0.08], 0, -38, { color: P.C.inkSoft, label: 'g', widthPx: 1.6 });
    }

    // launch geometry
    const a = rad(angle);
    const L0 = 70 / view.scale;
    P.drawDashed(r, [0, h0], [L0 * 1.2, h0]);
    if (show.labels && angle > 0.5) {
      P.drawDashed(r, [0, h0], [Math.cos(a) * L0 * 1.15, h0 + Math.sin(a) * L0 * 1.15], { color: P.C.inkSoft });
      P.drawAngleArc(r, [0, h0], 0, a, 46, '\\theta');
    }
    this._drawLauncher(r, a);

    // reference vacuum parabola when drag is on
    if (this.dragPath && show.labels) {
      ctx.save(); ctx.setLineDash([4, 6]); ctx.strokeStyle = 'rgba(232,237,242,0.35)'; ctx.lineWidth = 1.2; ctx.beginPath();
      this.vacuumPath.forEach((p, i) => { const [sx, sy] = view.pt(p); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.stroke(); ctx.restore();
      const last = this.vacuumPath[this.vacuumPath.length - 1];
      P.drawTag(r, last, 'vacuum path', { dy: 34, color: P.C.inkDim });
    }

    if (show.trail) P.drawTrace(r, this.trail, { dotEvery: 15 });

    // apex marker and dimensions after landing
    if (this.measured.hmax !== undefined && show.labels) {
      P.drawDimension(r, [this.peak.x, 0], [this.peak.x, this.peak.y], `H = ${fmt(this.measured.hmax)}\\text{ m}`, { size: 15 });
    }
    if (this.landed && show.labels) {
      P.drawDimension(r, [0, 0], [this.landed.x, 0], `R = ${fmt(this.landed.x)}\\text{ m}`, { offsetPx: 46 });
    }

    // the ball
    const rPx = 8 + 4 * Math.cbrt(m);
    P.drawBob(r, [x, y], rPx, { label: show.labels ? 'm' : null, labelOffset: [-1, 1] });

    // vectors
    if (show.velocity && !this.finished) {
      const vs = 70 / Math.max(1, this.p.v0);
      const [dx, dy] = P.vecPx(vx, vy, vs, 140);
      P.drawArrow(r, [x, y], dx, dy, { color: P.C.velocity, label: 'v' });
      if (show.components) {
        P.drawArrow(r, [x, y], dx, 0, { color: P.C.velocity, dashed: true, widthPx: 1.6, label: 'v_x' });
        P.drawArrow(r, [x, y], 0, dy, { color: P.C.velocity, dashed: true, widthPx: 1.6, label: 'v_y' });
      }
    }
    if (show.forces && !this.finished) {
      const fs = 48 / (m * g);
      P.drawArrow(r, [x, y], 0, -m * g * fs, { color: P.C.gravity, label: 'mg' });
      if (drag > 0) {
        const sp = Math.hypot(vx, vy);
        const Fd = drag * sp * sp;
        const [dx, dy] = P.vecPx(-vx / (sp || 1) * Fd, -vy / (sp || 1) * Fd, fs, 120);
        P.drawArrow(r, [x, y], dx, dy, { color: P.C.friction, label: 'F_D' });
      }
    }
  }

  _drawLauncher(r, a) {
    const { ctx, view } = r;
    const [x, y] = view.pt([0, this.p.h0]);
    ctx.save();
    ctx.translate(x, y);
    // base
    ctx.fillStyle = '#1a2129'; ctx.strokeStyle = P.C.ink; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(0, 0, 13, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    // barrel
    ctx.rotate(-a);
    const g = ctx.createLinearGradient(0, -6, 0, 6); g.addColorStop(0, '#9aa5b1'); g.addColorStop(1, '#3a4450');
    ctx.fillStyle = g; P.roundRect(ctx, -4, -6, 36, 12, 3); ctx.fill(); ctx.stroke();
    ctx.restore();
    P.drawPivot(r, [0, this.p.h0], { fixed: false, sizePx: 4 });
  }

  readouts() {
    const [x, y, vx, vy] = this.s;
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: 'x', value: x, unit: 'm' },
      { sym: 'y', value: y, unit: 'm' },
      { sym: '|v|', value: Math.hypot(vx, vy), unit: 'm/s' },
      { sym: 'v_x', value: vx, unit: 'm/s' },
      { sym: 'v_y', value: vy, unit: 'm/s' },
    ];
  }

  series() {
    const e = () => this.energy();
    return [
      { key: 'x', label: 'x position', unit: 'm', color: '#4fd1ff', get: () => this.s[0] },
      { key: 'y', label: 'Height y', unit: 'm', color: '#c6f36b', get: () => this.s[1] },
      { key: 'speed', label: 'Speed |v|', unit: 'm/s', color: '#7dffcf', get: () => Math.hypot(this.s[2], this.s[3]) },
      { key: 'vx', label: 'Horizontal velocity v_x', unit: 'm/s', color: '#b79cff', get: () => this.s[2] },
      { key: 'vy', label: 'Vertical velocity v_y', unit: 'm/s', color: '#ff8fd0', get: () => this.s[3] },
      ...this.energySeries(e),
    ];
  }
  defaultGraph() { return ['y', 'vy']; }

  derived() {
    const th = this.theory();
    return {
      range_theory: { label: 'Range (no drag, theory)', value: th.R, unit: 'm' },
      tof_theory: { label: 'Flight time (no drag, theory)', value: th.tof, unit: 's' },
      hmax_theory: { label: 'Max height (no drag, theory)', value: th.H, unit: 'm' },
      range_measured: { label: 'Range (simulated)', value: this.measured.range ?? null, unit: 'm' },
      hmax_measured: { label: 'Max height (simulated)', value: this.measured.hmax ?? null, unit: 'm' },
      tof_measured: { label: 'Flight time (simulated)', value: this.measured.tof ?? null, unit: 's' },
    };
  }

  equations() {
    const { v0, angle, h0, g, drag, m } = this.p;
    const th = this.theory();
    const eq = [
      { title: 'Horizontal motion (constant velocity)', tex: `x(t) = v_0\\cos\\theta\\,t = ${fmt(th.vx)}\\,t` },
      { title: 'Vertical motion (constant acceleration)', tex: `y(t) = h_0 + v_0\\sin\\theta\\,t - \\tfrac12 g t^2 = ${fmt(h0)} + ${fmt(th.vy)}\\,t - ${fmt(g / 2)}\\,t^2` },
      { title: 'Time of flight', tex: `T = \\frac{v_0\\sin\\theta + \\sqrt{(v_0\\sin\\theta)^2 + 2gh_0}}{g} = ${fmt(th.tof)}\\ \\text{s}` },
      { title: 'Maximum height', tex: `H = h_0 + \\frac{(v_0\\sin\\theta)^2}{2g} = ${fmt(th.H)}\\ \\text{m}` },
      { title: h0 === 0 ? 'Range on level ground' : 'Range', tex: h0 === 0 ? `R = \\frac{v_0^2\\sin 2\\theta}{g} = \\frac{${fmt(v0)}^2\\sin ${fmt(2 * angle)}^\\circ}{${fmt(g)}} = ${fmt(th.R)}\\ \\text{m}` : `R = v_0\\cos\\theta\\,T = ${fmt(th.R)}\\ \\text{m}` },
    ];
    if (drag > 0) eq.push({ title: 'With quadratic air drag (solved numerically, RK4)', tex: `m\\dot{\\vec v} = m\\vec g - k|\\vec v|\\vec v,\\quad k/m = ${fmt(drag / m)}\\ \\text{m}^{-1}` });
    return eq;
  }

  predictions() {
    const th = this.theory();
    const drag = this.p.drag > 0;
    return [
      { id: 'range', kind: 'number', question: 'How far will the ball travel horizontally before it lands?', sym: 'R', unit: 'm', measuredKey: 'range', theory: drag ? null : th.R,
        hint: 'Split the motion: find the flight time from the vertical motion, then multiply by the constant horizontal speed v₀cosθ.' },
      { id: 'hmax', kind: 'number', question: 'What maximum height will the ball reach?', sym: 'H', unit: 'm', measuredKey: 'hmax', theory: drag ? null : th.H,
        hint: 'At the top the vertical velocity is zero: (v₀sinθ)² = 2g(H − h₀).' },
      { id: 'mass', kind: 'choice', question: 'If the ball were 10× heavier (same launch speed and angle), its range would…',
        choices: ['increase', 'stay the same', 'decrease'], answer: drag ? 'increase' : 'stay the same',
        explanation: drag
          ? 'With air drag on, the drag deceleration is (k/m)v², so a heavier ball of the same size loses speed more slowly and goes further.'
          : 'Without air resistance every object has the same acceleration g, so mass cancels and the trajectory is identical.',
        suggest: { m: Math.min(20, this.p.m * 10) } },
      { id: 'angle', kind: 'choice', question: 'On level ground with no air resistance, which launch angle gives the greatest range?',
        choices: ['30°', '45°', '60°', '75°'], answer: '45°',
        explanation: 'R = v₀² sin 2θ / g is largest when sin 2θ = 1, i.e. θ = 45°. 30° and 60° give equal ranges.',
        suggest: { angle: 45, h0: 0, drag: 0 } },
    ];
  }
}
