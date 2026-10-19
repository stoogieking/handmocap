# Implementation and validation report

## What was built

The app runs entirely in the browser as a static site (`index.html`, `style.css`, `config.js`,
`src/`). Each pipeline layer lives in its own module:

1. **Tracking.** `tracking.js` runs MediaPipe Hand Landmarker (Tasks Vision 1.0.1, VIDEO mode, two
   hands) in a module worker, with a main-thread fallback.
   - `requestVideoFrameCallback` drives it, so each camera frame is processed at most once.
   - Frames that arrive while inference is busy are dropped, never queued.
   - Input size adapts down only if that measurably reduces inference time.
2. **Association.** `association.js` gives each hand a persistent track id, matched by image
   position rather than detection order.
   - Side evidence = MediaPipe label vote + a geometric chirality vote (finger curl relative to the
     palm), with hysteresis.
   - An identity change is accepted when a confident label and clear geometry both contradict the
     track for 2 frames.
   - Overlapping hands are marked ambiguous and held.
3. **Conditioning.** `conditioning.js` and `filters.js` handle:
   - validity checks: finite values, plausible palm size, finger segment proportions, palm-frame
     degeneracy, implausible wrist flips;
   - time-aware One Euro filtering of landmarks and quaternions;
   - tracking loss: hold, then blend to a neutral pose, then blend back in on resume.
4. **Solver.** `solver.js` and `handmodel.js`:
   - palm frame from wrist and four knuckles;
   - per finger: Rz(spread)·Rx(flex) at the knuckle and 1-DOF hinges distally, with twist held at
     zero;
   - thumb: a separate 2-DOF metacarpal swing, opposition-coupled axial twist, and MCP/IP minimal
     swings;
   - calibration offsets removed, then anatomical limits applied to the deltas.
5. **Mapping and calibration.** `mapping.js` and `calibration.js`:
   - name-based mapping suggestions across five conventions, and validation;
   - versioned rig profiles;
   - multi-frame robust neutral calibration with palm-facing verification and automatic
     handedness-convention correction.
6. **Retargeting.** `retarget.js` infers a per-bone anatomical frame from each rig's rest geometry
   and computes `local = restLocal · C · D · C⁻¹` for every frame, from stored rest values only.
   - Wrist modes: absolute or calibration-relative.
   - Optional approximate root offset.
   - Missing segments are folded into the nearest mapped one.
7. **Recording and export.** `recording.js` and `export.js`:
   - capture-timestamped canonical recording;
   - slerp interpolation and timestamp resampling with sign continuity;
   - canonical JSON, raw landmark JSON, and a baked glTF 2.0 GLB with automatic re-import
     verification.
8. **UI.** `main.js` uses native controls only.
   - Diagnostics: render FPS, inference time, processed/dropped frames, sample age (from capture),
     MediaPipe handedness score, and heuristic stability.

Deliverables:
- the built-in procedural rig;
- two validation rigs with different naming, axes, units and rest poses (`examples/rig-b-*`,
  `rig-c-*`);
- an example profile (`profile-rig-c.json`);
- a synthetic example recording;
- README;
- node and browser test suites.

## Assumptions and decisions

- **Interface.** Native controls and minimal CSS, as the scope-control requirement takes precedence
  over the spec's "polished" wording.
- **Default handedness convention: `reported`.** The legacy MediaPipe Hands docs say labels assume a
  mirrored input. With Tasks Vision 1.0.1 on unmirrored frames, labels matched the hands' actual
  chirality (see validation below).
  - Calibration verifies the convention geometrically and switches it automatically if needed.
- **The 3D view is never mirrored.** The *from performer* camera preset gives the same left/right
  screen layout as the mirrored webcam preview.
- **Wrist mode defaults to absolute for the built-in hands** and to calibration-relative for imported
  rigs.
- **Model and WASM load on the first camera start,** not on page load.

## Validation

### Tested: node, `npm test` (28 tests, 1828 checks, all passing)

| Area | Test | Result |
|---|---|---|
| Pose math | FK → solve on 400 random poses, both hands, random wrist orientation | max error: wrist 9e-14°, fingers 1e-12°, thumb 4e-13° |
| Numerics | degenerate/collinear frames, antiparallel swing, all-coincident landmarks | finite output, degeneracy reported |
| Handedness geometry | wrong side mirrors the palm normal | normal flips sign exactly (basis of calibration check) |
| Thumb model | twist sign turns the pad toward the index tip in a pinch | sign −1 chosen; model-based heuristic |
| Calibration | biased neutral (8–14° flex, splay, thumb offset) + 1.5 mm noise | residual at neutral ≤ 1.6° |
| Calibration | inverted labels → auto-switch; one hand back-facing → reported for that hand only | pass |
| Association | shuffled detection order + label flicker over 120 frames | 1 id per side, 0 swaps |
| Association | hands crossing | 0 swaps outside 13 held (ambiguous) frames |
| Association | right fist replaced in place by left fist | flipped within 1 frame |
| Loss handling | 1.5 s dropout + corrupt (NaN) sample | tracked→held→blending→lost→resuming→tracked; max step 16.9°/frame at 30 fps; never NaN |
| Filtering | 5 cm step at 30 vs 60 fps | 47.4 vs 49.3 mm after 0.1 s (frame-rate independent); −q input takes short path |
| Approximate root | known translation (+15, +8, −30 cm) on synthetic pinhole data | estimated (+14.9, +8.1, −30.0) cm |
| Mapping | suggestions on built-in, rig B (Mixamo), rig C (Unreal) | exact expected bones; tips, metacarpals and IK bones skipped; 2-segment pinky reported |
| Parent-local transforms | rig frame = rest frame carried by parent × D, rigs A/B/C × 40 random poses | ≤ 7e-6° |
| Absolute wrist | palm frame measured from posed rig bones vs performer hand frame | ≤ 3e-13° on all rigs |
| Retarget fidelity | finger angles measured back from posed rig geometry | ≤ 5e-4° (A), 9e-5° (B) |
| Rest preservation | identity pose reproduces each rig's rest pose | ≤ 1e-5 |
| Drift | bone lengths, unmapped body bones, 300 frames then repeat | no drift, lengths unchanged |
| Missing segment | rig C pinky2 carries the pinky3 delta | exact |
| Recording | monotonic samples, slerp across sign flip, resampling count and sign continuity | pass |
| Canonical JSON | resampled export → reload | matches interpolation; wrong schema/version rejected |
| GLB | bake → export → re-import → `AnimationMixer` (A, B, C, A + root channel) | all channels bound, max error 1.6e-14° |
| GLB | baked keys vs live preview at the same times | ≤ 1e-5° |
| GLB | rest/bind transforms in exported file | unchanged |
| Profiles | save → load; different rig warns; unknown version rejected | pass |

