// Layer 3: landmark conditioning, tracking validity, filtering and tracking-loss continuity.
// One SideProcessor exists per anatomical side. It turns an associated detection into a
// canonical HandPose (via the solver, layer 4) and owns all temporal state for that side.
import { Vector3, Quaternion } from 'three';
import { FINGERS, FINGER_BASE, newHandPose, cloneHandPose, identityJoints, FINGER_JOINTS } from './canonical.js';
import { solveRaw, rawToJoints, newRaw } from './solver.js';
import { PointsFilter, QuatFilter, smoothingParams } from './filters.js';
import { quatAngle, smoothstep, readQuat, writeQuat, alignSign, quatX, quatZ, DEG } from './math.js';
import { TEMPLATE, segmentLengths } from './handmodel.js';

export const DEFAULT_SETTINGS = {
  hands: 'both', // 'both' | 'left' | 'right'
  smoothing: 0.35, // 0 = off
  holdTime: 0.3, // s: hold last valid pose
  blendTime: 0.5, // s: then blend to neutral
  resumeTime: 0.2, // s: blend back in when tracking resumes
  lossPose: 'relaxed', // 'rest' | 'relaxed'
  rootPolicy: 'fixed', // 'fixed' | 'approx-screen'
  thumbTwist: 25 * DEG,
  hfov: 60 * DEG, // assumed horizontal field of view for approximate positioning
  recordRaw: false,
};

// MediaPipe world landmarks (x right, y down, z away) -> canonical world (x, -y, -z).
export function toCanonicalPoints(world, out) {
  for (let i = 0; i < 21; i++) out[i].set(world[i * 3], -world[i * 3 + 1], -world[i * 3 + 2]);
  return out;
}

// Approximate camera-space position of the palm centre from a weak-perspective fit between
// the metric world landmarks and their image projections. Assumes a pinhole camera with
// horizontal FOV `hfov`. This is an estimate, not a measured trajectory.
const PAIRS = [[0, 5], [0, 9], [0, 17], [5, 17], [0, 13]];
export function approxRoot(det, hfov, out = new Vector3()) {
  const W = det.width || 640, H = det.height || 480;
  const f = W / 2 / Math.tan(hfov / 2);
  let s2 = 0, s3 = 0;
  for (const [a, b] of PAIRS) {
    s2 += Math.hypot((det.image[a * 3] - det.image[b * 3]) * W, (det.image[a * 3 + 1] - det.image[b * 3 + 1]) * H);
    s3 += Math.hypot(det.world[a * 3] - det.world[b * 3], det.world[a * 3 + 1] - det.world[b * 3 + 1]);
  }
  if (!(s2 > 1) || !(s3 > 1e-4)) return null;
  const Z = (f * s3) / s2;
  let cx = 0, cy = 0;
  for (const i of [0, 5, 9, 13, 17]) {
    cx += det.image[i * 3];
    cy += det.image[i * 3 + 1];
  }
  cx = (cx / 5) * W;
  cy = (cy / 5) * H;
  const X = ((cx - W / 2) * Z) / f, Y = ((cy - H / 2) * Z) / f;
  return out.set(X, -Y, -Z);
}

// Relaxed loss pose: mild flexion, used when tracking is lost and lossPose == 'relaxed'.
export function relaxedJoints() {
  const J = identityJoints();
  const q = new Quaternion();
  for (const f of FINGERS.slice(1)) {
    const i = FINGER_JOINTS.indexOf(f + '1');
    writeQuat(J, i, quatX(22 * DEG, q));
    writeQuat(J, i + 1, quatX(30 * DEG, q));
    writeQuat(J, i + 2, quatX(15 * DEG, q));
  }
  writeQuat(J, 1, quatX(10 * DEG, q));
  writeQuat(J, 2, quatX(12 * DEG, q));
  return J;
}
const RELAXED = relaxedJoints();
const REST = identityJoints();

const TEMPLATE_RATIOS = (() => {
  const L = segmentLengths(TEMPLATE.right);
  const palm = TEMPLATE.right[9].distanceTo(TEMPLATE.right[0]);
  return L.map((l) => l / palm);
})();

const _qa = new Quaternion(), _qb = new Quaternion();
export function blendPose(a, b, w, out) {
  for (let i = 0; i < 15; i++) {
    readQuat(a.joints, i, _qa);
    readQuat(b.joints, i, _qb);
    alignSign(_qb, _qa);
    writeQuat(out.joints, i, _qa.slerp(_qb, w));
  }
  _qa.fromArray(a.wrist);
  _qb.fromArray(b.wrist);
  alignSign(_qb, _qa);
  _qa.slerp(_qb, w).toArray(out.wrist);
  if (a.root && b.root) {
    out.root = out.root || new Float32Array(3);
    for (let k = 0; k < 3; k++) out.root[k] = a.root[k] + (b.root[k] - a.root[k]) * w;
  } else out.root = (w < 0.5 ? a.root : b.root) ? Float32Array.from(w < 0.5 ? a.root : b.root) : null;
  return out;
}

