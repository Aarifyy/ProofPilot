// Reusable technical-drawing primitives. All positions are world coordinates
// (metres, y up) unless a parameter name ends in "Px". Each physical component
// has its own unmistakable look: coiled springs, thin flexible ropes, thick rigid
// rods with joints, shaded masses, hatched fixed supports.
import { drawMath } from './mathtext.js';

export const C = {
  bg: '#0a0d11',
  ink: '#e8edf2',
  inkSoft: '#b9c3cd',
  inkDim: '#6b7783',
  grid: 'rgba(160, 190, 220, 0.045)',
  gridStrong: 'rgba(160, 190, 220, 0.09)',
  gravity: '#ffb547',
  normal: '#5fe3a1',
  friction: '#ff6b6b',
  tension: '#b79cff',
  spring: '#ff8fd0',
  velocity: '#4fd1ff',
  accel: '#c6f36b',
  rope: '#e7d6b0',
  trace: '#4fd1ff',
  ghost: '#ff8fd0',
};

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);

function screenFrame(view, a, b) {
  const [ax, ay] = view.pt(a);
  const [bx, by] = view.pt(b);
  const dx = bx - ax, dy = by - ay;
  const L = Math.hypot(dx, dy) || 1e-6;
  return { ax, ay, bx, by, L, ux: dx / L, uy: dy / L, nx: -dy / L, ny: dx / L };
}

// ---------------------------------------------------------------- background
export function drawGrid(r) {
  const { ctx, view } = r;
  const target = 70; // px between minor lines
  const raw = target / view.scale;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const vis = view.visible();
  ctx.save();
  ctx.lineWidth = 1;
  for (let x = Math.ceil(vis.xmin / step) * step; x <= vis.xmax; x += step) {
    ctx.strokeStyle = Math.abs(x / (step * 5) - Math.round(x / (step * 5))) < 1e-6 ? C.gridStrong : C.grid;
    const sx = Math.round(view.sx(x)) + 0.5;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, view.h); ctx.stroke();
  }
  for (let y = Math.ceil(vis.ymin / step) * step; y <= vis.ymax; y += step) {
    ctx.strokeStyle = Math.abs(y / (step * 5) - Math.round(y / (step * 5))) < 1e-6 ? C.gridStrong : C.grid;
    const sy = Math.round(view.sy(y)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(view.w, sy); ctx.stroke();
  }
  ctx.restore();
  return step;
}

// ---------------------------------------------------------------- supports
/** Fixed surface with engineering hatching. side: 'below' (floor) | 'above' (ceiling). */
export function drawHatchedLine(r, a, b, { side = 'below', depthPx = 10, spacingPx = 9, color = C.ink, width = 2 } = {}) {
  const { ctx, view } = r;
  const f = screenFrame(view, a, b);
  // normal pointing to hatch side
  let hx = f.nx, hy = f.ny;
  const wantDown = side === 'below' || side === 'right';
  if ((side === 'below' || side === 'above')) { if ((hy > 0) !== wantDown) { hx = -hx; hy = -hy; } }
  else { if ((hx > 0) !== (side === 'right')) { hx = -hx; hy = -hy; } }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let s = spacingPx * 0.5; s < f.L; s += spacingPx) {
    const px = f.ax + f.ux * s, py = f.ay + f.uy * s;
    ctx.moveTo(px, py);
    ctx.lineTo(px + hx * depthPx - f.ux * depthPx, py + hy * depthPx - f.uy * depthPx);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(f.ax, f.ay); ctx.lineTo(f.bx, f.by); ctx.stroke();
  ctx.restore();
}

export function drawGround(r, x1, x2, y = 0, opts = {}) {
  drawHatchedLine(r, [x1, y], [x2, y], { side: 'below', ...opts });
}
export function drawCeiling(r, x1, x2, y, opts = {}) {
  drawHatchedLine(r, [x1, y], [x2, y], { side: 'above', ...opts });
}
export function drawWall(r, x, y1, y2, side = 'left', opts = {}) {
  drawHatchedLine(r, [x, y1], [x, y2], { side, ...opts });
}

