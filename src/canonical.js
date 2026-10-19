// Canonical hand-motion representation (layer 4 output, layer 6/7 input).
//
// COORDINATE CONVENTIONS (all canonical data)
//   World ("canonical world"): right-handed, metres, +Y up, +X = image right as seen by the
//   webcam (the performer's left), +Z = from the performer toward the webcam.
//   Conversion from MediaPipe (x right, y down, z away from camera):  (x, -y, -z).
//   A character standing in glTF convention (facing +Z) therefore faces the webcam, and its
//   right hand is on world -X, the same side as the performer's right hand.
//
//   Hand frame (wrist orientation): right-handed. +Y distal (wrist -> middle knuckles),
//   +Z palmar (out of the palm), +X = Y x Z. +X points toward the thumb on a right hand and
//   toward the little finger on a left hand (the frame stays right-handed; no mirroring).
//
//   Canonical bone frame (every finger bone): +Y along the bone toward its child, +Z the palm
//   normal made perpendicular to the bone, +X = Y x Z. Positive rotation about +X is flexion
//   for both hands. Positive rotation about +Z moves the bone toward -X (little-finger side on
//   a right hand, thumb side on a left hand).
//
//   Quaternions are stored [x, y, z, w] (glTF / three.js order).
//
// ROTATION SEMANTICS
//   wrist   : ABSOLUTE orientation of the hand frame in canonical world.
//   joints  : REST-RELATIVE local rotations. Each is expressed in the bone's own canonical frame
//             at the calibrated neutral pose (open hand), and composed parent -> child:
//               boneFrame = parentFrame * neutralOffset * delta
//             Identity everywhere == the performer's calibrated neutral open hand.
//   root    : approximate camera-space wrist-area position (metres, canonical world), or null.
//             Only meaningful when rootPolicy == 'approx-screen'. Not a measured trajectory.

export const CANONICAL_SCHEMA = 'handmocap.canonical-motion';
export const CANONICAL_VERSION = 1;
export const PROFILE_SCHEMA = 'handmocap.rig-profile';
export const PROFILE_VERSION = 1;
export const RAW_SCHEMA = 'handmocap.raw-landmarks';
export const RAW_VERSION = 1;

export const SIDES = ['left', 'right'];
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const FINGER_BASE = { thumb: 1, index: 5, middle: 9, ring: 13, pinky: 17 };

// 16 canonical joints. `from`/`to` are MediaPipe landmark indices: the bone pivots at `from`
// and points to `to`.
export const JOINT_INFO = {
  wrist: { parent: null, finger: null, seg: 0, from: 0, to: 9 },
  thumb1: { parent: 'wrist', finger: 'thumb', seg: 1, from: 1, to: 2 }, // CMC (metacarpal)
  thumb2: { parent: 'thumb1', finger: 'thumb', seg: 2, from: 2, to: 3 }, // MCP
  thumb3: { parent: 'thumb2', finger: 'thumb', seg: 3, from: 3, to: 4 }, // IP
  index1: { parent: 'wrist', finger: 'index', seg: 1, from: 5, to: 6 },
  index2: { parent: 'index1', finger: 'index', seg: 2, from: 6, to: 7 },
  index3: { parent: 'index2', finger: 'index', seg: 3, from: 7, to: 8 },
  middle1: { parent: 'wrist', finger: 'middle', seg: 1, from: 9, to: 10 },
  middle2: { parent: 'middle1', finger: 'middle', seg: 2, from: 10, to: 11 },
  middle3: { parent: 'middle2', finger: 'middle', seg: 3, from: 11, to: 12 },
  ring1: { parent: 'wrist', finger: 'ring', seg: 1, from: 13, to: 14 },
  ring2: { parent: 'ring1', finger: 'ring', seg: 2, from: 14, to: 15 },
  ring3: { parent: 'ring2', finger: 'ring', seg: 3, from: 15, to: 16 },
  pinky1: { parent: 'wrist', finger: 'pinky', seg: 1, from: 17, to: 18 },
  pinky2: { parent: 'pinky1', finger: 'pinky', seg: 2, from: 18, to: 19 },
  pinky3: { parent: 'pinky2', finger: 'pinky', seg: 3, from: 19, to: 20 },
};
export const JOINTS = Object.keys(JOINT_INFO);
export const FINGER_JOINTS = JOINTS.slice(1); // 15, order matches HandPose.joints layout
export const JOINT_INDEX = Object.fromEntries(FINGER_JOINTS.map((j, i) => [j, i]));
export const fingerJoints = (f) => [1, 2, 3].map((s) => f + s);

