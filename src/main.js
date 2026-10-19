// Layer 8: user interface and diagnostics. Wires the layers together; holds no motion math.
import { WebGLRenderer, Scene, PerspectiveCamera, Color, HemisphereLight, DirectionalLight, GridHelper, Box3, Vector3, LoadingManager } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Tracker, cameraErrorMessage } from './tracking.js';
import { MocapPipeline } from './pipeline.js';
import { buildProceduralHands, builtinMapping, TargetRig } from './rigs.js';
import { suggestMapping, validateMapping, makeProfile, parseProfile } from './mapping.js';
import { RigAdapter } from './retarget.js';
import { Recording } from './recording.js';
import { bakeRigAnimation, exportGLB, verifyGLB } from './export.js';
import { JOINTS, SIDES } from './canonical.js';
import { DEG } from './math.js';
import { zipStore } from './zip.js';

// Set by artifact.html when the app runs inside the claude.ai artifact viewer, which blocks camera
// access and plain downloads.
const EMBEDDED = !!window.HANDMOCAP_EMBEDDED;

const $ = (id) => document.getElementById(id);
const ui = {};
for (const id of ['status', 'camStart', 'camStop', 'camSelect', 'mirror', 'showLandmarks', 'viewPreset', 'viewReset', 'rigName', 'rigBuiltin', 'rigFile', 'rigB', 'rigC', 'mapDetails', 'mapSuggest', 'mapApply', 'mapClear', 'mapTableWrap', 'axisWrap', 'hierarchy', 'mapReport', 'profileSave', 'profileFile', 'calStart', 'calClear', 'calResult', 'calHands', 'hands', 'smoothing', 'smoothingOut', 'rootPolicy', 'wristMode', 'holdMs', 'blendMs', 'lossPose', 'labelConvention', 'thumbTwist', 'recordRaw', 'exportFps', 'exportGlb', 'exportJson', 'exportRaw', 'exportResult', 'recBtn', 'playBtn', 'liveBtn', 'scrub', 'timeOut', 'recFile', 'recExample', 'diag', 'cam', 'video', 'overlay', 'gl']) ui[id] = $(id);

const state = {
  mode: 'live', // 'live' | 'playback'
  rig: null,
  adapter: null,
  mapping: { left: {}, right: {} },
  axisOverrides: { left: {}, right: {} },
  recording: null,
  recordingActive: false,
  playing: false,
  playTime: 0,
  liveFrame: null,
  liveCaptureMs: null,
  liveClock: null,
  lastResult: null,
  modelError: null,
  cameraOn: false,
  fps: null,
  processedRate: 0,
};

const pipeline = new MocapPipeline();
// URL options (troubleshooting): ?delegate=cpu forces CPU inference, ?worker=off forces the
// main-thread fallback.
const query = new URLSearchParams(location.search);
const tracker = new Tracker({ video: ui.video, onResult: onTrackingResult, onStatus: onTrackerStatus, delegate: query.get('delegate')?.toUpperCase() === 'CPU' ? 'CPU' : 'GPU', useWorker: query.get('worker') !== 'off' });

// ---------------------------------------------------------------------------------------------
// Status
let statusLock = null; // persistent error text
function setStatus(text, { error = false, lock = false } = {}) {
  if (lock) statusLock = error ? text : null;
  if (statusLock && !lock && !error) return;
  ui.status.textContent = text;
  ui.status.classList.toggle('error', error);
}

