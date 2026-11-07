// General-purpose track geometry engine.
//
// A track is built "turtle style" from connected segments, so tangent
// continuity is automatic: each segment starts where the previous one ended,
// heading the same way. Supported segments:
//   line   {length, turn?, radius?, corner?}  straight; `turn` (deg, + = left/CCW) is applied first,
//                                              smoothly via a fillet arc unless corner = true
//   arc    {radius, turn}                     circular arc; turn = 360 makes a vertical loop
//   curve  {expr, x0, x1}                     y = f(x) over [x0, x1] (safe expression grammar).
//                                              As the first segment it is placed absolutely.
//   hill   {height, width}                    smooth cosine bump (negative height = dip)
//   drop   {height, width}                    smooth descent by `height` (negative = climb)
//   spline {points: [{x, y}, ...]}            smooth curve through points relative to the segment start
//
// Geometry is parametric (x(u), y(u)), so loops and overhangs are fine. The
// physics runs on the path of the body's *centre*: the surface offset along
// the normal by the body's clearance (ball radius, half block height, ...).
// That path is resampled at uniform arc length and interpolated with cubic
// Hermite splines, so y(s) and dy/ds are exactly consistent (energy is
// conserved to integrator accuracy).
import { compileExpr } from './expr.js';

const D2R = Math.PI / 180;
const MAX_SEGMENTS = 40;
const MAX_EXTENT = 2000;

// ---------------------------------------------------------------- segment compilers
// Each returns { pt(u), d1(u), d2(u) } for u in [0, 1] (derivatives wrt u).

function lineSeg([x0, y0], h, L) {
  const c = Math.cos(h), s = Math.sin(h);
  return { pt: (u) => [x0 + L * u * c, y0 + L * u * s], d1: () => [L * c, L * s], d2: () => [0, 0] };
}

function arcSeg([x0, y0], h, R, turn) {
  const sg = Math.sign(turn) || 1;
  const cx = x0 - sg * R * Math.sin(h), cy = y0 + sg * R * Math.cos(h);
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  return {
    pt: (u) => { const a = a0 + turn * u; return [cx + R * Math.cos(a), cy + R * Math.sin(a)]; },
    d1: (u) => { const a = a0 + turn * u; return [-R * turn * Math.sin(a), R * turn * Math.cos(a)]; },
    d2: (u) => { const a = a0 + turn * u; return [-R * turn * turn * Math.cos(a), -R * turn * turn * Math.sin(a)]; },
    center: [cx, cy],
  };
}

// y = f(x) for x in [xa, xb], translated so (xa, f(xa)) lands on (ox, oy).
function fnSeg(f, xa, xb, [ox, oy]) {
  const dx = xb - xa;
  const hd = Math.max(1e-5, Math.abs(dx) * 2e-6);
  const fa = f(xa);
  const X = (u) => xa + u * dx;
  return {
    pt: (u) => [ox + u * dx, oy + f(X(u)) - fa],
    d1: (u) => { const x = X(u); return [dx, ((f(x + hd) - f(x - hd)) / (2 * hd)) * dx]; },
    d2: (u) => { const x = X(u); return [0, ((f(x + hd) - 2 * f(x) + f(x - hd)) / (hd * hd)) * dx * dx]; },
  };
}

