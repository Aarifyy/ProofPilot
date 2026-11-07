import { Scene, fmt } from './base.js';
import * as P from '../render/primitives.js';
import { drawMath } from '../render/mathtext.js';
import { buildTrack, presetTrack } from '../physics/track.js';

// General track simulation. The geometry comes from the spec (preset shape or
// AI-generated segments / safe expression); the motion comes from Newton's laws:
//
//   tangential:  m(1+β) dv/dt = −m g dy/ds + F_applied + f          (β = I/mr², rolling only)
//   normal:      N = m (v² κ + g n_y)                                 (κ: signed curvature of the
//                                                                     body-centre path, n: normal
//                                                                     pointing to the body's side)
// A body resting on a track needs N ≥ 0; if the required N goes negative it
// leaves the track and flies freely until it hits the track again (impact with
// restitution e). A rail-locked cart may have N < 0 (the rail pulls).
const D2R = Math.PI / 180;
const SHAPE_NAMES = {
  bowl: 'semicircular bowl', parabola: 'parabolic bowl', sine: 'sine-wave track', ramp: 'hill that levels out',
  incline: 'incline with run-out', coaster: 'roller-coaster track', function: 'function track', custom: 'custom track',
};
const BODY_NAMES = { ball: 'ball', cart: 'cart', block: 'block', point: 'point mass' };

export class TrackScene extends Scene {
  init() {
    if (!this.track) this._build();
    const { p } = this;
    this.h = 1 / 2000;
    this.maxTime = 90;
    this.trailClock = 0;
    this.spinAngle = 0;
    this.wheelAngle = 0;
    this.dist = 0;
    this.stuckFor = 0;
    this.vmax = 0;
    this.impacts = 0;
    this.turns = [];
    this.lastD = 1;
    this.slideSign = 1; this.slipSign = 1;
    this.nextCrest = undefined;
    this.measured = {};
    const q0 = this.track.at(this.s0);
    if (p.h_drop > 0) {
      this.mode = 'flight';
      const dirX = this.opt.dir === 'left' ? -1 : 1;
      this.fl = [q0.x, q0.y + p.h_drop, dirX * p.v0, 0];
      this.flAngle = Math.atan2(q0.ty, q0.tx);
      this.s = this.s0; this.v = 0; this.w = 0;
    } else {
      this.mode = 'track';
      this.s = this.s0;
      this.v = this.dirSign * p.v0;
      this.w = this.spin ? -this.v / this.r : 0;
      if (p.v0 === 0) this.turns.push(0);
      this.regime = this._regimeFor(this.s, this.v, this.w, 0);
    }
    this._kin = null;
  }

  // ------------------------------------------------------------ setup
  _build() {
    const { p, opt } = this;
    this.warnings = [];
    const body = BODY_NAMES[opt.body] ? opt.body : 'ball';
    this.bodyKind = body;
    const clearance = { ball: p.size / 2, block: p.size / 2, cart: 0.42 * p.size, point: 0 }[body];
    let shape = SHAPE_NAMES[opt.shape] ? opt.shape : 'bowl';
    const ends = (d) => { if (opt.ends === 'walls' || opt.ends === 'open') d.ends = opt.ends; return d; };
    let built;
    try {
      const { def, info } = presetTrack(shape, p, this.spec.track ?? {});
      built = { track: buildTrack(ends(def), clearance), info };
    } catch (err) {
      this.warnings.push(`Couldn't build that track (${err.message}). Showing a sine-wave track instead.`);
      shape = 'sine';
      const { def, info } = presetTrack('sine', { A: 1, lambda: 8, phi: 0, periods: 2.5, ...p }, {});
      built = { track: buildTrack(ends(def), clearance), info };
    }
    this.shape = shape;
    this.track = built.track;
    this.info = built.info;
    this.warnings.push(...this.track.warnings);
    this.c = this.track.clearance;
    this.scaleBody = clearance > 0 ? this.c / clearance : 1;
    this.r = Math.max(1e-3, this.c);
    this.rail = body === 'cart' && opt.rail === 'locked';
    this.spin = body === 'ball' && opt.contact !== 'slide';
    this.beta = this.spin ? (opt.inertia === 'hollow' ? 2 / 3 : 2 / 5) : 0;
    if (body === 'cart') { this.muS = p.c_rr; this.muK = p.c_rr; }
    else { this.muS = p.mu_s; this.muK = Math.min(p.mu_k, p.mu_s || p.mu_k); }
    this.canRoll = this.spin && this.muS > 0;
    if (this.spin && !this.canRoll) this.warnings.push('With zero friction nothing can make the ball spin, so it slides without rolling (its rotation stays constant).');
    if (body === 'point') this.warnings.push('Idealised point mass: no size and no rotation.');

    // start position
    const auto = this.spec.track?.start_auto !== false;
    let s0;
    if (auto) {
      if (this.info.startX != null) s0 = this.track.sAtX(this.info.startX);
      if (s0 == null) s0 = 0.03 * this.track.length;
    } else {
      s0 = this.track.sAtX(p.x0);
      if (s0 == null) {
        s0 = p.x0 < this.track.box.xmin ? 0 : this.track.length;
        this.warnings.push(`x = ${fmt(p.x0)} m is not on the track; starting at the nearest end instead.`);
      }
    }
    const L = this.track.length;
    s0 = Math.min(L * 0.999, Math.max(L * 0.001, s0));
    this.s0 = s0;
    const q0 = this.track.at(s0);
    this.p.x0 = +q0.sx.toFixed(3);
    if (this.spec.params) this.spec.params.x0 = this.p.x0;
    this.dirSign = (opt.dir === 'left' ? -1 : 1) * (q0.tx >= -1e-9 ? 1 : -1);
    this.startY = q0.y;

    // features used for measurements and annotations
    if (this.info.loopIdx != null) this.loopRange = this.track.segRange(this.info.loopIdx);
    this.crests = [];
    for (const Pc of this.track.pieces) for (let i = 1; i < Pc.n - 1; i++) {
      if (Pc.y[i] > Pc.y[i - 1] && Pc.y[i] >= Pc.y[i + 1] && Pc.ty[i - 1] > 0.002 && Pc.ty[i + 1] < -0.002) this.crests.push(Pc.s0 + i * Pc.ds);
    }
    this.railStyle = shape === 'coaster' || (shape === 'custom' && (this.info.loopIdx != null || this.track.segCount > 3));
    const S = this.track.surface;
    this.monotone = true;
    for (let i = 1; i < S.x.length; i++) if (S.x[i] < S.x[i - 1] - 1e-9) { this.monotone = false; break; }
  }

  paramRange(key) {
    if (key === 'x0' && this.track) {
      const b = this.track.box;
      return { min: +b.xmin.toFixed(2), max: +b.xmax.toFixed(2) };
    }
    return null;
  }