/** Rough-surface texture (short ticks) to show friction. */
export function drawRoughness(r, a, b, { color = C.friction } = {}) {
  const { ctx, view } = r;
  const f = screenFrame(view, a, b);
  ctx.save();
  ctx.strokeStyle = color; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let s = 3; s < f.L; s += 5) {
    const h = 2 + ((s * 7919) % 3);
    const px = f.ax + f.ux * s, py = f.ay + f.uy * s;
    ctx.moveTo(px, py); ctx.lineTo(px - f.nx * h, py - f.ny * h);
  }
  ctx.stroke(); ctx.restore();
}

/** Fixed pivot: ring + mounting triangle + hatched base, or a free joint. */
export function drawPivot(r, p, { fixed = true, mount = 'above', sizePx = 7 } = {}) {
  const { ctx, view } = r;
  const [x, y] = view.pt(p);
  ctx.save();
  if (fixed) {
    const dir = mount === 'above' ? -1 : 1;
    const tri = sizePx * 2.1;
    ctx.fillStyle = '#1a2129'; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - tri, y + dir * tri * 1.25);
    ctx.lineTo(x + tri, y + dir * tri * 1.25);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // hatched base
    const by = y + dir * tri * 1.25;
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - tri * 1.6, by); ctx.lineTo(x + tri * 1.6, by); ctx.stroke();
    ctx.lineWidth = 1; ctx.globalAlpha = 0.55; ctx.beginPath();
    for (let s = -tri * 1.6 + 3; s < tri * 1.6; s += 6) { ctx.moveTo(x + s, by); ctx.lineTo(x + s - 6, by + dir * 6); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.fillStyle = C.bg; ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, sizePx, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(x, y, sizePx * 0.32, 0, TAU); ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- connectors
/**
 * Helical coil spring from a to b. Coils keep their count and radius; pitch
 * changes as the spring stretches or compresses. Back half of each coil is
 * drawn dimmer to read as a 3-D helix.
 */
export function drawSpring(r, a, b, { coils = 11, radiusPx = 9, leadPx = 12, color = C.ink, label, labelSide = 1, stress = 0 } = {}) {
  const { ctx, view } = r;
  const f = screenFrame(view, a, b);
  const lead = Math.min(leadPx, f.L * 0.18);
  const Lc = Math.max(4, f.L - 2 * lead);
  const tilt = radiusPx * 0.85; // projection of coil depth along the axis (gives loops)
  const N = 220;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const phi = TAU * coils * s;
    // taper the first/last quarter turn into the lead wire
    const taper = Math.min(1, s * coils * 3, (1 - s) * coils * 3);
    const along = lead + s * Lc - tilt * taper * Math.cos(phi) + tilt * taper;
    const across = radiusPx * taper * Math.sin(phi);
    const depth = Math.cos(phi);
    pts.push([f.ax + f.ux * along + f.nx * across, f.ay + f.uy * along + f.ny * across, depth]);
  }
  // stress tint: compressed = warm, stretched = cool (subtle)
  const tint = stress > 0 ? `rgba(79,209,255,${Math.min(0.5, stress)})` : stress < 0 ? `rgba(255,143,208,${Math.min(0.5, -stress)})` : null;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // lead wires
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(f.ax, f.ay); ctx.lineTo(pts[0][0], pts[0][1]);
  ctx.moveTo(pts[N][0], pts[N][1]); ctx.lineTo(f.bx, f.by);
  ctx.stroke();
  for (const pass of ['back', 'front']) {
    ctx.strokeStyle = pass === 'back' ? 'rgba(185,195,205,0.62)' : color;
    ctx.lineWidth = pass === 'back' ? 1.3 : 2.1;
    ctx.beginPath();
    let pen = false;
    for (let i = 1; i <= N; i++) {
      const isFront = pts[i][2] >= 0;
      if ((pass === 'front') === isFront) {
        if (!pen) { ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); pen = true; }
        ctx.lineTo(pts[i][0], pts[i][1]);
      } else pen = false;
    }
    ctx.stroke();
  }
  if (tint) {
    ctx.strokeStyle = tint; ctx.lineWidth = 5; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }
  ctx.restore();
  // end anchors
  for (const [x, y] of [[f.ax, f.ay], [f.bx, f.by]]) {
    ctx.save(); ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, TAU); ctx.fill(); ctx.restore();
  }
  if (label) {
    const mx = (f.ax + f.bx) / 2 + f.nx * (radiusPx + 14) * labelSide;
    const my = (f.ay + f.by) / 2 + f.ny * (radiusPx + 14) * labelSide;
    drawMath(ctx, label, mx, my, { size: 17 });
  }
}