// Catmull-Rom style spline through points, leaving with the current heading.
function splineSeg(p0, h, rel) {
  const P = [p0, ...rel.map((q) => [p0[0] + q.x, p0[1] + q.y])];
  const n = P.length - 1;
  const M = P.map((_, i) => {
    if (i === 0) { const L = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]); return [Math.cos(h) * L, Math.sin(h) * L]; }
    if (i === n) return [P[n][0] - P[n - 1][0], P[n][1] - P[n - 1][1]];
    return [(P[i + 1][0] - P[i - 1][0]) / 2, (P[i + 1][1] - P[i - 1][1]) / 2];
  });
  const piece = (u) => { const v = Math.min(n - 1e-12, Math.max(0, u * n)); const i = Math.floor(v); return [i, v - i]; };
  const herm = (i, t, k) => {
    const [a, b, ma, mb] = [P[i][k], P[i + 1][k], M[i][k], M[i + 1][k]];
    const t2 = t * t, t3 = t2 * t;
    return [
      (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * ma + (-2 * t3 + 3 * t2) * b + (t3 - t2) * mb,
      ((6 * t2 - 6 * t) * a + (3 * t2 - 4 * t + 1) * ma + (-6 * t2 + 6 * t) * b + (3 * t2 - 2 * t) * mb) * n,
      ((12 * t - 6) * a + (6 * t - 4) * ma + (-12 * t + 6) * b + (6 * t - 2) * mb) * n * n,
    ];
  };
  return {
    pt: (u) => { const [i, t] = piece(u); return [herm(i, t, 0)[0], herm(i, t, 1)[0]]; },
    d1: (u) => { const [i, t] = piece(u); return [herm(i, t, 0)[1], herm(i, t, 1)[1]]; },
    d2: (u) => { const [i, t] = piece(u); return [herm(i, t, 0)[2], herm(i, t, 1)[2]]; },
  };
}

const num = (v, lo, hi, name) => {
  const x = +v;
  if (!Number.isFinite(x)) throw new Error(`${name} must be a finite number`);
  if (x < lo || x > hi) throw new Error(`${name} = ${x} is outside ${lo}…${hi}`);
  return x;
};

// ---------------------------------------------------------------- build
/**
 * def: { start?: [x, y], heading?: deg, segments: [...], ends?: 'walls' | 'open' }
 * clearance: distance from surface to the body's centre (m).
 */