  forceOn(t) { return this.p.F > 0 && t < this.p.tF; }

  // ------------------------------------------------------------ dynamics
  evalForces(s, v, w, t, regime) {
    const q = this.track.at(s);
    const { m, g } = this.p;
    const N = m * (v * v * q.k + g * q.ny);
    const Nn = this.rail ? Math.abs(N) : Math.max(0, N);
    const Fa = this.forceOn(t) ? this.p.F * this.dirSign : 0;
    const D = -m * g * q.dy + Fa;
    let f = 0, a, dw = 0;
    switch (regime) {
      case 'stick': a = 0; f = -D; break;
      case 'roll': a = D / (m * (1 + this.beta)); f = -this.beta * m * a; dw = -a / this.r; break;
      // Kinetic friction direction is fixed for the whole sub-step (set in step()),
      // so a crossing of zero relative velocity is detected instead of chattering.
      case 'slip':
        f = -this.muK * Nn * this.slipSign; a = (D + f) / m; dw = f / (this.beta * m * this.r);
        break;
      case 'slide':
        f = -this.muK * Nn * this.slideSign; a = (D + f) / m;
        break;
      default: a = D / m;
    }
    return { a, dw, N, Nn, f, D, Fa, q };
  }

  _regimeFor(s, v, w, t) {
    if (this.spin) {
      const vs = v + w * this.r;
      if (Math.abs(vs) < 1e-7 && this.canRoll) {
        const k = this.evalForces(s, v, w, t, 'roll');
        if (Math.abs(k.f) <= this.muS * k.Nn + 1e-12) return 'roll';
        this.slipSign = Math.sign(k.D) || 1;
      } else this.slipSign = Math.sign(vs) || 1;
      return 'slip';
    }
    if (this.muK > 0 || this.muS > 0) {
      if (Math.abs(v) < 1e-9) {
        const k = this.evalForces(s, 0, 0, t, 'stick');
        if (Math.abs(k.D) <= this.muS * k.Nn + 1e-12) return 'stick';
        this.slideSign = Math.sign(k.D) || 1;
      }
      return 'slide';
    }
    return 'free';
  }

  step(h) {
    if (this.mode === 'flight') return this._stepFlight(h);
    const t = this.t, R = this.regime;
    const s = this.s, v = this.v, w = this.w;
    if (R === 'slide' && v !== 0) this.slideSign = Math.sign(v);
    if (R === 'slip') { const vs = v + w * this.r; if (Math.abs(vs) > 1e-12) this.slipSign = Math.sign(vs); }
    const k1 = this.evalForces(s, v, w, t, R);
    const k2 = this.evalForces(s + (h / 2) * v, v + (h / 2) * k1.a, w + (h / 2) * k1.dw, t + h / 2, R);
    const v2 = v + (h / 2) * k1.a;
    const v3 = v + (h / 2) * k2.a;
    const k3 = this.evalForces(s + (h / 2) * v2, v3, w + (h / 2) * k2.dw, t + h / 2, R);
    const v4 = v + h * k3.a;
    const k4 = this.evalForces(s + h * v3, v4, w + h * k3.dw, t + h, R);
    let ns = s + (h / 6) * (v + 2 * v2 + 2 * v3 + v4);
    let nv = v + (h / 6) * (k1.a + 2 * k2.a + 2 * k3.a + k4.a);
    let nw = w + (h / 6) * (k1.dw + 2 * k2.dw + 2 * k3.dw + k4.dw);
    if (R === 'stick') { ns = s; nv = 0; }

    // track ends
    const L = this.track.length;
    if (ns < 0 || ns > L) {
      if (this.track.ends === 'walls') {
        // impact exactly at the stop: take the speed it has at s = 0 or L (energy-consistent), then reflect
        const sEnd = ns < 0 ? 0 : L, qe = this.track.at(sEnd);
        const yOver = qe.y + qe.dy * (ns - sEnd);
        const mEff = this.regime === 'roll' ? 1 + this.beta : 1;
        const vEnd = Math.sign(nv) * Math.sqrt(Math.max(0, nv * nv + (2 * this.p.g * (yOver - qe.y)) / mEff));
        ns = sEnd === 0 ? 1e-9 : L - 1e-9;
        nv = -this.p.e * vEnd;
        if (Math.abs(nv) < 0.03) nv = 0;
        if (this.spin) nw = this.regime === 'roll' ? -nv / this.r : nw;
        if (this.impacts++ < 3) this.banner(`Hit the end stop (e = ${fmt(this.p.e)})`, P.C.inkSoft);
      } else {
        this.s = Math.min(L, Math.max(0, ns)); this.v = nv; this.w = nw;
        this._detach('Ran off the end of the track');
        return;
      }
    }
    // sharp corners between smooth pieces
    const pa = this.track.pieceAt(s), pb = this.track.pieceAt(ns);
    if (pa !== pb) {
      const j = Math.min(pa, pb), jt = this.track.joints[j];
      if (jt.type === 'convex' && nv !== 0) {
        this.s = jt.s; this.v = nv; this.w = nw;
        this._detach('Left the track at a sharp crest');
        return;
      }
      const before = 0.5 * nv * nv;
      nv *= Math.max(0, jt.cos);
      this.banner(`Hit a sharp corner: ${fmt(this.p.m * (before - 0.5 * nv * nv))} J of kinetic energy lost`, P.C.friction);
    }
    const prevV = v;
    this.dist += Math.abs(ns - s);
    this.s = ns; this.v = nv; this.w = nw;
    if (this.spin) this.spinAngle += nw * h;
    if (this.bodyKind === 'cart') this.wheelAngle -= (nv / Math.max(0.01, 0.12 * this.p.size * this.scaleBody)) * h;

    // contact: a resting body can only be pushed
    const k = this.evalForces(ns, nv, nw, t + h, this.regime);
    if (!this.rail && k.N < -1e-6 * this.p.m * this.p.g) {
      this._detach('Lost contact: the track would have to pull (N < 0)');
      return;
    }

    // friction regime changes
    if (this.regime === 'slide') {
      if (prevV !== 0 && Math.sign(nv) !== Math.sign(prevV)) {
        this.v = 0;
        const kk = this.evalForces(ns, 0, 0, t + h, 'stick');
        if (Math.abs(kk.D) <= this.muS * kk.Nn) this.regime = 'stick';
        else this.slideSign = Math.sign(kk.D) || 1;
      }
    } else if (this.regime === 'stick') {
      const kk = this.evalForces(ns, 0, 0, t + h, 'stick');
      if (Math.abs(kk.D) > this.muS * kk.Nn) { this.regime = 'slide'; this.slideSign = Math.sign(kk.D) || 1; }
    } else if (this.regime === 'roll') {
      const kr = this.evalForces(ns, nv, nw, t + h, 'roll');
      if (Math.abs(kr.f) > this.muS * kr.Nn + 1e-12) { this.regime = 'slip'; this.slipSign = Math.sign(kr.D) || 1; if (this.impacts < 6) this.banner('Static friction is too small: the ball starts to skid', P.C.friction); }
    } else if (this.regime === 'slip' && this.canRoll) {
      const vs0 = v + w * this.r, vs1 = nv + nw * this.r;
      if (Math.sign(vs0) !== Math.sign(vs1) || Math.abs(vs1) < 1e-7) {
        this.w = -nv / this.r;
        this.regime = this._regimeFor(ns, nv, this.w, t + h);
      }
    }

    // stopped for good?
    if (this.regime === 'stick' && !this.forceOn(t + h)) {
      this.stuckFor += h;
      if (this.measured.d_stop === undefined) {
        this.measured.d_stop = this.dist;
        this.measured.x_stop = k.q.sx;
      }
      if (this.stuckFor > 1) this.finishAfterStep(`Came to rest after travelling ${fmt(this.dist)} m`, P.C.normal);
    } else this.stuckFor = 0;

    this._measure(s, ns, prevV, this.v, t + h, k);
    this._trail(h);
  }

