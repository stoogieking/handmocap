// Two retargeting-validation rigs with deliberately different conventions. They are exported to
// examples/*.glb by tools/make-test-rigs.mjs and loaded by the app through the normal glTF import
// path. Neither shares the built-in rig's naming, axes, units or rest pose.
//
// Rig B "mixamo-style": names "mixamorig:LeftHandIndex1" (sanitised to mixamorigLeftHandIndex1 by
//   glTF loading), +Y along every bone with arbitrary roll (+37° left, -52° right), armature scaled
//   0.01 (bone units = cm), T-pose with palms down, straight fingers, tip end bones (…4).
// Rig C "unreal-style": names "hand_l", "index_01_l", metacarpal bones, +X along the bone on the
//   right side and -X along the bone on the left side (mirrored axes), metres, A-pose with palms
//   facing the body, relaxed curled fingers, no tip bones, pinky with only two phalanges, and
//   unskinned IK helper bones (ik_hand_root, ik_hand_l, ik_hand_r).
import { Group, Bone, Matrix4, Vector3, Quaternion, BoxGeometry } from 'three';
import { fkHandLocal } from '../src/handmodel.js';
import { buildSkinnedMesh, capsuleAlong } from '../src/rigs.js';
import { newFrame, frameFromYZ, quatFromFrame, DEG } from '../src/math.js';
import { FINGERS, FINGER_BASE } from '../src/canonical.js';
import { thumbFromDir } from './synthetic.mjs';

const basisQuat = (x, y, z) => new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));

// Canonical-like frame for a body/arm bone: +Y toward child, +Z hint.
function axisFrame(dir, zHint) {
  const f = newFrame();
  frameFromYZ(dir.clone().normalize(), zHint, f, new Vector3(1, 0, 0));
  return quatFromFrame(f);
}

function handFrame(distal, palmar) {
  const f = newFrame();
  frameFromYZ(distal.clone().normalize(), palmar, f);
  return quatFromFrame(f);
}

// Convention converters: canonical frame quaternion -> bone world quaternion.
const CONV = {
  B: (side) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (side === 'left' ? 37 : -52) * DEG),
  C: (side) =>
    side === 'left'
      ? basisQuat(new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0))
      : basisQuat(new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)),
};

class Builder {
  constructor(container, unitScale) {
    this.container = container;
    this.s = unitScale;
    this.bones = [];
    this.byName = {};
    this.pieces = [];
  }
  bone(name, parent, worldPos, worldQuat) {
    const b = new Bone();
    b.name = name;
    (parent || this.container).add(b);
    const desired = new Matrix4().compose(worldPos, worldQuat, new Vector3(this.s, this.s, this.s));
    (parent || this.container).updateMatrixWorld(true);
    const local = new Matrix4().copy((parent || this.container).matrixWorld).invert().multiply(desired);
    local.decompose(b.position, b.quaternion, b.scale);
    b.scale.set(1, 1, 1);
    b.updateMatrixWorld(true);
    this.bones.push(b);
    this.byName[name] = b;
    return b;
  }
  capsules(radiusFor, leafAxisFor, skip = new Set()) {
    for (const b of this.bones) {
      if (skip.has(b.name)) continue;
      const kid = b.children.find((c) => c.isBone && !/^ik_/.test(c.name));
      const r = radiusFor(b.name) / this.s;
      if (kid) this.pieces.push({ bone: b, geometry: capsuleAlong(kid.position.clone(), kid.position.length(), r) });
      else this.pieces.push({ bone: b, geometry: capsuleAlong(leafAxisFor(b.name), 0.018 / this.s, r) });
    }
  }
  palm(bone, H, wristPos, side) {
    const g = new BoxGeometry(0.075, 0.085, 0.024);
    g.translate(side === 'left' ? -0.004 : 0.004, 0.045, 0);
    g.applyQuaternion(H);
    g.translate(wristPos.x, wristPos.y, wristPos.z);
    bone.updateMatrixWorld(true);
    g.applyMatrix4(new Matrix4().copy(bone.matrixWorld).invert());
    this.pieces.push({ bone, geometry: g });
  }
}

