// Anatomical hand template, shared frame construction and forward kinematics.
//
// The solver (solver.js), the built-in rig (rigs.js) and the synthetic test fixtures all use the
// frame helpers in this file, so "solve(FK(angles)) == angles" is exact by construction and is
// verified in tests/run.mjs.
import { Vector3, Quaternion } from 'three';
import { FINGERS, FINGER_BASE } from './canonical.js';
import { frameFromYZ, newFrame, quatFromFrame, frameFromQuat, toLocal, safeNormalize, Y_AXIS, Z_AXIS, quatX, quatZ } from './math.js';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _y = new Vector3();
const _n = new Vector3();

// ---------------------------------------------------------------------------------------------
// Palm frame from landmarks 0 (wrist), 5, 9, 13, 17 (index/middle/ring/pinky MCP).
// side: 'left' | 'right'. Points may be in any right-handed space; the frame is returned in it.
// Returns quality in [0,1] (|across x distal|); < 0.15 means the frame is unreliable.
export function palmFrame(P, side, out) {
  const w = P[0];
  _y.set(0, 0, 0)
    .addScaledVector(_a.subVectors(P[9], w), 0.5)
    .addScaledVector(_b.subVectors(P[5], w), 0.25)
    .addScaledVector(_c.subVectors(P[13], w), 0.25);
  const okY = safeNormalize(_y, Y_AXIS, 1e-5);
  _a.subVectors(P[5], P[17]); // little finger -> index (radial direction)
  const okA = safeNormalize(_a, out.x, 1e-5);
  _n.crossVectors(_a, _y); // = palmar for a right hand
  const quality = okY && okA ? _n.length() : 0;
  if (quality < 1e-6) _n.copy(out.z).multiplyScalar(side === 'left' ? -1 : 1); // keep previous
  if (side === 'left') _n.negate();
  safeNormalize(_n, out.z);
  out.y.copy(_y);
  out.z.copy(_n);
  out.x.crossVectors(out.y, out.z).normalize();
  out.y.crossVectors(out.z, out.x).normalize();
  return quality;
}

// Rest frame of a non-thumb finger's proximal bone, in hand-local coordinates:
// +Y = metacarpal direction (wrist->MCP) projected onto the palm plane, +Z = palm normal.
export function fingerRestFrame(mcpLocal, out) {
  _a.set(mcpLocal.x, mcpLocal.y, 0);
  safeNormalize(_a, Y_AXIS);
  return frameFromYZ(_a, Z_AXIS, out);
}

// Rest frame of the thumb metacarpal, in hand-local coordinates:
// +Y = rest direction, +Z = palm normal made perpendicular, fallback toward -X/+Y if degenerate.
const THUMB_Z_FALLBACK = new Vector3(0, 0.3, 1).normalize();
export function thumbRestFrame(restDir, out) {
  return frameFromYZ(restDir, Z_AXIS, out, THUMB_Z_FALLBACK);
}

// Compose frames: out = f rotated by local rotation q (q expressed in f's own axes).
const _qf = new Quaternion();
export function composeFrame(f, q, out) {
  quatFromFrame(f, _qf).multiply(q);
  return frameFromQuat(_qf, out);
}

// ---------------------------------------------------------------------------------------------
// Template (right hand, metres). Built raw, then re-expressed in its own palm frame so the
// template's axes are exactly the axes palmFrame() reports for it.
const RAW = {
  mcp: { index: [0.027, 0.088, 0], middle: [0.006, 0.093, 0], ring: [-0.014, 0.088, 0], pinky: [-0.031, 0.079, 0] },
  len: { index: [0.041, 0.025, 0.021], middle: [0.045, 0.028, 0.022], ring: [0.042, 0.027, 0.021], pinky: [0.033, 0.02, 0.019], thumb: [0.04, 0.032, 0.027] },
  thumbCmc: [0.022, 0.026, 0.008],
  thumbDir: [0.6, 0.74, 0.3],
};

function buildRawRight() {
  const P = Array.from({ length: 21 }, () => new Vector3());
  P[0].set(0, 0, 0);
  for (const f of FINGERS.slice(1)) {
    const b = FINGER_BASE[f];
    P[b].fromArray(RAW.mcp[f]);
    const d = new Vector3(P[b].x, P[b].y, 0).normalize();
    for (let s = 0; s < 3; s++) P[b + s + 1].copy(P[b + s]).addScaledVector(d, RAW.len[f][s]);
  }
  P[1].fromArray(RAW.thumbCmc);
  const td = new Vector3().fromArray(RAW.thumbDir).normalize();
  for (let s = 0; s < 3; s++) P[2 + s].copy(P[1 + s]).addScaledVector(td, RAW.len.thumb[s]);
  return P;
}

function canonicalize(P, side) {
  const f = newFrame();
  palmFrame(P, side, f);
  const w = P[0].clone();
  return P.map((p) => toLocal(f, p.clone().sub(w)));
}

const RIGHT = canonicalize(buildRawRight(), 'right');
const LEFT = RIGHT.map((p) => new Vector3(-p.x, p.y, p.z));

