// Layer 7a: timestamped canonical-motion recording, interpolation and resampling.
// Frames are stored with the tracker's sample timestamps (camera capture time), so recording is
// independent of render frame rate. Playback/scrubbing interpolates between samples.
import { Quaternion } from 'three';
import { cloneHandPose, cloneFrame, CANONICAL_SCHEMA, CANONICAL_VERSION, RAW_SCHEMA, RAW_VERSION, CONVENTIONS, FINGER_JOINTS, SIDES } from './canonical.js';
import { alignSign } from './math.js';
import { calibrationToJSON, calibrationFromJSON } from './calibration.js';

const _a = new Quaternion(), _b = new Quaternion();
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export class Recording {
  constructor(meta = {}) {
    this.frames = [];
    this.meta = { source: 'webcam', ...meta };
    this.t0 = null;
  }

  get duration() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  // frame.t is the absolute sample time (s); stored relative to the first frame.
  push(frame) {
    if (this.t0 === null) this.t0 = frame.t;
    const f = cloneFrame(frame);
    f.t = frame.t - this.t0;
    if (this.frames.length && f.t <= this.frames[this.frames.length - 1].t) return false; // monotonic only
    this.frames.push(f);
    return true;
  }

  // Interpolated frame at time t (seconds from start).
  sampleAt(t) {
    const F = this.frames;
    if (!F.length) return null;
    if (t <= F[0].t) return cloneFrame(F[0]);
    if (t >= F[F.length - 1].t) return cloneFrame(F[F.length - 1]);
    let lo = 0, hi = F.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (F[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const f0 = F[lo], f1 = F[hi];
    const w = (t - f0.t) / (f1.t - f0.t);
    const out = { t, hands: {} };
    for (const side of SIDES) {
      const a = f0.hands[side], b = f1.hands[side];
      if (a && b) out.hands[side] = interpHand(a, b, w);
      else out.hands[side] = cloneHandPose(w < 0.5 ? a : b);
    }
    return out;
  }

  // Frames at i / fps for i = 0..floor(duration * fps) (timestamp-based resampling).
  resample(fps) {
    const n = Math.floor(this.duration * fps + 1e-9) + 1;
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.sampleAt(i / fps));
    // Quaternion sign continuity per channel.
    for (const side of SIDES) {
      let prev = null;
      for (const f of out) {
        const h = f.hands[side];
        if (!h) {
          prev = null;
          continue;
        }
        if (prev) {
          for (let j = 0; j < 15; j++) flipIfNeeded(h.joints, j, prev.joints);
          flipIfNeeded(h.wrist, 0, prev.wrist);
        }
        prev = h;
      }
    }
    return out;
  }

  // Versioned canonical-motion JSON. fps: resample rate or null to keep the original samples.
  toJSON({ fps = null, calibration = null, extra = {} } = {}) {
    const frames = fps ? this.resample(fps) : this.frames;
    return {
      schema: CANONICAL_SCHEMA,
      version: CANONICAL_VERSION,
      generator: 'HandMocap',
      createdAt: new Date().toISOString(),
      source: this.meta.source,
      note: 'Canonical hand motion for re-targeting with HandMocap or a custom importer. Not a standard mocap interchange format; use the GLB export for DCC tools and engines.',
      conventions: CONVENTIONS,
      joints: FINGER_JOINTS,
      sampling: fps ? { resampled: true, fps } : { resampled: false, note: 'original sample timestamps' },
      duration: r6(this.duration),
      settings: this.meta.settings || null,
      calibration: calibration ? { left: calibrationToJSON(calibration.left), right: calibrationToJSON(calibration.right) } : this.meta.calibration || null,
      confidenceFields: {
        handednessScore: 'MediaPipe handedness category score as returned by the API (null when not observed)',
        stability: 'HEURISTIC segment-proportion consistency in [0,1]; not an API confidence',
        status: 'tracked | resuming | held | blending | lost',
        observed: 'true when the sample came from a camera observation',
        fingerValid: '[thumb,index,middle,ring,pinky] 1 = measured this sample, 0 = held from previous',
      },
      ...extra,
      frames: frames.map((f) => ({
        t: r6(f.t),
        hands: Object.fromEntries(SIDES.map((s) => [s, handToJSON(f.hands[s])])),
      })),
    };
  }

  static fromJSON(obj) {
    if (!obj || obj.schema !== CANONICAL_SCHEMA) throw new Error('not a HandMocap canonical-motion file (schema mismatch)');
    if (obj.version !== CANONICAL_VERSION) throw new Error(`unsupported canonical-motion version ${obj.version}`);
    if (!Array.isArray(obj.frames) || !obj.frames.length) throw new Error('file contains no frames');
    const rec = new Recording({ source: obj.source || 'file', settings: obj.settings || null });
    rec.meta.calibrationJSON = obj.calibration || null;
    try {
      rec.meta.calibration = obj.calibration ? { left: calibrationFromJSON(obj.calibration.left), right: calibrationFromJSON(obj.calibration.right) } : null;
    } catch {
      rec.meta.calibration = null;
    }
    rec.t0 = 0;
    for (const f of obj.frames) {
      const frame = { t: f.t, hands: {} };
      for (const s of SIDES) frame.hands[s] = handFromJSON(f.hands?.[s], s);
      rec.frames.push(frame);
    }
    rec.frames.sort((a, b) => a.t - b.t);
    return rec;
  }

  // Raw landmark diagnostics (only frames recorded with raw capture enabled).
  rawToJSON() {
    const frames = this.frames
      .filter((f) => SIDES.some((s) => f.hands[s]?.raw))
      .map((f) => ({
        t: r6(f.t),
        hands: Object.fromEntries(
          SIDES.map((s) => {
            const r = f.hands[s]?.raw;
            return [s, r ? { label: r.label, score: r.score, image: Array.from(r.image, r6), world: Array.from(r.world, r6) } : null];
          }),
        ),
      }));
    return {
      schema: RAW_SCHEMA,
      version: RAW_VERSION,
      createdAt: new Date().toISOString(),
      note: 'Diagnostic MediaPipe Hand Landmarker output. image: normalised [0,1] x,y (unmirrored camera image, y down) and relative z; world: metres, origin near the hand centre, MediaPipe axes (x right, y down, z away). label = model handedness label as reported (MediaPipe documents it as assuming mirrored input). Hand-relative world landmarks are not a camera-global trajectory.',
      landmarkCount: 21,
      frames,
    };
  }

  hasRaw() {
    return this.frames.some((f) => SIDES.some((s) => f.hands[s]?.raw));
  }
}

function flipIfNeeded(arr, i, ref) {
  _a.fromArray(arr, i * 4);
  _b.fromArray(ref, i * 4);
  if (_a.dot(_b) < 0) for (let k = 0; k < 4; k++) arr[i * 4 + k] = -arr[i * 4 + k];
}

function interpHand(a, b, w) {
  const near = w < 0.5 ? a : b;
  const h = cloneHandPose(near);
  for (let j = 0; j < 15; j++) {
    _a.fromArray(a.joints, j * 4);
    _b.fromArray(b.joints, j * 4);
    alignSign(_b, _a);
    _a.slerp(_b, w).toArray(h.joints, j * 4);
  }
  _a.fromArray(a.wrist);
  _b.fromArray(b.wrist);
  alignSign(_b, _a);
  _a.slerp(_b, w).toArray(h.wrist);
  if (a.root && b.root) h.root = Float32Array.from(a.root, (v, k) => v + (b.root[k] - v) * w);
  h.raw = null;
  return h;
}

function handToJSON(h) {
  if (!h) return null;
  return {
    id: h.id,
    status: h.status,
    observed: h.observed,
    handednessScore: h.handednessScore == null ? null : r6(h.handednessScore),
    stability: h.stability == null ? null : r6(h.stability),
    wrist: Array.from(h.wrist, r6),
    joints: Array.from(h.joints, r6),
    root: h.root ? Array.from(h.root, r6) : null,
    fingerValid: h.fingerValid.slice(),
  };
}

function handFromJSON(j, side) {
  if (!j) return null;
  if (!Array.isArray(j.wrist) || j.wrist.length !== 4 || !Array.isArray(j.joints) || j.joints.length !== 60) throw new Error(`malformed ${side} hand sample`);
  return {
    side,
    id: j.id ?? null,
    status: j.status || 'tracked',
    observed: !!j.observed,
    handednessScore: j.handednessScore ?? null,
    stability: j.stability ?? null,
    wrist: Float32Array.from(j.wrist),
    joints: Float32Array.from(j.joints),
    root: j.root ? Float32Array.from(j.root) : null,
    fingerValid: j.fingerValid || [1, 1, 1, 1, 1],
    raw: null,
  };
}