export function buildTrack(def, clearance = 0) {
  const warnings = [];
  const segs = def.segments ?? [];
  if (!segs.length) throw new Error('the track has no segments');
  if (segs.length > MAX_SEGMENTS) throw new Error(`too many segments (max ${MAX_SEGMENTS})`);

  // 1. compile segments
  let pos = def.start ? [+def.start[0], +def.start[1]] : [0, 0];
  let hd = (def.heading ?? 0) * D2R;
  const compiled = []; // {geo, corner, segIndex}
  const pushSeg = (geo, segIndex, corner = false) => {
    compiled.push({ geo, corner, segIndex });
    pos = geo.pt(1);
    const d = geo.d1(1);
    hd = Math.atan2(d[1], d[0]);
  };
  segs.forEach((sg, i) => {
    const kind = sg.kind;
    if (kind === 'line') {
      const L = num(sg.length, 0.01, 1000, `segment ${i + 1} length`);
      const turn = num(sg.turn ?? 0, -180, 180, `segment ${i + 1} turn`) * D2R;
      let corner = false;
      if (Math.abs(turn) > 1e-9) {
        if (sg.corner) { hd += turn; corner = true; }
        else {
          const fr = Math.min(num(sg.radius || 1, 0.05, 100, `segment ${i + 1} fillet radius`), L);
          pushSeg(arcSeg(pos, hd, fr, turn), i);
        }
      }
      pushSeg(lineSeg(pos, hd, L), i, corner);
    } else if (kind === 'arc') {
      const R = num(sg.radius, 0.05, 200, `segment ${i + 1} radius`);
      const turn = num(sg.turn, -720, 720, `segment ${i + 1} turn`) * D2R;
      if (Math.abs(turn) < 1e-6) throw new Error(`segment ${i + 1}: arc turn must not be 0`);
      pushSeg(arcSeg(pos, hd, R, turn), i);
    } else if (kind === 'curve') {
      const f = compileExpr(sg.expr);
      const xa = num(sg.x0, -1000, 1000, `segment ${i + 1} x0`), xb = num(sg.x1, -1000, 1000, `segment ${i + 1} x1`);
      if (!(xb - xa > 0.05)) throw new Error(`segment ${i + 1}: x1 must be greater than x0`);
      for (let k = 0; k <= 400; k++) {
        const y = f(xa + (k / 400) * (xb - xa));
        if (!Number.isFinite(y)) throw new Error(`y = ${f.source} is undefined at x = ${+(xa + (k / 400) * (xb - xa)).toFixed(3)}`);
        if (Math.abs(y) > MAX_EXTENT) throw new Error(`y = ${f.source} grows too large on [${xa}, ${xb}]`);
      }
      const origin = compiled.length === 0 && !def.start ? [xa, f(xa)] : pos;
      if (compiled.length === 0 && !def.start) pos = origin;
      const geo = fnSeg(f, xa, xb, origin);
      const d0 = geo.d1(0);
      const jump = wrapAngle(Math.atan2(d0[1], d0[0]) - hd);
      pushSeg(geo, i, compiled.length > 0 && Math.abs(jump) > 2 * D2R);
    } else if (kind === 'hill' || kind === 'drop') {
      const H = num(sg.height, -200, 200, `segment ${i + 1} height`);
      const W = num(sg.width, 0.2, 1000, `segment ${i + 1} width`);
      const f = kind === 'hill' ? (x) => (H * (1 - Math.cos((2 * Math.PI * x) / W))) / 2 : (x) => (-H * (1 - Math.cos((Math.PI * x) / W))) / 2;
      const geo = fnSeg(f, 0, W, pos);
      const jump = wrapAngle(0 - hd);
      pushSeg(geo, i, compiled.length > 0 && Math.abs(jump) > 2 * D2R);
    } else if (kind === 'spline') {
      const pts = (sg.points ?? []).map((q, k) => ({ x: num(q.x ?? q[0], -1000, 1000, `point ${k + 1}`), y: num(q.y ?? q[1], -1000, 1000, `point ${k + 1}`) }));
      if (pts.length < 2 || pts.length > 30) throw new Error(`segment ${i + 1}: a spline needs 2–30 points`);
      pushSeg(splineSeg(pos, hd, pts), i);
    } else {
      throw new Error(`unknown segment kind "${kind}"`);
    }
  });

  // 2. dense sampling of the surface
  const S = { x: [], y: [], tx: [], ty: [], k: [], s: [], seg: [] };
  const breaks = []; // dense indices where a sharp corner starts a new smooth piece
  let sAcc = 0;
  compiled.forEach((c, ci) => {
    const { geo } = c;
    let est = 0, prev = geo.pt(0);
    for (let k = 1; k <= 64; k++) { const q = geo.pt(k / 64); est += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
    if (!(est > 1e-4)) throw new Error(`segment ${c.segIndex + 1} has zero length`);
    const n = Math.min(40000, Math.max(24, Math.ceil(est / 0.004)));
    if (ci > 0) {
      if (c.corner) breaks.push(S.x.length);
      else { S.x.pop(); S.y.pop(); S.tx.pop(); S.ty.pop(); S.k.pop(); S.s.pop(); S.seg.pop(); }
    }
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const p = geo.pt(u), d = geo.d1(u), dd = geo.d2(u);
      const sp = Math.hypot(d[0], d[1]);
      if (!Number.isFinite(p[0] + p[1] + sp + dd[0] + dd[1]) || sp < 1e-12) throw new Error(`segment ${c.segIndex + 1} produces invalid coordinates`);
      if (S.x.length && !(c.corner && k === 0)) sAcc += Math.hypot(p[0] - S.x[S.x.length - 1], p[1] - S.y[S.y.length - 1]);
      S.x.push(p[0]); S.y.push(p[1]); S.tx.push(d[0] / sp); S.ty.push(d[1] / sp);
      S.k.push((d[0] * dd[1] - d[1] * dd[0]) / (sp * sp * sp)); S.s.push(sAcc); S.seg.push(c.segIndex);
    }
  });
  const N = S.x.length;
  if (sAcc < 0.2) throw new Error('the track is too short (under 0.2 m)');
  if (sAcc > 3000) throw new Error('the track is too long (over 3 km)');
  for (let i = 0; i < N; i++) if (Math.abs(S.x[i]) > MAX_EXTENT || Math.abs(S.y[i]) > MAX_EXTENT) throw new Error('the track extends too far (beyond ±2 km)');
  let kmax = 0;
  for (let i = 0; i < N; i++) kmax = Math.max(kmax, Math.abs(S.k[i]));
  if (kmax > 50) throw new Error(`the track bends too sharply (radius of curvature ${(1 / kmax).toFixed(3)} m); use a larger radius or an explicit corner`);

  // 3. the body may not fit inside tight concave curves
  let kConcave = 0;
  for (let i = 0; i < N; i++) kConcave = Math.max(kConcave, S.k[i]);
  let c = clearance;
  if (c * kConcave > 0.85) {
    const cNew = 0.85 / kConcave;
    warnings.push(`The body was too big for the tightest curve (radius ${(1 / kConcave).toFixed(2)} m); its size was reduced so it fits.`);
    c = cNew;
  }

  // 4. split into smooth pieces and offset to the body-centre path
  const ranges = [];
  let a = 0;
  for (const b of [...breaks, N]) { ranges.push([a, b - 1]); a = b; }
  let pieces = ranges.map(([i0, i1]) => {
    const P = { x: [], y: [], tx: [], ty: [], k: [], sx: [], sy: [], sS: [], seg: [] };
    for (let i = i0; i <= i1; i++) {
      const nx = -S.ty[i], ny = S.tx[i];
      P.x.push(S.x[i] + c * nx); P.y.push(S.y[i] + c * ny);
      P.tx.push(S.tx[i]); P.ty.push(S.ty[i]);
      P.k.push(S.k[i] / (1 - c * S.k[i]));
      P.sx.push(S.x[i]); P.sy.push(S.y[i]); P.sS.push(S.s[i]); P.seg.push(S.seg[i]);
    }
    return P;
  });

  // 5. joints between pieces (sharp corners)
  const joints = [];
  for (let j = 0; j + 1 < pieces.length; j++) {
    const A = pieces[j], B = pieces[j + 1];
    const na = A.x.length - 1;
    const dTheta = wrapAngle(Math.atan2(B.ty[0], B.tx[0]) - Math.atan2(A.ty[na], A.tx[na]));
    const type = dTheta > 0 ? 'concave' : 'convex';
    if (type === 'concave' && c > 0) trimConcave(A, B);
    joints.push({ type, dTheta, cos: Math.cos(dTheta) });
  }

  // 6. resample each piece at uniform arc length
  let sBase = 0;
  pieces = pieces.map((P) => {
    const cum = [0];
    for (let i = 1; i < P.x.length; i++) cum.push(cum[i - 1] + Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]));
    const L = cum[cum.length - 1];
    const n = Math.max(2, Math.min(60000, Math.ceil(L / 0.01) + 1));
    const ds = L / (n - 1);
    const R = { s0: sBase, L, ds, n, x: new Float64Array(n), y: new Float64Array(n), tx: new Float64Array(n), ty: new Float64Array(n),
      k: new Float64Array(n), sx: new Float64Array(n), sy: new Float64Array(n), seg: new Int16Array(n), surfS: new Float64Array(n) };
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = i * ds;
      while (j < cum.length - 2 && cum[j + 1] < s) j++;
      const span = cum[j + 1] - cum[j];
      const u = span > 0 ? Math.min(1, Math.max(0, (s - cum[j]) / span)) : 0;
      const lerp = (arr) => arr[j] + (arr[j + 1] - arr[j]) * u;
      R.x[i] = lerp(P.x); R.y[i] = lerp(P.y);
      let tx = lerp(P.tx), ty = lerp(P.ty); const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      R.tx[i] = tx; R.ty[i] = ty; R.k[i] = lerp(P.k); R.sx[i] = lerp(P.sx); R.sy[i] = lerp(P.sy);
      R.surfS[i] = lerp(P.sS); R.seg[i] = u < 0.5 ? P.seg[j] : P.seg[j + 1];
    }
    sBase += L;
    return R;
  });
  joints.forEach((jt, i) => { jt.s = pieces[i].s0 + pieces[i].L; });

  return new Track({ pieces, joints, surface: S, breaks, clearance: c, warnings, segCount: segs.length, ends: def.ends ?? 'open' });
}

