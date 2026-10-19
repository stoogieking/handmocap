import '../tools/node-env.mjs';
import { readFileSync } from 'node:fs';
import { Vector3, Quaternion } from 'three';
import { test, check, near, note, rng } from './harness.mjs';
import { buildProceduralHands, builtinMapping, TargetRig } from '../src/rigs.js';
import { suggestMapping, validateMapping, makeProfile, parseProfile } from '../src/mapping.js';
import { RigAdapter } from '../src/retarget.js';
import { parseGLB } from '../src/export.js';
import { palmFrame } from '../src/handmodel.js';
import { solveRaw } from '../src/solver.js';
import { identityJoints, newHandPose, JOINTS, FINGER_JOINTS } from '../src/canonical.js';
import { DEG, quatAngle, newFrame, quatFromFrame, quatX, quatZ, writeQuat, readQuat } from '../src/math.js';

export async function loadRig(file) {
  const buf = readFileSync(new URL('../examples/' + file, import.meta.url));
  const gltf = await parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return new TargetRig(gltf.scene, { name: file, kind: 'file', fileName: file });
}
export async function allRigs() {
  return {
    A: new TargetRig(buildProceduralHands(), { name: 'builtin', kind: 'builtin' }),
    B: await loadRig('rig-b-mixamo-style.glb'),
    C: await loadRig('rig-c-unreal-style.glb'),
  };
}

const randIn = (r, a, b) => a + (b - a) * r();
function randomQuat(r) {
  const u1 = r(), u2 = r(), u3 = r();
  return new Quaternion(Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2), Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), Math.sqrt(u1) * Math.cos(2 * Math.PI * u3));
}
export function randomFrame(r, { flexOnly = false } = {}) {
  const f = { t: 0, hands: {} };
  for (const side of ['left', 'right']) {
    const h = newHandPose(side);
    h.status = 'tracked';
    randomQuat(r).toArray(h.wrist);
    for (const fg of ['index', 'middle', 'ring', 'pinky']) {
      const i = FINGER_JOINTS.indexOf(fg + '1');
      const spread = flexOnly ? 0 : randIn(r, -20, 20) * DEG;
      writeQuat(h.joints, i, quatZ(spread).multiply(quatX(randIn(r, -20, 90) * DEG)));
      writeQuat(h.joints, i + 1, quatX(randIn(r, 0, 100) * DEG));
      writeQuat(h.joints, i + 2, quatX(randIn(r, 0, 80) * DEG));
    }
    for (let k = 0; k < 3; k++) {
      const ax = new Vector3(randIn(r, -1, 1), flexOnly ? 0 : randIn(r, -0.3, 0.3), randIn(r, -1, 1)).normalize();
      writeQuat(h.joints, k, new Quaternion().setFromAxisAngle(ax, randIn(r, 0, 50) * DEG));
    }
    f.hands[side] = h;
  }
  return f;
}

const worldQuat = (o) => {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  o.updateWorldMatrix(true, false);
  o.matrixWorld.decompose(p, q, s);
  return q;
};

