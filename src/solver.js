// Layer 4: canonical hand-pose solver.
//
// Input : 21 conditioned landmarks in canonical world (metres) + anatomical side.
// Output: wrist orientation (absolute) and 15 rest-relative joint rotations (see canonical.js).
//
// Method
//  1. Palm frame from wrist + four MCP landmarks (palmFrame). Its +Z sign comes from the
//     anatomical side, so a wrong handedness label would mirror the frame; calibration checks
//     this (palm must face the camera in the neutral pose).
//  2. Landmarks are expressed in the palm frame ("hand-local").
//  3. Index..pinky: the proximal bone is decomposed as  Rz(spread) * Rx(flex) relative to the
//     metacarpal direction projected on the palm plane (2 DOF, no twist: twist is not observable
//     from landmarks). Middle and distal bones are 1-DOF hinges about the parent bone's +X.
//     Spread is attenuated as the finger flexes toward the palm normal, where it is ill-defined.
//  4. Thumb: the metacarpal gets a full 2-DOF swing from its calibrated rest direction plus a
//     separately modelled axial twist coupled to opposition (palmar swing); MCP and IP are
//     minimal swings (no assumed hinge axis, which differs between people and rigs).
//  5. Calibration offsets (neutral open hand) are removed; anatomical limits are applied to the
//     resulting deltas. Child frames are always built from the raw parent rotation, so
//     limits on one joint never corrupt the measurement of the next.
import { Vector3, Quaternion } from 'three';
import { FINGERS, FINGER_BASE, JOINT_INDEX } from './canonical.js';
import { palmFrame, fingerRestFrame, thumbRestFrame, composeFrame, templateThumbDir } from './handmodel.js';
import { newFrame, quatFromFrame, toLocal, safeNormalize, clamp, smoothstep, quatX, quatY, quatZ, swing, clampQuatAngle, writeQuat, DEG, Y_AXIS } from './math.js';

export const LIMITS = {
  mcpFlex: [-35 * DEG, 100 * DEG],
  spread: [-30 * DEG, 30 * DEG],
  pip: [-10 * DEG, 115 * DEG],
  dip: [-15 * DEG, 95 * DEG],
  thumb1: 80 * DEG,
  thumb2: 85 * DEG,
  thumb3: 95 * DEG,
};

// Sign of the modelled thumb axial rotation (pronation) during opposition, in the canonical
// thumb frame. In opposition the thumbnail turns from facing radially (+X of the thumb frame) to
// facing palmar (+Z): X -> Z is a negative rotation about +Y. Left hands get the mirrored
// physical rotation automatically through the frame convention. Checked in tests.
export const THUMB_TWIST_SIGN = -1;

const _d = new Vector3();
const _e = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();

export function newRaw() {
  return {
    palmQuality: 0,
    hand: new Quaternion(),
    local: Array.from({ length: 21 }, () => new Vector3()),
    fingers: Object.fromEntries(
      FINGERS.slice(1).map((f) => [f, { flex1: 0, spread: 0, spreadWeight: 1, flex2: 0, flex3: 0, ok: true }]),
    ),
    thumb: { dir1: new Vector3(), d1: new Quaternion(), s2: new Quaternion(), s3: new Quaternion(), opposition: 0, ok: true },
  };
}

const HF = newFrame(), F0 = newFrame(), B1 = newFrame(), B2 = newFrame(), T0 = newFrame();

