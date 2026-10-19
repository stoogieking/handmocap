// Synthetic landmark fixtures (clearly NOT camera data). Used by tests and to generate the
// example recording. Poses are produced with the same forward kinematics the solver inverts.
import { Vector3, Quaternion, Euler } from 'three';
import { fkHandLocal, localToWorld, toMediaPipe } from '../src/handmodel.js';
import { THUMB_TWIST_SIGN } from '../src/solver.js';
import { DEG, smoothstep, quatY, Y_AXIS } from '../src/math.js';

export const GESTURES = {
  open: { f: [0, 0, 0, 0], spread: [0, 0, 0, 0], thumb: [0, 0, 0, 0, 0] },
  fist: { f: [85, 100, 60], spread: [0, 0, 0, 0], thumb: [-0.55, 0.45, 0.7, 35, 45] },
  point: { f: [80, 100, 60], index: [0, 0, 0], spread: [0, 0, 0, 0], thumb: [-0.5, 0.5, 0.7, 30, 40] },
  spread: { f: [0, 0, 0], spread: [-14, -3, 6, 16], thumb: [0.35, 0.9, -0.1, 0, 0] },
  pinch: { f: [20, 30, 15], index: [35, 40, 20], spread: [0, 0, 0, 0], thumb: [-0.35, 0.65, 0.65, 15, 15] },
};

// thumb: [ex, ey, ez, mcpDeg, ipDeg] metacarpal direction in rest frame + bend angles
export function gesturePose(name, side = 'right') {
  const g = GESTURES[name];
  const fingers = {};
  ['index', 'middle', 'ring', 'pinky'].forEach((f, i) => {
    const a = f === 'index' && g.index ? g.index : g.f;
    fingers[f] = { flex1: (a[0] || 0) * DEG, spread: (g.spread[i] || 0) * DEG, flex2: (a[1] || 0) * DEG, flex3: (a[2] || 0) * DEG };
  });
  const [ex, ey, ez, mcp, ip] = g.thumb;
  const thumb = thumbFromDir(new Vector3(ex, ey || 1, ez), mcp * DEG, ip * DEG);
  return { fingers, thumb };
}

// Thumb local rotations consistent with the solver's twist model.
export function thumbFromDir(eDir, mcpRad, ipRad, twistMax = 30 * DEG) {
  const e = eDir.clone().normalize();
  const d1 = new Quaternion().setFromUnitVectors(Y_AXIS, e);
  const opp = smoothstep(0.05, 0.7, e.z);
  d1.multiply(quatY(THUMB_TWIST_SIGN * twistMax * opp));
  // Bend the MCP/IP toward the local palmar-ulnar direction (pure swings, as the solver measures).
  const bendAxis = new Vector3(1, 0, 1).normalize();
  const s2 = new Quaternion().setFromAxisAngle(bendAxis, mcpRad);
  const s3 = new Quaternion().setFromAxisAngle(bendAxis, ipRad);
  return { d1, s2, s3 };
}

export function lerpPose(a, b, t) {
  const fingers = {};
  for (const f of Object.keys(a.fingers)) {
    fingers[f] = {};
    for (const k of ['flex1', 'spread', 'flex2', 'flex3']) fingers[f][k] = a.fingers[f][k] + (b.fingers[f][k] - a.fingers[f][k]) * t;
  }
  return {
    fingers,
    thumb: {
      d1: a.thumb.d1.clone().slerp(b.thumb.d1, t),
      s2: a.thumb.s2.clone().slerp(b.thumb.s2, t),
      s3: a.thumb.s3.clone().slerp(b.thumb.s3, t),
    },
  };
}

// Canonical-world landmarks for a pose with hand orientation H at wristPos.
export function worldLandmarks(side, pose, H, wristPos) {
  return localToWorld(fkHandLocal(side, pose), H, wristPos);
}

// A MediaPipe-like detection object (what tracking.js hands to the pipeline).
// labelConvention 'reported' emits the anatomical label (what Tasks Vision 1.0.1 was observed to
// report for unmirrored frames); 'swap' emits the opposite label (legacy mirrored-input semantics).
export function detection(side, pose, H, wristPos, { noise = 0, rand = Math.random, score = 0.97, labelConvention = 'reported', width = 640, height = 480 } = {}) {
  const P = worldLandmarks(side, pose, H, wristPos);
  if (noise > 0) for (const p of P) p.add(new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(2 * noise));
  const mp = toMediaPipe(P, { width, height });
  const anatomical = side === 'right' ? 'Right' : 'Left';
  const reported = labelConvention === 'swap' ? (side === 'right' ? 'Left' : 'Right') : anatomical;
  return { image: mp.image, world: mp.world, label: reported, score, width, height };
}

// Hand orientation helpers: palm facing camera, fingers up, then rotated.
export function handQuat(side, { yaw = 0, pitch = 0, roll = 0 } = {}) {
  return new Quaternion().setFromEuler(new Euler(pitch * DEG, yaw * DEG, roll * DEG, 'YXZ'));
}

export const DEFAULT_WRIST = { right: new Vector3(-0.12, -0.05, -0.55), left: new Vector3(0.12, -0.05, -0.55) };