  _measure(s, ns, v, nv, t, k) {
    const M = this.measured;
    const sp = Math.abs(nv);
    this.vmax = Math.max(this.vmax, sp);
    // turning points (oscillation period, return height)
    if (v !== 0 && nv !== 0 && Math.sign(v) !== Math.sign(nv) && this.regime !== 'stick') {
      const tc = t - this.h * (Math.abs(nv) / (Math.abs(v) + Math.abs(nv)));
      this.turns.push(tc);
      if (M.h_turn === undefined) M.h_turn = this.track.at(ns).y - this.track.lowest.y;
      if (this.turns.length >= 2 && M.T === undefined) M.T = 2 * (this.turns[1] - this.turns[0]);
      if (this.nextCrest != null && M.cleared === undefined) M.cleared = 'no';
    }
    const low = this.track.lowest.s;
    if ((s - low) * (ns - low) <= 0 && s !== ns && M.v_bottom === undefined) { M.v_bottom = sp; M.N_bottom = k.N; }
    if (this.loopRange) {
      const [lo, hi] = this.loopRange, top = (lo + hi) / 2;
      if ((s - top) * (ns - top) <= 0 && s !== ns && M.v_top === undefined) { M.v_top = sp; M.N_top = k.N; }
      if (s < hi && ns >= hi && M.loop === undefined) { M.loop = 'completed'; this.banner('Made it round the loop!', P.C.normal); }
    }
    if (this.nextCrest === undefined) {
      const dir = Math.sign(nv);
      this.nextCrest = dir ? (dir > 0 ? this.crests.find((c) => c > this.s0 + 0.05) : [...this.crests].reverse().find((c) => c < this.s0 - 0.05)) ?? null : null;
    }
    if (this.nextCrest != null && M.cleared === undefined && (s - this.nextCrest) * (ns - this.nextCrest) <= 0 && s !== ns) M.cleared = 'yes';
  }

  _trail(h) {
    this.trailClock += h;
    if (this.trailClock > 1 / 50) { this.trailClock = 0; this.pushTrail(this.pos(), 700); }
  }

  _detach(reason) {
    const q = this.track.at(this.s);
    this.fl = [q.x, q.y, this.v * q.tx, this.v * q.ty];
    this.flAngle = Math.atan2(q.ty, q.tx);
    this.mode = 'flight';
    this.lastD = 0;
    const M = this.measured;
    if (M.detach_h === undefined) M.detach_h = q.y - this.track.lowest.y;
    if (this.loopRange && this.s > this.loopRange[0] && this.s < this.loopRange[1] && M.loop === undefined) M.loop = 'fell';
    if (this.nextCrest != null && M.cleared === undefined && Math.abs(this.s - this.nextCrest) < 0.3) M.cleared = 'yes';
    this.banner(reason, P.C.gravity);
  }

  _stepFlight(h) {
    const { g, m, e } = this.p;
    const [x, y, vx, vy] = this.fl;
    const nx = x + vx * h, ny = y + vy * h - 0.5 * g * h * h, nvy = vy - g * h;
    if (this.spin) this.spinAngle += this.w * h;
    const q = this.track.nearest(nx, ny);
    if (q && !q.outside && q.d < 0 && this.lastD >= -1e-9) {
      const { tx, ty, nx: Nx, ny: Ny } = q.q;
      const vn = vx * Nx + nvy * Ny, vt = vx * tx + nvy * ty;
      const vnNew = -e * Math.min(0, vn);
      const lost = 0.5 * m * (vn * vn - vnNew * vnNew);
      this.impacts++;
      if (lost > 0.005 * m * (vx * vx + nvy * nvy) && this.impacts <= 6) this.banner(`Impact: ${fmt(lost)} J of kinetic energy lost (e = ${fmt(e)})`, P.C.friction);
      this.measured.impact_loss = (this.measured.impact_loss ?? 0) + lost;
      if (vnNew < 0.25) {
        this.mode = 'track';
        this.s = q.s; this.v = vt;
        this.regime = this._regimeFor(this.s, this.v, this.w, this.t + h);
        this.fl = null;
      } else {
        this.fl = [q.q.x + Nx * 1e-6, q.q.y + Ny * 1e-6, vt * tx + vnNew * Nx, vt * ty + vnNew * Ny];
        this.lastD = 1e-6;
      }
    } else {
      this.fl = [nx, ny, vx, nvy];
      this.lastD = q ? q.d : 1;
      const b = this.track.box, span = Math.max(b.xmax - b.xmin, b.ymax - b.ymin, 1);
      if (ny < b.ymin - 0.6 * span - 5 || Math.abs(nx - (b.xmin + b.xmax) / 2) > 3 * span + 20) {
        this.finishAfterStep(`The ${BODY_NAMES[this.bodyKind]} left the track`, P.C.gravity);
      }
    }
    this.vmax = Math.max(this.vmax, Math.hypot(this.fl ? this.fl[2] : this.v, this.fl ? this.fl[3] : 0));
    this._trail(h);
  }

  // ------------------------------------------------------------ state access
  pos() {
    if (this.mode === 'flight') return [this.fl[0], this.fl[1]];
    const q = this.track.at(this.s);
    return [q.x, q.y];
  }
  vel() {
    if (this.mode === 'flight') return [this.fl[2], this.fl[3]];
    const q = this.track.at(this.s);
    return [this.v * q.tx, this.v * q.ty];
  }