export class SideProcessor {
  constructor(side) {
    this.side = side;
    this.P = Array.from({ length: 21 }, () => new Vector3());
    this.Praw = Array.from({ length: 21 }, () => new Vector3());
    this.flat = new Float32Array(63);
    this.raw = newRaw();
    this.lmFilter = new PointsFilter(21);
    this.rootFilter = new PointsFilter(1);
    this.rotFilters = Array.from({ length: 16 }, () => new QuatFilter());
    this.reset();
  }

  reset() {
    this.trackId = null;
    this.mode = 'none'; // none | tracked | resuming | held | blending | lost
    this.lastSeen = -Infinity;
    this.lastLive = null;
    this.lastOut = null;
    this.heldFrom = null;
    this.resumeFrom = null;
    this.resumeStart = 0;
    this.prevJoints = null;
    this.prevWrist = null;
    this.rejectCount = 0;
    this.ratioEma = null;
    this.lastSample = null; // for calibration: { P (unfiltered), raw-independent data }
    this._resetFilters();
  }

  _resetFilters() {
    this.lmFilter.reset();
    this.rootFilter.reset();
    for (const f of this.rotFilters) f.reset();
  }

  // Validity of the incoming landmarks. Returns { ok, reason, stability, fingerOk[5] }.
  _validate(det, P) {
    for (let i = 0; i < 63; i++) if (!Number.isFinite(det.world[i]) || !Number.isFinite(det.image[i])) return { ok: false, reason: 'non-finite landmarks' };
    const palm = P[9].distanceTo(P[0]);
    if (!(palm > 0.02 && palm < 0.25)) return { ok: false, reason: 'implausible palm size' };
    const L = segmentLengths(P).map((l) => l / palm);
    const fingerOk = [1, 1, 1, 1, 1];
    let dev = 0;
    L.forEach((r, k) => {
      const rel = Math.abs(r - TEMPLATE_RATIOS[k]) / TEMPLATE_RATIOS[k];
      dev += rel;
      if (rel > 0.6) fingerOk[Math.floor(k / 4)] = 0;
    });
    dev /= L.length;
    // Heuristic stability: segment-proportion consistency vs. this track's running average.
    if (!this.ratioEma) this.ratioEma = L.slice();
    let drift = 0;
    L.forEach((r, k) => {
      drift += Math.abs(r - this.ratioEma[k]) / this.ratioEma[k];
      this.ratioEma[k] += 0.1 * (r - this.ratioEma[k]);
    });
    drift /= L.length;
    const stability = Math.max(0, Math.min(1, 1 - 4 * drift - Math.max(0, dev - 0.25)));
    return { ok: true, stability, fingerOk };
  }

