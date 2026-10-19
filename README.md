# HandMocap

Webcam hand motion capture in the browser. MediaPipe Hand Landmarker tracks up to two hands; a
skeletal solver turns the landmarks into wrist orientation and finger joint rotations; an adapter
retargets them onto the built-in hand rig or an imported glTF rig; recordings export as an
animated GLB (standard glTF 2.0 skin animation) or as HandMocap JSON.

Workflow: **Start camera → Calibrate → move your hands → Record → Export**.

No account, server, build step, glove or special camera. Video is processed on the device and is
not uploaded (see Privacy for MediaPipe's metrics notice).

## Launch

**Windows:** double-click **`Start HandMocap.bat`** in the folder. It starts a small local server
using PowerShell's built-in web listener (nothing is installed), opens
`http://localhost:8080` in your default browser, and keeps running until you close its window.
Allow camera access when the browser asks. The launcher runs `tools/serve.ps1` with
`-ExecutionPolicy Bypass` for that one process; no system setting is changed.

Any other system: the app is a static folder with `index.html` at its root. Serve it over
`http://localhost` or any HTTPS host:

```sh
cd handmocap
python3 -m http.server 8080      # or: npx serve .
# open http://localhost:8080
```

Opening `index.html` directly from disk (`file://`) is not supported: browsers block ES module
loading and camera access there. The page shows a notice if you try.

Any static HTTPS host works (GitHub Pages, Netlify, S3, nginx). There is no server code.

Browser support: tested in Chromium (desktop). Needs WebGL 2 for the 3D view, `getUserMedia` for
the camera, ES modules and import maps. Workers with `OffscreenCanvas` are used when available.
Firefox and Safari are expected to work but were not tested.

## Controls

**1. Camera**
- **Start / Stop camera**. Stopping releases the camera.
- **Camera**: choose a device. Switching restarts tracking and clears temporal state.
- **Mirror preview**: mirrors the webcam thumbnail only. It never changes the tracking data or the
  left/right assignment.
- **Landmark overlay**: draws the MediaPipe landmarks. Blue = left hand, orange = right hand,
  grey = not assigned.
- **View**: *from performer* (behind your hands, like a mirror) or *from webcam*. **Reset view**
  re-frames the rig. Drag to orbit, scroll to zoom.

**2. Rig**
- **Built-in hands**: procedural two-hand rig (blue = left, orange = right). It is the default.
- **Load GLB/glTF…**: import a local file. For `.gltf`, select the `.gltf` together with its `.bin`
  and texture files. Remote URLs inside imported files are never fetched.
- **Validation rigs B / C**: the two example rigs in `examples/` (see Supported rigs).
- **Map bones**: one bone drop-down per canonical joint and side, with the hierarchy indented.
  - **Suggest** fills it from bone names.
  - **Apply mapping** rebuilds the retargeting adapter. The report under the panel lists errors,
    warnings and per-bone notes.
  - **Per-bone axis corrections** (X Y Z degrees): use these if a finger bends the wrong way.
  - **Bone hierarchy**: lists every node, its skin weights and its mapping.
- **Save / Load rig profile**: versioned JSON holding the mapping, axis corrections, calibration
  and settings.

**3. Calibrate**
- Show open hands, palms to the camera, fingers up, about 50 cm away.
- **Calibrate** counts down 2 s, then captures many frames. Unstable frames are rejected, and the
  neutral pose is averaged per hand.
- The result line shows frames used and jitter. Recalibrate any time. **Clear calibration** goes
  back to the flat-hand default.

**Tracking**
- **Hands**: both, left only or right only.
- **Smoothing**: 0 = off. Default 0.35 is low-latency. Higher values are smoother and lag more.
- **Advanced** (collapsed):
  - **Root**: *fixed* (default; wrist rotation and fingers only) or *approximate screen-space
    position* (moves the wrist bone; an estimate, see Limitations).
  - **Wrist**: *absolute* matches the hand's orientation in camera space (default for the built-in
    rig). *Relative to calibration pose* applies rotation since calibration to the rig's rest
    hand (default for imported body rigs, whose rest arms usually point sideways).
  - **On tracking loss**: hold time, blend time, and target pose (relaxed hand or rest pose).
  - **Handedness labels**: *use as reported* (default) or *swap*. Calibration detects an inverted
    convention and switches it automatically.
  - **Thumb twist coupling**: modelled thumb axial roll during opposition. Set 0 to disable.
  - **Record raw landmarks**: stores MediaPipe output for the raw-landmark export.

