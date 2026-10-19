import { Vector3, Quaternion } from 'three';
import { test, check, near, note, rng } from './harness.mjs';
import { MocapPipeline } from '../src/pipeline.js';
import { HandAssociator, chiralityVote } from '../src/association.js';
import { PointsFilter, QuatFilter, smoothingParams } from '../src/filters.js';
import { gesturePose, lerpPose, detection, handQuat, DEFAULT_WRIST, thumbFromDir } from '../tools/synthetic.mjs';
import { DEG, quatAngle, readQuat } from '../src/math.js';

const FPS = 30;
const frameOf = (t, hands, w = 640, h = 480) => ({ t, width: w, height: h, hands });
function maxJointStep(a, b) {
  let m = 0;
  const qa = new Quaternion(), qb = new Quaternion();
  for (let i = 0; i < 15; i++) m = Math.max(m, quatAngle(readQuat(a.joints, i, qa), readQuat(b.joints, i, qb)));
  m = Math.max(m, quatAngle(qa.fromArray(a.wrist), qb.fromArray(b.wrist)));
  return m;
}
const allFinite = (h) => h && [...h.joints, ...h.wrist].every(Number.isFinite);

export async function run() {
  await test('association: identities stable under detection-order shuffles and label flicker', () => {
    const r = rng(3);
    const A = new HandAssociator();
    const ids = { left: new Set(), right: new Set() };
    let swaps = 0;
    for (let i = 0; i < 120; i++) {
      const t = i / FPS;
      const dl = detection('left', gesturePose('open'), handQuat('left'), DEFAULT_WRIST.left);
      const dr = detection('right', gesturePose('open'), handQuat('right'), DEFAULT_WRIST.right);
      if (i % 17 === 5) { dl.label = dl.label === 'Left' ? 'Right' : 'Left'; dl.score = 0.62; } // flicker
      const hands = r() < 0.5 ? [dl, dr] : [dr, dl];
      const out = A.update(frameOf(t, hands));
      if (out.left) ids.left.add(out.left.id);
      if (out.right) ids.right.add(out.right.id);
      if (out.left && out.left.det !== dl) swaps++;
      if (out.right && out.right.det !== dr) swaps++;
    }
    check(ids.left.size === 1 && ids.right.size === 1, `one persistent id per side (${[...ids.left]} / ${[...ids.right]})`);
    check(swaps === 0, `no left/right swaps (${swaps})`);
  });

  await test('association: geometric chirality vote and fast flip on in-place identity change', () => {
    const fistR = detection('right', gesturePose('fist'), handQuat('right', { yaw: 30 }), DEFAULT_WRIST.right);
    const fistL = detection('left', gesturePose('fist'), handQuat('left', { yaw: -30 }), DEFAULT_WRIST.left);
    const openR = detection('right', gesturePose('open'), handQuat('right'), DEFAULT_WRIST.right);
    check(chiralityVote(fistR.world) > 0.3 && chiralityVote(fistL.world) < -0.3, `curled hands vote their side (${chiralityVote(fistR.world).toFixed(2)}, ${chiralityVote(fistL.world).toFixed(2)})`);
    check(Math.abs(chiralityVote(openR.world)) < 1e-6, 'flat hand gives no geometric vote');
    // Same image position: a right fist is replaced by a left fist (labels correct).
    const A = new HandAssociator();
    for (let i = 0; i < 20; i++) A.update(frameOf(i / FPS, [fistR]));
    const swapIn = { ...fistL, image: fistR.image }; // same place on screen
    let flippedAt = -1;
    for (let i = 0; i < 10; i++) {
      const out = A.update(frameOf((20 + i) / FPS, [swapIn]));
      if (out.left && flippedAt < 0) flippedAt = i;
    }
    check(flippedAt >= 0 && flippedAt <= 1, `identity change recognised within 2 frames (frame ${flippedAt})`);
    // A single confident wrong label on a flat hand does not flip a stable track.
    const B = new HandAssociator();
    for (let i = 0; i < 20; i++) B.update(frameOf(i / FPS, [openR]));
    const wrong = { ...openR, label: 'Left', score: 0.99 };
    const o1 = B.update(frameOf(20 / FPS, [wrong])), o2 = B.update(frameOf(21 / FPS, [openR]));
    check(o1.right && o2.right && !o1.left, 'one wrong label on a flat hand is ignored');
  });

  await test('association: crossing hands keep anatomical sides; overlap marked ambiguous', () => {
    const A = new HandAssociator();
    let wrong = 0, ambiguousFrames = 0;
    for (let i = 0; i < 90; i++) {
      const t = i / FPS;
      const s = Math.cos((i / 89) * Math.PI); // 1 -> -1 : hands cross over
      const pl = new Vector3(0.12 * s, -0.05, -0.55), pr = new Vector3(-0.12 * s, -0.05, -0.55);
      const dl = detection('left', gesturePose('open'), handQuat('left'), pl);
      const dr = detection('right', gesturePose('open'), handQuat('right'), pr);
      const out = A.update(frameOf(t, i % 2 ? [dl, dr] : [dr, dl]));
      if (out.left?.ambiguous || out.right?.ambiguous) ambiguousFrames++;
      else {
        if (out.left && out.left.det !== dl) wrong++;
        if (out.right && out.right.det !== dr) wrong++;
      }
    }
    note(`ambiguous (held) frames during crossing: ${ambiguousFrames}`);
    check(wrong === 0, `no swaps outside ambiguous frames (${wrong})`);
    check(ambiguousFrames > 0 && ambiguousFrames < 30, 'overlap detected but brief');
  });

  await test('pipeline: side assignment depends on anatomical handedness only (label convention)', () => {
    for (const convention of ['swap', 'reported']) {
      const P = new MocapPipeline();
      P.setLabelConvention(convention);
      const dr = detection('right', gesturePose('fist'), handQuat('right'), DEFAULT_WRIST.right, { labelConvention: convention });
      const out = P.process(frameOf(0, [dr]));
      check(out.hands.right && !out.hands.left, `${convention}: right hand drives right side`);
      check(out.hands.right.joints[12] > 0.5, `${convention}: right side shows the fist`);
    }
  });

  await test('pipeline: dropout holds, blends to neutral, resumes without snapping; never NaN', () => {
    const P = new MocapPipeline({ smoothing: 0 });
    const fist = gesturePose('fist');
    let prev = null, maxStep = 0, statuses = [];
    for (let i = 0; i < 120; i++) {
      const t = i / FPS;
      const visible = i < 30 || i >= 75;
      let hands = visible ? [detection('right', fist, handQuat('right', { yaw: 20 }), DEFAULT_WRIST.right)] : [];
      if (i === 95) hands = [{ ...hands[0], world: hands[0].world.map((v, k) => (k === 7 ? NaN : v)) }]; // corrupt sample
      const out = P.process(frameOf(t, hands)).hands.right;
      check(allFinite(out), `finite at frame ${i}`);
      statuses.push(out.status);
      if (prev && i > 0) maxStep = Math.max(maxStep, maxJointStep(prev, out));
      prev = out;
    }
    const seq = statuses.filter((s, i) => i === 0 || s !== statuses[i - 1]);
    note(`status sequence: ${seq.join(' -> ')}; max per-frame step ${(maxStep / DEG).toFixed(1)}°`);
    check(seq.slice(0, 6).join(',') === 'tracked,held,blending,lost,resuming,tracked', 'expected loss/resume states');
    check(seq.includes('held') && seq.at(-1) === 'tracked', 'corrupt sample held then tracked again');
    check(maxStep < 25 * DEG, 'no violent snapping (< 25° per frame at 30 fps)');
  });

  await test('pipeline: approximate screen-space root follows hand translation (weak perspective)', () => {
    const P = new MocapPipeline({ smoothing: 0, rootPolicy: 'approx-screen' });
    const at = (x, y, z) => P.process(frameOf(0, [detection('right', gesturePose('open'), handQuat('right', { yaw: 15 }), new Vector3(x, y, z))])).hands.right.root;
    const r0 = at(-0.1, 0, -0.6), r1 = at(0.05, 0.08, -0.6), r2 = at(-0.1, 0, -0.9);
    const dx = r1[0] - r0[0], dy = r1[1] - r0[1], dz = r2[2] - r0[2];
    note(`moved (+0.15, +0.08, -0.30) m -> estimated (${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)}) m`);
    near(dx, 0.15, 0.02, 'x translation'); near(dy, 0.08, 0.02, 'y translation'); near(dz, -0.3, 0.05, 'depth (approximate)');
  });

  await test('pipeline: hand selection (left/right/both) gates outputs', () => {
    const P = new MocapPipeline({ hands: 'left' });
    const out = P.process(frameOf(0, [detection('right', gesturePose('open'), handQuat('right'), DEFAULT_WRIST.right), detection('left', gesturePose('open'), handQuat('left'), DEFAULT_WRIST.left)]));
    check(out.hands.left && !out.hands.right, 'only left output');
  });

  await test('filters: time-aware smoothing is frame-rate independent', () => {
    const params = smoothingParams(0.5);
    const resp = (fps) => {
      const f = new PointsFilter(1);
      let last = 0;
      for (let i = 0; i <= Math.round(0.1 * fps); i++) {
        const v = new Float32Array([i === 0 ? 0 : 0.05, 0, 0]); // 5 cm step at t>0
        f.filter(v, i / fps, params.pos);
        last = v[0];
      }
      return last;
    };
    const r30 = resp(30), r60 = resp(60);
    note(`step response at 0.1 s: 30 fps ${r30.toFixed(4)} m, 60 fps ${r60.toFixed(4)} m`);
    near(r30, r60, 0.004, 'similar response at different frame rates');
    const qf = new QuatFilter();
    const target = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 170 * DEG);
    qf.filter(new Quaternion(), 0, params.rot);
    const q = qf.filter(target.clone().set(-target.x, -target.y, -target.z, -target.w), 1 / 30, params.rot); // opposite hemisphere input
    check(quatAngle(q, new Quaternion()) < 170 * DEG && Number.isFinite(q.w), 'quaternion filter takes the short path for -q input');
  });

  await test('calibration: biased, noisy neutral is removed; palm-away is detected', () => {
    const r = rng(11);
    const bias = { fingers: {}, thumb: thumbFromDir(new Vector3(0.3, 0.95, 0.15), 6 * DEG, 12 * DEG) };
    for (const f of ['index', 'middle', 'ring', 'pinky']) bias.fingers[f] = { flex1: 8 * DEG, spread: (f === 'pinky' ? 5 : -2) * DEG, flex2: 14 * DEG, flex3: 7 * DEG };
    const P = new MocapPipeline({ smoothing: 0 });
    let t = 0;
    P.process(frameOf(t, []));
    P.startCalibration(0);
    for (let i = 0; i < 200 && P.calibrator.state !== 'done' && P.calibrator.state !== 'failed'; i++) {
      t = i / FPS;
      P.process(frameOf(t, ['left', 'right'].map((s) => detection(s, bias, handQuat(s), DEFAULT_WRIST[s], { noise: 0.0015, rand: r }))));
    }
    note(P.calibrator.message);
    check(P.calibrator.state === 'done' && P.calibration.left && P.calibration.right, 'both sides calibrated');
    // Neutral input (noise-free) now yields near-identity joints.
    t += 1;
    const out = P.process(frameOf(t, ['left', 'right'].map((s) => detection(s, bias, handQuat(s), DEFAULT_WRIST[s]))));
    for (const s of ['left', 'right']) {
      let m = 0;
      const q = new Quaternion();
      for (let i = 0; i < 15; i++) m = Math.max(m, quatAngle(readQuat(out.hands[s].joints, i, q), new Quaternion()));
      note(`${s}: max joint deviation at neutral after calibration ${(m / DEG).toFixed(2)}°`);
      check(m < 2.5 * DEG, `${s}: neutral -> ~identity`);
    }
    // Inverted handedness labels -> palm-away error.
    const Q = new MocapPipeline({ smoothing: 0 });
    Q.setLabelConvention('swap'); // detections below use the 'reported' convention
    Q.startCalibration(0);
    for (let i = 0; i < 200 && Q.calibrator.state !== 'done' && Q.calibrator.state !== 'failed'; i++) {
      Q.process(frameOf(i / FPS, [detection('right', bias, handQuat('right'), DEFAULT_WRIST.right)]));
    }
    note(Q.calibrator.message.slice(0, 200));
    check(Q.calibrator.state === 'done' && Q.calibrator.flipConvention && Q.associator.labelConvention === 'reported' && Q.calibration.right, 'inverted labels detected, convention switched, right hand calibrated');
    // Mixed case (one hand palm-away, one palm-facing) is reported, not auto-switched.
    const M = new MocapPipeline({ smoothing: 0 });
    M.startCalibration(0);
    const away = handQuat('left', { yaw: 180 });
    for (let i = 0; i < 200 && M.calibrator.state !== 'done' && M.calibrator.state !== 'failed'; i++) {
      M.process(frameOf(i / FPS, [detection('right', bias, handQuat('right'), DEFAULT_WRIST.right), detection('left', bias, away, DEFAULT_WRIST.left)]));
    }
    note(M.calibrator.message.slice(0, 200));
    check(M.calibrator.state === 'done' && !M.calibrator.flipConvention && M.calibration.right && !M.calibration.left && /left: palm normal points away/.test(M.calibrator.message), 'back-of-hand reported for that hand only');
  });
}