  // assignment: { id, det, ambiguous } from HandAssociator. Returns a HandPose.
  observe(assignment, t, settings, calib) {
    const det = assignment.det;
    if (assignment.ambiguous) return this.noObservation(t, settings, calib, 'ambiguous overlap');
    if (assignment.id !== this.trackId) {
      // New identity on this side: clear per-track temporal state, keep the output for blending.
      this.trackId = assignment.id;
      this.ratioEma = null;
      this._resetFilters();
      this.prevJoints = null;
      this.prevWrist = null;
    }
    if (t - this.lastSeen > 0.3) this._resetFilters();

    toCanonicalPoints(det.world, this.Praw);
    const v = this._validate(det, this.Praw);
    if (!v.ok) return this.noObservation(t, settings, calib, v.reason);

    // Position filtering (time-aware) on a copy; calibration uses unfiltered points.
    const params = smoothingParams(settings.smoothing);
    for (let i = 0; i < 21; i++) this.Praw[i].toArray(this.flat, i * 3);
    this.lmFilter.filter(this.flat, t, params && params.pos);
    for (let i = 0; i < 21; i++) this.P[i].fromArray(this.flat, i * 3);

    const neutral = calib?.neutral || null;
    const raw = solveRaw(this.P, this.side, neutral?.thumbRestDir || null, { thumbTwist: settings.thumbTwist }, this.raw);
    if (raw.palmQuality < 0.15) return this.noObservation(t, settings, calib, 'degenerate palm frame');

    // Outlier rejection: implausibly fast wrist flips are rejected for up to 2 frames.
    if (this.prevWrist && t - this.lastSeen < 0.15) {
      const jump = quatAngle(raw.hand, this.prevWrist);
      if (jump > 100 * DEG && this.rejectCount < 2) {
        this.rejectCount++;
        return this.noObservation(t, settings, calib, 'rejected outlier');
      }
    }
    this.rejectCount = 0;

    const pose = newHandPose(this.side);
    pose.id = assignment.id;
    pose.observed = true;
    pose.handednessScore = det.score ?? null;
    pose.stability = v.stability;
    rawToJoints(raw, neutral, pose.joints, this.prevJoints, pose.fingerValid);
    for (let k = 0; k < 5; k++) {
      if (!v.fingerOk[k] && this.prevJoints) {
        // Finger proportions implausible this frame: keep its previous rotations.
        const joints = k === 0 ? [0, 1, 2] : [k * 3, k * 3 + 1, k * 3 + 2];
        for (const j of joints) for (let c = 0; c < 4; c++) pose.joints[j * 4 + c] = this.prevJoints[j * 4 + c];
        pose.fingerValid[k] = 0;
      }
    }
    raw.hand.toArray(pose.wrist);

    // Rotation filtering (quaternion-safe, time-aware).
    const rp = params && params.rot;
    _qa.fromArray(pose.wrist);
    this.rotFilters[0].filter(_qa, t, rp).toArray(pose.wrist);
    for (let i = 0; i < 15; i++) {
      readQuat(pose.joints, i, _qa);
      writeQuat(pose.joints, i, this.rotFilters[i + 1].filter(_qa, t, rp));
    }

    if (settings.rootPolicy === 'approx-screen') {
      const r = approxRoot(det, settings.hfov);
      if (r) {
        const arr = r.toArray(new Float32Array(3));
        this.rootFilter.filter(arr, t, params && params.pos);
        pose.root = arr;
      }
    }
    if (settings.recordRaw) pose.raw = { image: Float32Array.from(det.image), world: Float32Array.from(det.world), label: det.label, score: det.score };

    this.prevJoints = Float32Array.from(pose.joints);
    this.prevWrist = raw.hand.clone();
    this.lastSample = { t, P: this.Praw.map((p) => p.clone()), det, palmQuality: raw.palmQuality };

    // Continuity on resume.
    let out = pose;
    if (this.mode !== 'tracked' && this.mode !== 'resuming' && this.lastOut) {
      this.mode = 'resuming';
      this.resumeFrom = cloneHandPose(this.lastOut);
      this.resumeStart = t;
    }
    if (this.mode === 'resuming') {
      const w = (t - this.resumeStart) / settings.resumeTime;
      if (w >= 1) this.mode = 'tracked';
      else {
        out = blendPose(this.resumeFrom, pose, smoothstep(0, 1, w), cloneHandPose(pose));
        out.status = 'resuming';
      }
    } else this.mode = 'tracked';
    if (this.mode === 'tracked') out.status = 'tracked';
    this.lastSeen = t;
    this.lastLive = pose;
    this.lastOut = out;
    this.heldFrom = null;
    return out;
  }

  // No usable observation this frame: hold, then blend toward the neutral pose.
  noObservation(t, settings, calib, reason = 'not detected') {
    this.lastSample = null;
    if (!this.lastOut) return null; // never seen: nothing to drive
    if (!this.heldFrom) this.heldFrom = cloneHandPose(this.lastOut);
    const gap = t - this.lastSeen;
    let out;
    if (gap <= settings.holdTime) {
      out = cloneHandPose(this.heldFrom);
      out.status = 'held';
      this.mode = 'held';
    } else {
      const target = cloneHandPose(this.heldFrom);
      target.joints = Float32Array.from(settings.lossPose === 'rest' ? REST : RELAXED);
      if (calib?.wrist) target.wrist = Float32Array.from(calib.wrist);
      target.root = calib?.rootRef ? Float32Array.from(calib.rootRef) : this.heldFrom.root;
      const w = settings.blendTime > 0 ? (gap - settings.holdTime) / settings.blendTime : 1;
      if (w >= 1) {
        out = target;
        out.status = 'lost';
        this.mode = 'lost';
      } else {
        out = blendPose(this.heldFrom, target, smoothstep(0, 1, w), cloneHandPose(this.heldFrom));
        out.status = 'blending';
        this.mode = 'blending';
      }
    }
    out.observed = false;
    out.handednessScore = null;
    out.stability = null;
    out.raw = null;
    out.lossReason = reason;
    this.lastOut = out;
    return out;
  }
}