**4. Record** (bottom strip)
- **Record / Stop**.
- **Play / Pause** and the scrub bar work without a camera.
- **Live** returns to live tracking.
- **Load recording…** reads a canonical-motion JSON. **Example recording** loads
  `examples/example-recording.json`.

**5. Export**
- **Frame rate**: 24 / 25 / 30 / 60.
- **Rig animation (.glb)**: bakes, downloads, then re-imports the file and reports whether every
  channel bound and matched.
- **Canonical motion (.json)**.
- **Raw landmarks (.json)**: enabled only if raw landmarks were recorded.

Diagnostics (bottom of the 3D view) are all measured, never estimated:
- render FPS;
- inference duration: time spent inside `detectForVideo` only, not end-to-end latency;
- frames processed and dropped per second;
- sample age: time from camera capture, when the browser provides `captureTime`, otherwise from the
  frame callback, to display;
- per hand: status, track id, MediaPipe's handedness score, and a stability value labelled
  heuristic.

URL options for troubleshooting: `?delegate=cpu` forces CPU inference; `?worker=off` forces the
main-thread fallback.

## Supported rigs

"Rig agnostic" here means one canonical hand-motion representation plus a configurable adapter per
rig. It does not mean any character works without setup.

What the adapter handles without solver changes:
- Different bone names, lengths, local axes and roll.
- Rest poses: T-pose, A-pose, curled or flat fingers.
- Unit scale on the armature, e.g. Mixamo's 0.01.
- Intermediate unmapped bones such as metacarpals.
- Unrelated body bones, which are left untouched.

Requirements:
- A glTF 2.0 / GLB file whose hands are node hierarchies: skinned bones or plain nodes.
- At least **wrist, index1 and pinky1 (or ring1)** mapped per side, so the palm frame can be
  inferred from the rest pose.
- Missing finger segments are allowed. A segment's rotation is folded into the nearest mapped
  segment of the same finger (for example a two-segment pinky).

Name suggestions recognise these conventions. Every suggestion can be changed.

| Convention | Example bone names |
|---|---|
| Mixamo | `mixamorig:LeftHandIndex1..4` |
| Unreal | `hand_l`, `index_01_l`, `index_metacarpal_l` |
| Blender metarig / Rigify | `f_index.01.L`, `DEF-thumb.01.L` |
| VRM / Unity humanoid | `J_Bip_L_Index1`, `LeftIndexProximal` |
| 3ds Max Biped | `Bip01 L Finger01` |

Tip and end bones, control bones (`ik`, `ctrl`, `mch`, …) and metacarpals are skipped. For the
thumb, a metacarpal bone is the first joint.

How axes are inferred:
- In the rest pose, each mapped bone gets an anatomical frame: +Y toward the child joint, +Z the
  palm normal made perpendicular.
- The palm normal comes from wrist, knuckles and side. This is the same construction the solver
  uses on landmarks.
- Bones with no child use the parent segment direction. These, and bones nearly parallel to the
  palm normal, are flagged in the mapping report. Use the per-bone axis corrections there if needed.

Reported as unsupported or warned about:
- Mapped bones with no skin weights. These are typically control bones driven by constraints that
  glTF does not carry, so animating them does not deform the mesh.
- Non-uniform or negative scale above the wrist.
- Duplicate or unnamed nodes. These are renamed uniquely, and the rename is reported.
- Bones mapped twice, or a finger mapped above the wrist.
- Embedded animations are ignored. Morph-target or constraint-based hand rigs are not supported.

**Included rigs**

- **Built-in procedural hands.** Its bone axes equal the canonical frames. Rest pose is a flat hand
  facing the camera.
- **`examples/rig-b-mixamo-style.glb`.**
  - Mixamo names.
  - +Y along each bone, with arbitrary roll (+37° left, −52° right).
  - Armature scale 0.01, so bones are in centimetres.
  - T-pose, palms down, straight fingers, with tip bones.
