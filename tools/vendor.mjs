// Self-hosting helper: downloads the pinned runtime assets into ./vendor and points the app at
// them, so the deployed folder needs no third-party network access at all.
//
//   node tools/vendor.mjs                     download + switch to ./vendor
//   node tools/vendor.mjs --model FILE        use a local hand_landmarker.task instead of downloading
//   node tools/vendor.mjs --revert            switch index.html/config.js back to the CDN URLs
//
// Requires node >= 18 and npm (for `npm pack`). Files written:
//   vendor/three/build/three.module.js, three.core.js and the examples/jsm modules the app imports
//   vendor/tasks-vision/vision_bundle.mjs and vendor/tasks-vision/wasm/*
//   vendor/models/hand_landmarker.task
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THREE = '0.186.1', VISION = '1.0.1';
const CDN_THREE = `https://cdn.jsdelivr.net/npm/three@${THREE}/`;
const CDN_VISION = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION}/`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LOCAL = { three: './vendor/three/', vision: './vendor/tasks-vision/', model: './vendor/models/hand_landmarker.task' };

const args = process.argv.slice(2);
const edit = (file, pairs) => {
  const p = join(ROOT, file);
  let s = readFileSync(p, 'utf8');
  for (const [a, b] of pairs) s = s.split(a).join(b);
  writeFileSync(p, s);
};

if (args.includes('--revert')) {
  edit('index.html', [[LOCAL.three, CDN_THREE]]);
  edit('config.js', [[LOCAL.vision, CDN_VISION], [LOCAL.model, MODEL_URL]]);
  console.log('index.html and config.js point at the CDN again (vendor/ left in place).');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'handmocap-vendor-'));
const unpack = (spec) => {
  const dir = mkdtempSync(join(tmp, 'pkg-'));
  const name = execFileSync('npm', ['pack', spec, '--silent'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('tar', ['xzf', name], { cwd: dir });
  return join(dir, 'package');
};

// three.js: copy the module closure of the files the app imports.
const threePkg = unpack(`three@${THREE}`);
const entries = ['build/three.module.js', 'examples/jsm/controls/OrbitControls.js', 'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/exporters/GLTFExporter.js', 'examples/jsm/utils/BufferGeometryUtils.js'];
const seen = new Set();
const queue = [...entries];
while (queue.length) {
  const rel = queue.pop();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const src = readFileSync(join(threePkg, rel), 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(join(dirname(rel), m[1]).replace(/\\/g, '/'));
}
for (const rel of seen) {
  const out = join(ROOT, 'vendor/three', rel);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(join(threePkg, rel), out);
}
console.log(`three@${THREE}: ${seen.size} files`);

// MediaPipe Tasks Vision bundle + WASM.
const visionPkg = unpack(`@mediapipe/tasks-vision@${VISION}`);
mkdirSync(join(ROOT, 'vendor/tasks-vision/wasm'), { recursive: true });
copyFileSync(join(visionPkg, 'vision_bundle.mjs'), join(ROOT, 'vendor/tasks-vision/vision_bundle.mjs'));
for (const f of readdirSync(join(visionPkg, 'wasm'))) copyFileSync(join(visionPkg, 'wasm', f), join(ROOT, 'vendor/tasks-vision/wasm', f));
console.log(`@mediapipe/tasks-vision@${VISION}: bundle + ${readdirSync(join(visionPkg, 'wasm')).length} wasm files`);

// Model.
mkdirSync(join(ROOT, 'vendor/models'), { recursive: true });
const modelOut = join(ROOT, 'vendor/models/hand_landmarker.task');
const mi = args.indexOf('--model');
if (mi >= 0) copyFileSync(resolve(args[mi + 1]), modelOut);
else {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed (${res.status}); download it manually from ${MODEL_URL} and rerun with --model FILE`);
  writeFileSync(modelOut, Buffer.from(await res.arrayBuffer()));
}
console.log('model: vendor/models/hand_landmarker.task');

edit('index.html', [[CDN_THREE, LOCAL.three]]);
edit('config.js', [[CDN_VISION, LOCAL.vision], [MODEL_URL, LOCAL.model]]);
rmSync(tmp, { recursive: true, force: true });
console.log('index.html and config.js now load everything from ./vendor. Revert with --revert.');
if (!existsSync(modelOut)) process.exit(1);