// Hand bones for one side. names(finger, seg) -> bone name (seg 1..4, 4 = tip) or null.
function addHand(B, conv, side, parent, wristName, H, wristPos, pose, names, metacarpalName = null, pinkySegments = 3) {
  const K = conv(side);
  const frames = {};
  const L = fkHandLocal(side, pose, undefined, frames);
  const W = (p) => p.clone().applyQuaternion(H).add(wristPos);
  const F = (j) => H.clone().multiply(frames[j]);
  const wrist = B.bone(wristName, parent, wristPos, H.clone().multiply(K));
  for (const f of FINGERS) {
    const base = FINGER_BASE[f];
    let p = wrist;
    if (metacarpalName && f !== 'thumb') {
      const mcp = W(L[base]);
      const start = wristPos.clone().lerp(mcp, 0.22);
      p = B.bone(metacarpalName(f), wrist, start, axisFrame(mcp.clone().sub(start), new Vector3(0, 0, 1).applyQuaternion(H)).multiply(K));
    }
    const segs = f === 'pinky' ? pinkySegments : 3;
    for (let s = 1; s <= segs; s++) {
      let q = F(f + s);
      if (s === segs && segs < 3) {
        // last bone spans to the tip: aim it at the tip
        const from = W(L[base + s - 1]), to = W(L[base + 3]);
        const f2 = newFrame();
        frameFromYZ(to.clone().sub(from).normalize(), new Vector3(0, 0, 1).applyQuaternion(F(f + s)), f2);
        q = quatFromFrame(f2);
      }
      p = B.bone(names(f, s), p, W(L[base + s - 1]), q.multiply(K));
    }
    if (names(f, 4)) B.bone(names(f, 4), p, W(L[base + 3]), F(f + '3').multiply(K));
  }
  return wrist;
}

const relaxed = () => {
  const fingers = {};
  for (const f of ['index', 'middle', 'ring', 'pinky']) fingers[f] = { flex1: 15 * DEG, spread: 0, flex2: 25 * DEG, flex3: 12 * DEG };
  return { fingers, thumb: thumbFromDir(new Vector3(0.15, 0.95, 0.3), 10 * DEG, 15 * DEG) };
};
const straight = () => ({ fingers: {}, thumb: {} });

// ---------------------------------------------------------------------------------------------
export function buildRigB() {
  const root = new Group();
  root.name = 'RigB_MixamoStyle';
  const arm = new Group();
  arm.name = 'Armature';
  arm.scale.setScalar(0.01);
  root.add(arm);
  root.updateMatrixWorld(true);
  const B = new Builder(arm, 0.01);
  const K = CONV.B;
  const n = (s) => 'mixamorig:' + s;
  const up = new Vector3(0, 1, 0), fwd = new Vector3(0, 0, 1);
  const hips = B.bone(n('Hips'), null, new Vector3(0, 1.0, 0), axisFrame(up, fwd).multiply(K('right')));
  const spine = B.bone(n('Spine'), hips, new Vector3(0, 1.12, 0), axisFrame(up, fwd).multiply(K('right')));
  const spine1 = B.bone(n('Spine1'), spine, new Vector3(0, 1.26, 0), axisFrame(up, fwd).multiply(K('right')));
  const neck = B.bone(n('Neck'), spine1, new Vector3(0, 1.48, 0), axisFrame(up, fwd).multiply(K('right')));
  B.bone(n('Head'), neck, new Vector3(0, 1.56, 0), axisFrame(up, fwd).multiply(K('right')));
  for (const side of ['left', 'right']) {
    const sx = side === 'left' ? 1 : -1;
    const S = side === 'left' ? 'Left' : 'Right';
    const out = new Vector3(sx, 0, 0);
    const sh = B.bone(n(S + 'Shoulder'), spine1, new Vector3(0.05 * sx, 1.42, 0), axisFrame(out, fwd).multiply(K(side)));
    const a = B.bone(n(S + 'Arm'), sh, new Vector3(0.16 * sx, 1.42, 0), axisFrame(out, fwd).multiply(K(side)));
    const fa = B.bone(n(S + 'ForeArm'), a, new Vector3(0.42 * sx, 1.42, 0), axisFrame(out, fwd).multiply(K(side)));
    const H = handFrame(out, new Vector3(0, -1, 0)); // palms down
    const wp = new Vector3(0.67 * sx, 1.42, 0);
    const FN = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' };
    const hand = addHand(B, K, side, fa, n(S + 'Hand'), H, wp, straight(), (f, s) => n(`${S}Hand${FN[f]}${s}`));
    B.palm(hand, H, wp, side);
  }
  const leafAxis = () => new Vector3(0, 1, 0);
  B.capsules((name) => (/Hand.+\d/.test(name) ? (/Thumb1/.test(name) ? 0.01 : 0.0075) : /Arm|Shoulder/.test(name) ? 0.03 : 0.06), leafAxis, new Set(B.bones.filter((b) => /Hand$/.test(b.name)).map((b) => b.name)));
  buildSkinnedMesh(hips, B.bones, B.pieces, 0xb8c4a8);
  return root;
}

