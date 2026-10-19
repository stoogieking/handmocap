// Pinned runtime dependencies. The app's own code requests only these URLs plus the three.js URLs
// in index.html's import map. Camera frames, landmarks, rigs and recordings are not uploaded by the
// app. MediaPipe's own privacy notice mentions usage metrics; see README, Privacy.
//
// Self-hosting: run `node tools/vendor.mjs` (downloads everything into ./vendor and rewrites
// these URLs and the import map), or copy the files yourself and edit the URLs. See README.
export const VERSIONS = {
  three: '0.186.1',
  tasksVision: '1.0.1',
  handLandmarkerModel: 'hand_landmarker/float16/1',
};

export const URLS = {
  // MediaPipe Tasks Vision ES module bundle (HandLandmarker, FilesetResolver).
  visionBundle: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs',
  // Directory containing vision_wasm_internal.{js,wasm} and vision_wasm_module_internal.{js,wasm}.
  visionWasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
  // Official hand landmarker model bundle (palm detector + landmark model, ~7.5 MB).
  handModel: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
