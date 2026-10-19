// Writes examples/rig-b-mixamo-style.glb and examples/rig-c-unreal-style.glb.
import './node-env.mjs';
import { writeFileSync } from 'node:fs';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildRigB, buildRigC } from './testrigs.mjs';

for (const [file, build] of [['examples/rig-b-mixamo-style.glb', buildRigB], ['examples/rig-c-unreal-style.glb', buildRigC]]) {
  const root = build();
  const buf = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
  writeFileSync(new URL('../' + file, import.meta.url), Buffer.from(buf));
  let bones = 0;
  root.traverse((o) => o.isBone && bones++);
  console.log(`${file}: ${bones} bones, ${(buf.byteLength / 1024).toFixed(0)} KiB`);
}
