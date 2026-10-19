// Time-aware One Euro filters (Casiez et al. 2012) for positions and rotations.
// All filters take timestamps in seconds; smoothing strength adapts to real frame intervals,
// so irregular camera/inference cadence does not change the effective cutoff.
import { Quaternion } from 'three';
import { alignSign, quatAngle } from './math.js';

const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

// Map the UI smoothing value s in [0,1] to filter parameters. s = 0 disables filtering.
export function smoothingParams(s) {
  if (s <= 0) return null;
  const minCutoff = Math.pow(10, Math.log10(8) + (Math.log10(0.6) - Math.log10(8)) * s); // 8 Hz .. 0.6 Hz
  return {
    pos: { minCutoff, beta: 20, dCutoff: 1 }, // beta in Hz per (m/s)
    rot: { minCutoff, beta: 0.8, dCutoff: 1 }, // beta in Hz per (rad/s)
  };
}

// Filters N 3-D points; the adaptive cutoff uses each point's speed.
export class PointsFilter {
  constructor(n) {
    this.n = n;
    this.x = new Float64Array(n * 3);
    this.dx = new Float64Array(n * 3);
    this.t = null;
  }
  reset() {
    this.t = null;
  }
  // values: array-like of length n*3, filtered in place. params null -> passthrough.
  filter(values, t, params) {
    if (!params) {
      this.t = null;
      return values;
    }
    if (this.t === null || !(t > this.t)) {
      if (this.t === null) {
        for (let i = 0; i < this.n * 3; i++) {
          this.x[i] = values[i];
          this.dx[i] = 0;
        }
        this.t = t;
      }
      for (let i = 0; i < this.n * 3; i++) values[i] = this.x[i];
      return values;
    }
    const dt = Math.min(t - this.t, 0.25);
    this.t = t;
    const ad = alpha(params.dCutoff, dt);
    for (let p = 0; p < this.n; p++) {
      let speed2 = 0;
      for (let k = 0; k < 3; k++) {
        const i = p * 3 + k;
        const d = (values[i] - this.x[i]) / dt;
        this.dx[i] += ad * (d - this.dx[i]);
        speed2 += this.dx[i] * this.dx[i];
      }
      const a = alpha(params.minCutoff + params.beta * Math.sqrt(speed2), dt);
      for (let k = 0; k < 3; k++) {
        const i = p * 3 + k;
        this.x[i] += a * (values[i] - this.x[i]);
        values[i] = this.x[i];
      }
    }
    return values;
  }
}

// Quaternion One Euro: derivative = angular speed, smoothing by slerp (hemisphere-aligned).
export class QuatFilter {
  constructor() {
    this.q = new Quaternion();
    this.speed = 0;
    this.t = null;
  }
  reset() {
    this.t = null;
  }
  filter(q, t, params) {
    if (!params) {
      this.t = null;
      return q;
    }
    if (this.t === null) {
      this.q.copy(q);
      this.speed = 0;
      this.t = t;
      return q;
    }
    if (!(t > this.t)) return q.copy(this.q);
    const dt = Math.min(t - this.t, 0.25);
    this.t = t;
    alignSign(q, this.q);
    const rawSpeed = quatAngle(q, this.q) / dt;
    this.speed += alpha(params.dCutoff, dt) * (rawSpeed - this.speed);
    const a = alpha(params.minCutoff + params.beta * this.speed, dt);
    this.q.slerp(q, a);
    return q.copy(this.q);
  }
}
