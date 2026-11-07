// Tiny TeX-like label renderer for canvas: italic variables, upright digits,
// units and function names, Greek letters, subscripts (_x, _{xy}), superscripts
// (^2), accents (\hat{e}, \dot x, \ddot x, \vec v) and \text{...}.
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', theta: 'θ',
  lambda: 'λ', mu: 'μ', omega: 'ω', Omega: 'Ω', phi: 'φ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', cdot: '·', times: '×', approx: '≈', to: '→', deg: '°', ell: 'ℓ', circ: '°',
};
const FUNCS = new Set(['sin', 'cos', 'tan', 'ln', 'log', 'exp', 'max', 'min']);
const ACCENTS = new Set(['hat', 'dot', 'ddot', 'vec', 'bar']);
const BS = '\\';

export const MATH_FONT = '"KaTeX_Math", "Cambria Math", "Times New Roman", serif';
export const MAIN_FONT = '"KaTeX_Main", "Cambria", "Times New Roman", serif';

function tokenize(src) {
  const runs = [];
  let i = 0;
  const push = (text, level, italicHint, accent = null) => {
    for (const ch of text) {
      const italic = italicHint ?? /[A-Za-zα-ωΑ-Ω]/.test(ch);
      runs.push({ text: ch, level, italic, accent });
    }
  };
  const readGroup = () => {
    while (src[i] === ' ') i++;
    if (src[i] === '{') {
      let depth = 1, j = i + 1;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      const g = src.slice(i + 1, j - 1); i = j; return g;
    }
    if (src[i] === BS) {
      const m = /^\\([A-Za-z]+)/.exec(src.slice(i));
      if (m) { i += m[0].length; return BS + m[1]; }
    }
    return src[i++] ?? '';
  };
  const expand = (g) => {
    const upright = /\\(text|mathrm)\{/.test(g);
    const text = g
      .replace(/\\(?:text|mathrm)\{([^}]*)\}/g, '$1')
      .replace(/\\([A-Za-z]+)/g, (m, n) => GREEK[n] ?? n)
      .replace(/[{}]/g, '');
    return { text, upright };
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '_' || ch === '^') {
      i++;
      const { text, upright } = expand(readGroup());
      push(text, ch === '_' ? -1 : 1, upright || /^[0-9+\-=.,()]+$/.test(text) ? false : null);
    } else if (ch === BS) {
      const m = /^\\([A-Za-z]+)/.exec(src.slice(i));
      const name = m?.[1];
      i += m ? m[0].length : 1;
      if (ACCENTS.has(name)) { push(expand(readGroup()).text, 0, null, name); continue; }
      if (name === 'text' || name === 'mathrm') { push(readGroup(), 0, false); continue; }
      if (FUNCS.has(name)) { push(name, 0, false); continue; }
      if (name === 'quad') { push('  ', 0, false); continue; }
      if (name) push(GREEK[name] ?? name, 0, null);
    } else if (ch === '{' || ch === '}') {
      i++;
    } else {
      i++;
      push(ch, 0, /[A-Za-z]/.test(ch) ? null : false);
    }
  }
  return runs;
}

function fontFor(run, size) {
  const s = run.level === 0 ? size : size * 0.7;
  return run.italic ? `italic ${s}px ${MATH_FONT}` : `${s}px ${MAIN_FONT}`;
}

export function measureMath(ctx, src, size = 16) {
  let w = 0;
  for (const r of tokenize(String(src))) { ctx.font = fontFor(r, size); w += ctx.measureText(r.text).width + (r.italic ? size * 0.04 : 0); }
  return w;
}

/**
 * Draw a math label. align: 'left'|'center'|'right'; y is the vertical centre.
 * opts.halo draws a background-coloured outline for legibility over linework.
 */
export function drawMath(ctx, src, x, y, opts = {}) {
  const { size = 16, color = '#e8edf2', align = 'center', halo = '#0a0d11', haloWidth = 4 } = opts;
  const runs = tokenize(String(src));
  const width = measureMath(ctx, src, size);
  let cx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const r of runs) {
    ctx.font = fontFor(r, size);
    const dy = r.level === -1 ? size * 0.32 : r.level === 1 ? -size * 0.38 : 0;
    const w = ctx.measureText(r.text).width;
    if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = haloWidth; ctx.strokeText(r.text, cx, y + dy); }
    ctx.fillStyle = color;
    ctx.fillText(r.text, cx, y + dy);
    if (r.accent) {
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.2;
      const hy = y + dy - size * 0.55, mx = cx + w * 0.6;
      ctx.beginPath();
      if (r.accent === 'hat') { ctx.moveTo(cx + w * 0.2, hy + 2.5); ctx.lineTo(cx + w * 0.6, hy - 1); ctx.lineTo(cx + w, hy + 2.5); ctx.stroke(); }
      else if (r.accent === 'dot') { ctx.arc(mx, hy + 1, 1.5, 0, Math.PI * 2); ctx.fill(); }
      else if (r.accent === 'ddot') { ctx.arc(mx - 2.5, hy + 1, 1.4, 0, Math.PI * 2); ctx.arc(mx + 2.5, hy + 1, 1.4, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.moveTo(cx + w * 0.1, hy + 1); ctx.lineTo(cx + w * 1.05, hy + 1); ctx.stroke(); }
    }
    cx += w + (r.italic ? size * 0.04 : 0);
  }
  ctx.restore();
  return width;
}