function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

// Concave corner: the two offset paths cross; cut both at the crossing.
function trimConcave(A, B) {
  const na = A.x.length;
  const look = Math.min(4000, na - 1, B.x.length - 1);
  for (let i = na - 2; i >= na - 1 - look; i--) {
    for (let j = 0; j < look; j++) {
      const hit = segX(A.x[i], A.y[i], A.x[i + 1], A.y[i + 1], B.x[j], B.y[j], B.x[j + 1], B.y[j + 1]);
      if (hit) {
        const keepA = i + 1, dropB = j + 1;
        for (const key of Object.keys(A)) A[key].length = keepA;
        A.x.push(hit[0]); A.y.push(hit[1]); A.tx.push(A.tx[keepA - 1]); A.ty.push(A.ty[keepA - 1]); A.k.push(0);
        A.sx.push(A.sx[keepA - 1]); A.sy.push(A.sy[keepA - 1]); A.sS.push(A.sS[keepA - 1]); A.seg.push(A.seg[keepA - 1]);
        for (const key of Object.keys(B)) B[key].splice(0, dropB);
        B.x.unshift(hit[0]); B.y.unshift(hit[1]); B.tx.unshift(B.tx[0]); B.ty.unshift(B.ty[0]); B.k.unshift(0);
        B.sx.unshift(B.sx[0]); B.sy.unshift(B.sy[0]); B.sS.unshift(B.sS[0]); B.seg.unshift(B.seg[0]);
        return;
      }
    }
  }
}