/** Thin flexible rope/string. If slack (distance < length), it sags. */
export function drawRope(r, a, b, { length = null, color = C.rope, widthPx = 1.6, label } = {}) {
  const { ctx, view } = r;
  const f = screenFrame(view, a, b);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = widthPx; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(f.ax, f.ay);
  const d = len(sub(b, a));
  if (length && d < length * 0.995) {
    // parabola-ish sag: control point below the chord, depth chosen so arc ≈ rope length
    const slack = Math.sqrt(Math.max(0, length * length - d * d)) * 0.75;
    const mx = (f.ax + f.bx) / 2, my = (f.ay + f.by) / 2 + view.px(slack);
    ctx.quadraticCurveTo(mx, my, f.bx, f.by);
    ctx.setLineDash([]);
  } else {
    ctx.lineTo(f.bx, f.by);
  }
  ctx.stroke();
  ctx.restore();
  if (label) drawMath(ctx, label, (f.ax + f.bx) / 2 + f.nx * 14, (f.ay + f.by) / 2 + f.ny * 14, { size: 16 });
}

/** Rigid rod: thick shaded bar with rounded ends — visibly solid. */
export function drawRod(r, a, b, { widthPx = 7, label, labelSide = 1, ghost = false } = {}) {
  const { ctx, view } = r;
  const f = screenFrame(view, a, b);
  const hw = widthPx / 2;
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.35;
  const g = ctx.createLinearGradient(f.ax - f.nx * hw, f.ay - f.ny * hw, f.ax + f.nx * hw, f.ay + f.ny * hw);
  g.addColorStop(0, '#f4f7fa'); g.addColorStop(0.45, '#aab4bf'); g.addColorStop(1, '#5d6874');
  ctx.fillStyle = ghost ? C.ghost : g;
  ctx.strokeStyle = ghost ? C.ghost : '#0c0f13';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const ang = Math.atan2(f.uy, f.ux);
  ctx.arc(f.ax, f.ay, hw, ang + Math.PI / 2, ang - Math.PI / 2);
  ctx.arc(f.bx, f.by, hw, ang - Math.PI / 2, ang + Math.PI / 2);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  if (label && !ghost) drawMath(ctx, label, (f.ax + f.bx) / 2 + f.nx * (hw + 14) * labelSide, (f.ay + f.by) / 2 + f.ny * (hw + 14) * labelSide, { size: 17 });
}

// ---------------------------------------------------------------- bodies
/** Shaded rectangular mass. (cx, cy) centre in world, w/h in metres, rot radians (CCW). */
export function drawBlock(r, cx, cy, w, h, { rot = 0, label, fill = '#232b35', accent = null, ghost = false } = {}) {
  const { ctx, view } = r;
  const [x, y] = view.pt([cx, cy]);
  const W = view.px(w), H = view.px(h);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(-rot);
  if (ghost) ctx.globalAlpha = 0.35;
  const g = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
  g.addColorStop(0, '#3a4552'); g.addColorStop(1, fill);
  ctx.fillStyle = g; ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
  roundRect(ctx, -W / 2, -H / 2, W, H, Math.min(4, W * 0.08));
  ctx.fill(); ctx.stroke();
  // bevel highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-W / 2 + 4, -H / 2 + 3); ctx.lineTo(W / 2 - 4, -H / 2 + 3); ctx.stroke();
  if (accent) { ctx.fillStyle = accent; ctx.fillRect(-W / 2 + 3, H / 2 - 6, W - 6, 3); }
  ctx.restore();
  if (label) drawMath(ctx, label, x, y, { size: Math.max(14, Math.min(22, H * 0.45)), halo: null });
}

