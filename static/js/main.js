import { View } from './render/view.js';
import * as P from './render/primitives.js';
import { drawMath } from './render/mathtext.js';
import { createScene, EXAMPLES } from './scenes/index.js';
import { fmt } from './scenes/base.js';
import { Graph } from './ui/graph.js';
import { Tutor } from './ui/tutor.js';
import { Predict } from './ui/predict.js';

const $ = (s) => document.querySelector(s);
const tex = (s, display = false) => {
  try { return window.katex.renderToString(s, { throwOnError: false, displayMode: display }); } catch { return s; }
};

const SUGGESTIONS = {
  projectile: ['Why is the path a parabola?', 'Does a heavier ball go further?', 'Which angle goes furthest?', 'What does air resistance change?'],
  pendulum: ['Does the mass change the period?', 'Why is the measured period longer than 2π√(L/g)?', 'When would the string go slack?', 'Where is the bob fastest?'],
  spring: ['Why doesn’t amplitude change the period?', 'How is the energy shared?', 'How is friction different from damping?'],
  spring_vertical: ['Why doesn’t gravity change the period?', 'What sets the equilibrium position?', 'How is the energy shared?'],
  incline: ['Why does (or doesn’t) it slide?', 'Explain the free-body diagram', 'Does mass affect the acceleration?'],
  collision: ['Is momentum conserved?', 'Where does the kinetic energy go?', 'What if the masses are equal?'],
  atwood: ['Why is the tension less than the heavier weight?', 'Derive the acceleration', 'What if the masses are equal?'],
  cart_pendulum: ['Explain the normal modes', 'Why does the cart move when the pendulum swings?', 'Is momentum conserved?'],
  double_pendulum: ['Why is this chaotic?', 'Is energy conserved?', 'What happens at small angles?'],
  track: ['Why isn’t the normal force just mg cos θ here?', 'Why does it need enough speed at the top of the loop?', 'How does rolling change the speed?', 'Where is it fastest, and why?'],
};

const KIND = {
  projectile: 'Kinematics', pendulum: 'Oscillations', spring: 'Oscillations', spring_vertical: 'Oscillations',
  incline: 'Forces & friction', collision: 'Momentum', atwood: 'Newton’s laws', cart_pendulum: 'Lagrangian mechanics',
  double_pendulum: 'Chaos', track: 'Tracks & curved motion',
};

class App {
  constructor() {
    this.canvas = $('#sim-canvas');
    this.view = new View(this.canvas);
    this.graph = new Graph($('#graph-canvas'), $('#graph-legend'), $('#graph-tools'));
    this.playing = true;
    this.speed = 1;
    this.show = { forces: true, velocity: true, accel: false, components: false, labels: true, trail: true };
    this.predict = new Predict($('#panel-predict'), this);
    this.tutor = new Tutor({
      log: $('#tutor-log'), form: $('#tutor-form'), input: $('#tutor-input'), suggest: $('#tutor-suggest'),
      sourceEl: $('#tutor-source'), getContext: () => this.tutorContext(), onTry: (c, label) => this.applyParams(c, label),
    });
    new ResizeObserver(() => { this.view.resize(); if (this.scene) this.view.fit(this.scene.bounds()); }).observe($('#canvas-wrap'));
    this.bindUI();
  }

