// AI tutor chat: streams replies, renders markdown + KaTeX, and turns
// [[try: k=v, ... | label]] directives into one-click experiment buttons.

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderTex(tex, display) {
  try { return window.katex.renderToString(tex, { displayMode: display, throwOnError: false }); }
  catch { return esc(tex); }
}

export function renderMarkdown(src) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = src;
  // try-buttons
  s = s.replace(/\[\[\s*try:\s*([^|\]]+?)\s*(?:\|\s*([^\]]+?))?\s*\]\]/gi, (_, kv, label) => {
    const changes = {};
    for (const part of kv.split(',')) {
      const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(-?[\d.]+(?:e-?\d+)?|[A-Za-z]+)\s*$/.exec(part);
      if (m) changes[m[1]] = isNaN(+m[2]) ? m[2] : +m[2];
    }
    if (!Object.keys(changes).length) return '';
    const text = label || Object.entries(changes).map(([k, v]) => `${k} = ${v}`).join(', ');
    return keep(`<button class="try-btn" data-try='${esc(JSON.stringify(changes))}'>${esc(text)}</button>`);
  });
  // maths
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep(renderTex(t.trim(), true)));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => keep(renderTex(t.trim(), true)));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, t) => keep(renderTex(t, false)));
  s = s.replace(/\\\((.+?)\\\)/g, (_, t) => keep(renderTex(t, false)));
  s = s.replace(/`([^`]+)`/g, (_, t) => keep(`<code>${esc(t)}</code>`));
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // blocks
  const lines = s.split('\n');
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = /^\s*[-•*]\s+(.*)/.exec(line), ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
    const h = /^#{1,4}\s+(.*)/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
    } else if (h) { flushPara(); flushList(); out.push(`<p><strong>${h[1]}</strong></p>`); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

export class Tutor {
  constructor({ log, form, input, suggest, sourceEl, getContext, onTry }) {
    Object.assign(this, { log, form, input, suggest, sourceEl, getContext, onTry });
    this.messages = [];
    this.busy = false;
    form.addEventListener('submit', (e) => { e.preventDefault(); const q = input.value.trim(); if (q) { input.value = ''; this.ask(q); } });
    log.addEventListener('click', (e) => {
      const b = e.target.closest('.try-btn');
      if (b) onTry(JSON.parse(b.dataset.try), b.textContent);
    });
  }

  system(text) {
    const d = document.createElement('div');
    d.className = 'msg system'; d.textContent = text;
    this.log.appendChild(d); this.scroll();
  }

  bubble(role, text = '') {
    const d = document.createElement('div');
    d.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
    d.innerHTML = role === 'user' ? `<p>${esc(text)}</p>` : renderMarkdown(text);
    this.log.appendChild(d); this.scroll();
    return d;
  }

  scroll() { this.log.scrollTop = this.log.scrollHeight; }

  setSuggestions(list) {
    this.suggest.innerHTML = '';
    for (const q of list) {
      const c = document.createElement('button');
      c.className = 'chip'; c.type = 'button'; c.textContent = q;
      c.onclick = () => this.ask(q);
      this.suggest.appendChild(c);
    }
  }

  resetConversation(intro) {
    this.messages = [];
    this.log.innerHTML = '';
    if (intro) this.bubble('assistant', intro);
  }

  async ask(question, { display = question, extraContext = {} } = {}) {
    if (this.busy) return;
    this.busy = true;
    this.bubble('user', display);
    this.messages.push({ role: 'user', content: question });
    const el = this.bubble('assistant', '');
    el.classList.add('streaming');
    let text = '';
    try {
      const res = await fetch('/api/tutor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.messages.slice(-20), context: { ...this.getContext(), ...extraContext } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const src = res.headers.get('X-Tutor-Source');
      if (this.sourceEl) this.sourceEl.textContent = src === 'claude' ? 'Claude' : 'Offline tutor';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        const now = performance.now();
        if (now - last > 60) { el.innerHTML = renderMarkdown(text); this.scroll(); last = now; }
      }
      text += dec.decode();
    } catch (err) {
      text = text || `Sorry — I couldn't reach the tutor (${err.message}). Your simulation still works; try again in a moment.`;
    }
    el.classList.remove('streaming');
    el.innerHTML = renderMarkdown(text);
    this.scroll();
    this.messages.push({ role: 'assistant', content: text });
    this.busy = false;
  }
}
