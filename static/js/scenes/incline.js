import { Scene, fmt } from './base.js';
import { rad, deg } from '../physics/rk4.js';
import * as P from '../render/primitives.js';

// Block on a fixed ramp with static (μs) and kinetic (μk) friction.
// s = distance travelled down the slope from the starting point.
export class Incline extends Scene {
  init() {
    const { m, d } = this.p;
    const sz = Math.min(0.16 * d, 0.6) * Math.cbrt(m / 2);
    this.bw = Math.max(0.18, sz * 1.25); this.bh = Math.max(0.14, sz * 0.9);
    this.travel = Math.max(0, d - this.bw - 0.05 * d);
    this.s = 0;
    this.v = this.p.v0;
    this.h = 1 / 2000;
    this.state = this.v > 0 ? 'sliding' : (this.willSlip() ? 'sliding' : 'static');
    this.thermal = 0;
  }

  get a_() { return rad(this.p.angle); }
  willSlip() { return Math.tan(this.a_) > this.p.mu_s; }
  accSliding() { const { g, mu_k } = this.p; return g * (Math.sin(this.a_) - mu_k * Math.cos(this.a_)); }

  frictionForce() {
    const { m, g, mu_k } = this.p;
    if (this.state === 'static') return m * g * Math.sin(this.a_); // up the slope, balancing exactly
    return mu_k * m * g * Math.cos(this.a_);                       // up the slope, opposing motion
  }

  step(h) {
    if (this.state === 'static') {
      if (!this.finished) this.finishAfterStep(`No slip — tan α = ${fmt(Math.tan(this.a_))} ≤ μs = ${fmt(this.p.mu_s)}, static friction holds the block`, P.C.normal);
      return;
    }
    const a = this.accSliding();
    let v = this.v + a * h;
    let ds = this.v * h + 0.5 * a * h * h;
    if (v <= 0 && a < 0) {
      // decelerates to rest; then static friction can hold it (tan α < μk ≤ μs)
      const tstop = this.v / -a;
      ds = this.v * tstop + 0.5 * a * tstop * tstop;
      this.thermal += this.p.mu_k * this.p.m * this.p.g * Math.cos(this.a_) * ds;
      this.s += ds; this.v = 0; this.state = 'static';
      this.measured.stopDistance = this.s;
      this.finishAfterStep(`Friction brought the block to rest after ${fmt(this.s)} m`, P.C.friction);
      return;
    }
    if (this.s + ds >= this.travel) {
      const rem = this.travel - this.s;
      const tHit = Math.abs(a) < 1e-12 ? rem / this.v : (-this.v + Math.sqrt(this.v * this.v + 2 * a * rem)) / a;
      this.thermal += this.p.mu_k * this.p.m * this.p.g * Math.cos(this.a_) * rem;
      this.v = this.v + a * tHit;
      this.s = this.travel;
      this.measured.t_bottom = this.t + tHit;
      this.measured.v_bottom = this.v;
      this.t += tHit - h;
      this.finishAfterStep(`Reached the bottom in ${fmt(this.measured.t_bottom)} s at ${fmt(this.v)} m/s`, P.C.velocity);
      return;
    }
    this.thermal += this.p.mu_k * this.p.m * this.p.g * Math.cos(this.a_) * ds;
    this.s += ds; this.v = v;
  }

  // geometry: ramp top-left at (0, H), bottom-right at (B, 0)
  geom() {
    const { d } = this.p;
    const a = this.a_;
    return { H: d * Math.sin(a), B: d * Math.cos(a), ux: Math.cos(a), uy: -Math.sin(a), nx: Math.sin(a), ny: Math.cos(a) };
  }

  blockCentre() {
    const G = this.geom();
    const along = 0.03 * this.p.d + this.bw / 2 + this.s;
    const sx = along * G.ux, sy = G.H + along * G.uy;
    return [sx + G.nx * this.bh / 2, sy + G.ny * this.bh / 2];
  }

  energy() {
    const { m, g } = this.p;
    const [, y] = this.blockCentre();
    return { KE: 0.5 * m * this.v * this.v, PE: m * g * (y - this.bh / 2 * Math.cos(this.a_)) };
  }