export const TEMPLATE = Object.freeze({ right: RIGHT, left: LEFT });

export function templateLocal(side) {
  return TEMPLATE[side];
}
export function templateThumbDir(side) {
  const T = TEMPLATE[side];
  return new Vector3().subVectors(T[2], T[1]).normalize();
}
export function templatePalmLength(side = 'right') {
  const T = TEMPLATE[side];
  return T[9].distanceTo(T[0]);
}
export function segmentLengths(P) {
  // 20 segment lengths in MediaPipe connection order (per finger chain from wrist).
  const out = [];
  for (const f of FINGERS) {
    const b = FINGER_BASE[f];
    out.push(P[b].distanceTo(P[0]));
    for (let s = 0; s < 3; s++) out.push(P[b + s + 1].distanceTo(P[b + s]));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Forward kinematics in hand-local coordinates.
// pose = {
//   fingers: { index: {flex1, spread, flex2, flex3}, middle, ring, pinky }  (radians, raw angles)
//   thumb: { d1: Quaternion (in thumb rest frame), s2: Quaternion (in bone-1 frame), s3: Quaternion (in bone-2 frame) }
//   thumbRestDir?: Vector3 (hand-local) — defaults to the template rest direction
// }
// Returns 21 hand-local positions (wrist at origin) using template bone lengths.
// If `frames` is given, it is filled with hand-local canonical bone frames (Quaternion) per joint.
export function fkHandLocal(side, pose, out = Array.from({ length: 21 }, () => new Vector3()), frames = null) {
  const rec = (name, f) => frames && (frames[name] = quatFromFrame(f));
  const T = TEMPLATE[side];
  out[0].set(0, 0, 0);
  const F0 = newFrame(), B = newFrame();
  const q = new Quaternion(), qx = new Quaternion();
  for (const f of FINGERS.slice(1)) {
    const b = FINGER_BASE[f];
    const a = pose.fingers?.[f] || { flex1: 0, spread: 0, flex2: 0, flex3: 0 };
    out[b].copy(T[b]);
    fingerRestFrame(T[b], F0);
    composeFrame(F0, quatZ(a.spread, q).multiply(quatX(a.flex1, qx)), B);
    rec(f + '1', B);
    const L = [T[b + 1].distanceTo(T[b]), T[b + 2].distanceTo(T[b + 1]), T[b + 3].distanceTo(T[b + 2])];
    out[b + 1].copy(out[b]).addScaledVector(B.y, L[0]);
    composeFrame(B, quatX(a.flex2, q), B);
    rec(f + '2', B);
    out[b + 2].copy(out[b + 1]).addScaledVector(B.y, L[1]);
    composeFrame(B, quatX(a.flex3, q), B);
    rec(f + '3', B);
    out[b + 3].copy(out[b + 2]).addScaledVector(B.y, L[2]);
  }
  const th = pose.thumb || {};
  const restDir = pose.thumbRestDir || templateThumbDir(side);
  out[1].copy(T[1]);
  thumbRestFrame(restDir, F0);
  const LT = [T[2].distanceTo(T[1]), T[3].distanceTo(T[2]), T[4].distanceTo(T[3])];
  composeFrame(F0, th.d1 || new Quaternion(), B);
  rec('thumb1', B);
  out[2].copy(out[1]).addScaledVector(B.y, LT[0]);
  composeFrame(B, th.s2 || new Quaternion(), B);
  rec('thumb2', B);
  out[3].copy(out[2]).addScaledVector(B.y, LT[1]);
  composeFrame(B, th.s3 || new Quaternion(), B);
  rec('thumb3', B);
  out[4].copy(out[3]).addScaledVector(B.y, LT[2]);
  return out;
}

// Hand-local -> canonical world: P = wristPos + H * local
export function localToWorld(local, H, wristPos) {
  return local.map((p) => p.clone().applyQuaternion(H).add(wristPos));
}

// Canonical world -> MediaPipe-style outputs from a pinhole camera at the canonical origin
// looking down -Z (hfov in radians, image size w x h pixels). Used only by synthetic fixtures.
export function toMediaPipe(worldPts, { width = 640, height = 480, hfov = 60 * Math.PI / 180 } = {}) {
  const f = width / 2 / Math.tan(hfov / 2);
  const center = new Vector3();
  for (const i of [0, 5, 9, 13, 17]) center.add(worldPts[i]);
  center.multiplyScalar(1 / 5);
  const image = new Float32Array(63);
  const world = new Float32Array(63);
  const zw = -worldPts[0].z;
  worldPts.forEach((p, i) => {
    const xc = p.x, yc = -p.y, zc = -p.z; // camera coords (x right, y down, z forward)
    image[i * 3] = (width / 2 + (f * xc) / zc) / width;
    image[i * 3 + 1] = (height / 2 + (f * yc) / zc) / height;
    image[i * 3 + 2] = ((zc - zw) * f) / (zc * width);
    world[i * 3] = p.x - center.x;
    world[i * 3 + 1] = -(p.y - center.y);
    world[i * 3 + 2] = -(p.z - center.z);
  });
  return { image, world, width, height };
}
