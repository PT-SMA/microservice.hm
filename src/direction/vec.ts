import type { Vec3 } from "./types.ts";

export const G = 9.80665;
export const DEG = Math.PI / 180;

export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 =>
  vec(a.x * k, a.y * k, a.z * k);
export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const norm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : vec(0, 0, 1);
};

/** Degrees into [0, 360). */
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** Signed difference a − b in (−180, 180]. */
export const angleDiff = (a: number, b: number): number => {
  const d = wrap360(a - b);
  return d > 180 ? d - 360 : d;
};

/** Circular mean and spread (degrees) of angles. */
export function circularStats(
  angles: number[],
): { meanDeg: number; stdDeg: number } {
  let s = 0, c = 0;
  for (const a of angles) {
    s += Math.sin(a * DEG);
    c += Math.cos(a * DEG);
  }
  const n = Math.max(angles.length, 1);
  const r = Math.min(Math.hypot(s, c) / n, 1);
  return {
    meanDeg: wrap360(Math.atan2(s, c) / DEG),
    stdDeg: r > 0 ? Math.sqrt(-2 * Math.log(r)) / DEG : 180,
  };
}

export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Pearson correlation; 0 when either side is constant. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * Ordinary least squares y ≈ X·β. Returns β, the residual RMS and the
 * standard error of each coefficient, or null when X'X is singular.
 */
export function leastSquares(
  rows: number[][],
  y: number[],
): { beta: number[]; residualRms: number; stdErr: number[] } | null {
  const n = rows.length, p = rows[0]?.length ?? 0;
  if (n <= p || p === 0) return null;
  // normal equations, then Gauss–Jordan inverse of X'X
  const a: number[][] = Array.from(
    { length: p },
    () => new Array(2 * p).fill(0),
  );
  const xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      xty[j] += rows[i][j] * y[i];
      for (let k = 0; k < p; k++) a[j][k] += rows[i][j] * rows[i][k];
    }
  }
  for (let j = 0; j < p; j++) a[j][p + j] = 1;
  for (let col = 0; col < p; col++) {
    let pivot = col;
    for (let r = col + 1; r < p; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    const scaleRef = Math.abs(a[col][col]) + 1e-300;
    if (Math.abs(a[pivot][col]) < 1e-12 * scaleRef) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    if (Math.abs(d) < 1e-15) return null;
    for (let k = 0; k < 2 * p; k++) a[col][k] /= d;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let k = 0; k < 2 * p; k++) a[r][k] -= f * a[col][k];
    }
  }
  const inv = a.map((row) => row.slice(p));
  const beta = inv.map((row) => row.reduce((s, v, k) => s + v * xty[k], 0));
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const fit = rows[i].reduce((s, v, k) => s + v * beta[k], 0);
    rss += (y[i] - fit) ** 2;
  }
  const sigma2 = rss / (n - p);
  return {
    beta,
    residualRms: Math.sqrt(rss / n),
    stdErr: inv.map((row, j) => Math.sqrt(Math.max(row[j] * sigma2, 0))),
  };
}
