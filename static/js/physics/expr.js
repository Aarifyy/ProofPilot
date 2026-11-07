// Safe maths-expression compiler for track shapes such as "2sin(x) + 0.1x^2".
// A small recursive-descent parser builds an AST that is evaluated by a closure;
// nothing is ever passed to eval/Function, so arbitrary code cannot run.
//
// Grammar:  expr  := term (('+'|'-') term)*
//           term  := unary (('*'|'/'|implicit) unary)*
//           unary := ('+'|'-') unary | power
//           power := atom ('^' unary)?            (right-associative)
//           atom  := number | 'x' | const | func '(' expr ')' | '(' expr ')'

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log10,
  sqrt: Math.sqrt, abs: Math.abs, cbrt: Math.cbrt,
};
const CONSTS = { pi: Math.PI, e: Math.E };
export const EXPR_FUNCTIONS = Object.keys(FUNCS);
const MAX_LEN = 160;

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num && !(num[0].toLowerCase().endsWith('e') )) { toks.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-z]+/i.exec(src.slice(i));
    if (id) {
      // split glued identifiers like "xsin" or "pix" greedily into known names
      let w = id[0].toLowerCase();
      while (w.length) {
        const name = ['x', ...Object.keys(FUNCS).sort((a, b) => b.length - a.length), ...Object.keys(CONSTS)]
          .sort((a, b) => b.length - a.length).find((n) => w.startsWith(n));
        if (!name) throw new Error(`unknown name "${id[0]}"`);
        toks.push({ t: name === 'x' ? 'x' : FUNCS[name] ? 'fn' : 'const', v: name });
        w = w.slice(name.length);
      }
      i += id[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    if (c === '·' || c === '×') { toks.push({ t: '*' }); i++; continue; }
    if (c === '−') { toks.push({ t: '-' }); i++; continue; }
    throw new Error(`unexpected character "${c}"`);
  }
  return toks;
}

function parse(toks) {
  let i = 0;
  const peek = () => toks[i];
  const eat = (t) => { if (peek()?.t !== t) throw new Error(`expected "${t}"`); return toks[i++]; };
  const startsAtom = (tk) => tk && (tk.t === 'num' || tk.t === 'x' || tk.t === 'fn' || tk.t === 'const' || tk.t === '(');

  function expr() {
    let n = term();
    while (peek()?.t === '+' || peek()?.t === '-') { const op = toks[i++].t; n = { op, a: n, b: term() }; }
    return n;
  }
  function term() {
    let n = unary();
    for (;;) {
      if (peek()?.t === '*' || peek()?.t === '/') { const op = toks[i++].t; n = { op, a: n, b: unary() }; }
      else if (startsAtom(peek())) n = { op: '*', a: n, b: power() }; // implicit: 2x, 2sin(x), (x+1)(x-1)
      else return n;
    }
  }
  function unary() {
    if (peek()?.t === '-') { i++; return { op: 'neg', a: unary() }; }
    if (peek()?.t === '+') { i++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (peek()?.t === '^') { i++; return { op: '^', a: base, b: unary() }; }
    return base;
  }
  function atom() {
    const tk = toks[i++];
    if (!tk) throw new Error('unexpected end of expression');
    if (tk.t === 'num') return { op: 'num', v: tk.v };
    if (tk.t === 'x') return { op: 'x' };
    if (tk.t === 'const') return { op: 'num', v: CONSTS[tk.v] };
    if (tk.t === 'fn') { eat('('); const a = expr(); eat(')'); return { op: 'fn', f: FUNCS[tk.v], name: tk.v, a }; }
    if (tk.t === '(') { const a = expr(); eat(')'); return a; }
    throw new Error(`unexpected "${tk.t}"`);
  }
  const ast = expr();
  if (i !== toks.length) throw new Error(`unexpected "${toks[i].t}"`);
  return ast;
}

function evaluate(n, x) {
  switch (n.op) {
    case 'num': return n.v;
    case 'x': return x;
    case 'neg': return -evaluate(n.a, x);
    case '+': return evaluate(n.a, x) + evaluate(n.b, x);
    case '-': return evaluate(n.a, x) - evaluate(n.b, x);
    case '*': return evaluate(n.a, x) * evaluate(n.b, x);
    case '/': return evaluate(n.a, x) / evaluate(n.b, x);
    case '^': return Math.pow(evaluate(n.a, x), evaluate(n.b, x));
    case 'fn': return n.f(evaluate(n.a, x));
    default: return NaN;
  }
}

/** Compile "y = ..." (the "y =" prefix is optional) into f(x). Throws a readable Error if invalid. */
export function compileExpr(src) {
  if (typeof src !== 'string') throw new Error('expression must be text');
  let s = src.trim().replace(/^y\s*=\s*/i, '').replace(/^f\s*\(\s*x\s*\)\s*=\s*/i, '');
  if (!s) throw new Error('empty expression');
  if (s.length > MAX_LEN) throw new Error('expression is too long');
  s = s.replace(/\*\*/g, '^');
  const ast = parse(tokenize(s));
  const f = (x) => evaluate(ast, x);
  f.source = s;
  return f;
}