// ---------------------------------------------------------------------------------------------
// 3D view
let renderer = null, scene, camera, controls, grid;
try {
  renderer = new WebGLRenderer({ canvas: ui.gl, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
} catch (err) {
  renderer = null;
  setStatus('3D preview unavailable: this browser/GPU does not provide WebGL 2. Tracking, recording and export still work.', { error: true, lock: true });
}
scene = new Scene();
scene.background = new Color(0xe9e9e9);
scene.add(new HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
const sun = new DirectionalLight(0xffffff, 1.6);
sun.position.set(0.5, 1.5, 1.2);
scene.add(sun);
grid = new GridHelper(2, 20, 0x999999, 0xc4c4c4);
scene.add(grid);
camera = new PerspectiveCamera(40, 1, 0.01, 100);
if (renderer) {
  controls = new OrbitControls(camera, ui.gl);
  controls.enableDamping = false;
}
let viewTarget = new Vector3(), viewDist = 0.6;

function resize() {
  if (!renderer) return;
  const r = ui.gl.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(ui.gl.parentElement);

function frameView() {
  // Frame the mapped wrists (or the whole rig) at rest.
  const pts = [];
  state.rig.resetToRest();
  for (const s of SIDES) {
    const w = state.rig.get(state.mapping[s]?.wrist);
    if (w) pts.push(w.getWorldPosition(new Vector3()));
  }
  const box = new Box3().setFromObject(state.rig.root);
  if (pts.length) {
    viewTarget = pts.reduce((a, b) => a.add(b), new Vector3()).multiplyScalar(1 / pts.length);
    viewTarget.y += 0.06;
    const span = pts.length === 2 ? pts[0].distanceTo(pts[1]) : 0.2;
    viewDist = Math.max(0.45, span * 1.2 + 0.3);
  } else {
    box.getCenter(viewTarget);
    viewDist = box.getSize(new Vector3()).length() * 1.2 + 0.2;
  }
  grid.position.y = Math.min(box.min.y, viewTarget.y - 0.15);
  applyViewPreset();
}

function applyViewPreset() {
  const z = ui.viewPreset.value === 'camera' ? viewDist : -viewDist;
  camera.position.set(viewTarget.x, viewTarget.y + 0.05, viewTarget.z + z);
  camera.lookAt(viewTarget);
  if (controls) {
    controls.target.copy(viewTarget);
    controls.update();
  }
}

// ---------------------------------------------------------------------------------------------
// Rig
function disposeObject(o) {
  o.traverse((c) => {
    c.geometry?.dispose?.();
    const m = c.material;
    (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => x.dispose?.());
  });
}

function setRig(rig, { mapping = null, axisOverrides = null } = {}) {
  if (state.rig) {
    scene.remove(state.rig.root);
    disposeObject(state.rig.root);
  }
  state.rig = rig;
  scene.add(rig.root);
  state.mapping = mapping || (rig.kind === 'builtin' ? builtinMapping() : suggestMapping(rig));
  state.axisOverrides = axisOverrides || { left: {}, right: {} };
  ui.wristMode.value = rig.kind === 'builtin' ? 'absolute' : 'relative';
  ui.rigName.textContent = `Rig: ${rig.name} (${rig.nodes.length} nodes${rig.skinnedMeshes.length ? '' : ', no skinned mesh'})`;
  buildMappingUI();
  applyMapping();
  frameView();
  const found = SIDES.filter((s) => state.mapping[s]?.wrist);
  if (rig.kind !== 'builtin' && !found.length) {
    ui.mapDetails.open = true;
    setStatus('No hand bones were recognised automatically. Map the bones manually under "Map bones".', { error: true });
  }
}

function applyMapping() {
  readMappingUI();
  const v = validateMapping(state.rig, state.mapping);
  let adapterOk = true;
  try {
    state.adapter = new RigAdapter(state.rig, { mapping: state.mapping, axisOverrides: state.axisOverrides });
  } catch (err) {
    adapterOk = false;
    state.adapter = null;
    v.errors.push('adapter: ' + err.message);
  }
  const rows = adapterOk ? state.adapter.report() : [];
  const flagged = rows.filter((r) => r.flags.length).map((r) => `${r.side} ${r.joint} (${r.bone}): ${r.flags.join('; ')}`);
  const sides = SIDES.map((s) => `${s}: ${v.sides[s]}`).join(', ');
  ui.mapReport.textContent = [`Mapping ${sides}.`, ...v.errors.map((e) => 'Error — ' + e), ...v.warnings.map((w) => 'Warning — ' + w), ...flagged.map((f) => 'Note — ' + f)].join('\n');
  ui.mapReport.style.whiteSpace = 'pre-wrap';
  ui.mapReport.classList.toggle('error', v.errors.length > 0);
  for (const r of rows) {
    const cell = document.querySelector(`[data-flag="${r.side}-${r.joint}"]`);
    if (cell) cell.textContent = r.flags.some((f) => /ambiguous|degenerate|not inferred/.test(f)) ? 'ambiguous' : r.flags.length ? 'note' : 'ok';
  }
  ui.hierarchy.textContent = state.rig.hierarchyLines(new Map(SIDES.flatMap((s) => Object.entries(state.mapping[s] || {}).map(([j, n]) => [n, `${s} ${j}`])))).join('\n');
  state.rig.resetToRest();
}

function buildMappingUI() {
  const rig = state.rig;
  const opts = ['<option value="">—</option>']
    .concat(rig.nodes.map((o) => `<option value="${escapeAttr(o.name)}">${' '.repeat(2 * (rig.depth.get(o) || 0))}${escapeHtml(o.name)}</option>`))
    .join('');
  let html = '<table><thead><tr><th>Joint</th><th>Left</th><th>Right</th><th>Axes</th></tr></thead><tbody>';
  for (const j of JOINTS) {
    html += `<tr><td>${j}</td>`;
    for (const s of SIDES) html += `<td><select data-map="${s}" data-joint="${j}" aria-label="${s} ${j} bone">${opts}</select></td>`;
    html += `<td><span data-flag="left-${j}"></span> / <span data-flag="right-${j}"></span></td></tr>`;
  }
  ui.mapTableWrap.innerHTML = html + '</tbody></table>';
  let ax = '<table><thead><tr><th>Joint</th><th>Left</th><th>Right</th></tr></thead><tbody>';
  for (const j of JOINTS) {
    ax += `<tr><td>${j}</td>`;
    for (const s of SIDES) ax += `<td><input data-axis="${s}" data-joint="${j}" placeholder="0 0 0" aria-label="${s} ${j} axis correction degrees"></td>`;
    ax += '</tr>';
  }
  ui.axisWrap.innerHTML = ax + '</tbody></table>';
  writeMappingUI();
}

function writeMappingUI() {
  for (const el of ui.mapTableWrap.querySelectorAll('select[data-map]')) el.value = state.mapping[el.dataset.map]?.[el.dataset.joint] || '';
  for (const el of ui.axisWrap.querySelectorAll('input[data-axis]')) {
    const v = state.axisOverrides[el.dataset.axis]?.[el.dataset.joint];
    el.value = v && v.some((x) => x) ? v.join(' ') : '';
  }
}

function readMappingUI() {
  const m = { left: {}, right: {} }, ax = { left: {}, right: {} };
  for (const el of ui.mapTableWrap.querySelectorAll('select[data-map]')) if (el.value) m[el.dataset.map][el.dataset.joint] = el.value;
  for (const el of ui.axisWrap.querySelectorAll('input[data-axis]')) {
    const v = el.value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.length === 3 && v.every(Number.isFinite) && v.some((x) => x)) ax[el.dataset.axis][el.dataset.joint] = v;
  }
  state.mapping = m;
  state.axisOverrides = ax;
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

async function loadGltfFiles(files) {
  const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (!main) throw new Error('select a .glb or .gltf file (and, for .gltf, its .bin and texture files)');
  const urls = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const name = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]);
    if (urls.has(name)) return urls.get(name);
    if (url.startsWith('blob:')) return url;
    // Privacy: never fetch remote resources referenced by an imported file.
    return 'data:application/octet-stream;base64,';
  });
  try {
    return await new GLTFLoader(manager).loadAsync(urls.get(main.name));
  } finally {
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 5000);
  }
}