  /** Current forces/kinematics (cached per time step). */
  kin() {
    if (this._kin && this._kin.t === this.t) return this._kin;
    const { m, g } = this.p;
    let out;
    if (this.mode === 'flight') {
      out = { t: this.t, flight: true, N: 0, f: 0, Fa: 0, at: NaN, an: NaN, ax: 0, ay: -g, q: null };
    } else {
      const k = this.evalForces(this.s, this.v, this.w, this.t, this.regime);
      const an = this.v * this.v * k.q.k;
      out = { t: this.t, flight: false, N: k.N, f: k.f, Fa: k.Fa, at: k.a, an, ax: k.a * k.q.tx + an * k.q.nx, ay: k.a * k.q.ty + an * k.q.ny, q: k.q };
    }
    out.mg = m * g;
    return (this._kin = out);
  }

  energy() {
    const { m, g } = this.p;
    const [vx, vy] = this.vel();
    const rot = this.spin ? 0.5 * this.beta * m * this.r * this.r * this.w * this.w : 0;
    return { KE: 0.5 * m * (vx * vx + vy * vy) + rot, PE: m * g * (this.pos()[1] - this.track.lowest.y) };
  }

  // ------------------------------------------------------------ view
  bounds() {
    const b = this.track.box;
    const span = Math.max(b.xmax - b.xmin, b.ymax - b.ymin, 2);
    const top = Math.max(b.ymax, this.startY + this.p.h_drop + this.c) + this.c;
    return { xmin: b.xmin - 0.06 * span - this.c, xmax: b.xmax + 0.06 * span + this.c, ymin: this._floorY() - 0.02 * span, ymax: top + 0.1 * span };
  }
  _floorY() {
    const b = this.track.box, span = Math.max(b.xmax - b.xmin, b.ymax - b.ymin, 2);
    return b.ymin - Math.max(0.35, 0.05 * span);
  }

