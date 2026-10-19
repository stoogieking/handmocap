// Layer 5 (source side): neutral-pose calibration from many stable frames.
//
// The performer holds an open hand, palm toward the camera, fingers up. For each side we collect
// unfiltered landmark frames, reject unstable ones, and average:
//   - raw finger angles (flex/spread/hinges)  -> neutral offsets subtracted by the solver
//   - thumb metacarpal direction              -> thumb rest frame
//   - thumb MCP/IP swings (re-solved with that rest direction) -> thumb neutral offsets
//   - hand orientation                        -> neutral wrist (relative wrist mode, loss pose)
//   - approximate root position               -> reference for approximate positioning
//   - palm length (MediaPipe world units)      -> source scale for position scaling
// The palm-facing check detects inverted handedness labels: with the wrong side assumed, the
// computed palm normal points away from the camera.
import { Vector3, Quaternion } from 'three';
import { FINGERS } from './canonical.js';
import { solveRaw, newRaw, defaultNeutral } from './solver.js';
import { averageQuats, quatAngle, DEG, Z_AXIS } from './math.js';
import { approxRoot } from './conditioning.js';

export const CALIBRATION_VERSION = 1;

export class Calibrator {
  constructor() {
    this.state = 'idle'; // idle | countdown | capturing | done | failed
    this.message = '';
    this.result = null;
  }

  start(t, sides, { countdown = 2, maxCapture = 5, framesNeeded = 30 } = {}) {
    this.state = 'countdown';
    this.sides = sides;
    this.t0 = t;
    this.countdown = countdown;
    this.maxCapture = maxCapture;
    this.framesNeeded = framesNeeded;
    this.samples = Object.fromEntries(sides.map((s) => [s, []]));
    this.result = null;
    this.message = `Hold the neutral pose… capturing in ${countdown.toFixed(0)} s`;
  }

  cancel() {
    this.state = 'idle';
    this.message = 'Calibration cancelled.';
  }

  // Called by the pipeline once per processed frame with per-side last samples.
  update(t, sampleBySide, settings) {
    if (this.state === 'countdown') {
      const left = this.countdown - (t - this.t0);
      this.message = `Hold the neutral pose… capturing in ${Math.max(0, left).toFixed(1)} s`;
      if (left <= 0) {
        this.state = 'capturing';
        this.tCapture = t;
      }
      return;
    }
    if (this.state !== 'capturing') return;
    for (const side of this.sides) {
      const s = sampleBySide[side];
      if (s) this.samples[side].push(s);
    }
    const counts = this.sides.map((s) => this.samples[s].length);
    this.message = `Capturing… ${this.sides.map((s, i) => `${s} ${counts[i]}`).join(', ')} frames`;
    // Done when every side that is being seen has enough frames; sides never seen are given
    // 1.5 s before they are skipped (calibrating one hand is allowed).
    const seen = counts.filter((c) => c > 0);
    const enough = seen.length > 0 && seen.every((c) => c >= this.framesNeeded * 1.5) && (seen.length === counts.length || t - this.tCapture > 1.5);
    if (enough || t - this.tCapture > this.maxCapture) this._finish(settings);
  }

  _finish(settings) {
    this.flipConvention = false;
    let { result, errors, palmAway } = this._solveAll(this.samples, settings);
    // Every captured hand palm-away is the signature of inverted handedness labels (a wrong
    // side flips the computed palm normal). Re-solve with the samples swapped between sides.
    if (palmAway.length && palmAway.length === this.sides.filter((s) => this.samples[s].length).length) {
      const swapped = { left: this.samples.right || [], right: this.samples.left || [] };
      const again = this._solveAll(swapped, settings);
      if (Object.keys(again.result).length && !again.palmAway.length) {
        ({ result, errors } = again);
        this.flipConvention = true;
      }
    }
    this.result = result;
    if (Object.keys(result).length === 0) {
      this.state = 'failed';
      this.message = 'Calibration failed. ' + errors.join(' ');
    } else {
      this.state = 'done';
      const parts = Object.entries(result).map(([s, r]) => `${s}: ${r.frames} frames, jitter ${r.jitterDeg.toFixed(1)}°${r.warnings.length ? ' (' + r.warnings.join('; ') + ')' : ''}`);
      this.message = 'Calibrated — ' + parts.join(' | ') + (errors.length ? ' | not calibrated: ' + errors.join(' ') : '') + (this.flipConvention ? ' | Handedness labels were inverted for this model/browser; the label convention was switched automatically.' : '');
    }
  }