async function loadRigFromGltf(gltf, name) {
  const root = gltf.scene;
  root.name = root.name || name;
  const rig = new TargetRig(root, { name, kind: 'file', fileName: name });
  if (!rig.nodes.length) throw new Error('the file contains no nodes or bones to animate');
  setRig(rig);
  const notes = [];
  if (gltf.animations?.length) notes.push(`${gltf.animations.length} embedded animation(s) ignored`);
  if (rig.renamed.length) notes.push(`${rig.renamed.length} duplicate node name(s) made unique`);
  setStatus(`Loaded rig "${name}".${notes.length ? ' ' + notes.join('; ') + '.' : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Tracking
function onTrackerStatus(s) {
  if (s.type === 'model') {
    if (s.state !== 'ready') setStatus(s.message, { error: s.state === 'failed' || s.state === 'slow' });
  } else if (s.type === 'camera') {
    state.cameraOn = false;
    pipeline.reset();
    updateButtons();
    setStatus(s.message, { error: true });
  }
}

let rateWindow = { t: performance.now(), n: 0 };
function onTrackingResult(res) {
  state.lastResult = res;
  rateWindow.n++;
  const frame = pipeline.process(res);
  state.liveFrame = frame;
  state.liveCaptureMs = res.captureMs;
  state.liveClock = res.clock;
  if (state.recordingActive) {
    state.recording.push(frame);
    updateTimeline();
  }
  drawOverlay(res);
  const cal = pipeline.calibrator;
  if (cal.state === 'countdown' || cal.state === 'capturing') setStatus(cal.message);
  else if (cal.state === 'done' || cal.state === 'failed') {
    ui.labelConvention.value = pipeline.associator.labelConvention; // may have been switched by calibration
    ui.calResult.textContent = cal.message;
    ui.calResult.classList.toggle('error', cal.state === 'failed');
    setStatus(cal.state === 'done' ? 'Calibration complete. Move your hands to preview; recalibrate any time.' : 'Calibration failed — see section 3.', { error: cal.state === 'failed' });
    cal.state = 'idle';
    updateButtons();
  }
  const seen = SIDES.filter((s) => pipeline.lastAssign?.[s]).map((s) => `${s} (MediaPipe handedness score ${pipeline.lastAssign[s].det.score?.toFixed(2) ?? 'n/a'})`);
  ui.calHands.textContent = seen.length ? seen.join(', ') : 'none';
}

const CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const SIDE_COLORS = { left: '#3a6fd8', right: '#d9732a', unassigned: '#888' };
function drawOverlay(res) {
  const c = ui.overlay;
  if (c.width !== res.width || c.height !== res.height) {
    c.width = res.width;
    c.height = res.height;
  }
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!ui.showLandmarks.checked) return;
  g.lineWidth = Math.max(2, c.width / 320);
  for (const h of res.hands) {
    const side = SIDES.find((s) => pipeline.lastAssign?.[s]?.det === h) || 'unassigned';
    g.strokeStyle = g.fillStyle = SIDE_COLORS[side];
    g.beginPath();
    for (const [a, b] of CONNECTIONS) {
      g.moveTo(h.image[a * 3] * c.width, h.image[a * 3 + 1] * c.height);
      g.lineTo(h.image[b * 3] * c.width, h.image[b * 3 + 1] * c.height);
    }
    g.stroke();
    for (let i = 0; i < 21; i++) g.fillRect(h.image[i * 3] * c.width - 2, h.image[i * 3 + 1] * c.height - 2, 4, 4);
  }
}

// The model (~7.5 MB) and WASM (~11 MB) are fetched on first camera start, not on page load,
// so playback/export-only sessions make no tracking-related requests.
let modelPromise = null;
function ensureModel() {
  if (!modelPromise) {
    modelPromise = tracker.init().catch((err) => {
      modelPromise = null;
      state.modelError = `Hand tracking model failed to load: ${err.message || err}. Check access to cdn.jsdelivr.net and storage.googleapis.com, or self-host the assets (README). Playback and export still work.`;
      throw err;
    });
  }
  return modelPromise;
}

const EMBEDDED_CAMERA_NOTE = 'Live camera tracking cannot run inside this preview: the viewer blocks camera access. Download handmocap.zip and serve the folder locally (README) to track your hands. Playback, rigs, mapping and export work here.';

async function startCamera(deviceId = null) {
  if (EMBEDDED) return setStatus(EMBEDDED_CAMERA_NOTE, { error: true });
  const model = ensureModel();
  try {
    setStatus('Starting camera…');
    const settings = await tracker.start(deviceId || ui.camSelect.value || null);
    state.cameraOn = true;
    pipeline.reset();
    ui.cam.hidden = false;
    state.mode = 'live';
    state.playing = false;
    await refreshCameraList(settings.deviceId);
    updateButtons();
    if (!tracker.ready) setStatus('Camera on. Loading hand tracking model…');
    await model;
    setStatus(`Camera on (${settings.width || ui.video.videoWidth}×${settings.height || ui.video.videoHeight}), tracking with ${tracker.mode === 'worker' ? 'a worker' : 'the main thread'} (${tracker.delegate}). Next: calibrate (section 3), then Record.`, { lock: true });
  } catch (err) {
    if (state.modelError && tracker.stream) setStatus(state.modelError, { error: true });
    else {
      state.cameraOn = false;
      tracker.stop();
      ui.cam.hidden = true;
      setStatus(cameraErrorMessage(err), { error: true });
    }
  }
  updateButtons();
}

function stopCamera() {
  tracker.stop();
  state.cameraOn = false;
  if (state.recordingActive) toggleRecord();
  pipeline.reset();
  state.liveFrame = null;
  ui.cam.hidden = true;
  updateButtons();
  setStatus('Camera stopped.');
}

async function refreshCameraList(activeId) {
  const cams = await tracker.listCameras();
  ui.camSelect.innerHTML = cams.map((d, i) => `<option value="${escapeAttr(d.deviceId)}">${escapeHtml(d.label || 'Camera ' + (i + 1))}</option>`).join('') || '<option value="">(no cameras)</option>';
  if (activeId) ui.camSelect.value = activeId;
  ui.camSelect.disabled = cams.length < 2 && !state.cameraOn;
}

// ---------------------------------------------------------------------------------------------
// Recording and playback
function toggleRecord() {
  if (!state.recordingActive) {
    state.recording = new Recording({
      source: 'webcam (MediaPipe Hand Landmarker, tasks-vision 1.0.1)',
      settings: { ...pipeline.settings, labelConvention: pipeline.associator.labelConvention },
      calibration: { left: pipeline.calibration.left, right: pipeline.calibration.right },
    });
    state.recordingActive = true;
    state.mode = 'live';
    state.playing = false;
    setStatus('Recording… press Stop to finish.');
  } else {
    state.recordingActive = false;
    const n = state.recording.frames.length;
    setStatus(n ? `Recorded ${n} samples (${state.recording.duration.toFixed(2)} s). Play, scrub, or export.` : 'Nothing recorded (no camera frames arrived).');
    if (!n) state.recording = null;
  }
  updateButtons();
  updateTimeline();
}

function setRecording(rec, label) {
  state.recording = rec;
  state.recordingActive = false;
  state.mode = 'playback';
  state.playTime = 0;
  state.playing = false;
  updateButtons();
  updateTimeline();
  setStatus(`Loaded ${label}: ${rec.frames.length} samples, ${rec.duration.toFixed(2)} s${/synthetic/.test(rec.meta.source) ? ' (synthetic example, not a camera capture)' : ''}. Press Play or scrub.`);
}

function updateTimeline() {
  const d = state.recording?.duration || 0;
  ui.scrub.max = String(Math.max(d, 0.001));
  if (state.recordingActive) ui.timeOut.textContent = `rec ${d.toFixed(2)} s`;
  else {
    ui.scrub.value = String(state.playTime);
    ui.timeOut.textContent = `${state.playTime.toFixed(2)} / ${d.toFixed(2)} s`;
  }
}

function updateButtons() {
  const hasRec = !!state.recording && state.recording.frames.length > 0 && !state.recordingActive;
  ui.camStart.disabled = state.cameraOn || EMBEDDED;
  ui.camStop.disabled = !state.cameraOn;
  ui.camSelect.disabled = !state.cameraOn;
  ui.calStart.disabled = !state.cameraOn;
  ui.recBtn.disabled = !state.cameraOn;
  ui.recBtn.textContent = state.recordingActive ? 'Stop' : 'Record';
  ui.recBtn.setAttribute('aria-pressed', String(state.recordingActive));
  ui.playBtn.disabled = !hasRec;
  ui.playBtn.textContent = state.playing ? 'Pause' : 'Play';
  ui.scrub.disabled = !hasRec;
  ui.liveBtn.disabled = !state.cameraOn || state.mode === 'live';
  ui.exportGlb.disabled = !hasRec || !state.adapter;
  ui.exportJson.disabled = !hasRec;
  ui.exportRaw.disabled = !hasRec || !state.recording.hasRaw();
}

// ---------------------------------------------------------------------------------------------
// Export
// Returns true when the file was handed to the browser (or the viewer accepted the save).
async function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  if (EMBEDDED && window.claude?.use) {
    const downloads = await window.claude.use('downloads');
    if (!downloads) throw new Error('saving files is not available in this view');
    let file = blob, fname = name;
    if (!/\.(json|txt|csv|zip)$/i.test(name)) {
      // The viewer only saves an allowlist of types; .glb goes inside a .zip.
      file = new Blob([zipStore([{ name, data: new Uint8Array(await blob.arrayBuffer()) }])]);
      fname = name.replace(/\.[^.]+$/, '') + '.zip';
    }
    try {
      await downloads.save({ filename: fname, data: file });
      return true;
    } catch (e) {
      if (e?.code === 'declined') return false;
      throw new Error(e?.message || e?.code || 'save failed');
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function retargetOpts(rec = null) {
  const cal = rec?.meta?.calibration && (rec.meta.calibration.left || rec.meta.calibration.right) ? rec.meta.calibration : pipeline.calibration;
  return { wristMode: ui.wristMode.value, rootPolicy: ui.rootPolicy.value, calibration: cal, positionScale: 'auto' };
}

async function exportGlbAction() {
  const rec = state.recording;
  const fps = Number(ui.exportFps.value);
  ui.exportResult.textContent = 'Baking and exporting…';
  try {
    const baked = bakeRigAnimation(state.adapter, rec, fps, retargetOpts(rec), 'HandMocap');
    const buf = await exportGLB(state.rig, baked.clip);
    const rep = await verifyGLB(buf, baked);
    const name = `handmocap-${(state.rig.fileName || 'builtin-hands').replace(/\.(glb|gltf)$/i, '')}-${stamp()}.glb`;
    const saved = await download(new Blob([buf], { type: 'model/gltf-binary' }), name, 'model/gltf-binary');
    ui.exportResult.textContent = `${saved ? '' : 'Not saved (declined). '}${name}${EMBEDDED ? ' (inside a .zip)' : ''}: ${baked.frameCount} frames @ ${fps} fps, ${rep.channels} channels. Re-import check ${rep.ok ? 'passed' : 'FAILED'}: ${rep.matched}/${rep.channels} channels bound, max rotation error ${rep.maxRotErrDeg.toFixed(5)}°${rep.missing.length ? ', missing: ' + rep.missing.slice(0, 5).join(', ') : ''}.`;
    ui.exportResult.classList.toggle('error', !rep.ok);
  } catch (err) {
    ui.exportResult.textContent = 'Export failed: ' + err.message;
    ui.exportResult.classList.add('error');
  }
  state.rig.resetToRest();
}

// ---------------------------------------------------------------------------------------------
// Render loop (rendering only: tracking and solving happen in onTrackingResult)
let lastT = performance.now(), fpsWin = { t: lastT, n: 0 }, lastDiag = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  fpsWin.n++;
  if (now - fpsWin.t > 500) {
    state.fps = (fpsWin.n * 1000) / (now - fpsWin.t);
    state.processedRate = (rateWindow.n * 1000) / (now - rateWindow.t);
    fpsWin = { t: now, n: 0 };
    rateWindow = { t: now, n: 0 };
  }
  const opts = retargetOpts(state.mode === 'playback' ? state.recording : null);
  if (state.adapter) {
    if (state.mode === 'playback' && state.recording && !state.recordingActive) {
      if (state.playing) {
        state.playTime += dt;
        if (state.playTime >= state.recording.duration) {
          state.playTime = state.recording.duration;
          state.playing = false;
          updateButtons();
        }
        updateTimeline();
      }
      state.adapter.apply(state.recording.sampleAt(state.playTime), opts);
    } else if (state.liveFrame) state.adapter.apply(state.liveFrame, opts);
    else state.adapter.apply(null);
  }
  if (renderer) renderer.render(scene, camera);
  if (now - lastDiag > 250) {
    lastDiag = now;
    updateDiag(now);
  }
}

function updateDiag(now) {
  const parts = [`render ${state.fps == null ? '—' : state.fps.toFixed(0)} fps`];
  if (state.cameraOn && state.lastResult) {
    const r = state.lastResult;
    parts.push(`inference ${(tracker.inferEma ?? r.inferMs).toFixed(1)} ms (${tracker.mode}, ${tracker.delegate}, input ${r.inputW}×${r.inputH})`);
    parts.push(`processed ${state.processedRate.toFixed(1)}/s, dropped ${tracker.stats.dropped}`);
    if (state.mode === 'live' && state.liveCaptureMs != null) parts.push(`sample age ${(now - state.liveCaptureMs).toFixed(0)} ms (from ${state.liveClock})`);
  }
  parts.push(state.mode === 'playback' ? 'mode: playback' : state.cameraOn ? 'mode: live' : 'mode: idle');
  const lines = [parts.join(' | ')];
  const f = state.mode === 'playback' && state.recording ? state.recording.sampleAt(state.playTime) : state.liveFrame;
  if (f) {
    lines.push(
      SIDES.map((s) => {
        const h = f.hands[s];
        if (!h) return `${s}: —`;
        const bits = [`${s}: ${h.status}`];
        if (h.id) bits.push(h.id);
        if (h.handednessScore != null) bits.push(`MediaPipe handedness ${h.handednessScore.toFixed(2)}`);
        if (h.stability != null) bits.push(`stability ${h.stability.toFixed(2)} (heuristic)`);
        if (h.fingerValid.some((v) => !v)) bits.push('some fingers held');
        return bits.join(', ');
      }).join(' | '),
    );
  }
  ui.diag.textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Events
ui.camStart.onclick = () => startCamera();
ui.camStop.onclick = stopCamera;
ui.camSelect.onchange = () => state.cameraOn && startCamera(ui.camSelect.value);
ui.mirror.onchange = () => {
  ui.cam.classList.toggle('mirrored', ui.mirror.checked);
  ui.viewPreset.value = ui.mirror.checked ? 'performer' : 'camera';
  applyViewPreset();
};
ui.showLandmarks.onchange = () => state.lastResult && drawOverlay(state.lastResult);
ui.viewPreset.onchange = applyViewPreset;
ui.viewReset.onclick = frameView;

ui.rigBuiltin.onclick = () => {
  setRig(new TargetRig(buildProceduralHands(), { name: 'built-in hands', kind: 'builtin' }));
  setStatus('Using the built-in procedural hands.');
};
ui.rigFile.onchange = async () => {
  const files = [...ui.rigFile.files];
  ui.rigFile.value = '';
  if (!files.length) return;
  try {
    setStatus('Loading rig…');
    const gltf = await loadGltfFiles(files);
    await loadRigFromGltf(gltf, files.find((f) => /\.(glb|gltf)$/i.test(f.name)).name);
  } catch (err) {
    setStatus('Invalid rig: ' + (err.message || err), { error: true });
  }
  updateButtons();
};
async function loadExampleRig(file) {
  try {
    setStatus('Loading ' + file + '…');
    let gltf;
    if (EMBEDDED) {
      // The artifact viewer does not serve .glb files; the examples ship as base64 in JSON.
      const j = await (await fetch('examples/' + file + '.b64.json')).json();
      const bin = Uint8Array.from(atob(j.base64), (c) => c.charCodeAt(0));
      gltf = await new Promise((res, rej) => new GLTFLoader().parse(bin.buffer, '', res, rej));
    } else gltf = await new GLTFLoader().loadAsync('examples/' + file);
    await loadRigFromGltf(gltf, file);
  } catch (err) {
    setStatus('Could not load example rig: ' + (err.message || err), { error: true });
  }
  updateButtons();
}
ui.rigB.onclick = () => loadExampleRig('rig-b-mixamo-style.glb');
ui.rigC.onclick = async () => {
  await loadExampleRig('rig-c-unreal-style.glb');
  try {
    const prof = await (await fetch('examples/profile-rig-c.json')).json();
    // Mapping and settings only: the example's calibration is synthetic, not the performer's.
    applyProfile(prof, 'example rig C with its example profile (mapping and settings; calibrate with your own hands)', { withCalibration: false });
  } catch {}
};
ui.mapSuggest.onclick = () => {
  state.mapping = state.rig.kind === 'builtin' ? builtinMapping() : suggestMapping(state.rig);
  writeMappingUI();
  applyMapping();
  updateButtons();
};
ui.mapApply.onclick = () => {
  applyMapping();
  updateButtons();
};
ui.mapClear.onclick = () => {
  state.mapping = { left: {}, right: {} };
  state.axisOverrides = { left: {}, right: {} };
  writeMappingUI();
  applyMapping();
  updateButtons();
};

ui.profileSave.onclick = () => {
  readMappingUI();
  const prof = makeProfile(state.rig, state.mapping, {
    axisOverrides: state.axisOverrides,
    calibration: pipeline.calibration,
    settings: { wristMode: ui.wristMode.value, rootPolicy: ui.rootPolicy.value, labelConvention: ui.labelConvention.value, positionScale: 'auto' },
  });
  download(JSON.stringify(prof, null, 1), `handmocap-profile-${(state.rig.fileName || 'builtin-hands').replace(/\.(glb|gltf)$/i, '')}.json`, 'application/json').catch((err) => setStatus('Could not save the profile: ' + err.message, { error: true }));
};
function applyProfile(obj, label, { withCalibration = true } = {}) {
  const p = parseProfile(obj, state.rig);
  state.mapping = p.mapping;
  state.axisOverrides = p.axisOverrides;
  if (withCalibration) for (const s of SIDES) pipeline.calibration[s] = p.calibration[s];
  if (p.settings.wristMode) ui.wristMode.value = p.settings.wristMode;
  if (p.settings.rootPolicy) ui.rootPolicy.value = p.settings.rootPolicy;
  if (p.settings.labelConvention) {
    ui.labelConvention.value = p.settings.labelConvention;
    pipeline.setLabelConvention(p.settings.labelConvention);
  }
  pipeline.settings.rootPolicy = ui.rootPolicy.value;
  writeMappingUI();
  applyMapping();
  showCalibration();
  setStatus(`Loaded ${label}.${p.warnings.length ? ' Warning: ' + p.warnings.join('; ') : ''}`, { error: p.warnings.length > 0 });
  updateButtons();
}
ui.profileFile.onchange = async () => {
  const f = ui.profileFile.files[0];
  ui.profileFile.value = '';
  if (!f) return;
  try {
    applyProfile(JSON.parse(await f.text()), 'rig profile ' + f.name);
  } catch (err) {
    setStatus('Could not load profile: ' + err.message, { error: true });
  }
};

function showCalibration() {
  const parts = SIDES.filter((s) => pipeline.calibration[s]).map((s) => {
    const c = pipeline.calibration[s];
    return `${s}: ${c.frames} frames, jitter ${Number(c.jitterDeg).toFixed(1)}°`;
  });
  ui.calResult.textContent = parts.length ? 'Calibrated — ' + parts.join(' | ') : 'Not calibrated (neutral = flat open hand).';
  ui.calResult.classList.remove('error');
}
ui.calStart.onclick = () => {
  if (!pipeline.lastFrame) return setStatus('Waiting for camera frames…');
  pipeline.startCalibration(pipeline.lastFrame.t);
  ui.calResult.textContent = 'Calibrating…';
};
ui.calClear.onclick = () => {
  pipeline.calibration = { left: null, right: null };
  showCalibration();
};

const syncSettings = () => {
  Object.assign(pipeline.settings, {
    hands: ui.hands.value,
    smoothing: Number(ui.smoothing.value),
    rootPolicy: ui.rootPolicy.value,
    holdTime: Math.max(0, Number(ui.holdMs.value) || 0) / 1000,
    blendTime: Math.max(0, Number(ui.blendMs.value) || 0) / 1000,
    lossPose: ui.lossPose.value,
    thumbTwist: Math.max(0, Math.min(60, Number(ui.thumbTwist.value) || 0)) * DEG,
    recordRaw: ui.recordRaw.checked,
  });
  ui.smoothingOut.textContent = Number(ui.smoothing.value).toFixed(2);
};
for (const el of [ui.hands, ui.smoothing, ui.rootPolicy, ui.holdMs, ui.blendMs, ui.lossPose, ui.thumbTwist, ui.recordRaw]) el.addEventListener('input', syncSettings);
ui.labelConvention.onchange = () => pipeline.setLabelConvention(ui.labelConvention.value);

ui.recBtn.onclick = toggleRecord;
ui.playBtn.onclick = () => {
  if (!state.recording) return;
  state.mode = 'playback';
  if (!state.playing && state.playTime >= state.recording.duration) state.playTime = 0;
  state.playing = !state.playing;
  updateButtons();
};
ui.liveBtn.onclick = () => {
  state.mode = 'live';
  state.playing = false;
  updateButtons();
};
ui.scrub.oninput = () => {
  state.mode = 'playback';
  state.playing = false;
  state.playTime = Number(ui.scrub.value);
  updateTimeline();
  updateButtons();
};
ui.recFile.onchange = async () => {
  const f = ui.recFile.files[0];
  ui.recFile.value = '';
  if (!f) return;
  try {
    setRecording(Recording.fromJSON(JSON.parse(await f.text())), f.name);
  } catch (err) {
    setStatus('Could not load recording: ' + err.message, { error: true });
  }
};
ui.recExample.onclick = async () => {
  try {
    const obj = await (await fetch('examples/example-recording.json')).json();
    setRecording(Recording.fromJSON(obj), 'example recording');
  } catch (err) {
    setStatus('Could not load example recording: ' + err.message, { error: true });
  }
};
ui.exportGlb.onclick = exportGlbAction;
ui.exportJson.onclick = () => {
  const fps = Number(ui.exportFps.value);
  const rec = state.recording;
  const cal = retargetOpts(rec).calibration;
  download(JSON.stringify(rec.toJSON({ fps, calibration: cal })), `handmocap-motion-${stamp()}.json`, 'application/json')
    .then((ok) => (ui.exportResult.textContent = ok ? `Canonical motion JSON exported (${fps} fps resampled, HandMocap schema v1).` : 'Not saved (declined).'))
    .catch((err) => (ui.exportResult.textContent = 'Export failed: ' + err.message));
};
ui.exportRaw.onclick = () => {
  download(JSON.stringify(state.recording.rawToJSON()), `handmocap-raw-landmarks-${stamp()}.json`, 'application/json')
    .then((ok) => (ui.exportResult.textContent = ok ? 'Raw landmark JSON exported (diagnostic, original sample times).' : 'Not saved (declined).'))
    .catch((err) => (ui.exportResult.textContent = 'Export failed: ' + err.message));
};

document.addEventListener('visibilitychange', () => {
  // Returning from a background tab: temporal state is stale.
  if (document.visibilityState === 'visible' && state.cameraOn) pipeline.reset();
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => state.cameraOn && refreshCameraList(ui.camSelect.value));
window.addEventListener('pagehide', () => tracker.dispose());

// ---------------------------------------------------------------------------------------------
// Boot
syncSettings();
ui.cam.classList.toggle('mirrored', ui.mirror.checked);
setRig(new TargetRig(buildProceduralHands(), { name: 'built-in hands', kind: 'builtin' }));
resize();
updateButtons();
requestAnimationFrame(loop);
if (EMBEDDED) {
  ui.camStart.disabled = true;
  ui.camStart.title = 'Camera access is blocked in this preview';
  setStatus(EMBEDDED_CAMERA_NOTE);
} else if (location.protocol !== 'file:') setStatus('Ready. Start the camera, or load the example recording to try playback and export without one.');
window.handmocap = { state, pipeline, tracker, camera, controls }; // for debugging and automated tests