  draw(r) {
    const { ctx, view, show } = r;
    const { m, g } = this.p;
    this._drawTrack(r);
    if (show.labels) this._annotate(r);
    if (show.trail) P.drawTrace(r, this.trail, { color: P.C.trace, widthPx: 1.6, alpha: 0.65 });

    const kin = this.kin();
    const angle = this.mode === 'flight' ? this.flAngle : Math.atan2(kin.q.ty, kin.q.tx);
    // Bodies are drawn at least a readable size on big tracks. The physics uses the
    // real size; a drawn body larger than that is lifted along the normal so it
    // still sits on the surface.
    const minPx = { ball: 9, block: 22, cart: 46, point: 0 }[this.bodyKind];
    const realPx = this.bodyKind === 'ball' ? view.px(this.c) : view.px(this.p.size * this.scaleBody);
    const vis = realPx > 0 ? Math.max(1, minPx / realPx) : 1;
    let pos = this.pos();
    if (!kin.flight && vis > 1) { const lift = this.c * (vis - 1); pos = [pos[0] + kin.q.nx * lift, pos[1] + kin.q.ny * lift]; }
    // contact point
    if (!kin.flight) {
      const [cx, cy] = view.pt([kin.q.sx, kin.q.sy]);
      ctx.save(); ctx.fillStyle = P.C.normal; ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    this._drawBody(r, pos, angle, show.labels, vis);

    // ---- vectors: forces solid, kinematics dashed
    const fs = 52 / (m * g);
    if (show.forces) {
      P.drawArrow(r, pos, 0, -m * g * fs, { color: P.C.gravity, label: 'mg' });
      if (!kin.flight) {
        const n = [kin.q.nx, kin.q.ny], t = [kin.q.tx, kin.q.ty];
        if (Math.abs(kin.N) > 1e-6 * m * g) {
          const [dx, dy] = P.vecPx(kin.N * n[0], kin.N * n[1], fs, 170);
          P.drawArrow(r, pos, dx, dy, { color: P.C.normal, label: this.rail && kin.N < 0 ? 'N_{\\text{rail}}' : 'N' });
        }
        if (Math.abs(kin.f) > 1e-6 * m * g) {
          const [dx, dy] = P.vecPx(kin.f * t[0], kin.f * t[1], fs, 140);
          P.drawArrow(r, pos, dx, dy, { color: P.C.friction, label: 'f' });
        }
        if (kin.Fa) {
          const [dx, dy] = P.vecPx(kin.Fa * t[0], kin.Fa * t[1], fs, 150);
          P.drawArrow(r, pos, dx, dy, { color: P.C.tension, label: 'F' });
        }
      }
    }
    if (show.velocity) {
      const [vx, vy] = this.vel();
      const vRef = Math.max(1, Math.sqrt(2 * g * Math.max(0.5, this.track.box.ymax - this.track.box.ymin)) + this.p.v0);
      const [dx, dy] = P.vecPx(vx, vy, 75 / vRef, 140);
      P.drawArrow(r, pos, dx, dy, { color: P.C.velocity, label: 'v', dashed: true });
    }
    if (show.accel) {
      const as = 40 / g;
      const [dx, dy] = P.vecPx(kin.ax, kin.ay, as, 150);
      P.drawArrow(r, pos, dx, dy, { color: P.C.accel, label: 'a', dashed: true });
      if (show.components && !kin.flight) {
        const t = [kin.q.tx, kin.q.ty], n = [kin.q.nx, kin.q.ny];
        P.drawArrow(r, pos, ...P.vecPx(kin.at * t[0], kin.at * t[1], as, 150), { color: P.C.accel, label: 'a_t', dashed: true, widthPx: 1.4 });
        P.drawArrow(r, pos, ...P.vecPx(kin.an * n[0], kin.an * n[1], as, 150), { color: P.C.accel, label: 'a_c', dashed: true, widthPx: 1.4 });
      }
    }
    // state tags
    const tag = this.mode === 'flight' ? 'airborne' : this.regime === 'slip' && this.canRoll && Math.abs(this.v + this.w * this.r) > 0.02 ? 'skidding' : this.regime === 'stick' ? 'at rest (static friction)' : null;
    if (tag && show.labels) P.drawTag(r, pos, tag, { dy: Math.max(18, view.px(this.c) * vis) + 22, color: this.mode === 'flight' ? P.C.gravity : P.C.friction });
    this._legend(r);
  }

  _legend(r) {
    const { ctx, view, show } = r;
    if (!(show.forces || show.velocity || show.accel)) return;
    ctx.save();
    ctx.font = '11.5px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = P.C.inkDim;
    ctx.fillText('solid arrows = forces  ·  dashed = velocity v, acceleration a (not forces)', view.w - 14, 14);
    ctx.restore();
  }

  _drawTrack(r) {
    const { ctx, view } = r;
    const pcs = this.track.drawPieces(Math.max(0.005, 2.5 / view.scale));
    const floorY = this._floorY();
    const band = 13 / view.scale;
    for (const pc of pcs) {
      const n = pc.x.length;
      ctx.save();
      ctx.beginPath();
      const [x0, y0] = view.pt([pc.x[0], pc.y[0]]);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < n; i++) { const [x, y] = view.pt([pc.x[i], pc.y[i]]); ctx.lineTo(x, y); }
      if (!this.railStyle && this.monotone) {
        ctx.lineTo(view.sx(pc.x[n - 1]), view.sy(floorY)); ctx.lineTo(view.sx(pc.x[0]), view.sy(floorY));
      } else {
        for (let i = n - 1; i >= 0; i--) { const [x, y] = view.pt([pc.x[i] - pc.nx[i] * band, pc.y[i] - pc.ny[i] * band]); ctx.lineTo(x, y); }
      }
      ctx.closePath();
      const grd = ctx.createLinearGradient(0, view.sy(this.track.box.ymax), 0, view.sy(floorY));
      grd.addColorStop(0, this.railStyle ? '#26303b' : '#1d252e'); grd.addColorStop(1, '#141a20');
      ctx.fillStyle = grd; ctx.fill();
      ctx.clip();
      ctx.strokeStyle = 'rgba(185,195,205,0.16)'; ctx.lineWidth = 1;
      const vis = { x0: 0, x1: view.w, y0: 0, y1: view.h };
      ctx.beginPath();
      for (let k = -vis.y1; k < vis.x1 + vis.y1; k += 10) { ctx.moveTo(k, vis.y0); ctx.lineTo(k - (vis.y1 - vis.y0), vis.y1); }
      ctx.stroke();
      ctx.restore();
      // surface line
      ctx.save();
      ctx.strokeStyle = P.C.ink; ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0);
      for (let i = 1; i < n; i++) { const [x, y] = view.pt([pc.x[i], pc.y[i]]); ctx.lineTo(x, y); }
      ctx.stroke();
      if (this.railStyle) {
        // second rail + sleepers
        ctx.strokeStyle = P.C.inkDim; ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < n; i++) { const [x, y] = view.pt([pc.x[i] - pc.nx[i] * band, pc.y[i] - pc.ny[i] * band]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
        ctx.strokeStyle = 'rgba(185,195,205,0.35)'; ctx.lineWidth = 1.2;
        let acc = 0;
        ctx.beginPath();
        for (let i = 1; i < n; i++) {
          acc += Math.hypot(pc.x[i] - pc.x[i - 1], pc.y[i] - pc.y[i - 1]) * view.scale;
          if (acc > 14) { acc = 0; const [a, b] = view.pt([pc.x[i], pc.y[i]]); const [c, d] = view.pt([pc.x[i] - pc.nx[i] * band, pc.y[i] - pc.ny[i] * band]); ctx.moveTo(a, b); ctx.lineTo(c, d); }
        }
        ctx.stroke();
        // support struts down to the ground where the track faces up
        ctx.strokeStyle = '#3a4552'; ctx.lineWidth = 2;
        acc = 0;
        ctx.beginPath();
        for (let i = 1; i < n; i++) {
          acc += Math.hypot(pc.x[i] - pc.x[i - 1], pc.y[i] - pc.y[i - 1]);
          if (acc > Math.max(1.2, 60 / view.scale) && pc.ny[i] > 0.6) {
            acc = 0;
            const bx = pc.x[i] - pc.nx[i] * band, by = pc.y[i] - pc.ny[i] * band;
            if (by - floorY > 2 * band) { ctx.moveTo(view.sx(bx), view.sy(by)); ctx.lineTo(view.sx(bx), view.sy(floorY)); }
          }
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    if (this.railStyle) P.drawGround(r, this.track.box.xmin - 1, this.track.box.xmax + 1, floorY);
    // end stops
    if (this.track.ends === 'walls') {
      for (const s of [0, this.track.length]) {
        const q = this.track.at(s);
        const hgt = Math.max(26 / view.scale, 2.4 * this.c + 0.1);
        const up = q.ny > 0.2 ? [0, 1] : [q.nx, q.ny]; // upright wall unless the end is overhanging
        const a = [q.sx, q.sy], b = [q.sx + up[0] * hgt, q.sy + up[1] * hgt];
        ctx.save(); ctx.strokeStyle = P.C.ink; ctx.lineWidth = 4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(...view.pt(a)); ctx.lineTo(...view.pt(b)); ctx.stroke(); ctx.restore();
      }
    }
  }

  _annotate(r) {
    const { ctx, view } = r;
    const b = this.track.box, info = this.info;
    const muTxt = this.bodyKind === 'cart' ? (this.p.c_rr > 0 ? `c_{rr} = ${fmt(this.p.c_rr)}` : 'c_{rr} = 0') : this.muK > 0 || this.muS > 0 ? `\\mu_s = ${fmt(this.muS)},\\ \\mu_k = ${fmt(this.muK)}` : '\\mu = 0';
    if (this.shape === 'bowl') {
      const [cx, cy] = info.center, R = info.R;
      P.drawPivot(r, [cx, cy], { fixed: false, sizePx: 4 });
      drawMath(ctx, 'O', view.sx(cx) - 14, view.sy(cy) - 12, { size: 15, color: P.C.inkSoft });
      const a = -35 * D2R;
      P.drawDimension(r, [cx, cy], [cx + R * Math.cos(a), cy + R * Math.sin(a)], 'R', { offsetPx: 0 });
      P.drawTag(r, [cx, cy], `R = ${fmt(R)} m`, { dy: -22, color: P.C.inkSoft });
      drawMath(ctx, muTxt, view.sx(0), view.sy(0) + 30, { size: 15, color: P.C.inkSoft });
    } else {
      drawMath(ctx, muTxt, view.sx(b.xmax) - 8, view.sy(this._floorY()) - 14, { size: 14, color: P.C.inkSoft, align: 'right' });
    }
    if (this.shape === 'sine') {
      const { A, lambda, phi, k } = info;
      let xc = (Math.PI / 2 - phi) / k;
      while (xc < 0) xc += lambda;
      if (xc + lambda <= b.xmax + 1e-9) {
        P.drawDashed(r, [b.xmin, 0], [b.xmax, 0], { color: 'rgba(185,195,205,0.25)' });
        P.drawDimension(r, [xc, 0], [xc, A], 'A', { offsetPx: -16 });
        const yl = A + Math.max(0.9, 0.8 * A) + 2 * this.c;
        P.drawDimension(r, [xc, yl], [xc + lambda, yl], '\\lambda', { offsetPx: 0 });
      }
    }
    if (info.expr) P.drawTag(r, [b.xmin, b.ymax], info.expr.replace('*', '·'), { dx: 4, dy: -16, align: 'left', color: P.C.inkSoft });
    if (this.loopRange) {
      const q = this.track.at((this.loopRange[0] + this.loopRange[1]) / 2);
      const top = [q.sx, q.sy];
      const Rl = info.R_loop;
      const centre = [top[0], top[1] - Rl];
      P.drawPivot(r, centre, { fixed: false, sizePx: 3 });
      P.drawDimension(r, centre, [centre[0] + Rl * Math.cos(-0.6), centre[1] + Rl * Math.sin(-0.6)], 'R', { offsetPx: 0 });
    }
    if ((this.shape === 'coaster' || this.shape === 'ramp') && info.H) {
      P.drawDimension(r, [b.xmin - 0.4, b.ymin], [b.xmin - 0.4, b.ymin + info.H], 'H', { offsetPx: 0 });
    }
    if (this.shape === 'incline') P.drawTag(r, [b.xmin, b.ymax], `θ = ${fmt(info.theta)}°`, { dx: 6, dy: -16, align: 'left' });
    if (this.p.h_drop > 0) {
      const q0 = this.track.at(this.s0);
      P.drawDashed(r, [q0.x, q0.y], [q0.x, q0.y + this.p.h_drop]);
      P.drawDimension(r, [q0.x, q0.y], [q0.x, q0.y + this.p.h_drop], 'h', { offsetPx: -26 });
    }
    P.drawArrow(r, [b.xmax + 0.03 * (b.xmax - b.xmin + 2), b.ymax], 0, -36, { color: P.C.inkSoft, label: 'g', widthPx: 1.6 });
    P.drawAxesTriad(r, 30, view.h - 44, { labels: ['\\hat{x}', '\\hat{y}'], sizePx: 30 });
  }

  _drawBody(r, pos, angle, labels, vis = 1) {
    const { ctx, view } = r;
    const [x, y] = view.pt(pos);
    const kind = this.bodyKind;
    if (kind === 'ball') {
      const R = Math.max(4, view.px(this.c) * vis);
      P.drawBob(r, pos, R, {});
      // rotation marks so spin is visible
      ctx.save();
      ctx.translate(x, y); ctx.rotate(-this.spinAngle);
      ctx.strokeStyle = 'rgba(20,26,33,0.55)'; ctx.lineWidth = Math.max(1, R * 0.09);
      ctx.beginPath(); ctx.moveTo(-R * 0.85, 0); ctx.lineTo(R * 0.85, 0); ctx.moveTo(0, -R * 0.85); ctx.lineTo(0, R * 0.85); ctx.stroke();
      ctx.fillStyle = '#ff6b6b'; ctx.beginPath(); ctx.arc(R * 0.62, 0, Math.max(1.6, R * 0.13), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (labels) drawMath(ctx, 'm', x + R + 12, y - R - 6, { size: 17 });
    } else if (kind === 'block') {
      const s = this.p.size * this.scaleBody * vis;
      P.drawBlock(r, pos[0], pos[1], s, s, { rot: angle, label: labels ? 'm' : null });
    } else if (kind === 'cart') {
      const L = view.px(this.p.size * this.scaleBody) * vis;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(-angle);
      const wr = 0.12 * L;
      for (const sx of [-0.3 * L, 0.3 * L]) {
        ctx.fillStyle = '#12171d'; ctx.strokeStyle = P.C.ink; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(sx, 0.3 * L, wr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.save(); ctx.translate(sx, 0.3 * L); ctx.rotate(-this.wheelAngle);
        ctx.strokeStyle = P.C.inkSoft; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let k = 0; k < 3; k++) { const a = (k * Math.PI) / 3; ctx.moveTo(-Math.cos(a) * wr * 0.8, -Math.sin(a) * wr * 0.8); ctx.lineTo(Math.cos(a) * wr * 0.8, Math.sin(a) * wr * 0.8); }
        ctx.stroke(); ctx.restore();
        if (this.rail) { ctx.strokeStyle = P.C.tension; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, 0.42 * L + 13 + wr * 0.5, wr * 0.5, 0, Math.PI * 2); ctx.stroke(); }
      }
      const g = ctx.createLinearGradient(0, -0.17 * L, 0, 0.17 * L);
      g.addColorStop(0, '#46c2ff'); g.addColorStop(1, '#1d5f86');
      ctx.fillStyle = g; ctx.strokeStyle = P.C.ink; ctx.lineWidth = 2;
      P.roundRect(ctx, -0.5 * L, -0.17 * L, L, 0.34 * L, Math.min(6, L * 0.08)); ctx.fill(); ctx.stroke();
      ctx.restore();
      if (labels) drawMath(ctx, 'm', x, y, { size: Math.max(13, Math.min(20, 0.2 * L)), halo: null });
      if (labels && this.rail) P.drawTag(r, pos, 'locked to rail', { dy: L * 0.5 + 18, color: P.C.tension });
    } else {
      ctx.save();
      ctx.fillStyle = '#f2f5f8'; ctx.strokeStyle = '#0c0f13'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
      if (labels) drawMath(ctx, 'm', x + 14, y - 12, { size: 16 });
    }
  }

  // ------------------------------------------------------------ data
  readouts() {
    const kin = this.kin();
    const [vx, vy] = this.vel();
    return [
      { sym: 't', value: this.t, unit: 's' },
      { sym: '|v|', value: Math.hypot(vx, vy), unit: 'm/s', label: 'speed' },
      { sym: 'v_t', value: kin.flight ? NaN : this.v, unit: 'm/s', label: 'along track' },
      { sym: 'a_t', value: kin.at, unit: 'm/s²', label: 'tangential' },
      { sym: 'N', value: kin.flight ? 0 : kin.N, unit: 'N', label: this.rail ? 'track/rail force' : 'normal force' },
      { sym: 'h', value: this.pos()[1] - this.track.lowest.y, unit: 'm', label: 'height' },
      { sym: 'E', value: this.energy().KE + this.energy().PE, unit: 'J', label: 'mech. energy' },
    ];
  }

  series() {
    const v2 = () => { const [vx, vy] = this.vel(); return [vx, vy]; };
    return [
      { key: 'speed', label: 'Speed |v|', unit: 'm/s', color: '#4fd1ff', get: () => Math.hypot(...v2()) },
      { key: 'vt', label: 'Velocity along track v_t', unit: 'm/s', color: '#7dffcf', get: () => (this.mode === 'flight' ? NaN : this.v) },
      { key: 'vx', label: 'Horizontal velocity v_x', unit: 'm/s', color: '#9fb4ff', get: () => v2()[0] },
      { key: 'vy', label: 'Vertical velocity v_y', unit: 'm/s', color: '#ff9fd8', get: () => v2()[1] },
      { key: 's', label: 'Position along track s', unit: 'm', color: '#e8edf2', get: () => (this.mode === 'flight' ? NaN : this.s) },
      { key: 'a', label: 'Acceleration |a|', unit: 'm/s²', color: '#c6f36b', get: () => Math.hypot(this.kin().ax, this.kin().ay) },
      { key: 'at', label: 'Tangential accel. a_t', unit: 'm/s²', color: '#e6ff8a', get: () => this.kin().at },
      { key: 'ac', label: 'Centripetal accel. v²/ρ', unit: 'm/s²', color: '#8affc1', get: () => this.kin().an },
      { key: 'N', label: 'Normal reaction N', unit: 'N', color: '#5fe3a1', get: () => this.kin().N },
      { key: 'f', label: 'Friction force f', unit: 'N', color: '#ff6b6b', get: () => this.kin().f },
      ...this.energySeries(() => this.energy()),
    ];
  }
  defaultGraph() { return ['speed', 'N']; }

  // ------------------------------------------------------------ theory
  theory() {
    const { g, m } = this.p;
    const drop = this.startY + this.p.h_drop - this.track.lowest.y;
    const b = this.canRoll ? this.beta : 0;
    const frictionless = this.bodyKind === 'cart' ? this.p.c_rr === 0 : this.spin ? this.muK === 0 || this.canRoll : this.muK === 0;
    const v0 = this.p.v0;
    const vBottom = frictionless && this.p.h_drop === 0 ? Math.sqrt(Math.max(0, v0 * v0 + (2 * g * drop) / (1 + b))) : null;
    const out = { drop, beta: b, vBottom, frictionless };
    if (this.shape === 'bowl') {
      const Re = this.info.R - this.c;
      out.Re = Re;
      out.Tsmall = 2 * Math.PI * Math.sqrt(((1 + b) * Re) / g);
      if (vBottom != null) out.Nbottom = m * (vBottom * vBottom / Re + g);
    }
    if (this.shape === 'parabola') {
      const a = this.info.D / (this.info.W / 2) ** 2, rho = 1 / (2 * a) - this.c;
      out.Tsmall = 2 * Math.PI * Math.sqrt(((1 + b) * rho) / g);
      if (vBottom != null) out.Nbottom = m * (vBottom * vBottom / rho + g);
    }
    if (this.loopRange) {
      const Re = this.info.R_loop - this.c;
      const qTop = this.track.at((this.loopRange[0] + this.loopRange[1]) / 2);
      const hTop = qTop.y - this.track.lowest.y;
      out.ReLoop = Re;
      out.hMin = hTop + ((1 + b) * Re) / 2; // height (above lowest point) needed to reach the top with v² = gR
      out.vTopMin = Math.sqrt(g * Re);
      if (frictionless) out.vTop = Math.sqrt(Math.max(0, v0 * v0 + (2 * g * (this.startY - qTop.y)) / (1 + b)));
    }
    return out;
  }

  derived() {
    const th = this.theory();
    const d = {
      shape: { label: 'Track', value: SHAPE_NAMES[this.shape] },
      body: { label: 'Body', value: `${BODY_NAMES[this.bodyKind]}${this.spin ? (this.canRoll ? ' (rolling, β = ' + fmt(this.beta) + ')' : ' (sliding, no spin)') : ''}${this.rail ? ', locked to rail' : ''}` },
      length: { label: 'Track length', value: this.track.length, unit: 'm' },
      start_height: { label: 'Start height above lowest point', value: th.drop, unit: 'm' },
      contact_model: { label: 'Contact model', value: this.rail ? 'rail can push or pull' : 'surface can only push (N ≥ 0)' },
      push: { label: 'Initial push (instant velocity)', value: this.p.v0, unit: 'm/s' },
      applied_force: { label: 'Applied force', value: this.p.F > 0 ? `${fmt(this.p.F)} N for ${fmt(this.p.tF)} s` : 'none' },
      v_bottom_theory: { label: 'Theory: speed at lowest point', value: th.vBottom, unit: 'm/s' },
      T_small: { label: 'Theory: small-oscillation period', value: th.Tsmall ?? null, unit: 's' },
      N_bottom_theory: { label: 'Theory: N at the bottom', value: th.Nbottom ?? null, unit: 'N' },
      loop_h_min: { label: 'Theory: minimum start height for the loop', value: th.hMin ?? null, unit: 'm' },
      loop_v_top_min: { label: 'Theory: minimum speed at loop top √(gR)', value: th.vTopMin ?? null, unit: 'm/s' },
      v_top_theory: { label: 'Theory: speed at loop top', value: th.vTop ?? null, unit: 'm/s' },
      T_measured: { label: 'Measured period', value: this.measured.T ?? null, unit: 's' },
      v_bottom_measured: { label: 'Measured speed at lowest point', value: this.measured.v_bottom ?? null, unit: 'm/s' },
      N_bottom_measured: { label: 'Measured N at lowest point', value: this.measured.N_bottom ?? null, unit: 'N' },
      v_top_measured: { label: 'Measured speed at loop top', value: this.measured.v_top ?? null, unit: 'm/s' },
      loop_result: { label: 'Loop result', value: this.measured.loop ?? null },
      detach_height: { label: 'Left the track at height', value: this.measured.detach_h ?? null, unit: 'm' },
      stop_distance: { label: 'Distance travelled before stopping', value: this.measured.d_stop ?? null, unit: 'm' },
      max_speed: { label: 'Maximum speed so far', value: this.vmax, unit: 'm/s' },
    };
    if (this.warnings.length) d.notes = { label: 'Notes', value: this.warnings.join(' ') };
    return d;
  }

  equations() {
    const { m, g } = this.p;
    const b = this.canRoll ? this.beta : 0;
    const th = this.theory();
    const eqs = [
      { title: 'Along the track (from Newton’s 2nd law; φ = local slope angle)',
        tex: b > 0 ? `m(1+\\beta)\\,\\dot v = -mg\\sin\\varphi + F,\\qquad \\beta = \\tfrac{I}{mr^2} = ${fmt(b)}` : `m\\dot v = -mg\\sin\\varphi ${this.muK > 0 || this.p.c_rr > 0 ? '- \\mu N\\,\\mathrm{sgn}(v)' : ''} + F` },
      { title: 'Perpendicular to the track: N supplies the centripetal force (not just mg cos φ)',
        tex: `N = m\\left(\\frac{v^2}{\\rho} + g\\cos\\varphi\\right),\\qquad ${this.rail ? '\\text{rail: } N \\text{ may be negative}' : 'N \\ge 0\\ \\text{or the body leaves the track}'}` },
      { title: 'Curvature of the track y(x)', tex: `\\kappa = \\frac{1}{\\rho} = \\frac{y''}{\\left(1+y'^2\\right)^{3/2}}` },
      { title: 'Energy (friction and impacts remove energy)', tex: `\\tfrac12 m(1+\\beta)v^2 + mgy = E_0 - W_{\\text{friction}}` },
    ];
    if (this.shape === 'bowl' && th.Tsmall) eqs.push({ title: 'Small oscillations in the bowl (centre path radius R − r)', tex: `T \\approx 2\\pi\\sqrt{\\frac{(1+\\beta)(R-r)}{g}} = ${fmt(th.Tsmall, 4)}\\ \\text{s}` });
    if (th.vBottom != null) eqs.push({ title: 'Speed at the lowest point (energy conservation)', tex: `v = \\sqrt{v_0^2 + \\frac{2g\\,\\Delta h}{1+\\beta}} = \\sqrt{${fmt(this.p.v0)}^2 + \\frac{2(${fmt(g)})(${fmt(th.drop)})}{${fmt(1 + b)}}} = ${fmt(th.vBottom, 4)}\\ \\text{m/s}` });
    if (th.ReLoop) eqs.push({ title: 'Staying on at the top of the loop (N ≥ 0)', tex: `\\frac{mv_{\\text{top}}^2}{R} = mg + N \\;\\Rightarrow\\; v_{\\text{top}} \\ge \\sqrt{gR} = ${fmt(th.vTopMin, 4)}\\ \\text{m/s}` });
    if (this.muK > 0 && this.bodyKind !== 'cart') eqs.push({ title: 'Kinetic friction (opposes sliding)', tex: `f = \\mu_k N = ${fmt(this.muK)}\\,N` });
    if (this.p.h_drop > 0 || this.track.ends === 'walls') eqs.push({ title: 'Impacts (coefficient of restitution)', tex: `v_n' = -e\\,v_n,\\qquad e = ${fmt(this.p.e)}` });
    return eqs;
  }

  /** Run a hidden copy of this experiment to know outcomes for concept checks. */
  forecast() {
    if (this._fc) return this._fc;
    const c = new TrackScene(this.spec, this.entry);
    c.reset();
    for (let i = 0; i < 300 && !c.finished; i++) c.advance(0.1);
    return (this._fc = c.measured);
  }

  predictions() {
    const th = this.theory();
    const name = BODY_NAMES[this.bodyKind];
    const out = [];
    if (this.loopRange) {
      const fc = this.forecast();
      const ok = fc.loop === 'completed';
      out.push({ id: 'loop', kind: 'choice', question: `Will the ${name} make it all the way round the loop?`, choices: ['Yes, it stays on the track', 'No, it loses contact before the top'],
        answer: ok ? 'Yes, it stays on the track' : 'No, it loses contact before the top',
        explanation: ok ? `It starts high enough: it needs to start at least ${fmt(th.hMin)} m above the lowest point (with no friction) so that v² ≥ gR at the top, where gravity alone can supply the centripetal force.`
          : `At the top it needs v ≥ √(gR) = ${fmt(th.vTopMin)} m/s, so that gravity alone can supply the centripetal force. Starting lower than about ${fmt(th.hMin)} m (with no friction), the required N becomes negative before the top, and a track can only push.`,
        suggest: this.shape === 'coaster' ? { H: Math.min(80, Math.ceil(((th.hMin ?? 10) + 2) * 2) / 2) } : null });
      if (ok && th.vTop != null) out.push({ id: 'vtop', kind: 'number', question: 'How fast will it be going at the very top of the loop?', sym: 'v_top', unit: 'm/s', measuredKey: 'v_top', theory: th.vTop,
        hint: 'Use energy conservation between the start and the top of the loop (top = lowest point + 2R).' });
    }
    if (th.vBottom != null && th.drop > 0.05) out.push({ id: 'vbottom', kind: 'number', question: 'How fast will it be moving at the lowest point of the track?', sym: 'v', unit: 'm/s', measuredKey: 'v_bottom', theory: th.vBottom,
      hint: this.canRoll ? 'Energy conservation, but part of the kinetic energy goes into spinning: ½mv²(1 + β) = mgΔh.' : 'Energy conservation: ½mv² = mgΔh (plus any initial kinetic energy). The shape of the track does not matter!' });
    if ((this.shape === 'bowl' || this.shape === 'parabola') && th.Tsmall && th.frictionless) out.push({ id: 'period', kind: 'number', question: 'How long will one full back-and-forth oscillation take?', sym: 'T', unit: 's', measuredKey: 'T', theory: th.Tsmall,
      hint: 'For small oscillations a bowl behaves like a pendulum of length R − r. Large amplitudes take a little longer.' });
    if (th.Nbottom != null) out.push({ id: 'nbottom', kind: 'choice', question: 'At the lowest point, the normal force on the body is…', choices: ['less than mg', 'equal to mg', 'greater than mg'], answer: 'greater than mg',
      explanation: `At the bottom the body is moving on a curve, so the net force must point up to the centre: N − mg = mv²/ρ. Here N ≈ ${fmt(th.Nbottom)} N, compared with mg = ${fmt(this.p.m * this.p.g)} N. Watch the N graph.` });
    if (this.p.v0 > 0 && this.crests.length && this.p.h_drop === 0) {
      const fc = this.forecast();
      if (fc.cleared) out.push({ id: 'crest', kind: 'choice', question: `Will the push be enough to get the ${name} over the next hill?`, choices: ['yes', 'no'], answer: fc.cleared,
        explanation: fc.cleared === 'yes' ? 'Its kinetic energy from the push is larger than the extra potential energy needed (mgΔh) to reach the crest.' : 'Its kinetic energy runs out before the crest: it slows to a stop on the slope and rolls back.',
        suggest: { v0: Math.min(40, +(this.p.v0 * (fc.cleared === 'yes' ? 0.6 : 1.5)).toFixed(1)) } });
    }
    if ((this.muK > 0 || this.p.c_rr > 0) && !this.spin) {
      const fc = this.forecast();
      if (fc.d_stop !== undefined) out.push({ id: 'stop', kind: 'number', question: `How far (along the track) will the ${name} travel before it stops?`, sym: 'd', unit: 'm', measuredKey: 'd_stop', theory: null,
        hint: 'Work–energy: friction does work μN·d. On curved parts N differs from mg cos φ, so this is only an estimate!' });
    }
    out.push({ id: 'mass', kind: 'choice', question: `If you double the ${name}'s mass, its speed at the bottom will…`, choices: ['double', 'increase a little', 'stay the same', 'halve'], answer: 'stay the same',
      explanation: 'Gravity and inertia are both proportional to m, and so are friction and the normal force, so the mass cancels from the motion. Forces like N do double.', suggest: { m: Math.min(500, this.p.m * 2) } });
    if (this.bodyKind === 'ball') out.push({ id: 'roll', kind: 'choice', question: 'Compared with sliding without friction, a ball that rolls without slipping reaches the bottom…', choices: ['faster', 'at the same speed', 'more slowly'], answer: 'more slowly',
      explanation: 'A rolling ball must also gain rotational kinetic energy (½Iω²), so less of mgΔh becomes forward motion: v² = 2gΔh/(1 + β), with β = 2/5 for a solid ball.',
      suggest: this.canRoll ? { contact: 'slide', mu_s: 0, mu_k: 0 } : { contact: 'roll', mu_s: 0.6, mu_k: 0.4 } });
    return out;
  }
}