Per-frame JavaScript cost (`npm run bench`, node, Xeon 2.8 GHz):
- pipeline for two hands (association, conditioning, solve, filters): 63 µs;
- retargeting: 10–14 µs per rig.

### Tested: Chromium headless (`tests/browser_test.py`, 61 checks, all passing on the final run of each suite)

Setup:
- The app was served from localhost. CDN URLs were answered from local copies of the same pinned
  packages, and any other request failed the run.
- Rendering used SwiftShader (no GPU), so inference used the CPU delegate.

Results:
- **Playback without a camera.** Boot with no page errors. No tracking assets are fetched before
  the camera starts. Example playback and scrubbing pose the rig.
- **Export per rig.** For the built-in rig and for rigs B and C loaded through the app: mapping
  suggestion, then GLB export, then the in-app re-import check, which passes with 0.00000° error.
- **JSON and profiles.** Canonical JSON export and re-load; profile save and load; rig import
  through the file input.
- **Every UI control.** Mapping Clear / Suggest / Apply (manual edit → folded segment), per-bone
  axis correction, built-in rig button, all tracking settings reaching the pipeline, view reset.
- **Live inference.**
  - Fake camera → module worker → MediaPipe → pipeline → recording; the camera is released on stop.
  - The main-thread fallback (`?worker=off`) works too.
  - No undeclared network requests in any run.
- **Self-hosted copy.** After `tools/vendor.mjs` the app tracks with zero CDN requests.
- **Error states.**
  - Permission denied: simulated, because headless Chrome cannot show the prompt.
  - No camera.
  - No WebGL 2: playback and export still work.
  - Model 404.
  - `file://` notice.
- **Exported GLBs** pass the Khronos glTF validator with 0 errors and 1 warning,
  `NODE_SKINNED_MESH_NON_ROOT`, the same layout Blender exports.

**Real MediaPipe output.**

Inputs: Tasks Vision 1.0.1 with a `hand_landmarker.task` bundle, fed public photos through Chrome's
fake camera. The bundle has the same size and structure as the official file but came from an npm
mirror, because the build sandbox could not reach Google's URL.

| Check | Result |
|---|---|
| Palm-facing left and right hands, unmirrored | labels `Left`/`Right` match anatomy |
| Same, after calibration | palm normals face the camera (0.93, 0.97); 12 frames per hand, jitter ≤ 0.2° |
| Toggling mirror preview | assignment unchanged |
| Inverted convention set deliberately | detected at calibration and switched back |
| Recording, raw landmark export and GLB export from this real-tracking session | pass |
| Gestures on real landmarks | fist: index/middle MCP+PIP 146°/159°<br>open hand: −0°/25°<br>pointing: index −10°, middle 123°<br>OK sign: index 80°, thumb rotated<br>Sides correct for all four |

Inference cost in this sandbox (CPU, no SIMD threads, SwiftShader) was 0.2–1 s per frame. That
number is not representative of a laptop.

### Not verified (needs a real-camera session or other tools)

- **Live performance by a person in front of a webcam.**
  - Real-time feel, latency and jitter.
  - Smoothing defaults (tuned only on synthetic data).
  - Hold/blend timings under real dropouts.
  - Two hands crossing in reality, and fast motion.
- **GPU delegate inference.**
  - Inference times and frame rates on an ordinary laptop.
  - Whether the input-size adaptation triggers there.
- **Wrist accuracy across orientations,** especially palm edge-on to the camera, and thumb accuracy
  in opposition. The thumb's axial twist is a model, not a measurement.
- **Approximate screen-space positioning on real camera data:** MediaPipe's world-landmark scale
  and the assumed 60° FOV.
- **The official model download** from `storage.googleapis.com`. Same structure is expected; the
  file actually tested had sha256 `fbc2a300…7cde1`, 7,819,105 bytes.
- **Browsers other than Chromium:** Firefox, Safari, mobile.
- **The real camera-permission prompt** (only the denial result was simulated).
- **Opening the exported GLB in Godot, Blender, Unity or Unreal.** Verified only against three.js
  and the Khronos validator.
- **Rigs other than the three included,** such as Mixamo or VRM files from real pipelines, or rigs
  with unusual hierarchies.
- **The example recording is synthetic.** It is forward-kinematics landmarks with noise run through
  the real pipeline, not a captured performance.