  async start() {
    const [catalog, status] = await Promise.all([
      fetch('/api/catalog').then((r) => r.json()),
      fetch('/api/status').then((r) => r.json()).catch(() => ({ ai: false })),
    ]);
    this.catalog = catalog;
    this.setStatus(status);
    try { await Promise.all([document.fonts.load('italic 16px KaTeX_Math'), document.fonts.load('16px KaTeX_Main')]); } catch { /* fallback fonts */ }
    const entry = catalog.projectile;
    const params = Object.fromEntries(Object.entries(entry.params).map(([k, m]) => [k, m.default]));
    Object.assign(params, { v0: 25, angle: 40 });
    this.setSpec({
      type: 'projectile', title: 'Ball Launched at 40°', params, options: {},
      summary: 'A ball launched from ground level at 25 m/s, 40° above the horizontal, with no air resistance.',
      assumptions: ['No air resistance', 'Launched from ground level'], source: 'example',
    }, { intro: true });
    $('#prompt-input').value = 'Simulate a ball being launched at 25 metres per second at 40 degrees.';
    // Deep links: ?q=<prompt> interprets a prompt, ?scene=<type> opens a scene with defaults.
    const qs = new URLSearchParams(location.search);
    if (qs.get('scene') && catalog[qs.get('scene')]) {
      const t = qs.get('scene'), e = catalog[t];
      this.setSpec({ type: t, title: e.title, summary: e.description, params: Object.fromEntries(Object.entries(e.params).map(([k, m]) => [k, m.default])),
        options: Object.fromEntries(Object.entries(e.options ?? {}).map(([k, m]) => [k, m.default])), assumptions: [], source: 'example' }, { intro: true });
    } else if (qs.get('q')) {
      $('#prompt-input').value = qs.get('q');
      this.generate(qs.get('q'));
    }
    if (qs.get('t')) { this.scene.advance(+qs.get('t')); this.setPlaying(false); }
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  setStatus(s) {
    const pill = $('#ai-status');
    pill.className = 'pill ' + (s.ai ? 'pill-good' : 'pill-warn');
    pill.querySelector('.pill-text').textContent = s.ai ? `Claude connected · ${s.model}` : 'Offline mode · built-in tutor';
    pill.title = s.ai ? 'Prompts are interpreted and questions answered by Claude.'
      : 'No ANTHROPIC_API_KEY configured: using the built-in interpreter and tutor. Add a key to .env for full AI.';
  }

  // ------------------------------------------------------------ UI wiring
  bindUI() {
    const ex = $('#examples');
    for (const e of EXAMPLES) {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'chip';
      c.innerHTML = `<span class="chip-kind">${KIND[e.type]}</span>${e.text}`;
      c.title = e.text;
      c.onclick = () => { $('#prompt-input').value = e.text; this.generate(e.text); };
      ex.appendChild(c);
    }
    $('#prompt-form').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#prompt-input').value.trim(); if (q) this.generate(q); });

    $('#btn-play').onclick = () => this.togglePlay();
    $('#btn-restart').onclick = () => this.restart(true);
    $('#btn-step').onclick = () => { this.setPlaying(false); this.scene.advance(1 / 60); };

    const sg = $('#speed-group');
    for (const s of [0.1, 0.25, 0.5, 1, 2]) {
      const b = document.createElement('button');
      b.textContent = `${s}×`; b.type = 'button';
      if (s === this.speed) b.classList.add('active');
      b.onclick = () => { this.speed = s; sg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); };
      sg.appendChild(b);
    }

    const ot = $('#overlay-toggles');
    const labels = { forces: ['Forces', P.C.gravity], velocity: ['Velocity', P.C.velocity], accel: ['Acceleration', P.C.accel], components: ['Components', P.C.velocity], labels: ['Labels', P.C.ink], trail: ['Trail', P.C.trace] };
    for (const [k, [name, col]] of Object.entries(labels)) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'toggle' + (this.show[k] ? ' on' : '');
      t.innerHTML = `<span class="sw" style="color:${col}"></span>${name}`;
      t.onclick = () => { this.show[k] = !this.show[k]; t.classList.toggle('on', this.show[k]); };
      ot.appendChild(t);
    }

    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
      if (t.dataset.tab === 'predict') $('#predict-dot').classList.remove('show');
    }));

    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'r' || e.key === 'R') this.restart(true);
      else if (e.key === 'ArrowRight') { this.setPlaying(false); this.scene.advance(1 / 60); }
    });
  }

  togglePlay() {
    if (this.scene.finished) { this.restart(true); return; }
    this.setPlaying(!this.playing);
  }
  setPlaying(p) { this.playing = p; $('#btn-play').classList.toggle('playing', p); }

  // ------------------------------------------------------------ prompt → spec
  async generate(prompt) {
    const btn = $('#prompt-submit');
    btn.disabled = true; $('#loading').hidden = false;
    try {
      const res = await fetch('/api/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const spec = await res.json();
      this.setSpec(spec, { intro: true, prompt });
    } catch (err) {
      this.tutor.system(`Couldn't interpret that request (${err.message}).`);
    } finally {
      btn.disabled = false; $('#loading').hidden = true;
    }
  }

  setSpec(spec, { intro = false, keepGraph = false } = {}) {
    clearTimeout(this._predDebounce); // a pending refresh from the previous scene must not wipe new predictions
    this.spec = spec;
    this._original = JSON.parse(JSON.stringify({ params: spec.params, options: spec.options, track: spec.track ?? null }));
    this.scene = createScene(spec, this.catalog);
    this.view.resize();
    this.view.fit(this.scene.bounds());
    if (keepGraph) this.graph.keepSelection();
    this.graph.setScene(this.scene);
    this.renderHeader();
    this.renderControls();
    this.renderEquations();
    this.renderReadouts();
    this.predict.render(this.scene);
    this.tutor.setSuggestions(SUGGESTIONS[spec.type] ?? []);
    this.setPlaying(true);
    if (intro) {
      $('#predict-dot').classList.add('show');
      this.tutor.resetConversation(
        `I've set up **${spec.title}**. ${spec.summary}\n\nBefore you watch closely, try the **Predict** tab: commit to an answer, then let the experiment check it. Or ask me about anything you see.`,
      );
    }
  }

  renderHeader() {
    const s = this.spec;
    $('#scene-kind').textContent = `${KIND[s.type] ?? 'Simulation'} · ${this.catalog[s.type].title}`;
    $('#scene-title').textContent = s.title;
    $('#scene-summary').textContent = s.summary;
    const src = $('#spec-source');
    src.textContent = s.source === 'claude' ? 'Interpreted by Claude' : s.source === 'local' ? 'Offline interpreter' : s.source === 'edited' ? 'Edited by you' : 'Example';
    src.className = 'source-badge' + (s.source === 'claude' ? ' claude' : '');
    const a = $('#assumptions');
    a.innerHTML = '';
    for (const t of s.assumptions ?? []) { const d = document.createElement('span'); d.className = 'assumption'; d.textContent = t; a.appendChild(d); }
    for (const t of this.scene?.warnings ?? []) { const d = document.createElement('span'); d.className = 'assumption note'; d.textContent = t; a.appendChild(d); }
    if (s.note?.trim()) { const d = document.createElement('span'); d.className = 'assumption note'; d.textContent = s.note.trim(); a.appendChild(d); }
  }

  // ------------------------------------------------------------ controls
  renderControls() {
    const entry = this.catalog[this.spec.type];
    const panel = $('#panel-experiment');
    panel.innerHTML = '';
    // Only show controls that apply to the current shape / body (track scene).
    const relevant = (m) => (!m.shapes || m.shapes.includes(this.spec.options.shape)) && (!m.bodies || m.bodies.includes(this.spec.options.body));
    if (this.spec.type === 'track') this.renderTrackControls(panel);
    for (const [key, m0] of Object.entries(entry.params)) {
      if (!relevant(m0)) continue;
      const m = { ...m0, ...(this.scene.paramRange?.(key) ?? {}) };
      const v = Math.min(m.max, Math.max(m.min, this.spec.params[key]));
      const row = document.createElement('div');
      row.className = 'param';
      row.innerHTML = `
        <div class="param-row">
          <label class="param-label"><span class="sym">${tex(m.symbol)}</span>${m.label}</label>
          <span class="param-value"><input type="number" step="${m.step}" min="${m.min}" max="${m.max}" value="${+v.toFixed(6)}" /><span class="unit">${m.unit}</span></span>
        </div>
        <input type="range" min="${m.min}" max="${m.max}" step="${m.step}" value="${v}" aria-label="${m.label}" />`;
      const [num, range] = [row.querySelector('input[type=number]'), row.querySelector('input[type=range]')];
      const fill = () => range.style.setProperty('--fill', `${((range.value - m.min) / (m.max - m.min)) * 100}%`);
      fill();
      range.addEventListener('input', () => { num.value = range.value; fill(); this.updateParam(key, +range.value); });
      num.addEventListener('change', () => {
        const x = Math.min(m.max, Math.max(m.min, +num.value));
        if (!Number.isFinite(x)) return;
        num.value = x; range.value = x; fill(); this.updateParam(key, x);
      });
      row.dataset.key = key;
      panel.appendChild(row);
    }
    const optionRows = [];
    for (const [key, m] of Object.entries(entry.options ?? {})) {
      if (!relevant(m)) continue;
      const row = document.createElement('div');
      row.className = 'param';
      const set = (v) => {
        this.spec.options[key] = v;
        if (key === 'shape' && this.spec.track) this.spec.track.start_auto = true;
        if (key === 'shape' && !this.spec.track) this.spec.track = { start_auto: true };
        this.rebuild(key === 'shape' || key === 'body');
      };
      if (m.choices.length > 4) {
        row.innerHTML = `<div class="param-row"><span class="param-label">${m.label}</span><select class="select">${m.choices.map((c) => `<option value="${c}" ${this.spec.options[key] === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>`;
        row.querySelector('select').onchange = (e) => set(e.target.value);
      } else {
        row.innerHTML = `<div class="param-row"><span class="param-label">${m.label}</span><span class="seg">${m.choices.map((c) => `<button type="button" data-v="${c}" class="${this.spec.options[key] === c ? 'active' : ''}">${c}</button>`).join('')}</span></div>`;
        row.querySelectorAll('button').forEach((b) => (b.onclick = () => {
          row.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          set(b.dataset.v);
        }));
      }
      row.dataset.option = key;
      optionRows.push(row);
    }
    // shape/body pickers go first for the track scene, the rest after the sliders
    const lead = optionRows.filter((r) => ['shape', 'body'].includes(r.dataset.option));
    lead.reverse().forEach((r) => panel.insertBefore(r, panel.firstChild));
    optionRows.filter((r) => !lead.includes(r)).forEach((r) => panel.appendChild(r));
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.innerHTML = `<button class="btn btn-sm" type="button" data-reset>Reset to interpreted values</button>`;
    actions.querySelector('[data-reset]').onclick = () => {
      this.spec.params = { ...this._original.params }; this.spec.options = { ...this._original.options };
      if (this._original.track) this.spec.track = JSON.parse(JSON.stringify(this._original.track));
      this.rebuild(true);
    };
    panel.appendChild(actions);
  }

  updateParam(key, value) {
    this.spec.params[key] = value;
    if (key === 'x0' && this.spec.type === 'track') this.spec.track = { ...(this.spec.track ?? {}), start_auto: false };
    clearTimeout(this._debounce);
    this.rebuild(false, true);
  }

  // Track-only controls: the equation editor for y = f(x) tracks, and a summary of AI-built segments.
  renderTrackControls(panel) {
    const shape = this.spec.options.shape;
    if (shape === 'function') {
      const row = document.createElement('div');
      row.className = 'param';
      const expr = (this.spec.track?.expr || 'sin(x)').replace(/^y\s*=\s*/i, '');
      row.innerHTML = `
        <div class="param-row"><label class="param-label"><span class="sym">${tex('y(x)')}</span>Track equation</label></div>
        <form class="expr-form"><span class="expr-prefix">y =</span><input class="expr-input" type="text" spellcheck="false" value="${expr.replace(/"/g, '&quot;')}" aria-label="Track equation y = f(x)" /><button class="btn btn-sm" type="submit">Build</button></form>
        <div class="expr-help">Use x, numbers, + − × / ^, sin cos tan exp ln log sqrt abs, pi. Example: 2sin(x) + 0.1x^2</div>`;
      row.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        this.spec.track = { ...(this.spec.track ?? {}), expr: row.querySelector('input').value.trim(), start_auto: true };
        this.spec.source = 'edited';
        this.rebuild();
        this.renderHeader();
      });
      panel.appendChild(row);
    } else if (shape === 'custom') {
      const segs = this.spec.track?.segments ?? [];
      const row = document.createElement('div');
      row.className = 'param';
      const desc = (s) => ({ line: `line ${fmt(s.length)} m${s.turn ? `, turn ${fmt(s.turn)}°` : ''}`, arc: `arc R ${fmt(s.radius)} m, ${fmt(s.turn)}°${Math.abs(s.turn) >= 300 ? ' (loop)' : ''}`,
        curve: `curve y = ${s.expr}`, hill: `hill ${fmt(s.height)} m high`, drop: `drop ${fmt(s.height)} m`, spline: `spline (${s.points?.length ?? 0} pts)` }[s.kind] ?? s.kind);
      row.innerHTML = `<div class="param-row"><span class="param-label">Track pieces</span></div><div class="seg-list">${(segs.length ? segs : []).map((s, i) => `<span>${i + 1}. ${desc(s)}</span>`).join('') || '<span>Demo track (no custom pieces were provided)</span>'}</div>`;
      panel.appendChild(row);
    }
  }

  rebuild(rerenderControls = false, live = false) {
    const playing = this.playing;
    this.graph.keepSelection();
    const prev = this.scene;
    this.scene = createScene(this.spec, this.catalog);
    this.view.fit(this.scene.bounds());
    this.graph.setScene(this.scene, prev);
    this.renderHeader();
    if (rerenderControls) this.renderControls();
    else this.syncDynamicRanges();
    this.renderEquations();
    this.renderReadouts();
    clearTimeout(this._predDebounce);
    this._predDebounce = setTimeout(() => this.predict.render(this.scene), live ? 400 : 0);
    this.setPlaying(live ? playing || true : true);
  }

  // Keep sliders whose range depends on the geometry (e.g. start x) in step with the rebuilt scene.
  syncDynamicRanges() {
    document.querySelectorAll('#panel-experiment .param[data-key]').forEach((row) => {
      const key = row.dataset.key;
      const rg = this.scene.paramRange?.(key);
      if (!rg) return;
      const range = row.querySelector('input[type=range]'), num = row.querySelector('input[type=number]');
      const v = this.spec.params[key];
      range.min = num.min = rg.min; range.max = num.max = rg.max;
      if (document.activeElement !== range) { range.value = v; num.value = +(+v).toFixed(4); }
      range.style.setProperty('--fill', `${((range.value - rg.min) / (rg.max - rg.min || 1)) * 100}%`);
    });
  }

  // Apply changes suggested by the tutor or a concept check.
  applyParams(changes, label) {
    const entry = this.catalog[this.spec.type];
    const applied = [];
    for (const [k, v] of Object.entries(changes)) {
      if (entry.params[k] && Number.isFinite(+v)) {
        const m = entry.params[k];
        this.spec.params[k] = Math.min(m.max, Math.max(m.min, +v));
        applied.push(`${m.label} → ${fmt(this.spec.params[k])} ${m.unit}`);
      } else if (entry.options?.[k] && entry.options[k].choices.includes(String(v))) {
        this.spec.options[k] = String(v);
        applied.push(`${entry.options[k].label} → ${v}`);
      }
    }
    if (!applied.length) return;
    if (this.spec.type === 'track') {
      if ('x0' in changes) this.spec.track = { ...(this.spec.track ?? {}), start_auto: false };
      else if ('shape' in changes) this.spec.track = { ...(this.spec.track ?? {}), start_auto: true };
    }
    this.spec.source = 'edited';
    this.renderHeader();
    this.rebuild(true);
    this.tutor.system(`Experiment: ${label ? label + ' — ' : ''}${applied.join(', ')}`);
    document.querySelectorAll('.param').forEach((row) => {
      if (row.dataset.key && changes[row.dataset.key] !== undefined) { row.style.transition = 'background .6s'; row.style.background = 'rgba(95,227,161,0.12)'; setTimeout(() => (row.style.background = ''), 900); }
    });
  }

  restart(play = true) {
    this.scene.reset();
    this.setPlaying(play);
  }

  // ------------------------------------------------------------ panels
  renderEquations() {
    const panel = $('#panel-equations');
    const eqs = this.scene.equations();
    const der = this.scene.derived();
    panel.innerHTML = eqs.map((e) => `<div class="eq"><div class="eq-title">${e.title}</div><div class="eq-tex">${tex(e.tex, true)}</div></div>`).join('')
      + `<div class="eq"><div class="eq-title">Key quantities</div><div class="derived">${Object.values(der).filter((d) => d.value !== null && d.value !== undefined)
        .map((d) => `<span class="k">${d.label}</span><span class="v">${typeof d.value === 'number' ? fmt(d.value, 4) : typeof d.value === 'boolean' ? (d.value ? 'yes' : 'no') : d.value} ${d.unit ?? ''}</span>`).join('')}</div></div>`;
  }

  renderReadouts() {
    const el = $('#readouts');
    el.innerHTML = '';
    this._readoutEls = this.scene.readouts().map((r) => {
      const d = document.createElement('div');
      d.className = 'readout';
      d.innerHTML = `<div class="r-sym">${tex(r.sym)}${r.label ? `<span class="r-note">${r.label}</span>` : ''}</div><div class="r-val"><span class="v">—</span><span class="r-unit">${r.unit}</span></div>`;
      el.appendChild(d);
      return d.querySelector('.v');
    });
  }

  updateReadouts() {
    const rs = this.scene.readouts();
    rs.forEach((r, i) => { const el = this._readoutEls[i]; if (el) el.textContent = Number.isFinite(r.value) ? fmt(r.value, r.digits ?? 3) : '—'; });
    $('#time-value').textContent = this.scene.t.toFixed(2);
  }

  tutorContext() {
    const entry = this.catalog[this.spec.type];
    const s = this.scene;
    return {
      scene: this.spec.type,
      title: this.spec.title,
      summary: this.spec.summary,
      assumptions: this.spec.assumptions,
      time_s: +s.t.toFixed(3),
      finished: s.finished,
      params: Object.fromEntries(Object.entries(entry.params).map(([k, m]) => [k, { label: m.label, value: this.spec.params[k], unit: m.unit, min: m.min, max: m.max }])),
      options: this.spec.options,
      ...(this.spec.type === 'track' ? { track_geometry: { expr: this.spec.track?.expr || null, segments: this.spec.track?.segments ?? null, length_m: +s.track.length.toFixed(3),
        motion_state: s.mode === 'flight' ? 'airborne (lost contact)' : { roll: 'rolling without slipping', slip: 'skidding', slide: 'sliding', stick: 'at rest, held by static friction', free: 'moving freely on the track' }[s.regime] } } : {}),
      derived: Object.fromEntries(Object.entries(s.derived()).map(([k, d]) => [k, { label: d.label, value: typeof d.value === 'number' ? +d.value.toPrecision(5) : d.value, unit: d.unit ?? '' }])),
      live_readouts: Object.fromEntries(s.readouts().map((r) => [r.label ? `${r.sym} (${r.label})` : r.sym, Number.isFinite(r.value) ? `${fmt(r.value, 4)} ${r.unit}` : 'not yet measured'])),
      measured: s.measured,
      on_screen: 'Canvas shows labelled masses, springs/ropes/rods/tracks, force arrows as solid arrows (gravity amber, normal green, friction red, tension/applied violet, spring pink), velocity (cyan) and acceleration (lime) as dashed arrows, motion trail, plus a live graph (with hover inspector and previous-run comparison) and equations panel.',
    };
  }

  // ------------------------------------------------------------ render loop
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.playing && !this.scene.finished) this.scene.advance(dt * this.speed);
    if (this.scene.finished && this.playing) this.setPlaying(false);
    this.draw(now);
    this.predict.tick(this.scene);
    if (!this._lastUi || now - this._lastUi > 90) { this.updateReadouts(); this._lastUi = now; }
    if (!this._lastGraph || now - this._lastGraph > 70) { this.graph.draw(); this._lastGraph = now; }
    if (!this._lastEq || now - this._lastEq > 1000) {
      // refresh measured values in the equations/derived panel occasionally
      if (!$('#panel-equations').hidden) this.renderEquations();
      this._lastEq = now;
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  draw(now) {
    const { ctx } = this.view;
    const r = { ctx, view: this.view, show: this.show };
    ctx.fillStyle = P.C.bg;
    ctx.fillRect(0, 0, this.view.w, this.view.h);
    P.drawGrid(r);
    try { this.scene.draw(r); } catch (err) { console.error(err); }
    // banners
    const b = this.scene.banners;
    if (b.length) {
      const last = b[b.length - 1];
      const age = (now - last.at) / 1000;
      if (age < 4.5) P.drawBanner(r, last.text, Math.min(1, (4.5 - age) / 0.6), last.color);
    }
    // scale bar
    this.drawScaleBar(r);
    if (this.scene.finished) {
      ctx.save(); ctx.font = '600 12px Inter, sans-serif'; ctx.fillStyle = P.C.inkDim; ctx.textAlign = 'left';
      ctx.fillText('Finished — press ▶ or R to replay', 14, this.view.h - 16); ctx.restore();
    }
  }

  drawScaleBar(r) {
    const { ctx, view } = r;
    const target = 90 / view.scale;
    const p = Math.pow(10, Math.floor(Math.log10(target)));
    const len = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= target * 0.6) ?? target;
    const px = len * view.scale;
    const x = 16, y = 22;
    ctx.save();
    ctx.strokeStyle = P.C.inkDim; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4); ctx.stroke();
    ctx.restore();
    drawMath(ctx, `${+len.toPrecision(3)}\\text{ m}`, x + px + 8, y, { size: 13, color: P.C.inkDim, align: 'left' });
  }
}

const app = new App();
window.proofpilot = app;
app.start();
