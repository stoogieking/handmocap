// Generates the example assets in examples/:
//   example-recording.json  — SYNTHETIC performance (forward-kinematics landmarks + noise, run
//                             through the real tracking pipeline). Not a camera capture.
//   profile-rig-c.json      — rig-mapping + calibration profile for rig-c-unreal-style.glb
//                             (calibration from a synthetic neutral pose).
import './node-env.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { MocapPipeline } from '../src/pipeline.js';
import { Recording } from '../src/recording.js';
import { TargetRig } from '../src/rigs.js';
import { suggestMapping, makeProfile } from '../src/mapping.js';
import { parseGLB } from '../src/export.js';
import { gesturePose, lerpPose, detection, handQuat, DEFAULT_WRIST, thumbFromDir } from './synthetic.mjs';
import { rng } from '../tests/harness.mjs';
import { DEG } from '../src/math.js';

const FPS = 30;
const SOURCE = 'synthetic: tools/make-example.mjs (forward-kinematics landmarks with 1 mm noise, processed by the HandMocap pipeline; not a camera capture)';

// Keyframed gesture script per side: [time, gesture, wrist {yaw,pitch,roll}]
const SCRIPT = {
  right: [[0, 'open', {}], [0.8, 'open', {}], [1.4, 'fist', {}], [2.0, 'fist', {}], [2.6, 'open', {}], [3.2, 'point', {}], [3.9, 'point', { yaw: 15 }], [4.5, 'spread', {}], [5.1, 'pinch', { pitch: 15 }], [5.8, 'pinch', { pitch: 15 }], [6.4, 'open', { yaw: 50 }], [7.0, 'open', { yaw: -45, roll: 20 }], [7.6, 'open', { roll: -30 }], [8.2, 'open', {}]],
  left: [[0, 'open', {}], [1.0, 'open', {}], [1.6, 'spread', {}], [2.4, 'fist', { yaw: -20 }], [3.2, 'fist', {}], [3.8, 'open', {}], [4.6, 'pinch', {}], [5.4, 'point', { roll: 25 }], [6.2, 'open', {}], [7.2, 'open', { pitch: -35 }], [8.2, 'open', {}]],
};
const DROPOUT = { left: [6.5, 6.95] }; // brief tracking loss to exercise hold/blend/resume

const ease = (t) => t * t * (3 - 2 * t);
function poseAt(side, t) {
  const s = SCRIPT[side];
  let i = 0;
  while (i < s.length - 2 && s[i + 1][0] <= t) i++;
  const [t0, g0, w0] = s[i], [t1, g1, w1] = s[i + 1];
  const u = ease(Math.min(1, Math.max(0, (t - t0) / (t1 - t0))));
  const pose = lerpPose(gesturePose(g0, side), gesturePose(g1, side), u);
  const w = {};
  for (const k of ['yaw', 'pitch', 'roll']) w[k] = (w0[k] || 0) + ((w1[k] || 0) - (w0[k] || 0)) * u;
  if (side === 'left') w.yaw = -(w.yaw || 0); // mirrored performance
  return { pose, H: handQuat(side, w) };
}

const r = rng(2024);
const pipeline = new MocapPipeline();
const rec = new Recording({ source: SOURCE, settings: { ...pipeline.settings } });
const duration = 8.2;
for (let i = 0; i <= duration * FPS; i++) {
  const t = 1000 + i / FPS; // arbitrary absolute clock, like performance.now()/1000
  const hands = [];
  for (const side of ['right', 'left']) {
    const tt = i / FPS;
    if (DROPOUT[side] && tt >= DROPOUT[side][0] && tt < DROPOUT[side][1]) continue;
    const { pose, H } = poseAt(side, tt);
    hands.push(detection(side, pose, H, DEFAULT_WRIST[side].clone().add(new Vector3(0, 0.01 * Math.sin(tt * 2), 0)), { noise: 0.001, rand: r }));
  }
  rec.push(pipeline.process({ t, width: 640, height: 480, hands }));
}
writeFileSync(new URL('../examples/example-recording.json', import.meta.url), JSON.stringify(rec.toJSON()));
console.log(`example-recording.json: ${rec.frames.length} frames, ${rec.duration.toFixed(2)} s`);

// Calibration (synthetic neutral) for the profile example.
const cal = new MocapPipeline();
const bias = { fingers: {}, thumb: thumbFromDir(new Vector3(0.25, 0.95, 0.2), 6 * DEG, 10 * DEG) };
for (const f of ['index', 'middle', 'ring', 'pinky']) bias.fingers[f] = { flex1: 6 * DEG, spread: 0, flex2: 10 * DEG, flex3: 5 * DEG };
cal.startCalibration(0);
for (let i = 0; i < 300 && !['done', 'failed'].includes(cal.calibrator.state); i++) {
  cal.process({ t: i / FPS, width: 640, height: 480, hands: ['left', 'right'].map((s) => detection(s, bias, handQuat(s), DEFAULT_WRIST[s], { noise: 0.001, rand: r })) });
}
console.log(cal.calibrator.message);
const buf = readFileSync(new URL('../examples/rig-c-unreal-style.glb', import.meta.url));
const gltf = await parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const rig = new TargetRig(gltf.scene, { name: 'rig-c-unreal-style.glb', kind: 'file', fileName: 'rig-c-unreal-style.glb' });
const profile = makeProfile(rig, suggestMapping(rig), {
  calibration: cal.calibration,
  settings: { wristMode: 'relative', rootPolicy: 'fixed', labelConvention: 'reported', positionScale: 'auto' },
});
profile.note = 'Example profile for examples/rig-c-unreal-style.glb. Calibration was computed from a synthetic neutral pose; recalibrate with your own hands for real use.';
writeFileSync(new URL('../examples/profile-rig-c.json', import.meta.url), JSON.stringify(profile, null, 1));
console.log('profile-rig-c.json written');
