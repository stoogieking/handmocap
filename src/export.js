// Layer 7b: target-rig animation baking, GLB export and re-import verification.
//
// Three different outputs exist and are kept separate:
//   1. Raw landmarks JSON      (recording.rawToJSON)   — diagnostic MediaPipe output
//   2. Canonical motion JSON   (recording.toJSON)      — rig-independent, HandMocap schema
//   3. Target-rig animated GLB (this file)             — standard glTF skeletal animation of the
//      current rig, baked from the canonical motion. Plays without HandMocap or its solver.
import { AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack, AnimationMixer, LoopOnce, PropertyBinding, Quaternion } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { quatAngle } from './math.js';
import { cleanQuat } from './rigs.js';

// Bake: sample the recording at i/fps, retarget to the rig, read back local transforms.
// opts are passed to RigAdapter.apply (wristMode, rootPolicy, calibration, positionScale).
export function bakeRigAnimation(adapter, recording, fps, opts = {}, name = 'HandMocap') {
  const rig = adapter.rig;
  const bones = adapter.drivenBones();
  const frames = recording.resample(fps);
  const times = new Float32Array(frames.map((f, i) => i / fps));
  const qv = bones.map(() => new Float32Array(frames.length * 4));
  const moveRoot = opts.rootPolicy === 'approx-screen';
  const wristBones = new Set(Object.values(adapter.sides).map((e) => e.wrist?.bone).filter(Boolean));
  const pv = new Map([...wristBones].map((b) => [b, new Float32Array(frames.length * 3)]));
  const prev = bones.map(() => null);
  rig.resetToRest();
  frames.forEach((f, i) => {
    adapter.apply(f, opts);
    bones.forEach((b, k) => {
      const q = cleanQuat(b.quaternion);
      if (prev[k] && prev[k].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // sign continuity
      prev[k] = (prev[k] || new Quaternion()).copy(q);
      q.toArray(qv[k], i * 4);
      if (pv.has(b)) b.position.toArray(pv.get(b), i * 3);
    });
  });
  rig.resetToRest();
  const tracks = [];
  const channels = [];
  bones.forEach((b, k) => {
    if (b.name !== PropertyBinding.sanitizeNodeName(b.name)) throw new Error(`bone name "${b.name}" contains characters that animation channels cannot address`);
    tracks.push(new QuaternionKeyframeTrack(`${b.name}.quaternion`, times, qv[k]));
    channels.push({ node: b.name, path: 'quaternion', values: qv[k] });
    if (moveRoot && pv.has(b)) {
      tracks.push(new VectorKeyframeTrack(`${b.name}.position`, times, pv.get(b)));
      channels.push({ node: b.name, path: 'position', values: pv.get(b) });
    }
  });
  const clip = new AnimationClip(name, times.length ? times[times.length - 1] : 0, tracks);
  return { clip, times, channels, fps, frameCount: frames.length };
}

// Export the rig (at rest, so the file's node transforms are the rest pose) with the clip.
export async function exportGLB(rig, clip) {
  rig.resetToRest();
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(rig.root, { binary: true, animations: clip ? [clip] : [], onlyVisible: false });
  return result; // ArrayBuffer
}

export function parseGLB(buffer) {
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
}

// Re-import a GLB and check every baked channel: it must exist, target a node with the same
// name, and reproduce the baked values at every key time when played by a generic mixer.
export async function verifyGLB(buffer, baked) {
  const gltf = await parseGLB(buffer);
  const report = { ok: true, channels: baked.channels.length, matched: 0, missing: [], maxRotErrDeg: 0, maxPosErr: 0, frames: baked.times.length, clipCount: gltf.animations.length, nodeCount: 0 };
  gltf.scene.traverse(() => report.nodeCount++);
  const clip = gltf.animations[0];
  if (!clip) {
    report.ok = false;
    report.missing = baked.channels.map((c) => c.node);
    return report;
  }
  const trackNames = new Set(clip.tracks.map((t) => t.name));
  const nodes = new Map();
  for (const c of baked.channels) {
    const name = `${c.node}.${c.path}`;
    const node = PropertyBinding.findNode(gltf.scene, c.node);
    if (!trackNames.has(name) || !node) report.missing.push(name);
    else nodes.set(c, node);
  }
  const mixer = new AnimationMixer(gltf.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const q = new Quaternion();
  for (let i = 0; i < baked.times.length; i++) {
    mixer.setTime(baked.times[i]);
    for (const [c, node] of nodes) {
      if (c.path === 'quaternion') {
        q.fromArray(c.values, i * 4);
        report.maxRotErrDeg = Math.max(report.maxRotErrDeg, (quatAngle(q, node.quaternion) * 180) / Math.PI);
      } else {
        const e = Math.hypot(node.position.x - c.values[i * 3], node.position.y - c.values[i * 3 + 1], node.position.z - c.values[i * 3 + 2]);
        report.maxPosErr = Math.max(report.maxPosErr, e);
      }
    }
  }
  report.matched = nodes.size;
  report.ok = report.missing.length === 0 && report.maxRotErrDeg < 0.01 && report.maxPosErr < 1e-4;
  return report;
}
