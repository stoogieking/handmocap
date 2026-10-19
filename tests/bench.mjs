// Main-thread cost of the per-frame layers (node; excludes MediaPipe inference and rendering).
import '../tools/node-env.mjs';
import { MocapPipeline } from '../src/pipeline.js';
import { RigAdapter } from '../src/retarget.js';
import { suggestMapping } from '../src/mapping.js';
import { gesturePose, lerpPose, detection, handQuat, DEFAULT_WRIST } from '../tools/synthetic.mjs';
import { allRigs } from './retarget.test.mjs';
const N = 3000;
const frames = [];
for (let i = 0; i < 60; i++) {
  const p = lerpPose(gesturePose('open'), gesturePose('fist'), (i % 30) / 29);
  frames.push(['left', 'right'].map((s) => detection(s, p, handQuat(s, { yaw: i }), DEFAULT_WRIST[s], { noise: 0.001 })));
}
const P = new MocapPipeline();
let out;
for (let i = 0; i < 300; i++) out = P.process({ t: i / 30, width: 640, height: 480, hands: frames[i % 60] });
let t0 = performance.now();
for (let i = 0; i < N; i++) out = P.process({ t: 10 + i / 30, width: 640, height: 480, hands: frames[i % 60] });
const pipeUs = ((performance.now() - t0) / N) * 1000;
const rigs = await allRigs();
const res = { pipelineTwoHands_us: pipeUs.toFixed(1) };
for (const k of ['A', 'B', 'C']) {
  const ad = new RigAdapter(rigs[k], { mapping: suggestMapping(rigs[k]), axisOverrides: {} });
  for (let i = 0; i < 200; i++) ad.apply(out);
  t0 = performance.now();
  for (let i = 0; i < N; i++) ad.apply(out, { wristMode: 'relative' });
  res[`retarget_${k}_us`] = (((performance.now() - t0) / N) * 1000).toFixed(1);
}
console.log(JSON.stringify(res));