  bounds() {
    const G = this.geom();
    const w = Math.max(G.B, G.H * 1.2);
    return { xmin: -0.12 * w, xmax: G.B + 0.12 * w, ymin: -0.12 * w, ymax: G.H + 0.18 * w };
  }

  draw(r) {
    const { ctx, view, show } = r;
    const { m, g, mu_s, mu_k, angle } = this.p;
    const G = this.geom();
    const a = this.a_;
    const vis = view.visible();

    // ramp body
    ctx.save();
    const [x0, y0] = view.pt([0, 0]), [x1, y1] = view.pt([G.B, 0]), [x2, y2] = view.pt([0, G.H]);
    const grad = ctx.createLinearGradient(x2, y2, x1, y1);
    grad.addColorStop(0, '#1b232c'); grad.addColorStop(1, '#10151b');
    ctx.fillStyle = grad; ctx.strokeStyle = P.C.ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    P.drawGround(r, vis.xmin, vis.xmax, 0);
    if (mu_k > 0 || mu_s > 0) P.drawRoughness(r, [0, G.H], [G.B, 0]);

    if (show.labels) {
      P.drawAngleArc(r, [G.B, 0], Math.PI, Math.PI - a, Math.min(70, view.px(G.B) * 0.25), '\\alpha');
      P.drawDimension(r, [0, G.H], [G.B, 0], 'd', { offsetPx: -30 });
      const mid = [G.B * 0.62, G.H * 0.38];
      P.drawTag(r, mid, mu_s === 0 && mu_k === 0 ? 'frictionless' : `μs = ${fmt(mu_s)}   μk = ${fmt(mu_k)}`, { dy: -26, dx: -20 });
    }

    const [cx, cy] = this.blockCentre();
    P.drawBlock(r, cx, cy, this.bw, this.bh, { rot: -a, label: show.labels ? 'm' : null });

    if (show.forces) {
      const W = m * g;
      const fs = 70 / W;
      const N = W * Math.cos(a);
      P.drawArrow(r, [cx, cy], 0, -W * fs, { color: P.C.gravity, label: 'mg' });
      P.drawArrow(r, [cx, cy], G.nx * N * fs, G.ny * N * fs, { color: P.C.normal, label: 'N' });
      const f = this.frictionForce();
      if (f > 1e-9) {
        const base = [cx - G.nx * this.bh / 2, cy - G.ny * this.bh / 2];
        P.drawArrow(r, base, -G.ux * f * fs, -G.uy * f * fs, { color: P.C.friction, label: this.state === 'static' ? 'f_s' : 'f_k' });
      }
      if (show.components) {
        const along = W * Math.sin(a), perp = W * Math.cos(a);
        P.drawArrow(r, [cx, cy], G.ux * along * fs, G.uy * along * fs, { color: P.C.gravity, dashed: true, widthPx: 1.5, label: 'mg\\sin\\alpha' });
        P.drawArrow(r, [cx, cy], -G.nx * perp * fs, -G.ny * perp * fs, { color: P.C.gravity, dashed: true, widthPx: 1.5, label: 'mg\\cos\\alpha' });
      }
    }
    if (show.velocity && this.v > 1e-6) {
      const vmax = Math.sqrt(this.p.v0 ** 2 + 2 * Math.max(0.1, this.accSliding()) * this.travel);
      const L = Math.min(120, (this.v / Math.max(0.1, vmax)) * 110);
      const p = [cx + G.nx * (this.bh * 0.9), cy + G.ny * (this.bh * 0.9)];
      P.drawArrow(r, p, G.ux * L, G.uy * L, { color: P.C.velocity, label: 'v' });
    }
  }

