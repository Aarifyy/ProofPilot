// Classic 4th-order Runge–Kutta step for y' = f(t, y), y an array.
export function rk4(f, t, y, h) {
  const n = y.length;
  const k1 = f(t, y);
  const y2 = new Array(n), y3 = new Array(n), y4 = new Array(n);
  for (let i = 0; i < n; i++) y2[i] = y[i] + 0.5 * h * k1[i];
  const k2 = f(t + 0.5 * h, y2);
  for (let i = 0; i < n; i++) y3[i] = y[i] + 0.5 * h * k2[i];
  const k3 = f(t + 0.5 * h, y3);
  for (let i = 0; i < n; i++) y4[i] = y[i] + h * k3[i];
  const k4 = f(t + h, y4);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = y[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return out;
}

// Complete elliptic integral of the first kind K(k) via the AGM.
export function ellipticK(k) {
  let a = 1, b = Math.sqrt(1 - k * k);
  for (let i = 0; i < 30 && Math.abs(a - b) > 1e-15; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
}

export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
