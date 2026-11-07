// World (metres, y up) <-> screen (CSS pixels, y down) transform with DPR handling.
export class View {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 100; // px per metre
    this.ox = 0;
    this.oy = 0;
    this.w = 1;
    this.h = 1;
    this.bounds = { xmin: -1, xmax: 1, ymin: -1, ymax: 1 };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fit(this.bounds);
  }

  // Fit world bounds into the canvas, preserving aspect ratio.
  fit(b, pad = { l: 56, r: 56, t: 64, b: 56 }) {
    this.bounds = b;
    const bw = Math.max(1e-6, b.xmax - b.xmin);
    const bh = Math.max(1e-6, b.ymax - b.ymin);
    const aw = Math.max(40, this.w - pad.l - pad.r);
    const ah = Math.max(40, this.h - pad.t - pad.b);
    this.scale = Math.min(aw / bw, ah / bh);
    const cx = (b.xmin + b.xmax) / 2;
    const cy = (b.ymin + b.ymax) / 2;
    this.ox = pad.l + aw / 2 - cx * this.scale;
    this.oy = pad.t + ah / 2 + cy * this.scale;
  }

  sx(x) { return this.ox + x * this.scale; }
  sy(y) { return this.oy - y * this.scale; }
  pt(p) { return [this.sx(p[0]), this.sy(p[1])]; }
  px(len) { return len * this.scale; }
  // Visible world rectangle (may exceed fitted bounds on wide canvases).
  visible() {
    return {
      xmin: (0 - this.ox) / this.scale, xmax: (this.w - this.ox) / this.scale,
      ymin: (this.oy - this.h) / this.scale, ymax: this.oy / this.scale,
    };
  }
}
