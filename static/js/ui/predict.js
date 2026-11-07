// Prediction cards: the student commits to an answer *before* seeing the result.
// Numeric predictions are checked against values the simulation measures live;
// concept checks reveal immediately and offer a one-click experiment.
import { fmt } from '../scenes/base.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Predict {
  constructor(panel, app) {
    this.panel = panel;
    this.app = app;
    this.pending = null; // {pred, value, el}
    this.done = new Map();
  }

  render(scene) {
    this.scene = scene;
    this.pending = null;
    this.done = new Map();
    const preds = scene.predictions();
    const p = this.panel;
    p.innerHTML = `<p class="pred-intro">Commit to a prediction <em>before</em> you run the experiment. Then compare it with what the simulation actually measures.</p>`;
    for (const pred of preds) {
      const card = document.createElement('div');
      card.className = 'pred';
      card.dataset.id = pred.id;
      if (pred.kind === 'number') {
        card.innerHTML = `
          <div class="pred-kind">Quantitative prediction</div>
          <div class="pred-q">${esc(pred.question)}</div>
          <form class="pred-input">
            <input type="number" step="any" inputmode="decimal" placeholder="Your prediction" required />
            <span class="unit">${esc(pred.unit)}</span>
            <button class="btn btn-sm btn-primary" type="submit">Lock in &amp; run</button>
          </form>
          <div class="pred-out"></div>`;
        card.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const v = parseFloat(card.querySelector('input').value);
          if (!Number.isFinite(v)) return;
          this.lockIn(pred, v, card);
        });
      } else {
        card.innerHTML = `
          <div class="pred-kind">Concept check</div>
          <div class="pred-q">${esc(pred.question)}</div>
          <div class="pred-choices">${pred.choices.map((c) => `<button class="pred-choice" type="button">${esc(c)}</button>`).join('')}</div>
          <div class="pred-out"></div>`;
        card.querySelectorAll('.pred-choice').forEach((b) => b.addEventListener('click', () => this.choose(pred, b.textContent, card)));
      }
      p.appendChild(card);
    }
  }

  lockIn(pred, value, card) {
    card.querySelectorAll('input, button').forEach((x) => (x.disabled = true));
    this.pending = { pred, value, card };
    card.querySelector('.pred-out').innerHTML = `<div class="waiting"><div class="spinner"></div>Running the experiment to measure ${esc(pred.sym)}…</div>`;
    this.app.restart(true);
  }

  // Called every frame by the app.
  tick(scene) {
    if (!this.pending || scene !== this.scene) return;
    const { pred, value, card } = this.pending;
    const measured = scene.measured[pred.measuredKey];
    if (measured === undefined) {
      if (scene.finished) {
        card.querySelector('.pred-out').innerHTML = `<div class="pred-result bad">The simulation finished without measuring this (e.g. the block never moved). Adjust the parameters and try again.</div>`;
        card.querySelectorAll('input, button').forEach((x) => (x.disabled = false));
        this.pending = null;
      }
      return;
    }
    this.pending = null;
    const err = Math.abs(value - measured) / Math.max(Math.abs(measured), 1e-9) * 100;
    const cls = err < 5 ? 'good' : err < 20 ? 'ok' : 'bad';
    const verdict = err < 5 ? 'Spot on!' : err < 20 ? 'Close!' : 'Not quite — let’s find out why.';
    const meterColor = cls === 'good' ? 'var(--good)' : cls === 'ok' ? 'var(--amber)' : 'var(--bad)';
    const theoryRow = pred.theory != null ? `<div class="row"><span class="k">Theory</span><span>${fmt(pred.theory, 4)} ${esc(pred.unit)}</span></div>` : '';
    card.querySelector('.pred-out').innerHTML = `
      <div class="pred-result ${cls}">
        <div class="verdict">${verdict}</div>
        <div class="row"><span class="k">Your prediction</span><span>${fmt(value, 4)} ${esc(pred.unit)}</span></div>
        <div class="row"><span class="k">Measured in simulation</span><span>${fmt(measured, 4)} ${esc(pred.unit)}</span></div>
        ${theoryRow}
        <div class="row"><span class="k">Error</span><span>${err.toFixed(1)}%</span></div>
        <div class="meter"><div style="width:${Math.max(4, 100 - Math.min(100, err))}%;background:${meterColor}"></div></div>
      </div>
      <div class="panel-actions"><button class="btn btn-sm" type="button" data-again>Predict again</button></div>`;
    card.querySelector('[data-again]').onclick = () => this.render(this.scene);
    this.done.set(pred.id, true);
    this.app.tutor.ask(
      `I predicted ${pred.sym} = ${value} ${pred.unit}. The simulation measured ${fmt(measured, 4)} ${pred.unit}. Can you give me feedback on my prediction?`,
      { display: `My prediction: ${pred.sym} = ${value} ${pred.unit} (measured ${fmt(measured, 4)} ${pred.unit})`,
        extraContext: { prediction: { kind: 'number', question: pred.question, student: value, actual: measured, theory: pred.theory, unit: pred.unit, hint: pred.hint, error_percent: +err.toFixed(1) } } },
    );
  }

  choose(pred, choice, card) {
    const correct = choice === pred.answer;
    card.querySelectorAll('.pred-choice').forEach((b) => {
      b.disabled = true;
      if (b.textContent === pred.answer) b.classList.add('correct');
      else if (b.textContent === choice) b.classList.add('wrong');
    });
    const tryBtn = pred.suggest ? `<button class="try-btn" type="button" data-try>Test it in the simulation</button>` : '';
    card.querySelector('.pred-out').innerHTML = `
      <div class="pred-result ${correct ? 'good' : 'bad'}">
        <div class="verdict">${correct ? 'Correct ✓' : 'Not quite'}</div>
        <div>${esc(pred.explanation)}</div>
      </div>
      <div>${tryBtn}</div>`;
    const t = card.querySelector('[data-try]');
    if (t) t.onclick = () => this.app.applyParams(pred.suggest, 'Concept test');
    this.done.set(pred.id, true);
    if (!correct) {
      this.app.tutor.ask(
        `For the question "${pred.question}" I predicted "${choice}" but the answer is "${pred.answer}". Help me understand my misconception.`,
        { display: `I answered “${choice}” — the correct answer is “${pred.answer}”. Why?`,
          extraContext: { prediction: { kind: 'choice', question: pred.question, student: choice, answer: pred.answer, correct, explanation: pred.explanation } } },
      );
    }
  }
}