function segX(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [ax + t * rx, ay + t * ry] : null;
}

// ---------------------------------------------------------------- track object
export class Track {
  constructor(o) {
    Object.assign(this, o);
    this.length = this.pieces.reduce((a, p) => a + p.L, 0);
    this._buildGrid();
    this._bounds();
    this._checkSelfIntersection();
  }

  pieceAt(s) {
    const P = this.pieces;
    for (let i = 0; i < P.length - 1; i++) if (s < P[i].s0 + P[i].L) return i;
    return P.length - 1;
  }

  /** Point on the body-centre path at arc length s (clamped to the track). */
  at(s, pi = this.pieceAt(s)) {
    const P = this.pieces[pi];
    const local = Math.min(P.L, Math.max(0, s - P.s0));
    const { ds } = P;
    let i = Math.floor(local / ds);
    if (i > P.n - 2) i = P.n - 2;
    const u = local / ds - i;
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const g00 = 6 * u2 - 6 * u, g10 = 3 * u2 - 4 * u + 1, g01 = -6 * u2 + 6 * u, g11 = 3 * u2 - 2 * u;
    const x = h00 * P.x[i] + h10 * ds * P.tx[i] + h01 * P.x[i + 1] + h11 * ds * P.tx[i + 1];
    const y = h00 * P.y[i] + h10 * ds * P.ty[i] + h01 * P.y[i + 1] + h11 * ds * P.ty[i + 1];
    const dx = (g00 * P.x[i] + g01 * P.x[i + 1]) / ds + g10 * P.tx[i] + g11 * P.tx[i + 1];
    const dy = (g00 * P.y[i] + g01 * P.y[i + 1]) / ds + g10 * P.ty[i] + g11 * P.ty[i + 1];
    const tl = Math.hypot(dx, dy) || 1;
    const tx = dx / tl, ty = dy / tl;
    return {
      x, y, dx, dy, tx, ty, nx: -ty, ny: tx,
      k: P.k[i] + (P.k[i + 1] - P.k[i]) * u,
      sx: P.sx[i] + (P.sx[i + 1] - P.sx[i]) * u, sy: P.sy[i] + (P.sy[i + 1] - P.sy[i]) * u,
      seg: u < 0.5 ? P.seg[i] : P.seg[i + 1], piece: pi,
    };
  }

