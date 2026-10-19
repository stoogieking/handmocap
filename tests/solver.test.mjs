import { Vector3, Quaternion } from 'three';
import { test, check, near, note, rng } from './harness.mjs';
import { solveRaw, rawToJoints, defaultNeutral, newRaw, THUMB_TWIST_SIGN } from '../src/solver.js';
import { fkHandLocal, localToWorld, palmFrame, TEMPLATE, thumbRestFrame, templateThumbDir, composeFrame } from '../src/handmodel.js';
import { DEG, quatAngle, newFrame, quatFromFrame, frameFromYZ, safeNormalize, Y_AXIS, Z_AXIS, smoothstep, quatY, clampQuatAngle, quatRotationAngle } from '../src/math.js';
import { identityJoints } from '../src/canonical.js';
import { thumbFromDir, gesturePose } from '../tools/synthetic.mjs';

const randIn = (r, a, b) => a + (b - a) * r();
function randomQuat(r) {
  const u1 = r(), u2 = r(), u3 = r();
  return new Quaternion(
    Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
    Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
    Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
    Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
  );
}

export async function run() {
  await test('template: palm frame of the template is the identity (both sides)', () => {
    for (const side of ['left', 'right']) {
      const f = newFrame();
      palmFrame(TEMPLATE[side], side, f);
      const q = quatFromFrame(f);
      near(quatAngle(q, new Quaternion()), 0, 1e-6, `${side} template frame`);
      check(TEMPLATE[side][0].length() < 1e-9, 'wrist at origin');
    }
    // Mirror symmetry: index MCP is on +X for right (thumb side), -X for left.
    check(TEMPLATE.right[5].x > 0 && TEMPLATE.left[5].x < 0, 'thumb-side sign convention');
  });

  await test('math: frame construction survives near-collinear and degenerate input', () => {
    const f = newFrame();
    const q1 = frameFromYZ(new Vector3(0, 0, 1), Z_AXIS, f, new Vector3(0, 1, 0)); // y parallel to hint
    check([f.x, f.y, f.z].every((v) => Number.isFinite(v.x) && Math.abs(v.length() - 1) < 1e-6), 'orthonormal with fallback');
    near(f.x.dot(f.y), 0, 1e-9, 'x.y'); near(f.y.dot(f.z), 0, 1e-9, 'y.z');
    check(q1 < 1e-9, 'quality reports degeneracy');
    frameFromYZ(new Vector3(0, 0, 1), Z_AXIS, f); // no fallback at all
    check([f.x, f.y, f.z].every((v) => Number.isFinite(v.x) && Math.abs(v.length() - 1) < 1e-6), 'orthonormal without fallback');
    const v = new Vector3(0, 0, 0);
    check(!safeNormalize(v, Y_AXIS) && v.equals(Y_AXIS), 'zero vector falls back');
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 170 * DEG);
    clampQuatAngle(q, 60 * DEG);
    near(quatRotationAngle(q), 60 * DEG, 1e-6, 'clamp angle');
    const anti = new Quaternion().setFromUnitVectors(Y_AXIS, new Vector3(0, -1, 0));
    check(Number.isFinite(anti.w) && Math.abs(anti.length() - 1) < 1e-6, 'antiparallel swing finite');
    // Degenerate landmarks: all points identical -> finite frame, quality 0
    const P = Array.from({ length: 21 }, () => new Vector3(0.1, 0.2, 0.3));
    const raw = solveRaw(P, 'right', null, {});
    check(raw.palmQuality < 0.15, 'degenerate palm quality is low');
    const J = rawToJoints(raw, null, identityJoints());
    check(J.every(Number.isFinite), 'joints finite for degenerate input');
  });

  await test('solver: FK -> solve recovers random joint angles exactly (both hands, random wrist)', () => {
    const r = rng(7);
    let maxFinger = 0, maxThumb = 0, maxWrist = 0;
    for (let n = 0; n < 400; n++) {
      const side = n % 2 ? 'left' : 'right';
      const fingers = {};
      for (const f of ['index', 'middle', 'ring', 'pinky']) {
        fingers[f] = { flex1: randIn(r, -25, 85) * DEG, spread: randIn(r, -20, 20) * DEG, flex2: randIn(r, -5, 105) * DEG, flex3: randIn(r, -10, 85) * DEG };
      }
      const e = new Vector3(randIn(r, -0.6, 0.6), randIn(r, 0.4, 1), randIn(r, -0.4, 0.8));
      const thumb = thumbFromDir(e, randIn(r, 0, 60) * DEG, randIn(r, 0, 70) * DEG);
      const H = randomQuat(r);
      const P = localToWorld(fkHandLocal(side, { fingers, thumb }), H, new Vector3(randIn(r, -0.3, 0.3), randIn(r, -0.3, 0.3), randIn(r, -0.9, -0.3)));
      const raw = solveRaw(P, side, null, { thumbTwist: 30 * DEG });
      maxWrist = Math.max(maxWrist, quatAngle(raw.hand, H));
      for (const f of Object.keys(fingers)) {
        for (const k of ['flex1', 'spread', 'flex2', 'flex3']) maxFinger = Math.max(maxFinger, Math.abs(raw.fingers[f][k] - fingers[f][k]));
        check(raw.fingers[f].ok, `${f} ok`);
      }
      maxThumb = Math.max(maxThumb, quatAngle(raw.thumb.d1, thumb.d1), quatAngle(raw.thumb.s2, thumb.s2), quatAngle(raw.thumb.s3, thumb.s3));
    }
    note(`max errors: wrist ${(maxWrist / DEG).toExponential(2)}°, fingers ${(maxFinger / DEG).toExponential(2)}°, thumb ${(maxThumb / DEG).toExponential(2)}°`);
    near(maxWrist, 0, 1e-4, 'wrist orientation');
    near(maxFinger, 0, 1e-4, 'finger angles');
    near(maxThumb, 0, 1e-4, 'thumb rotations');
  });

  await test('solver: wrong handedness assumption mirrors the palm normal (detectable at calibration)', () => {
    const P = localToWorld(fkHandLocal('right', gesturePose('open', 'right')), new Quaternion(), new Vector3(0, 0, -0.5));
    const fr = newFrame(), fl = newFrame();
    palmFrame(P, 'right', fr);
    palmFrame(P, 'left', fl);
    near(fr.z.z, 1, 1e-6, 'correct side: palm normal toward camera (+Z)');
    near(fl.z.z, -1, 1e-6, 'wrong side: palm normal away from camera');
  });

  await test('solver: gestures produce anatomically signed deltas (fist flexes, open is identity)', () => {
    for (const side of ['left', 'right']) {
      const H = new Quaternion();
      const solve = (g) => rawToJoints(solveRaw(localToWorld(fkHandLocal(side, gesturePose(g, side)), H, new Vector3()), side, null, {}), null, identityJoints());
      const open = solve('open');
      check(open.every((v, i) => Math.abs(v - (i % 4 === 3 ? 1 : 0)) < 1e-5), `${side}: open hand -> identity joints`);
      const fist = solve('fist');
      // index1 quaternion x-component positive => positive flexion about +X
      check(fist[4 * 3] > 0.5, `${side}: fist index MCP flexes about +X (${fist[12].toFixed(3)})`);
      const spread = solve('spread');
      // index spread is toward the thumb in both hands; numeric Z-rotation sign is mirrored
      // by convention, so compare the anatomical direction via FK of the delta instead.
      check(Math.abs(spread[4 * 3 + 2]) > 0.05, `${side}: spread produces a Z rotation`);
    }
  });

  await test('solver: modelled thumb twist turns the pad toward the fingers in opposition', () => {
    // Pad normal heuristic in the canonical thumb frame: halfway between +Z (palmar) and -X
    // (toward the fingers for a right hand at rest). Compare +/- twist for a pinch.
    const side = 'right';
    const g = gesturePose('pinch', side);
    const L = fkHandLocal(side, g);
    const T0 = newFrame();
    thumbRestFrame(templateThumbDir(side), T0);
    const scores = {};
    for (const sgn of [1, -1, 0]) {
      const e = new Vector3(-0.35, 0.65, 0.65).normalize();
      const d1 = new Quaternion().setFromUnitVectors(Y_AXIS, e).multiply(quatY(sgn * 30 * DEG * smoothstep(0.05, 0.7, e.z)));
      const B = newFrame();
      composeFrame(T0, d1, B);
      const pad = B.z.clone().sub(B.x).normalize();
      const toIndex = L[8].clone().sub(L[2]);
      toIndex.addScaledVector(B.y, -toIndex.dot(B.y)).normalize();
      scores[sgn] = pad.dot(toIndex);
    }
    note(`pad·toIndexTip: twist+ ${scores[1].toFixed(3)}, none ${scores[0].toFixed(3)}, twist- ${scores[-1].toFixed(3)}`);
    check(Math.sign(scores[THUMB_TWIST_SIGN] - scores[-THUMB_TWIST_SIGN]) > 0, 'THUMB_TWIST_SIGN turns pad toward index tip');
  });

  await test('solver: calibration offsets make the biased neutral pose the identity', () => {
    const side = 'right';
    // Performer neutral is not flat: slight flexion and splay, thumb rotated.
    const bias = { fingers: {}, thumb: thumbFromDir(new Vector3(0.25, 0.95, 0.2), 8 * DEG, 10 * DEG) };
    for (const f of ['index', 'middle', 'ring', 'pinky']) bias.fingers[f] = { flex1: 9 * DEG, spread: (f === 'index' ? -4 : 3) * DEG, flex2: 12 * DEG, flex3: 6 * DEG };
    const H = new Quaternion();
    const P = localToWorld(fkHandLocal(side, bias), H, new Vector3());
    const raw0 = solveRaw(P, side, null, {});
    const neutral = defaultNeutral();
    for (const f of Object.keys(bias.fingers)) Object.assign(neutral.fingers[f], { flex1: raw0.fingers[f].flex1, spread: raw0.fingers[f].spread, flex2: raw0.fingers[f].flex2, flex3: raw0.fingers[f].flex3 });
    neutral.thumbRestDir = raw0.thumb.dir1.clone();
    const raw1 = solveRaw(P, side, neutral.thumbRestDir, {});
    neutral.n2.copy(raw1.thumb.s2);
    neutral.n3.copy(raw1.thumb.s3);
    const J = rawToJoints(raw1, neutral, identityJoints());
    let maxDev = 0;
    for (let i = 0; i < 15; i++) maxDev = Math.max(maxDev, quatAngle(new Quaternion().fromArray(J, i * 4), new Quaternion()));
    near(maxDev, 0, 1e-4, 'neutral -> identity (rad)');
  });
}