/** Cart = block on two wheels. wheelsOn: 'bottom' | 'top' (hanging from a rail). */
export function drawCart(r, cx, cy, w, h, { label, accent, wheelsOn = 'bottom' } = {}) {
  const { ctx, view } = r;
  const wr = Math.min(h * 0.22, w * 0.12);
  const dir = wheelsOn === 'bottom' ? -1 : 1;
  for (const s of [-1, 1]) {
    const [x, y] = view.pt([cx + s * w * 0.3, cy + dir * (h / 2 + wr * 0.85)]);
    const R = view.px(wr);
    ctx.save();
    ctx.fillStyle = '#12171d'; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, R * 0.25), 0, TAU); ctx.fill();
    ctx.restore();
  }
  drawBlock(r, cx, cy, w, h, { label, accent });
}

/** Spherical bob with radial shading. radiusPx is screen size. */
export function drawBob(r, p, radiusPx, { label, labelOffset = [1, -1], ghost = false, color = '#f2f5f8' } = {}) {
  const { ctx, view } = r;
  const [x, y] = view.pt(p);
  ctx.save();
  if (ghost) { ctx.globalAlpha = 0.4; ctx.strokeStyle = C.ghost; ctx.lineWidth = 1.6; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, radiusPx, 0, TAU); ctx.stroke(); ctx.restore(); return; }
  const g = ctx.createRadialGradient(x - radiusPx * 0.35, y - radiusPx * 0.4, radiusPx * 0.1, x, y, radiusPx);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, color); g.addColorStop(1, '#8592a0');
  ctx.fillStyle = g; ctx.strokeStyle = '#0c0f13'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x, y, radiusPx, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.restore();
  if (label) drawMath(ctx, label, x + labelOffset[0] * (radiusPx + 16), y - labelOffset[1] * (radiusPx + 8), { size: 18 });
}

/** Pulley wheel with spokes that rotate with the rope. */
export function drawPulley(r, c, radius, angle = 0) {
  const { ctx, view } = r;
  const [x, y] = view.pt(c);
  const R = view.px(radius);
  ctx.save();
  const g = ctx.createRadialGradient(x - R * 0.3, y - R * 0.3, R * 0.1, x, y, R);
  g.addColorStop(0, '#3b4652'); g.addColorStop(1, '#1a2028');
  ctx.fillStyle = g; ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(232,237,242,0.5)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, R * 0.82, 0, TAU); ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = C.inkSoft;
  for (let i = 0; i < 4; i++) {
    const a = -angle + (i * Math.PI) / 2;
    ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * R * 0.2, y + Math.sin(a) * R * 0.2); ctx.lineTo(x + Math.cos(a) * R * 0.8, y + Math.sin(a) * R * 0.8); ctx.stroke();
  }
  ctx.restore();
  drawPivot(r, c, { fixed: false, sizePx: Math.max(4, R * 0.2) });
}

// ---------------------------------------------------------------- annotations
/** Arrow from world point p with a screen-space vector (dxPx right, dyPx up). */
export function drawArrow(r, p, dxPx, dyPx, { color = C.velocity, label, widthPx = 2.4, dashed = false, labelPos = 'tip', minPx = 6 } = {}) {
  const { ctx, view } = r;
  const L = Math.hypot(dxPx, dyPx);
  if (L < minPx) return;
  const [x0, y0] = view.pt(p);
  const x1 = x0 + dxPx, y1 = y0 - dyPx;
  const ux = dxPx / L, uy = -dyPx / L;
  const head = Math.min(11, L * 0.45);
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = widthPx; ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * head - uy * head * 0.45, y1 - uy * head + ux * head * 0.45);
  ctx.lineTo(x1 - ux * head + uy * head * 0.45, y1 - uy * head - ux * head * 0.45);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  if (label) {
    const off = 14;
    const lx = labelPos === 'mid' ? (x0 + x1) / 2 - uy * off : x1 + ux * off;
    const ly = labelPos === 'mid' ? (y0 + y1) / 2 + ux * off : y1 + uy * off;
    drawMath(ctx, label, lx, ly, { size: 15, color });
  }
}

