// Layer 6: rig retargeting.
//
// For every mapped bone the adapter infers, at the rig's rest pose, the rotation C that takes
// canonical bone-frame coordinates to the bone's local coordinates:
//     C = Qrest_world(bone)^-1 * F_canonical_world(bone)
// F is built from the rig's own rest geometry with the same rules the solver uses on landmarks
// (palm frame from wrist + knuckles + anatomical side; bone +Y toward the child joint; +Z the
// palm normal made perpendicular). A canonical rest-relative rotation D then becomes
//     local = restLocal * C * D * C^-1
// i.e. D is applied about the bone's anatomical axes regardless of naming, local axis
// convention, roll or rest pose. Only rotations are written (plus an optional, explicitly
// approximate wrist offset), so bone lengths and bind/rest transforms are preserved, and every
// frame is computed from the stored rest values, so nothing accumulates.
//
// Wrist modes:
//   absolute : the rig's hand frame matches the performer's hand frame in canonical world
//              (rig world == canonical world; glTF characters face +Z = toward the camera).
//   relative : the rotation since calibration is applied to the rig's rest hand orientation
//              (useful for full-body rigs whose rest arms point sideways).
import { Vector3, Quaternion, Matrix4, Euler } from 'three';
import { JOINTS, JOINT_INFO, FINGERS, SIDES, JOINT_INDEX } from './canonical.js';
import { palmFrame } from './handmodel.js';
import { newFrame, frameFromYZ, quatFromFrame, readQuat, alignSign, DEG } from './math.js';

const _p = new Vector3(), _s = new Vector3(), _q = new Quaternion(), _q2 = new Quaternion(), _m = new Matrix4();

function worldQuat(o, out = new Quaternion()) {
  o.matrixWorld.decompose(_p, out, _s);
  return out.normalize();
}

export class RigAdapter {
  // profile: { mapping, axisOverrides, calibration, settings }
  constructor(rig, profile) {
    this.rig = rig;
    this.profile = profile;
    this.sides = {};
    this.notes = [];
    rig.resetToRest();
    for (const side of SIDES) {
      const e = this._buildSide(side, profile.mapping?.[side] || {}, profile.axisOverrides?.[side] || {});
      if (e) this.sides[side] = e;
    }
  }

  _buildSide(side, map, overrides) {
    const rig = this.rig;
    const bone = (j) => rig.get(map[j]);
    const wrist = bone('wrist');
    const fingerJoints = JOINTS.slice(1).filter((j) => bone(j));
    if (!wrist && !fingerJoints.length) return null;
    const pos = (o) => o.getWorldPosition(new Vector3());
    const entry = { side, wrist: null, joints: [], notes: [] };

    // Palm frame from rest geometry (same function as the solver uses on landmarks).
    const hand = newFrame();
    let palmOk = false;
    if (wrist && bone('index1') && (bone('pinky1') || bone('ring1'))) {
      const P = Array.from({ length: 21 }, () => new Vector3());
      const i1 = pos(bone('index1'));
      const p1 = pos(bone('pinky1') || bone('ring1'));
      const r1 = bone('ring1') ? pos(bone('ring1')) : i1.clone().lerp(p1, 0.66);
      const m1 = bone('middle1') ? pos(bone('middle1')) : i1.clone().lerp(r1, 0.5);
      P[0].copy(pos(wrist));
      P[5].copy(i1);
      P[9].copy(m1);
      P[13].copy(r1);
      P[17].copy(p1);
      const quality = palmFrame(P, side, hand);
      palmOk = quality > 0.15;
      if (!palmOk) entry.notes.push('palm frame degenerate in rest pose');
    } else entry.notes.push('palm frame needs wrist, index1, pinky1/ring1');

    const override = (j) => {
      const o = overrides[j];
      return o && o.some((v) => v) ? new Quaternion().setFromEuler(new Euler(o[0] * DEG, o[1] * DEG, o[2] * DEG, 'XYZ')) : null;
    };

    if (wrist) {
      const Qw = worldQuat(wrist);
      const F = palmOk ? quatFromFrame(hand) : Qw.clone();
      const C = Qw.clone().invert().multiply(F);
      const ov = override('wrist');
      if (ov) C.multiply(ov);
      wrist.parent.updateMatrixWorld(true);
      entry.wrist = {
        bone: wrist,
        C,
        Cinv: C.clone().invert(),
        restLocal: rig.rest.get(wrist).q.clone(),
        restPos: rig.rest.get(wrist).p.clone(),
        restWorldQuat: Qw,
        restWorldPos: pos(wrist),
        parentWorldQuat: worldQuat(wrist.parent),
        parentWorldInv: new Matrix4().copy(wrist.parent.matrixWorld).invert(),
        inferred: palmOk,
      };
      entry.palmLength = bone('middle1') ? pos(bone('middle1')).distanceTo(pos(wrist)) : bone('index1') ? pos(bone('index1')).distanceTo(pos(wrist)) : null;
    }

    if (palmOk) {
      for (const f of FINGERS) {
        const chain = [1, 2, 3].map((s) => f + s);
        const mapped = chain.filter((j) => bone(j));
        if (!mapped.length) continue;
        let prevDir = null;
        for (const j of mapped) {
          const b = bone(j);
          const bp = pos(b);
          let dir = null, how = 'child joint';
          const nextMapped = chain.slice(chain.indexOf(j) + 1).map(bone).find(Boolean);
          if (nextMapped) dir = pos(nextMapped).sub(bp);
          if (!dir || dir.length() < 1e-6) {
            const kids = b.children.filter((c) => rig.rest.has(c));
            const kid = kids.find((c) => pos(c).distanceTo(bp) > 1e-6);
            if (kid) {
              dir = pos(kid).sub(bp);
              how = 'child node';
            }
          }
          if (!dir || dir.length() < 1e-6) {
            dir = prevDir ? prevDir.clone() : hand.y.clone();
            how = prevDir ? 'parent segment (no child)' : 'palm direction (no child)';
          }
          dir.normalize();
          const F = newFrame();
          const q = frameFromYZ(dir, hand.z, F, hand.x.clone().negate());
          const Qb = worldQuat(b);
          const C = Qb.clone().invert().multiply(quatFromFrame(F));
          const ov = override(j);
          if (ov) C.multiply(ov);
          const flags = [];
          if (how !== 'child joint' && how !== 'child node') flags.push('direction from ' + how);
          if (q < 0.3) flags.push('bone nearly parallel to palm normal: twist axis ambiguous');
          if (Math.acos(Math.max(-1, Math.min(1, dir.dot(hand.y)))) > 75 * DEG && f !== 'thumb') flags.push('strongly curled rest pose');
          entry.joints.push({ joint: j, bone: b, C, Cinv: C.clone().invert(), restLocal: rig.rest.get(b).q.clone(), owned: [], flags, ambiguous: q < 0.3 || how.startsWith('palm') });
          prevDir = dir;
        }
        // Fold unmapped segments into the nearest mapped one (leading -> first mapped,
        // trailing/intermediate -> previous mapped).
        const owner = (j) => {
          if (bone(j)) return j;
          const idx = chain.indexOf(j);
          for (let k = idx - 1; k >= 0; k--) if (bone(chain[k])) return chain[k];
          return mapped[0];
        };
        for (const j of chain) entry.joints.find((x) => x.joint === owner(j)).owned.push(JOINT_INDEX[j]);
      }
    }
    return entry;
  }

