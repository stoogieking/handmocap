// Layer 1 (worker side): MediaPipe Hand Landmarker inference off the main thread.
// Module worker. The WASM loader is the ES-module variant (FilesetResolver useModule = true),
// which MediaPipe loads with dynamic import() because importScripts is unavailable in module
// workers. One frame at a time: the main thread never sends a frame while one is in flight.
let landmarker = null;

async function create(vision, fileset, modelUrl, delegate, numHands) {
  return vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate },
    runningMode: 'VIDEO',
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

function pack(res) {
  const hands = [];
  const transfer = [];
  for (let i = 0; i < (res.landmarks?.length || 0); i++) {
    const image = new Float32Array(63), world = new Float32Array(63);
    res.landmarks[i].forEach((p, k) => {
      image[k * 3] = p.x;
      image[k * 3 + 1] = p.y;
      image[k * 3 + 2] = p.z;
    });
    (res.worldLandmarks?.[i] || []).forEach((p, k) => {
      world[k * 3] = p.x;
      world[k * 3 + 1] = p.y;
      world[k * 3 + 2] = p.z;
    });
    const cat = (res.handedness || res.handednesses)?.[i]?.[0];
    hands.push({ image, world, label: cat?.categoryName || 'Right', score: cat?.score ?? null });
    transfer.push(image.buffer, world.buffer);
  }
  return { hands, transfer };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const vision = await import(m.visionBundle);
      const fileset = await vision.FilesetResolver.forVisionTasks(m.wasmBase, true);
      let delegate = m.delegate || 'GPU';
      try {
        landmarker = await create(vision, fileset, m.modelUrl, delegate, m.numHands || 2);
      } catch (err) {
        if (delegate !== 'GPU') throw err;
        delegate = 'CPU';
        landmarker = await create(vision, fileset, m.modelUrl, delegate, m.numHands || 2);
      }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (m.type === 'frame') {
    const bitmap = m.bitmap;
    if (!landmarker) {
      bitmap.close();
      self.postMessage({ type: 'frameError', id: m.id, message: 'landmarker not ready' });
      return;
    }
    try {
      const t0 = performance.now();
      const res = landmarker.detectForVideo(bitmap, m.ts);
      const inferMs = performance.now() - t0;
      const { hands, transfer } = pack(res);
      self.postMessage({ type: 'result', id: m.id, inferMs, hands }, transfer);
    } catch (err) {
      self.postMessage({ type: 'frameError', id: m.id, message: String(err?.message || err) });
    } finally {
      bitmap.close();
    }
  } else if (m.type === 'close') {
    try {
      landmarker?.close();
    } catch {}
    landmarker = null;
  }
};