/** Engineering dimension line between world points a and b, offset sideways in px. */
export function drawDimension(r, a, b, label, { offsetPx = 0, color = C.inkSoft, size = 17 } = {}) {
  const { ctx, view } = r;
  const f = screenFrame(view, a, b);
  const ox = f.nx * offsetPx, oy = f.ny * offsetPx;
  const ax = f.ax + ox, ay = f.ay + oy, bx = f.bx + ox, by = f.by + oy;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.2;
  if (offsetPx) {
    ctx.globalAlpha = 0.6;
    const e = Math.sign(offsetPx) * 5;
    ctx.beginPath();
    ctx.moveTo(f.ax + f.nx * 3 * Math.sign(offsetPx), f.ay + f.ny * 3 * Math.sign(offsetPx)); ctx.lineTo(ax + f.nx * e, ay + f.ny * e);
    ctx.moveTo(f.bx + f.nx * 3 * Math.sign(offsetPx), f.by + f.ny * 3 * Math.sign(offsetPx)); ctx.lineTo(bx + f.nx * e, by + f.ny * e);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  const head = Math.min(8, f.L / 3);
  for (const [px, py, s] of [[ax, ay, 1], [bx, by, -1]]) {
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + s * f.ux * head - f.nx * head * 0.4, py + s * f.uy * head - f.ny * head * 0.4);
    ctx.lineTo(px + s * f.ux * head + f.nx * head * 0.4, py + s * f.uy * head + f.ny * head * 0.4);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  if (label) {
    const side = offsetPx >= 0 ? 1 : -1;
    drawMath(ctx, label, (ax + bx) / 2 + f.nx * 13 * side, (ay + by) / 2 + f.ny * 13 * side, { size, color: C.ink });
  }
}

/** Angle arc at world centre c from angle a0 to a1 (radians, CCW, world frame). */
export function drawAngleArc(r, c, a0, a1, radiusPx, label, { color = C.ink, labelR = 1.45 } = {}) {
  const { ctx, view } = r;
  const [x, y] = view.pt(c);
  if (Math.abs(a1 - a0) < 1e-3) return;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(x, y, radiusPx, -a0, -a1, a1 > a0);
  ctx.stroke();
  // small arrowhead at the a1 end
  const ex = x + Math.cos(a1) * radiusPx, ey = y - Math.sin(a1) * radiusPx;
  const t = a1 > a0 ? 1 : -1;
  const tx = -Math.sin(a1) * t, ty = -Math.cos(a1) * t;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - tx * 7 + ty * 3, ey - ty * 7 - tx * 3);
  ctx.lineTo(ex - tx * 7 - ty * 3, ey - ty * 7 + tx * 3);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  if (label) {
    const am = (a0 + a1) / 2;
    drawMath(ctx, label, x + Math.cos(am) * radiusPx * labelR, y - Math.sin(am) * radiusPx * labelR, { size: 17 });
  }
}

export function drawDashed(r, a, b, { color = C.inkDim, dash = [6, 5], widthPx = 1.2 } = {}) {
  const { ctx, view } = r;
  const [ax, ay] = view.pt(a), [bx, by] = view.pt(b);
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = widthPx; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.restore();
}

