// Small numerically-guarded helpers on top of three.js math classes.
import { Vector3, Quaternion, Matrix4 } from 'three';

export const DEG = Math.PI / 180;
export const X_AXIS = Object.freeze(new Vector3(1, 0, 0));
export const Y_AXIS = Object.freeze(new Vector3(0, 1, 0));
export const Z_AXIS = Object.freeze(new Vector3(0, 0, 1));

const _m = new Matrix4();
const _v = new Vector3();
const _q = new Quaternion();
const IDENTITY = Object.freeze(new Quaternion());

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export const isFiniteQuat = (q) =>
  Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);

// Normalise v in place; if it is too short or non-finite, copy `fallback` instead.
// Returns true when v was usable.
export function safeNormalize(v, fallback, minLen = 1e-8) {
  const l = v.length();
  if (!(l > minLen) || !Number.isFinite(l)) {
    v.copy(fallback);
    return false;
  }
  v.multiplyScalar(1 / l);
  return true;
}

// Right-handed orthonormal frame from a primary +Y direction and a +Z hint.
// The hint is made perpendicular to y; if it is (nearly) parallel to y, `zFallback` is used.
// Returns a "quality" number in [0,1]: |hint perpendicular component| of the original hint
// (before any fallback), so callers can tell when the frame is ill-conditioned.
export function frameFromYZ(y, zHint, out, zFallback = null) {
  out.y.copy(y);
  safeNormalize(out.y, Y_AXIS);
  out.z.copy(zHint).addScaledVector(out.y, -zHint.dot(out.y));
  const quality = out.z.length(); // reported before any fallback
  if (quality < 0.2 && zFallback) {
    const alt = _v.copy(zFallback).addScaledVector(out.y, -zFallback.dot(out.y));
    if (alt.length() > quality) out.z.copy(alt);
  }
  if (out.z.length() < 1e-6) {
    // Last resort: any perpendicular.
    out.z.set(out.y.y, out.y.z, out.y.x).cross(out.y);
  }
  out.z.normalize();
  out.x.crossVectors(out.y, out.z).normalize();
  out.z.crossVectors(out.x, out.y).normalize();
  return quality;
}

export function newFrame() {
  return { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };
}

export function quatFromFrame(f, out = new Quaternion()) {
  _m.makeBasis(f.x, f.y, f.z);
  return out.setFromRotationMatrix(_m).normalize();
}

export function frameFromQuat(q, out = newFrame()) {
  out.x.set(1, 0, 0).applyQuaternion(q);
  out.y.set(0, 1, 0).applyQuaternion(q);
  out.z.set(0, 0, 1).applyQuaternion(q);
  return out;
}

// Express a world vector in a frame's local coordinates.
export function toLocal(f, v, out = new Vector3()) {
  return out.set(v.dot(f.x), v.dot(f.y), v.dot(f.z));
}

// Angle between two rotations (radians, 0..pi), sign-invariant. Uses atan2 of the relative
// rotation (a^-1 b) instead of acos(dot), which loses precision near zero.
export function quatAngle(a, b) {
  const w = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  const x = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y;
  const y = a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x;
  const z = a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w;
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w));
}

export function quatRotationAngle(q) {
  return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w));
}

// Flip q to the same hemisphere as ref (q and -q are the same rotation).
export function alignSign(q, ref) {
  if (q.x * ref.x + q.y * ref.y + q.z * ref.z + q.w * ref.w < 0) {
    q.x = -q.x;
    q.y = -q.y;
    q.z = -q.z;
    q.w = -q.w;
  }
  return q;
}

// Limit the rotation angle of q (in place) by scaling it toward identity along the same axis.
export function clampQuatAngle(q, maxAngle) {
  if (q.w < 0) alignSign(q, IDENTITY);
  const a = quatRotationAngle(q);
  if (a > maxAngle && a > 1e-9) q.slerpQuaternions(IDENTITY, _q.copy(q), maxAngle / a);
  return q;
}

export const quatX = (a, out = new Quaternion()) => out.setFromAxisAngle(X_AXIS, a);
export const quatY = (a, out = new Quaternion()) => out.setFromAxisAngle(Y_AXIS, a);
export const quatZ = (a, out = new Quaternion()) => out.setFromAxisAngle(Z_AXIS, a);

// Minimal rotation taking unit vector a to unit vector b. three.js handles the antiparallel
// case by choosing an arbitrary perpendicular axis; callers clamp the result anyway.
export function swing(a, b, out = new Quaternion()) {
  return out.setFromUnitVectors(a, b);
}

// Sign-aligned normalised mean (fine for clustered rotations such as calibration samples).
export function averageQuats(list, out = new Quaternion()) {
  if (!list.length) return out.identity();
  let x = 0, y = 0, z = 0, w = 0;
  const ref = list[0];
  for (const q of list) {
    const s = q.x * ref.x + q.y * ref.y + q.z * ref.z + q.w * ref.w < 0 ? -1 : 1;
    x += s * q.x; y += s * q.y; z += s * q.z; w += s * q.w;
  }
  out.set(x, y, z, w);
  if (out.length() < 1e-9) return out.copy(ref);
  return out.normalize();
}

// Pack / unpack helpers for Float32Array quaternion storage.
export function readQuat(arr, i, out = new Quaternion()) {
  return out.set(arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3]);
}
export function writeQuat(arr, i, q) {
  arr[i * 4] = q.x;
  arr[i * 4 + 1] = q.y;
  arr[i * 4 + 2] = q.z;
  arr[i * 4 + 3] = q.w;
}
