import '../tools/node-env.mjs';
import { readFileSync } from 'node:fs';
import { Quaternion } from 'three';
import { test, check, near, note, rng } from './harness.mjs';
import { Recording } from '../src/recording.js';
import { RigAdapter } from '../src/retarget.js';
import { suggestMapping, parseProfile } from '../src/mapping.js';
import { bakeRigAnimation, exportGLB, verifyGLB } from '../src/export.js';
import { newHandPose } from '../src/canonical.js';
import { quatAngle, DEG } from '../src/math.js';
import { allRigs, randomFrame } from './retarget.test.mjs';

const example = () => Recording.fromJSON(JSON.parse(readFileSync(new URL('../examples/example-recording.json', import.meta.url), 'utf8')));

export async function run() {
  await test('recording: monotonic timestamps, interpolation, resampling with sign continuity', () => {
    const rec = new Recording();
    const mk = (t, angle, flip) => {
      const h = newHandPose('right');
      const q = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, angle);
      if (flip) q.set(-q.x, -q.y, -q.z, -q.w);
      q.toArray(h.wrist);
      h.status = 'tracked';
      return { t, hands: { left: null, right: h } };
    };
    check(rec.push(mk(10, 0, false)), 'first frame accepted');
    check(rec.push(mk(10.05, 0.2, true)), 'second frame accepted');
    check(!rec.push(mk(10.04, 0.3, false)), 'non-monotonic frame rejected');
    rec.push(mk(10.1, 0.4, false));
    rec.push(mk(10.15, 0.6, true));
    near(rec.duration, 0.15, 1e-9, 'duration relative to first sample');
    const mid = rec.sampleAt(0.025);
    near(quatAngle(new Quaternion().fromArray(mid.hands.right.wrist), new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, 0.1)), 0, 1e-6, 'slerp at midpoint across a sign flip');
    const rs = rec.resample(60);
    check(rs.length === 10, `resample count ${rs.length}`);
    let ok = true;
    for (let i = 1; i < rs.length; i++) if (new Quaternion().fromArray(rs[i].hands.right.wrist).dot(new Quaternion().fromArray(rs[i - 1].hands.right.wrist)) < 0) ok = false;
    check(ok, 'resampled quaternions keep sign continuity');
    near(rs[3].t, 3 / 60, 1e-12, 'timestamp-based sample times');
  });

  await test('canonical JSON: versioned schema round trip (example recording)', () => {
    const rec = example();
    check(rec.frames.length > 200 && /synthetic/.test(rec.meta.source), `example loads (${rec.frames.length} frames, source labelled synthetic)`);
    const j = rec.toJSON({ fps: 30 });
    check(j.schema === 'handmocap.canonical-motion' && j.version === 1 && j.conventions.quaternionOrder === 'xyzw' && j.sampling.fps === 30, 'header fields');
    const back = Recording.fromJSON(JSON.parse(JSON.stringify(j)));
    let m = 0;
    for (let i = 0; i < back.frames.length; i++) {
      const a = back.frames[i].hands.right, b = rec.sampleAt(i / 30).hands.right;
      m = Math.max(m, quatAngle(new Quaternion().fromArray(a.wrist), new Quaternion().fromArray(b.wrist)));
    }
    near(m, 0, 1e-4, 'resampled JSON matches interpolation');
    let threw = false;
    try {
      Recording.fromJSON({ ...j, schema: 'something-else' });
    } catch {
      threw = true;
    }
    check(threw, 'wrong schema rejected');
    check(!rec.hasRaw() && rec.rawToJSON().frames.length === 0, 'raw landmarks absent unless recorded');
  });

  await test('GLB: bake -> export -> re-import -> mixer playback reproduces the baked rig motion (A, B, C)', async () => {
    const rigs = await allRigs();
    const rec = example();
    const profC = parseProfile(JSON.parse(readFileSync(new URL('../examples/profile-rig-c.json', import.meta.url), 'utf8')), rigs.C);
    check(profC.warnings.length === 0, 'example profile matches rig C');
    const cases = [
      ['A', { mapping: suggestMapping(rigs.A), axisOverrides: {} }, { wristMode: 'absolute' }],
      ['B', { mapping: suggestMapping(rigs.B), axisOverrides: {} }, { wristMode: 'relative' }],
      ['C', profC, { wristMode: 'relative', calibration: profC.calibration }],
      ['A+root', { mapping: suggestMapping(rigs.A), axisOverrides: {} }, { wristMode: 'absolute', rootPolicy: 'approx-screen' }],
    ];
    for (const [k, prof, opts] of cases) {
      const rig = rigs[k[0]];
      const ad = new RigAdapter(rig, prof);
      const baked = bakeRigAnimation(ad, rec, 30, opts);
      const buf = await exportGLB(rig, baked.clip);
      const rep = await verifyGLB(buf, baked);
      note(`rig ${k}: ${(buf.byteLength / 1024).toFixed(0)} KiB, ${rep.matched}/${rep.channels} channels, ${rep.frames} frames, max rot err ${rep.maxRotErrDeg.toExponential(2)}°, max pos err ${rep.maxPosErr.toExponential(2)}`);
      check(rep.ok, `rig ${k}: verification ok (missing: ${rep.missing.slice(0, 3)})`);
      // Export == preview: the baked keys equal what the live adapter shows at the same times.
      let m = 0;
      for (const i of [0, 37, 120, baked.frameCount - 1]) {
        ad.apply(rec.sampleAt(baked.times[i]), opts);
        baked.channels.filter((c) => c.path === 'quaternion').forEach((c) => {
          m = Math.max(m, quatAngle(rig.get(c.node).quaternion, new Quaternion().fromArray(c.values, i * 4)));
        });
      }
      rig.resetToRest();
      near(m, 0, 1e-5, `rig ${k}: baked keys == live preview`);
    }
  });

  await test('GLB: rest pose is preserved in the exported file (bind/rest transforms untouched)', async () => {
    const rigs = await allRigs();
    const ad = new RigAdapter(rigs.B, { mapping: suggestMapping(rigs.B), axisOverrides: {} });
    const rec = new Recording();
    const r = rng(4);
    for (let i = 0; i < 10; i++) {
      const f = randomFrame(r);
      f.t = i / 30;
      rec.push(f);
    }
    const baked = bakeRigAnimation(ad, rec, 30, {});
    const buf = await exportGLB(rigs.B, baked.clip);
    const { parseGLB } = await import('../src/export.js');
    const g = await parseGLB(buf);
    let m = 0;
    for (const [o, rest] of rigs.B.rest) {
      const n = g.scene.getObjectByName(o.name);
      if (!n) continue;
      m = Math.max(m, quatAngle(n.quaternion, rest.q), n.position.distanceTo(rest.p) * 1e-3);
    }
    near(m, 0, 1e-6, 'node rest transforms in file == rig rest');
  });
}