// P: 21 Vector3 (canonical world). Returns raw anatomical measurements (no calibration).
// thumbRestDir: hand-local unit vector (calibrated) or null for the template direction.
export function solveRaw(P, side, thumbRestDir, opts, out = newRaw()) {
  out.palmQuality = palmFrame(P, side, HF);
  quatFromFrame(HF, out.hand);
  for (let i = 0; i < 21; i++) toLocal(HF, _d.subVectors(P[i], P[0]), out.local[i]);
  const L = out.local;

  for (const f of FINGERS.slice(1)) {
    const b = FINGER_BASE[f];
    const r = out.fingers[f];
    r.ok = true;
    fingerRestFrame(L[b], F0);
    _d.subVectors(L[b + 1], L[b]);
    if (!safeNormalize(_d, Y_AXIS, 1e-5)) r.ok = false;
    toLocal(F0, _d, _e);
    r.flex1 = Math.asin(clamp(_e.z, -1, 1));
    const planar = Math.hypot(_e.x, _e.y);
    r.spread = planar > 1e-4 ? Math.atan2(-_e.x, _e.y) : 0;
    r.spreadWeight = smoothstep(0.3, 0.7, planar);
    composeFrame(F0, quatZ(r.spread, _q).multiply(quatX(r.flex1, _q2)), B1);
    r.flex2 = hinge(L[b + 1], L[b + 2], B1, r);
    composeFrame(B1, quatX(r.flex2, _q), B2);
    r.flex3 = hinge(L[b + 2], L[b + 3], B2, r);
  }

  // Thumb.
  const t = out.thumb;
  t.ok = true;
  const restDir = thumbRestDir || templateThumbDir(side);
  thumbRestFrame(restDir, T0);
  _d.subVectors(L[2], L[1]);
  if (!safeNormalize(_d, restDir, 1e-5)) t.ok = false;
  t.dir1.copy(_d);
  toLocal(T0, _d, _e); // metacarpal direction in rest frame
  swing(Y_AXIS, _e, t.d1);
  t.opposition = smoothstep(0.05, 0.7, _e.z);
  const twist = THUMB_TWIST_SIGN * (opts?.thumbTwist ?? 30 * DEG) * t.opposition;
  t.d1.multiply(quatY(twist, _q));
  composeFrame(T0, t.d1, B1);
  _d.subVectors(L[3], L[2]);
  if (!safeNormalize(_d, B1.y, 1e-5)) t.ok = false;
  swing(Y_AXIS, toLocal(B1, _d, _e), t.s2);
  composeFrame(B1, t.s2, B2);
  _d.subVectors(L[4], L[3]);
  if (!safeNormalize(_d, B2.y, 1e-5)) t.ok = false;
  swing(Y_AXIS, toLocal(B2, _d, _e), t.s3);
  return out;
}

// Hinge angle of segment a->b about the parent frame's +X axis.
function hinge(a, b, parent, r) {
  _d.subVectors(b, a);
  safeNormalize(_d, parent.y, 1e-5);
  const y = _d.dot(parent.y), z = _d.dot(parent.z);
  if (Math.hypot(y, z) < 0.3) r.ok = false; // segment mostly sideways: unreliable
  return Math.atan2(z, y);
}

// Neutral (calibration) data for one hand; zeros/identity = uncalibrated.
export function defaultNeutral() {
  return {
    fingers: Object.fromEntries(FINGERS.slice(1).map((f) => [f, { flex1: 0, spread: 0, flex2: 0, flex3: 0 }])),
    thumbRestDir: null, // Vector3 or null
    n2: new Quaternion(),
    n3: new Quaternion(),
  };
}

// Convert raw measurements into canonical rest-relative joint rotations (Float32Array(60)).
// `prevJoints` supplies values for fingers flagged unreliable this frame.
export function rawToJoints(raw, neutral, out, prevJoints = null, fingerValid = null) {
  const n = neutral || defaultNeutral();
  for (const f of FINGERS.slice(1)) {
    const r = raw.fingers[f];
    const nf = n.fingers[f];
    const i1 = JOINT_INDEX[f + '1'];
    if (!r.ok && prevJoints) {
      for (let k = 0; k < 12; k++) out[i1 * 4 + k] = prevJoints[i1 * 4 + k];
      if (fingerValid) fingerValid[FINGERS.indexOf(f)] = 0;
      continue;
    }
    if (fingerValid) fingerValid[FINGERS.indexOf(f)] = r.ok ? 1 : 0;
    const flex1 = clamp(r.flex1 - nf.flex1, ...LIMITS.mcpFlex);
    const spread = clamp((r.spread - nf.spread) * r.spreadWeight, ...LIMITS.spread);
    const flex2 = clamp(r.flex2 - nf.flex2, ...LIMITS.pip);
    const flex3 = clamp(r.flex3 - nf.flex3, ...LIMITS.dip);
    writeQuat(out, i1, quatZ(spread, _q).multiply(quatX(flex1, _q2)));
    writeQuat(out, i1 + 1, quatX(flex2, _q));
    writeQuat(out, i1 + 2, quatX(flex3, _q));
  }
  const t = raw.thumb;
  const i1 = JOINT_INDEX.thumb1;
  if (!t.ok && prevJoints) {
    for (let k = 0; k < 12; k++) out[i1 * 4 + k] = prevJoints[i1 * 4 + k];
    if (fingerValid) fingerValid[0] = 0;
  } else {
    if (fingerValid) fingerValid[0] = t.ok ? 1 : 0;
    writeQuat(out, i1, clampQuatAngle(_q.copy(t.d1), LIMITS.thumb1));
    writeQuat(out, i1 + 1, clampQuatAngle(_q.copy(n.n2).invert().multiply(t.s2), LIMITS.thumb2));
    writeQuat(out, i1 + 2, clampQuatAngle(_q.copy(n.n3).invert().multiply(t.s3), LIMITS.thumb3));
  }
  return out;
}