  _solveAll(samples, settings) {
    const result = {}, errors = [], palmAway = [];
    for (const side of this.sides) {
      const r = calibrateSide(side, samples[side] || [], settings, this.framesNeeded);
      if (r.error) {
        errors.push(`${side}: ${r.error}`);
        if (r.palmAway) palmAway.push(side);
      } else result[side] = r;
    }
    return { result, errors, palmAway };
  }
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// samples: [{ t, P: Vector3[21] (canonical world, unfiltered), det }]
export function calibrateSide(side, samples, settings, framesNeeded = 30) {
  if (samples.length < framesNeeded) return { error: `only ${samples.length} usable frames (need ${framesNeeded}); keep the hand visible and still` };
  const opts = { thumbTwist: settings?.thumbTwist ?? 25 * DEG };
  const raws = samples.map((s) => {
    const r = solveRaw(s.P, side, null, opts, newRaw());
    return {
      hand: r.hand.clone(),
      thumbDir: r.thumb.dir1.clone(),
      f: Object.fromEntries(FINGERS.slice(1).map((f) => [f, { ...r.fingers[f] }])),
      sample: s,
    };
  });

  // Robust selection: keep frames close to the per-angle median (rejects motion and glitches).
  const keys = [];
  for (const f of FINGERS.slice(1)) for (const k of ['flex1', 'spread', 'flex2', 'flex3']) keys.push([f, k]);
  const med = keys.map(([f, k]) => median(raws.map((r) => r.f[f][k])));
  const medHand = averageQuats(raws.map((r) => r.hand));
  const kept = raws.filter((r) => {
    let worst = 0;
    keys.forEach(([f, k], i) => (worst = Math.max(worst, Math.abs(r.f[f][k] - med[i]))));
    return worst < 10 * DEG && quatAngle(r.hand, medHand) < 12 * DEG;
  });
  if (kept.length < framesNeeded) return { error: `hand moved too much (${kept.length}/${raws.length} stable frames); hold still` };

  const neutral = defaultNeutral();
  let jitter = 0;
  for (const f of FINGERS.slice(1)) {
    for (const k of ['flex1', 'spread', 'flex2', 'flex3']) {
      const vals = kept.map((r) => r.f[f][k]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      neutral.fingers[f][k] = mean;
      jitter += vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    }
  }
  jitter = Math.sqrt(jitter / 16) / DEG;
  const td = new Vector3();
  kept.forEach((r) => td.add(r.thumbDir));
  neutral.thumbRestDir = td.normalize();

  // Re-solve the thumb with the calibrated rest direction to get MCP/IP neutral swings.
  const n2 = [], n3 = [];
  for (const r of kept) {
    const rr = solveRaw(r.sample.P, side, neutral.thumbRestDir, opts, newRaw());
    n2.push(rr.thumb.s2.clone());
    n3.push(rr.thumb.s3.clone());
  }
  averageQuats(n2, neutral.n2);
  averageQuats(n3, neutral.n3);

  const wrist = averageQuats(kept.map((r) => r.hand));
  const palmNormal = Z_AXIS.clone().applyQuaternion(wrist);
  const palmFacing = palmNormal.z; // +1 = palm toward camera
  const warnings = [];
  if (palmFacing < -0.3) return { error: 'palm normal points away from the camera: either the back of the hand faced the camera, or handedness labels are inverted (Advanced → Handedness labels)', palmFacing, palmAway: true };
  if (palmFacing < 0.3) warnings.push('palm not facing the camera squarely');
  const curl = Math.max(...FINGERS.slice(1).map((f) => neutral.fingers[f].flex2 / DEG));
  if (curl > 35) warnings.push('fingers look curled; this pose now maps to the rig rest pose');

  const roots = kept.map((r) => approxRoot(r.sample.det, settings?.hfov ?? 60 * DEG)).filter(Boolean);
  const rootRef = roots.length ? roots.reduce((a, b) => a.add(b), new Vector3()).multiplyScalar(1 / roots.length) : null;
  const palmLength = kept.reduce((a, r) => a + r.sample.P[9].distanceTo(r.sample.P[0]), 0) / kept.length;

  return {
    version: CALIBRATION_VERSION,
    side,
    frames: kept.length,
    rejected: raws.length - kept.length,
    jitterDeg: jitter,
    palmFacing,
    warnings,
    neutral,
    wrist: wrist.toArray(new Float32Array(4)),
    rootRef: rootRef ? rootRef.toArray(new Float32Array(3)) : null,
    palmLength,
    createdAt: new Date().toISOString(),
  };
}

// JSON (de)serialisation for profiles.
export function calibrationToJSON(c) {
  if (!c) return null;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return {
    version: c.version,
    side: c.side,
    frames: c.frames,
    jitterDeg: r6(c.jitterDeg),
    palmFacing: r6(c.palmFacing),
    warnings: c.warnings,
    createdAt: c.createdAt,
    neutral: {
      fingers: Object.fromEntries(Object.entries(c.neutral.fingers).map(([f, v]) => [f, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r6(x)]))])),
      thumbRestDir: c.neutral.thumbRestDir ? c.neutral.thumbRestDir.toArray().map(r6) : null,
      n2: c.neutral.n2.toArray().map(r6),
      n3: c.neutral.n3.toArray().map(r6),
    },
    wrist: Array.from(c.wrist, r6),
    rootRef: c.rootRef ? Array.from(c.rootRef, r6) : null,
    palmLength: r6(c.palmLength),
    units: { angles: 'radians', lengths: 'metres', quaternions: 'xyzw' },
  };
}

export function calibrationFromJSON(j) {
  if (!j) return null;
  if (j.version !== CALIBRATION_VERSION) throw new Error(`unsupported calibration version ${j.version}`);
  const neutral = defaultNeutral();
  for (const f of Object.keys(neutral.fingers)) Object.assign(neutral.fingers[f], j.neutral.fingers[f]);
  neutral.thumbRestDir = j.neutral.thumbRestDir ? new Vector3().fromArray(j.neutral.thumbRestDir).normalize() : null;
  neutral.n2 = new Quaternion().fromArray(j.neutral.n2).normalize();
  neutral.n3 = new Quaternion().fromArray(j.neutral.n3).normalize();
  return {
    ...j,
    neutral,
    wrist: Float32Array.from(j.wrist),
    rootRef: j.rootRef ? Float32Array.from(j.rootRef) : null,
  };
}