/** Fading motion trace; optional stroboscopic dots every `dotEvery` points. */
export function drawTrace(r, pts, { color = C.trace, widthPx = 1.8, dotEvery = 0, alpha = 0.9 } = {}) {
  const { ctx, view } = r;
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const n = pts.length;
  for (let i = 1; i < n; i++) {
    const a = view.pt(pts[i - 1]), b = view.pt(pts[i]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha * (0.1 + 0.9 * (i / n));
    ctx.lineWidth = widthPx;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  if (dotEvery) {
    ctx.fillStyle = color;
    for (let i = 0; i < n; i += dotEvery) {
      const [x, y] = view.pt(pts[i]);
      ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

export function drawLabel(r, p, text, { dx = 0, dy = 0, size = 16, color = C.ink, align = 'center' } = {}) {
  const [x, y] = r.view.pt(p);
  drawMath(r.ctx, text, x + dx, y - dy, { size, color, align });
}

/** Plain UI text on canvas (sans-serif), e.g. tags like "frictionless". */
export function drawTag(r, p, text, { dx = 0, dy = 0, color = C.inkSoft, size = 12, align = 'center', bg = 'rgba(10,13,17,0.75)' } = {}) {
  const { ctx, view } = r;
  const [x0, y0] = view.pt(p);
  const x = x0 + dx, y = y0 - dy;
  ctx.save();
  ctx.font = `600 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 12;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.fillStyle = bg; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
  roundRect(ctx, left, y - size * 0.85, w, size * 1.7, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(text, left + 6, y + 0.5);
  ctx.restore();
}

/** Coordinate triad like ₁ê₁, ₁ê₂ in the reference figure (screen position). */
export function drawAxesTriad(r, xPx, yPx, { labels = ['\\hat{e}_1', '\\hat{e}_2'], sizePx = 34 } = {}) {
  const { ctx } = r;
  ctx.save();
  ctx.strokeStyle = C.inkSoft; ctx.fillStyle = C.inkSoft; ctx.lineWidth = 1.5;
  const arrow = (dx, dy) => {
    ctx.beginPath(); ctx.moveTo(xPx, yPx); ctx.lineTo(xPx + dx, yPx + dy); ctx.stroke();
    const L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
    ctx.beginPath(); ctx.moveTo(xPx + dx, yPx + dy);
    ctx.lineTo(xPx + dx - ux * 7 - uy * 3.5, yPx + dy - uy * 7 + ux * 3.5);
    ctx.lineTo(xPx + dx - ux * 7 + uy * 3.5, yPx + dy - uy * 7 - ux * 3.5);
    ctx.closePath(); ctx.fill();
  };
  arrow(sizePx, 0); arrow(0, -sizePx);
  ctx.restore();
  drawMath(ctx, labels[0], xPx + sizePx + 14, yPx + 2, { size: 15, color: C.inkSoft });
  drawMath(ctx, labels[1], xPx, yPx - sizePx - 12, { size: 15, color: C.inkSoft });
}

/** Distance ruler with labelled ticks along y=yWorld from x1 to x2. */
export function drawRuler(r, x1, x2, y, { minorPx = 28 } = {}) {
  const { ctx, view } = r;
  const raw = minorPx / view.scale;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  ctx.save();
  ctx.strokeStyle = C.inkDim; ctx.fillStyle = C.inkDim; ctx.lineWidth = 1;
  ctx.font = `11px Inter, "Segoe UI", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const sy = view.sy(y);
  let i = 0;
  for (let x = Math.ceil(x1 / step) * step; x <= x2 + 1e-9; x += step, i++) {
    const sx = view.sx(x);
    const major = Math.abs(x / (step * 5) - Math.round(x / (step * 5))) < 1e-6;
    ctx.beginPath(); ctx.moveTo(sx, sy + 14); ctx.lineTo(sx, sy + (major ? 22 : 18)); ctx.stroke();
    if (major) ctx.fillText(`${+x.toFixed(6)} m`, sx, sy + 24);
  }
  ctx.restore();
}

/** Transient banner on the canvas (e.g. "String went slack"). */
export function drawBanner(r, text, alpha = 1, color = C.gravity) {
  const { ctx, view } = r;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 13px Inter, "Segoe UI", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 28;
  const x = view.w / 2 - w / 2, y = 14;
  ctx.fillStyle = 'rgba(15,19,24,0.92)'; ctx.strokeStyle = color; ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, 30, 15); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText(text, view.w / 2, y + 15.5);
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, rad) {
  const r2 = Math.max(0, Math.min(rad, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r2, y);
  ctx.arcTo(x + w, y, x + w, y + h, r2);
  ctx.arcTo(x + w, y + h, x, y + h, r2);
  ctx.arcTo(x, y + h, x, y, r2);
  ctx.arcTo(x, y, x + w, y, r2);
  ctx.closePath();
}

/** Clamp an arrow length (px) so tiny/huge forces stay readable. */
export function arrowPx(value, scale, max = 150) {
  const L = value * scale;
  return Math.sign(L) * Math.min(Math.abs(L), max);
}
export function vecPx(vx, vy, scale, max = 150) {
  const L = Math.hypot(vx, vy) * scale;
  if (L === 0) return [0, 0];
  const k = Math.min(L, max) / L;
  return [vx * scale * k, vy * scale * k];
}