  // Report rows for the mapping UI: [{ side, joint, bone, flags }]
  report() {
    const rows = [];
    for (const side of SIDES) {
      const e = this.sides[side];
      if (!e) continue;
      if (e.wrist) rows.push({ side, joint: 'wrist', bone: e.wrist.bone.name, flags: e.wrist.inferred ? [] : ['palm frame not inferred: uses bone axes'] });
      for (const j of e.joints) rows.push({ side, joint: j.joint, bone: j.bone.name, flags: j.flags.concat(j.owned.length > 1 ? [`also carries ${j.owned.length - 1} unmapped segment(s)`] : []) });
      for (const n of e.notes) rows.push({ side, joint: '-', bone: '-', flags: [n] });
    }
    return rows;
  }

  drivenBones() {
    const out = [];
    for (const side of SIDES) {
      const e = this.sides[side];
      if (!e) continue;
      if (e.wrist) out.push(e.wrist.bone);
      for (const j of e.joints) out.push(j.bone);
    }
    return out;
  }

  // Apply a canonical frame. opts: { wristMode, rootPolicy, calibration: {left,right}, positionScale }
  apply(frame, opts = {}) {
    const wristMode = opts.wristMode || 'absolute';
    for (const side of SIDES) {
      const e = this.sides[side];
      if (!e) continue;
      const hand = frame?.hands?.[side];
      if (!hand) {
        this._rest(e);
        continue;
      }
      if (e.wrist) {
        const w = e.wrist;
        const H = _q.fromArray(hand.wrist).normalize();
        const target = _q2;
        if (wristMode === 'relative') {
          const cal = opts.calibration?.[side];
          const Hn = cal?.wrist ? new Quaternion().fromArray(cal.wrist) : new Quaternion();
          target.copy(H).multiply(Hn.invert()).multiply(w.restWorldQuat);
        } else target.copy(H).multiply(w.Cinv);
        w.bone.quaternion.copy(w.parentWorldQuat).invert().multiply(target);
        alignSign(w.bone.quaternion, w.restLocal);
        if (opts.rootPolicy === 'approx-screen' && hand.root) {
          const cal = opts.calibration?.[side];
          const ref = cal?.rootRef ? _p.fromArray(cal.rootRef) : _p.set(0, 0, -0.5);
          const scale = opts.positionScale === 'auto' || opts.positionScale == null
            ? (cal?.palmLength && e.palmLength ? e.palmLength / cal.palmLength : 1)
            : opts.positionScale;
          const world = new Vector3().fromArray(hand.root).sub(ref).multiplyScalar(scale).add(w.restWorldPos);
          w.bone.position.copy(world.applyMatrix4(w.parentWorldInv));
        } else w.bone.position.copy(w.restPos);
      }
      for (const j of e.joints) {
        // D = product of owned canonical deltas (in chain order), conjugated into bone space.
        const D = _q.identity();
        for (const idx of j.owned) D.multiply(readQuat(hand.joints, idx, _q2));
        j.bone.quaternion.copy(j.restLocal).multiply(j.C).multiply(D).multiply(j.Cinv);
      }
    }
  }

  _rest(e) {
    if (e.wrist) {
      e.wrist.bone.quaternion.copy(e.wrist.restLocal);
      e.wrist.bone.position.copy(e.wrist.restPos);
    }
    for (const j of e.joints) j.bone.quaternion.copy(j.restLocal);
  }
}