export function buildRigC() {
  const root = new Group();
  root.name = 'RigC_UnrealStyle';
  root.updateMatrixWorld(true);
  const B = new Builder(root, 1);
  const K = CONV.C;
  const up = new Vector3(0, 1, 0), fwd = new Vector3(0, 0, 1);
  const rootBone = B.bone('root', null, new Vector3(0, 0, 0), axisFrame(up, fwd).multiply(K('right')));
  const pelvis = B.bone('pelvis', rootBone, new Vector3(0, 0.98, 0), axisFrame(up, fwd).multiply(K('right')));
  const s1 = B.bone('spine_01', pelvis, new Vector3(0, 1.1, 0), axisFrame(up, fwd).multiply(K('right')));
  const s2 = B.bone('spine_02', s1, new Vector3(0, 1.26, 0), axisFrame(up, fwd).multiply(K('right')));
  const neck = B.bone('neck_01', s2, new Vector3(0, 1.47, 0), axisFrame(up, fwd).multiply(K('right')));
  B.bone('head', neck, new Vector3(0, 1.55, 0), axisFrame(up, fwd).multiply(K('right')));
  const ikRoot = B.bone('ik_hand_root', rootBone, new Vector3(0, 0, 0), new Quaternion());
  for (const side of ['left', 'right']) {
    const sx = side === 'left' ? 1 : -1;
    const sfx = side === 'left' ? '_l' : '_r';
    const down = new Vector3(0.707 * sx, -0.707, 0).normalize();
    const cl = B.bone('clavicle' + sfx, s2, new Vector3(0.04 * sx, 1.41, 0), axisFrame(new Vector3(sx, 0, 0), fwd).multiply(K(side)));
    const ua = B.bone('upperarm' + sfx, cl, new Vector3(0.15 * sx, 1.41, 0), axisFrame(down, fwd).multiply(K(side)));
    const laPos = new Vector3(0.15 * sx, 1.41, 0).addScaledVector(down, 0.27);
    const la = B.bone('lowerarm' + sfx, ua, laPos, axisFrame(down, fwd).multiply(K(side)));
    const wp = laPos.clone().addScaledVector(down, 0.25);
    const palmNormal = new Vector3(-0.707 * sx, -0.707, 0); // palms face the body
    const H = handFrame(down, palmNormal);
    const FN = { thumb: 'thumb', index: 'index', middle: 'middle', ring: 'ring', pinky: 'pinky' };
    const hand = addHand(B, K, side, la, 'hand' + sfx, H, wp, relaxed(), (f, s) => (s <= 3 ? `${FN[f]}_0${s}${sfx}` : null), (f) => `${FN[f]}_metacarpal${sfx}`, 2);
    B.palm(hand, H, wp, side);
    B.bone('ik_hand' + sfx, ikRoot, wp, H.clone());
  }
  const skip = new Set(['root', 'ik_hand_root', 'ik_hand_l', 'ik_hand_r', 'hand_l', 'hand_r', ...B.bones.filter((b) => /metacarpal/.test(b.name)).map((b) => b.name)]);
  B.capsules((name) => (/thumb_01/.test(name) ? 0.01 : /_0\d_/.test(name) ? 0.0075 : /arm|clavicle/.test(name) ? 0.03 : 0.06), (name) => new Vector3(name.endsWith('_l') ? -1 : 1, 0, 0), skip);
  buildSkinnedMesh(rootBone, B.bones.filter((b) => !/^ik_/.test(b.name)), B.pieces, 0xa8b8c8);
  return root;
}