// Status values for a HandPose.
//   tracked  : derived from the current camera observation
//   resuming : observation returned; blending from the held pose to the live pose
//   held     : no observation; last valid pose held unchanged
//   blending : no observation; blending from the held pose toward the configured neutral pose
//   lost     : no observation; neutral pose reached
export const STATUSES = ['tracked', 'resuming', 'held', 'blending', 'lost'];

export function newHandPose(side) {
  return {
    side,
    id: null, // persistent track id from association (e.g. "hand-3")
    status: 'lost',
    observed: false, // true only if this sample came from a camera observation this frame
    handednessScore: null, // MediaPipe handedness category score (API value) or null
    stability: null, // HEURISTIC 0..1, not an API value
    wrist: new Float32Array([0, 0, 0, 1]),
    joints: identityJoints(),
    root: null, // Float32Array(3) or null
    fingerValid: [1, 1, 1, 1, 1],
    raw: null, // { image: Float32Array(63), world: Float32Array(63), label, score } (diagnostic)
  };
}

export function identityJoints() {
  const a = new Float32Array(FINGER_JOINTS.length * 4);
  for (let i = 0; i < FINGER_JOINTS.length; i++) a[i * 4 + 3] = 1;
  return a;
}

export function cloneHandPose(h) {
  if (!h) return null;
  return {
    side: h.side,
    id: h.id,
    status: h.status,
    observed: h.observed,
    handednessScore: h.handednessScore,
    stability: h.stability,
    wrist: Float32Array.from(h.wrist),
    joints: Float32Array.from(h.joints),
    root: h.root ? Float32Array.from(h.root) : null,
    fingerValid: h.fingerValid.slice(),
    raw: h.raw
      ? { image: Float32Array.from(h.raw.image), world: Float32Array.from(h.raw.world), label: h.raw.label, score: h.raw.score }
      : null,
  };
}

export function cloneFrame(f) {
  return { t: f.t, hands: { left: cloneHandPose(f.hands.left), right: cloneHandPose(f.hands.right) } };
}

// Embedded verbatim in every export so files are self-describing.
export const CONVENTIONS = {
  units: 'metres',
  world: 'right-handed, +Y up, +X image-right (performer left), +Z performer->camera; from MediaPipe (x,-y,-z)',
  handFrame: '+Y distal (wrist->middle knuckles), +Z palmar, +X = Y x Z (thumb side on right hands, little-finger side on left hands)',
  boneFrame: '+Y along bone toward child, +Z palm normal orthogonalised to bone, +X = Y x Z; +X rotation = flexion',
  quaternionOrder: 'xyzw',
  wrist: 'absolute hand-frame orientation in canonical world',
  joints: 'rest-relative local rotations in each bone canonical frame; identity = calibrated neutral open hand; composed parent->child',
  root: 'approximate camera-space position estimate (metres) used only with rootPolicy approx-screen; not an accurate trajectory',
  jointParents: Object.fromEntries(JOINTS.map((j) => [j, JOINT_INFO[j].parent])),
  jointLandmarks: Object.fromEntries(JOINTS.map((j) => [j, [JOINT_INFO[j].from, JOINT_INFO[j].to]])),
  handedness: 'anatomical handedness of the performer; independent of preview mirroring',
};