  readouts() {
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: 's', value: this.s, unit: 'm', label: 'down slope' },
      { sym: 'v', value: this.v, unit: 'm/s' },
      { sym: 'a', value: this.state === 'static' ? 0 : this.accSliding(), unit: 'm/s²' },
      { sym: 'N', value: this.p.m * this.p.g * Math.cos(this.a_), unit: 'N' },
      { sym: 'f', value: this.frictionForce(), unit: 'N', label: this.state === 'static' ? 'static' : 'kinetic' },
    ];
  }

  series() {
    return [
      { key: 's', label: 'Distance s', unit: 'm', color: '#4fd1ff', get: () => this.s },
      { key: 'v', label: 'Speed v', unit: 'm/s', color: '#c6f36b', get: () => this.v },
      ...this.energySeries(() => this.energy()),
      { key: 'Q', label: 'Heat from friction', unit: 'J', color: '#ff6b6b', get: () => this.thermal },
    ];
  }
  defaultGraph() { return ['s', 'v']; }

  tBottomTheory() {
    if (!(this.willSlip() || this.p.v0 > 0)) return null;
    const a = this.accSliding(), v0 = this.p.v0, L = this.travel;
    if (Math.abs(a) < 1e-12) return v0 > 0 ? L / v0 : null;
    const disc = v0 * v0 + 2 * a * L;
    if (disc < 0) return null;
    return (-v0 + Math.sqrt(disc)) / a;
  }

  derived() {
    return {
      slides: { label: 'Block slides', value: this.willSlip() || this.p.v0 > 0 },
      critical_angle: { label: 'Critical angle arctan μs', value: deg(Math.atan(this.p.mu_s)), unit: '°' },
      a: { label: 'Acceleration while sliding', value: this.accSliding(), unit: 'm/s²' },
      t_bottom: { label: 'Time to bottom (theory)', value: this.tBottomTheory(), unit: 's' },
      travel: { label: 'Distance to bottom', value: this.travel, unit: 'm' },
      t_bottom_measured: { label: 'Time to bottom (simulated)', value: this.measured.t_bottom ?? null, unit: 's' },
    };
  }

  equations() {
    const { g, mu_s, mu_k, angle } = this.p;
    return [
      { title: 'Normal force (perpendicular to the ramp)', tex: `N = mg\\cos\\alpha` },
      { title: 'Slips if gravity along the slope beats max static friction', tex: `mg\\sin\\alpha > \\mu_s mg\\cos\\alpha \\iff \\tan\\alpha > \\mu_s \\quad(${fmt(Math.tan(this.a_))} ${this.willSlip() ? '>' : '\\le'} ${fmt(mu_s)})` },
      { title: 'Acceleration while sliding', tex: `a = g(\\sin\\alpha - \\mu_k\\cos\\alpha) = ${fmt(g)}(\\sin ${fmt(angle)}^\\circ - ${fmt(mu_k)}\\cos ${fmt(angle)}^\\circ) = ${fmt(this.accSliding())}\\ \\text{m/s}^2` },
      { title: 'Distance travelled', tex: `s = v_0 t + \\tfrac12 a t^2` },
      { title: 'Energy (friction turns work into heat)', tex: `mgh = \\tfrac12 mv^2 + \\mu_k mg\\cos\\alpha\\, s` },
    ];
  }

  predictions() {
    const slides = this.willSlip() || this.p.v0 > 0;
    return [
      { id: 'slip', kind: 'choice', question: 'Released from rest, will the block start to slide?', choices: ['Yes, it slides', 'No, it stays put'],
        answer: this.willSlip() ? 'Yes, it slides' : 'No, it stays put',
        explanation: `Compare tan α = ${fmt(Math.tan(this.a_))} with μs = ${fmt(this.p.mu_s)}: it slides only if tan α > μs (critical angle ${fmt(deg(Math.atan(this.p.mu_s)))}°).`,
        suggest: { v0: 0 } },
      ...(slides ? [{ id: 'tb', kind: 'number', question: 'How long will the block take to reach the bottom?', sym: 't', unit: 's', measuredKey: 't_bottom',
        theory: this.tBottomTheory(), hint: 'Find a = g(sin α − μk cos α), then solve s = v₀t + ½at² for t.' }] : []),
      { id: 'mass', kind: 'choice', question: 'If the block were 5× heavier, its acceleration down the ramp would…', choices: ['increase', 'stay the same', 'decrease'],
        answer: 'stay the same', explanation: 'Both mg sin α and friction μk mg cos α scale with m, so a = g(sin α − μk cos α) has no m in it.',
        suggest: { m: Math.min(50, this.p.m * 5) } },
    ];
  }
}