  get sEnd() { return this.length; }

  _buildGrid() {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const P of this.pieces) for (let i = 0; i < P.n; i++) {
      xmin = Math.min(xmin, P.x[i]); xmax = Math.max(xmax, P.x[i]); ymin = Math.min(ymin, P.y[i]); ymax = Math.max(ymax, P.y[i]);
    }
    this.cell = Math.max(0.15, Math.max(xmax - xmin, ymax - ymin) / 120);
    this.grid = new Map();
    this.pieces.forEach((P, pi) => {
      for (let i = 0; i < P.n; i++) {
        const key = this._key(Math.floor(P.x[i] / this.cell), Math.floor(P.y[i] / this.cell));
        let arr = this.grid.get(key);
        if (!arr) this.grid.set(key, (arr = []));
        arr.push(pi * 1e6 + i);
      }
    });
  }
  _key(ix, iy) { return ix * 1000003 + iy; }

  /** Closest point of the centre path to (x, y), or null if nothing is nearby.
   *  d = signed distance along the path normal (+ on the side the body rides). */
  nearest(x, y) {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 2 && best < 0; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) for (let iy = cy - r; iy <= cy + r; iy++) {
        const arr = this.grid.get(this._key(ix, iy));
        if (!arr) continue;
        for (const code of arr) {
          const P = this.pieces[Math.floor(code / 1e6)], i = code % 1e6;
          const d2 = (P.x[i] - x) ** 2 + (P.y[i] - y) ** 2;
          if (d2 < bd) { bd = d2; best = code; }
        }
      }
    }
    if (best < 0) return null;
    const pi = Math.floor(best / 1e6), i = best % 1e6, P = this.pieces[pi];
    // refine by projecting onto the neighbouring tangent
    let s = P.s0 + i * P.ds + ((x - P.x[i]) * P.tx[i] + (y - P.y[i]) * P.ty[i]);
    const outside = s < P.s0 - 1e-9 || s > P.s0 + P.L + 1e-9;
    s = Math.min(P.s0 + P.L, Math.max(P.s0, s));
    const q = this.at(s, pi);
    const d = (x - q.x) * q.nx + (y - q.y) * q.ny;
    const atEnd = outside && ((pi === 0 && s <= P.s0 + 1e-9) || (pi === this.pieces.length - 1 && s >= P.s0 + P.L - 1e-9));
    return { s, d, q, outside, atEnd, dist: Math.sqrt(bd) };
  }

  /** First arc length at which the *surface* passes x (scanning from the start); null if never. */
  sAtX(x) {
    for (const P of this.pieces) {
      for (let i = 0; i < P.n - 1; i++) {
        const a = P.sx[i], b = P.sx[i + 1];
        if ((a - x) * (b - x) <= 0 && a !== b) return P.s0 + (i + (x - a) / (b - a)) * P.ds;
        if (a === x) return P.s0 + i * P.ds;
      }
    }
    return null;
  }

  /** Arc-length range (centre path) of an input segment. */
  segRange(segIndex) {
    let lo = Infinity, hi = -Infinity;
    for (const P of this.pieces) for (let i = 0; i < P.n; i++) if (P.seg[i] === segIndex) { const s = P.s0 + i * P.ds; lo = Math.min(lo, s); hi = Math.max(hi, s); }
    return Number.isFinite(lo) ? [lo, hi] : null;
  }

  _bounds() {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    const S = this.surface;
    for (let i = 0; i < S.x.length; i++) { xmin = Math.min(xmin, S.x[i]); xmax = Math.max(xmax, S.x[i]); ymin = Math.min(ymin, S.y[i]); ymax = Math.max(ymax, S.y[i]); }
    this.box = { xmin, xmax, ymin, ymax };
    // lowest point of the centre path
    let low = { y: Infinity, s: 0 };
    for (const P of this.pieces) for (let i = 0; i < P.n; i++) if (P.y[i] < low.y) low = { y: P.y[i], s: P.s0 + i * P.ds };
    this.lowest = low;
  }

  /** Decimated surface polylines for drawing: [{x:[], y:[], nx:[], ny:[]}] per smooth piece. */
  drawPieces(step = 0.03) {
    if (this._draw && this._drawStep === step) return this._draw;
    const S = this.surface;
    const out = [];
    const ranges = [];
    let a = 0;
    for (const b of [...this.breaks, S.x.length]) { ranges.push([a, b - 1]); a = b; }
    for (const [i0, i1] of ranges) {
      const P = { x: [], y: [], nx: [], ny: [] };
      let last = -Infinity;
      for (let i = i0; i <= i1; i++) {
        if (S.s[i] - last >= step || i === i1 || i === i0) {
          P.x.push(S.x[i]); P.y.push(S.y[i]); P.nx.push(-S.ty[i]); P.ny.push(S.tx[i]); last = S.s[i];
        }
      }
      out.push(P);
    }
    this._draw = out; this._drawStep = step;
    return out;
  }

  _checkSelfIntersection() {
    const P = this.drawPieces(Math.max(0.05, this.length / 500));
    const pts = [];
    P.forEach((p) => { for (let i = 0; i < p.x.length; i++) pts.push([p.x[i], p.y[i]]); });
    for (let i = 0; i + 1 < pts.length; i++) {
      for (let j = i + 3; j + 1 < pts.length; j++) {
        const h = segXStrict(pts[i], pts[i + 1], pts[j], pts[j + 1]);
        if (h) {
          this.warnings.push(`The track crosses itself near (${h[0].toFixed(1)}, ${h[1].toFixed(1)}) m; the body only interacts with the part of the track it is on.`);
          return;
        }
      }
    }
  }
}