- **`examples/rig-c-unreal-style.glb`.**
  - Unreal names.
  - Bone axis +X on the right side and −X on the left side (mirrored axes).
  - Metres.
  - A-pose, palms facing the body, relaxed curled fingers.
  - Metacarpal bones, no tip bones, and a two-segment pinky.
  - Unskinned IK helper bones.
- **`examples/profile-rig-c.json`.** Example rig profile for rig C. Its calibration is synthetic,
  so the C button loads only its mapping and settings.

## Calibration

The neutral pose is an open hand with the palm toward the camera. For each side, calibration:
- collects at least 30 frames;
- rejects frames more than 10° (fingers) or 12° (wrist) from the median;
- averages finger flexion and spread offsets, the thumb rest direction, thumb MCP/IP neutral
  rotations, the wrist orientation, a reference for approximate position, and palm length (scale).

After calibration, this pose maps exactly to the rig's rest pose.

Calibration also checks that the computed palm normal faces the camera. If every captured hand
faces away, the handedness-label convention is inverted. Calibration switches it and re-solves
from the same frames. If only one hand faces away, that hand is reported (back of hand shown).

## Recording and export

Recording stores **canonical motion** samples with the tracker's capture timestamps. It is
independent of render frame rate and does not record the 3D view as video. Playback interpolates
between samples (slerp with sign alignment).

Exports are three distinct outputs.

**1. Rig animation (`.glb`).** This is a standard skeletal-animation format: glTF 2.0.
- Contents: the current rig at its rest pose (mesh, skin, inverse bind matrices unchanged) plus one
  animation clip named `HandMocap`.
- Keys: rotation for every driven bone, LINEAR, resampled at the chosen frame rate with
  quaternion sign continuity.
- Wrist translation keys are written only in approximate-position mode.
- The clip plays without HandMocap. After each export the app re-imports the file with three.js,
  plays it through an `AnimationMixer`, and compares every channel at every key with the baked
  values.
- Files pass the Khronos glTF validator with 0 errors. The one warning,
  `NODE_SKINNED_MESH_NON_ROOT`, is the same one Blender's exporter produces.

**2. Canonical motion (`.json`).** This is HandMocap's own schema (`handmocap.canonical-motion`,
version 1), not a universal mocap format.
- Contents: frames resampled at the chosen rate. Each frame has, per hand: track id, status
  (`tracked | resuming | held | blending | lost`), the `observed` flag, the MediaPipe handedness
  score, the heuristic stability, the absolute wrist quaternion, 15 rest-relative joint
  quaternions, optional approximate root, and per-finger validity.
- It also carries calibration metadata and a `conventions` block describing everything below.
- It can be loaded back as a recording.

**3. Raw landmarks (`.json`).** Diagnostic data (`handmocap.raw-landmarks`).
- Contents: MediaPipe's image and world landmarks, plus the label and score as reported, at the
  original sample times.
- Recorded only when enabled in Advanced.

### Conventions