export async function run() {
  const rigs = await allRigs();

  await test('mapping: suggestions match expected bones for all three naming conventions', () => {
    const sA = suggestMapping(rigs.A);
    const exp = builtinMapping();
    check(JSON.stringify(sA) === JSON.stringify(exp), 'built-in rig suggestion == built-in mapping');
    const sB = suggestMapping(rigs.B);
    check(sB.left.wrist === 'mixamorigLeftHand' && sB.right.index3 === 'mixamorigRightHandIndex3' && sB.left.thumb1 === 'mixamorigLeftHandThumb1' && !Object.values(sB.left).some((n) => /4$/.test(n)), `rig B suggestion (${sB.left.wrist}, ${sB.right.index3})`);
    check(Object.keys(sB.left).length === 16 && Object.keys(sB.right).length === 16, 'rig B: all 16 joints per side');
    const sC = suggestMapping(rigs.C);
    check(sC.left.wrist === 'hand_l' && sC.right.wrist === 'hand_r', `rig C wrist is the deform hand, not ik_hand (${sC.left.wrist})`);
    check(sC.left.index1 === 'index_01_l' && sC.right.thumb3 === 'thumb_03_r' && !Object.values(sC.left).some((n) => /metacarpal/.test(n)), 'rig C fingers skip metacarpals');
    check(sC.left.pinky2 === 'pinky_02_l' && !sC.left.pinky3, 'rig C pinky has two segments');
    const vC = validateMapping(rigs.C, sC);
    note(`rig C validation: ${vC.errors.length} errors, warnings: ${vC.warnings.join(' | ')}`);
    check(vC.errors.length === 0 && vC.warnings.some((w) => /pinky: 1 segment/.test(w)), 'rig C: no errors, missing segment reported');
    const bad = JSON.parse(JSON.stringify(sC));
    bad.left.wrist = 'ik_hand_l';
    const vBad = validateMapping(rigs.C, bad);
    check(vBad.warnings.some((w) => /no skin weights/.test(w)), 'unskinned control bone reported');
    const dup = JSON.parse(JSON.stringify(sC));
    dup.left.index2 = dup.left.index1;
    check(validateMapping(rigs.C, dup).errors.some((e) => /mapped twice/.test(e)), 'duplicate mapping is an error');
  });

  const adapters = {};
  for (const k of ['A', 'B', 'C']) adapters[k] = new RigAdapter(rigs[k], { mapping: suggestMapping(rigs[k]), axisOverrides: { left: {}, right: {} } });

  await test('retarget: identity canonical pose reproduces each rig rest pose exactly', () => {
    for (const k of ['A', 'B', 'C']) {
      const ad = adapters[k];
      const f = { t: 0, hands: {} };
      for (const s of ['left', 'right']) {
        const h = newHandPose(s);
        // absolute wrist: the rig's own rest hand frame
        const e = ad.sides[s];
        new Quaternion().copy(e.wrist.restWorldQuat).multiply(e.wrist.C).toArray(h.wrist);
        f.hands[s] = h;
      }
      ad.apply(f);
      let m = 0;
      for (const [o, r] of rigs[k].rest) m = Math.max(m, quatAngle(o.quaternion, r.q), o.position.distanceTo(r.p));
      near(m, 0, 1e-5, `rig ${k}: max deviation from rest`);
    }
  });

  await test('retarget: parent-local conversion — each bone frame = rest frame carried by parent, rotated by D', () => {
    const r = rng(21);
    for (const k of ['A', 'B', 'C']) {
      const ad = adapters[k];
      const rig = rigs[k];
      // rest world rotations of every node
      rig.resetToRest();
      const restW = new Map(rig.nodes.map((o) => [o, worldQuat(o)]));
      let maxErr = 0;
      for (let n = 0; n < 40; n++) {
        const fr = randomFrame(r);
        ad.apply(fr);
        rig.root.updateMatrixWorld(true);
        for (const side of ['left', 'right']) {
          const e = ad.sides[side];
          const hand = fr.hands[side];
          // wrist (absolute mode): canonical hand frame of the bone == performer hand frame
          maxErr = Math.max(maxErr, quatAngle(worldQuat(e.wrist.bone).multiply(e.wrist.C), new Quaternion().fromArray(hand.wrist)));
          for (const j of e.joints) {
            const D = new Quaternion();
            for (const idx of j.owned) D.multiply(readQuat(hand.joints, idx));
            const parent = j.bone.parent;
            const carried = worldQuat(parent).multiply(restW.get(parent).clone().invert());
            const expected = carried.multiply(restW.get(j.bone)).multiply(j.C).multiply(D);
            maxErr = Math.max(maxErr, quatAngle(worldQuat(j.bone).multiply(j.C), expected));
          }
        }
      }
      note(`rig ${k}: max frame error ${(maxErr / DEG).toExponential(2)}°`);
      near(maxErr, 0, 1e-3 * DEG * 100, `rig ${k}`);
    }
  });

  await test('retarget: absolute wrist — rig palm frame (from posed bone positions) equals the performer hand frame', () => {
    const r = rng(5);
    for (const k of ['A', 'B', 'C']) {
      const ad = adapters[k];
      let maxErr = 0;
      for (let n = 0; n < 20; n++) {
        const fr = randomFrame(r);
        ad.apply(fr);
        rigs[k].root.updateMatrixWorld(true);
        for (const side of ['left', 'right']) {
          const m = ad.profile.mapping[side];
          const pos = (j) => rigs[k].get(m[j]).getWorldPosition(new Vector3());
          const P = Array.from({ length: 21 }, () => new Vector3());
          P[0] = pos('wrist'); P[5] = pos('index1'); P[9] = pos('middle1'); P[13] = pos('ring1'); P[17] = pos('pinky1');
          const f = newFrame();
          palmFrame(P, side, f);
          maxErr = Math.max(maxErr, quatAngle(quatFromFrame(f), new Quaternion().fromArray(fr.hands[side].wrist)));
        }
      }
      note(`rig ${k}: max palm-frame error ${(maxErr / DEG).toExponential(2)}°`);
      near(maxErr, 0, 1e-3 * DEG, `rig ${k}`);
    }
  });

  await test('retarget: finger flexion measured back from rig geometry equals the canonical input (A, B: exact)', () => {
    const r = rng(9);
    for (const k of ['A', 'B']) {
      const ad = adapters[k], rig = rigs[k];
      const m = ad.profile.mapping;
      const tipName = (side, f) => (k === 'A' ? `${side === 'left' ? 'L_' : 'R_'}${f}_tip` : `mixamorig${side === 'left' ? 'Left' : 'Right'}Hand${f[0].toUpperCase() + f.slice(1)}4`);
      const pts = (side) => {
        rig.root.updateMatrixWorld(true);
        const P = Array.from({ length: 21 }, () => new Vector3());
        const pos = (n) => rig.get(n).getWorldPosition(new Vector3());
        P[0] = pos(m[side].wrist);
        const base = { thumb: 1, index: 5, middle: 9, ring: 13, pinky: 17 };
        for (const f of Object.keys(base)) {
          for (let s = 1; s <= 3; s++) P[base[f] + s - 1] = pos(m[side][f + s]);
          P[base[f] + 3] = pos(tipName(side, f));
        }
        return P;
      };
      ad.apply(null);
      const rest = { left: solveRaw(pts('left'), 'left', null, {}), right: solveRaw(pts('right'), 'right', null, {}) };
      const restF = { left: JSON.parse(JSON.stringify(rest.left.fingers)), right: JSON.parse(JSON.stringify(rest.right.fingers)) };
      let maxErr = 0;
      for (let n = 0; n < 30; n++) {
        const fr = randomFrame(r);
        ad.apply(fr);
        for (const side of ['left', 'right']) {
          const raw = solveRaw(pts(side), side, null, {});
          for (const f of ['index', 'middle', 'ring', 'pinky']) {
            const i = FINGER_JOINTS.indexOf(f + '1');
            const q1 = readQuat(fr.hands[side].joints, i);
            // expected angles from the canonical delta: Rz(spread) Rx(flex)
            const y = new Vector3(0, 1, 0).applyQuaternion(q1);
            const flex1 = Math.asin(y.z), spread = Math.atan2(-y.x, y.y);
            const flex2 = 2 * Math.atan2(readQuat(fr.hands[side].joints, i + 1).x, readQuat(fr.hands[side].joints, i + 1).w);
            const flex3 = 2 * Math.atan2(readQuat(fr.hands[side].joints, i + 2).x, readQuat(fr.hands[side].joints, i + 2).w);
            const g = raw.fingers[f], g0 = restF[side][f];
            maxErr = Math.max(maxErr, Math.abs(g.flex1 - g0.flex1 - flex1), Math.abs(g.spread - g0.spread - spread), Math.abs(g.flex2 - g0.flex2 - flex2), Math.abs(g.flex3 - g0.flex3 - flex3));
          }
        }
      }
      note(`rig ${k}: max finger angle error ${(maxErr / DEG).toExponential(2)}°`);
      near(maxErr, 0, 0.01 * DEG, `rig ${k}`);
    }
  });

  await test('retarget: bone lengths, unrelated body bones and repeated application (no drift)', () => {
    const r = rng(33);
    for (const k of ['B', 'C']) {
      const ad = adapters[k], rig = rigs[k];
      rig.resetToRest();
      const driven = new Set(ad.drivenBones());
      const before = new Map(rig.nodes.map((o) => [o, { p: o.position.clone(), q: o.quaternion.clone() }]));
      const fixed = randomFrame(r);
      ad.apply(fixed);
      const once = new Map(rig.nodes.map((o) => [o, o.quaternion.clone()]));
      for (let n = 0; n < 300; n++) ad.apply(randomFrame(r));
      ad.apply(fixed);
      let drift = 0, untouched = 0, lenErr = 0;
      for (const o of rig.nodes) {
        drift = Math.max(drift, quatAngle(o.quaternion, once.get(o)));
        lenErr = Math.max(lenErr, o.position.distanceTo(before.get(o).p));
        if (!driven.has(o)) untouched = Math.max(untouched, quatAngle(o.quaternion, before.get(o).q));
      }
      near(drift, 0, 1e-6, `rig ${k}: no drift after 300 frames`);
      near(lenErr, 0, 1e-9, `rig ${k}: local positions (bone lengths) unchanged`);
      near(untouched, 0, 1e-12, `rig ${k}: non-mapped bones untouched`);
    }
  });

  await test('retarget: missing pinky segment (rig C) carries the folded distal flexion', () => {
    const ad = adapters.C;
    const pk = ad.sides.left.joints.find((j) => j.joint === 'pinky2');
    check(pk && pk.owned.length === 2, 'pinky2 owns pinky2 + pinky3');
    const f = { t: 0, hands: { left: newHandPose('left'), right: null } };
    const e = ad.sides.left;
    new Quaternion().copy(e.wrist.restWorldQuat).multiply(e.wrist.C).toArray(f.hands.left.wrist);
    writeQuat(f.hands.left.joints, FINGER_JOINTS.indexOf('pinky3'), quatX(40 * DEG));
    ad.apply(f);
    near(quatAngle(pk.bone.quaternion, pk.restLocal), 40 * DEG, 1e-4, 'pinky2 rotates by the pinky3 delta');
  });

  await test('profile: save/load round trip and version check', () => {
    const map = suggestMapping(rigs.C);
    const prof = makeProfile(rigs.C, map, { axisOverrides: { left: { index1: [0, 0, 5] }, right: {} }, settings: { wristMode: 'relative' } });
    const text = JSON.stringify(prof);
    const back = parseProfile(JSON.parse(text), rigs.C);
    check(JSON.stringify(back.mapping) === JSON.stringify(map) && back.axisOverrides.left.index1[2] === 5 && back.settings.wristMode === 'relative' && back.warnings.length === 0, 'round trip');
    const wrongRig = parseProfile(JSON.parse(text), rigs.B);
    check(wrongRig.warnings.length === 1, 'warns when bone names differ');
    let threw = false;
    try {
      parseProfile({ ...JSON.parse(text), version: 99 });
    } catch {
      threw = true;
    }
    check(threw, 'rejects unknown version');
  });
}