function segXStrict(a, b, c, d) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  const e = 1e-6;
  // a loop's base touches its entry/exit tangentially; only report real crossings (> ~10°)
  const sinAng = Math.abs(den) / (Math.hypot(rx, ry) * Math.hypot(sx, sy));
  return t > e && t < 1 - e && u > e && u < 1 - e && sinAng > 0.17 ? [a[0] + t * rx, a[1] + t * ry] : null;
}

// ---------------------------------------------------------------- presets
/** Build the track definition for a named shape from scene parameters.
 *  Returns {def, info} where info carries annotation data and the default start x. */
export function presetTrack(shape, p, track = {}) {
  const info = { shape };
  let def;
  switch (shape) {
    case 'bowl': {
      const R = p.R;
      def = { start: [-R, R], heading: -90, segments: [{ kind: 'arc', radius: R, turn: 180 }], ends: 'open' };
      Object.assign(info, { center: [0, R], R, startX: p.h_drop > 0 ? -0.5 * R : -0.97 * R });
      break;
    }
    case 'parabola': {
      const W = p.W, Dp = p.D, a = Dp / (W / 2) ** 2;
      def = { segments: [{ kind: 'curve', expr: `${a}*x^2`, x0: -W / 2, x1: W / 2 }], ends: 'open' };
      Object.assign(info, { expr: `y = ${+a.toPrecision(3)}x^2`, startX: -0.47 * W, W, D: Dp });
      break;
    }
    case 'sine': {
      const { A, lambda, phi, periods } = p;
      const k = (2 * Math.PI) / lambda, ph = phi * D2R;
      def = { segments: [{ kind: 'curve', expr: `${A}*sin(${k}*x+${ph})`, x0: 0, x1: periods * lambda }], ends: 'walls' };
      // first valley: k x + φ = 3π/2 + 2πn, x ≥ 0
      let xv = (1.5 * Math.PI - ph) / k;
      while (xv < 0) xv += lambda;
      while (xv - lambda >= 0) xv -= lambda;
      Object.assign(info, { A, lambda, k, phi: ph, startX: Math.min(xv, periods * lambda * 0.98), valleyX: xv });
      break;
    }
    case 'ramp': {
      const { H, Lr } = p;
      def = { segments: [{ kind: 'curve', expr: `${H}*(1-x/${Lr})^2`, x0: 0, x1: Lr }, { kind: 'line', length: p.flat }], ends: 'walls' };
      Object.assign(info, { H, startX: 0.0, expr: `y = H(1 − x/L)²` });
      break;
    }
    case 'incline': {
      const th = p.theta * D2R, Ls = p.Ls;
      def = { start: [0, Ls * Math.sin(th)], heading: -p.theta, segments: [{ kind: 'line', length: Ls }, { kind: 'line', length: p.flat, turn: p.theta, radius: 0.6 }], ends: 'walls' };
      Object.assign(info, { theta: p.theta, startX: 0.02 * Ls * Math.cos(th) });
      break;
    }
    case 'coaster': {
      const H = p.H, segs = [{ kind: 'line', length: 2 }, { kind: 'drop', height: H, width: Math.max(4, 1.6 * H) }, { kind: 'line', length: 3 }];
      let hh = p.hill_ratio * H;
      const hillIdx = [];
      for (let i = 0; i < Math.round(p.hills); i++) {
        hillIdx.push(segs.length);
        // wide enough that a frictionless car keeps contact over the crest: v²κ < g there,
        // with v² = 2g(H − h) and κ = 2π²h/W²  ⇒  W > 2π√(h(H − h))
        const wSafe = 2 * Math.PI * Math.sqrt(hh * Math.max(0, H - hh)) * 1.08;
        segs.push({ kind: 'hill', height: hh, width: Math.max(4, 2.4 * hh + 3, wSafe) }, { kind: 'line', length: 2.5 });
        hh *= 0.75;
      }
      let loopIdx = null;
      if (p.R_loop > 0) {
        loopIdx = segs.length;
        segs.push({ kind: 'arc', radius: p.R_loop, turn: 360 }, { kind: 'line', length: Math.max(6, p.R_loop * 1.5) });
      } else segs.push({ kind: 'line', length: 8 });
      def = { start: [0, H], segments: segs, ends: 'walls' };
      Object.assign(info, { H, loopIdx, hillIdx, R_loop: p.R_loop, startX: 2 + 0.07 * Math.max(4, 1.6 * H) });
      break;
    }
    case 'function': {
      const expr = track.expr || 'sin(x)';
      def = { segments: [{ kind: 'curve', expr, x0: Math.min(p.xa, p.xb - 0.5), x1: Math.max(p.xb, p.xa + 0.5) }], ends: 'walls' };
      Object.assign(info, { expr: `y = ${expr.replace(/^y\s*=\s*/i, '')}`, startX: null });
      break;
    }
    case 'custom':
    default: {
      const segs = track.segments?.length ? track.segments : DEMO_SEGMENTS;
      def = { start: [0, 0], segments: segs, ends: 'walls' };
      const loopIdx = segs.findIndex((s) => s.kind === 'arc' && Math.abs(s.turn) >= 300);
      Object.assign(info, { loopIdx: loopIdx >= 0 ? loopIdx : null, R_loop: loopIdx >= 0 ? segs[loopIdx].radius : 0, startX: null, custom: true });
      break;
    }
  }
  return { def, info };
}

const DEMO_SEGMENTS = [
  { kind: 'line', length: 1.5 }, { kind: 'drop', height: 12, width: 18 }, { kind: 'line', length: 3 },
  { kind: 'hill', height: 5, width: 14 }, { kind: 'line', length: 3 }, { kind: 'arc', radius: 3.5, turn: 360 }, { kind: 'line', length: 8 },
];