| Item | Convention |
|---|---|
| Units | metres |
| Canonical world | right-handed, +Y up, +X image-right (performer's left), +Z from performer toward the camera. From MediaPipe world landmarks: (x, −y, −z). A glTF character facing +Z faces the camera. |
| Hand frame | +Y distal (wrist → middle knuckle), +Z palmar, +X = Y × Z. Thumb side on right hands, little-finger side on left hands. No mirroring. |
| Bone frame | +Y along the bone, +Z palm normal ⊥ bone, +X = Y × Z. Rotation about +X is flexion on both hands. |
| Quaternion order | `[x, y, z, w]` |
| `wrist` | absolute hand-frame orientation in canonical world |
| `joints` | rest-relative local rotations, parent → child (`thumb1..3`, `index1..3`, …, `pinky1..3`). Identity = calibrated neutral open hand. Joint *n* is in the frame of joint *n−1*; `*1` joints are relative to the palm. |
| `root` | approximate camera-space estimate, only with the approximate root policy |

## Dependencies and self-hosting

| Asset | Pinned version | Default URL |
|---|---|---|
| three.js | 0.186.1 | `cdn.jsdelivr.net/npm/three@0.186.1/` (import map in `index.html`) |
| MediaPipe Tasks Vision bundle | 1.0.1 | `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs` (`config.js`) |
| MediaPipe WASM | 1.0.1 | `…/tasks-vision@1.0.1/wasm/`: classic and ES-module loaders, SIMD and non-SIMD (`config.js`) |
| Hand landmarker model | float16/1 | `storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` (`config.js`) |

- The tracking assets (about 11 MB WASM + 7.5 MB model) load on the first **Start camera**, not on
  page load.
- Playback and export sessions make no tracking-related requests.
- The app's own code requests only these URLs. In every test run no other request was made (see
  Privacy for MediaPipe's metrics notice).

To self-host everything, run `node tools/vendor.mjs` (needs node ≥ 18 and npm). It downloads the
pinned files into `vendor/` (about 44 MB) and rewrites the import map and `config.js` to point
there.
- If your environment cannot reach Google's model URL, download the model yourself and add
  `--model path/to/hand_landmarker.task`.
- `node tools/vendor.mjs --revert` restores the CDN URLs.
- You can also copy the files by hand into any location and edit the four URLs.

## Privacy

- Camera frames are processed on your device: in a Web Worker, or on the main thread as a fallback.
- Video, landmarks, rigs, profiles and recordings are never uploaded by this app.
- Files you import are read locally. Exports are generated locally and downloaded by your browser.
- The app adds no analytics, cookies or accounts of its own.
- **MediaPipe metrics notice.** The privacy notice shipped in `@mediapipe/tasks-vision` (README,
  "Privacy Notice", last modified 5 June 2026) says input images are processed on device and not
  sent to Google, but that MediaPipe Tasks APIs send performance and usage metrics to Google, and
  that the app developer is responsible for obtaining users' informed consent where the law
  requires it.
  - In this project's browser tests (sessions of up to about a minute, every external request
    logged), no metrics request was observed. The 1.0.1 web WASM contains a `TasksDummyLogger`
    class and no upload endpoint string.
  - That is not proof that no metrics are ever sent. If you distribute the app, treat the notice
    as applying, and get consent or verify the network traffic in long real sessions yourself.

## Limitations

One ordinary webcam is a monocular, low-frame-rate sensor:
- **Hidden fingers.** Fingers hidden behind the palm or the other hand cannot be recovered. MediaPipe
  guesses them, and the result can be wrong while still looking confident.
- **Hand translation.** Global hand translation is not measured. MediaPipe world landmarks are
  hand-relative. The approximate position mode estimates position from apparent hand size with an
  assumed 60° horizontal field of view, so depth and scale are approximate.
- **Bone twist.** Twist about finger bones is not observable, so it is held at zero. Thumb axial roll
  is modelled from opposition, not measured.
- **Spread and wrist.** Spread is attenuated as fingers flex, because spread is ill-defined for a
  strongly flexed finger. Wrist orientation is usually most stable with the palm toward the camera
  and less stable edge-on (not quantified here).
- **Tracking loss.** Fast motion, motion blur, gloves, low light and two overlapping hands cause
  dropouts:
  - the last pose is held (300 ms default), then blended to the loss pose (500 ms);
  - when tracking resumes, the pose blends back in over 200 ms;
  - overlapping hands are held rather than risking a left/right swap.
- **Accuracy.** This is not studio-grade motion capture. Expect to clean up exported animation for
  hero shots.

## Development

```sh
npm install                 # three.js for the node tests and tools only
npm test                    # solver, pipeline, retargeting, export round-trip tests (node)
npm run bench               # per-frame cost of the JS layers
npm run make-rigs           # regenerate examples/rig-b/c GLBs
npm run make-example        # regenerate examples/example-recording.json and profile-rig-c.json
python3 tests/browser_test.py --help   # headless-Chrome tests (Playwright; see its docstring)
```

Layout:

| Layer | File |
|---|---|
| Webcam and tracking | `src/tracking.js`, `src/tracker-worker.js` |
| Left/right association | `src/association.js` |
| Conditioning, validity, filtering, loss handling | `src/conditioning.js`, `src/filters.js` |
| Canonical solver | `src/solver.js`, `src/handmodel.js`, `src/canonical.js` |
| Mapping and calibration | `src/mapping.js`, `src/calibration.js` |
| Retargeting | `src/retarget.js`, `src/rigs.js` |
| Recording and export | `src/recording.js`, `src/export.js` |
| UI | `index.html`, `style.css`, `src/main.js` |

`src/pipeline.js` glues layers 2 to 5 without any DOM, so the same code runs in node tests.
