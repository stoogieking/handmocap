// Layer 1: webcam acquisition and hand-landmark inference.
//
// Cadence: requestVideoFrameCallback delivers each new camera frame once (rAF + currentTime
// change detection as fallback). If inference is still busy the frame is dropped, never queued,
// so latency cannot accumulate. Inference runs in a module worker when possible (frames are
// transferred as resized ImageBitmaps); otherwise on the main thread. Input resolution adapts
// to measured inference time.
//
// Output (onResult): { t (s, capture clock), width, height (camera pixels), hands: [{ image,
// world, label, score }], inferMs, captureMs, inputW, inputH } — frames are NOT mirrored.
import { URLS } from '../config.js';

const WIDTH_STEPS = [960, 768, 640, 512, 448];
const START_STEP = 2; // 640 px

export class Tracker {
  // delegate: 'GPU' (falls back to CPU if GPU init fails) or 'CPU'.
  constructor({ video, onResult, onStatus, delegate = 'GPU', useWorker = true }) {
    this.video = video;
    this.useWorker = useWorker;
    this.preferredDelegate = delegate === 'CPU' ? 'CPU' : 'GPU';
    this.onResult = onResult;
    this.onStatus = onStatus || (() => {});
    this.worker = null;
    this.landmarker = null; // main-thread fallback
    this.mode = null; // 'worker' | 'main'
    this.delegate = null;
    this.ready = false;
    this.stream = null;
    this.running = false;
    this.busy = false;
    this.busySince = 0;
    this.frameId = 0;
    this.lastTs = 0;
    this.lastMediaTime = -1;
    this.widthIdx = START_STEP;
    this.adaptFrozen = false;
    this.pendingCheck = null;
    this.inferEma = null;
    this.intervalEma = null;
    this.lastCapture = null;
    this.lastAdapt = 0;
    this.stats = { processed: 0, dropped: 0, errors: 0 };
    this._canvas = null;
  }

  // ---- model ---------------------------------------------------------------------------------
  async init() {
    const abs = (u) => new URL(u, location.href).href;
    const cfg = { visionBundle: abs(URLS.visionBundle), wasmBase: abs(URLS.visionWasmBase), modelUrl: abs(URLS.handModel) };
    this.onStatus({ type: 'model', state: 'loading', message: 'Loading hand tracking model…' });
    if (this.useWorker && typeof Worker !== 'undefined' && typeof createImageBitmap !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        await this._initWorker(cfg);
        this.mode = 'worker';
      } catch (err) {
        console.warn('Worker tracking unavailable, falling back to main thread:', err);
        this.worker?.terminate();
        this.worker = null;
      }
    }
    if (!this.mode) {
      const vision = await import(cfg.visionBundle);
      const fileset = await vision.FilesetResolver.forVisionTasks(cfg.wasmBase);
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: cfg.modelUrl, delegate }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      try {
        this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts(this.preferredDelegate));
        this.delegate = this.preferredDelegate;
      } catch {
        this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU'));
        this.delegate = 'CPU';
      }
      this.mode = 'main';
    }
    this.ready = true;
    this.onStatus({ type: 'model', state: 'ready', message: `Tracking model ready (${this.mode === 'worker' ? 'worker' : 'main thread'}, ${this.delegate})` });
  }

  _initWorker(cfg) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./tracker-worker.js', import.meta.url), { type: 'module' });
      const timer = setTimeout(() => reject(new Error('worker init timeout')), 60000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.worker = w;
          this.delegate = m.delegate;
          w.onmessage = (ev) => this._onWorkerMessage(ev.data);
          resolve();
        } else if (m.type === 'error') {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        if (this.worker === w) {
          // Worker died after a successful start.
          this.ready = false;
          this.busy = false;
          this.onStatus({ type: 'model', state: 'failed', message: 'Tracking worker crashed: ' + (e.message || 'unknown error') + '. Reload the page.' });
        }
        reject(new Error(e.message || 'worker failed to start'));
      };
      w.postMessage({ type: 'init', ...cfg, delegate: this.preferredDelegate, numHands: 2 });
    });
  }

  // ---- camera --------------------------------------------------------------------------------
  async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'videoinput');
  }

  async start(deviceId = null) {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('Camera API unavailable. Open the app over https:// or http://localhost (not file://).');
      err.name = 'NoMediaDevices';
      throw err;
    }
    this.stop();
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      // Some Windows camera drivers refuse the preferred resolution/frame rate and report the
      // camera as busy (NotReadableError). Retry once with no constraints before giving up.
      if (err?.name !== 'NotReadableError' && err?.name !== 'OverconstrainedError' && err?.name !== 'AbortError') throw err;
      this.stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.running = true;
    this.busy = false;
    this.lastMediaTime = -1;
    this.inferEma = this.intervalEma = this.lastCapture = null;
    this.stats = { processed: 0, dropped: 0, errors: 0 };
    const track = this.stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      this.onStatus({ type: 'camera', state: 'ended', message: 'Camera stopped (device disconnected or released).' });
      this.stop();
    });
    this._schedule();
    return track.getSettings ? track.getSettings() : {};
  }

  stop() {
    this.running = false;
    if (this._rvfc != null && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._rvfc);
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._rvfc = this._raf = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.busy = false;
  }

  dispose() {
    this.stop();
    this.worker?.postMessage({ type: 'close' });
    this.worker?.terminate();
    this.worker = null;
    try {
      this.landmarker?.close();
    } catch {}
    this.landmarker = null;
  }

  // ---- frame loop ----------------------------------------------------------------------------
  _schedule() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) this._rvfc = this.video.requestVideoFrameCallback((now, meta) => this._onFrame(now, meta));
    else this._raf = requestAnimationFrame((now) => this._onRaf(now));
  }

  _onRaf(now) {
    // Fallback: a new frame is detected by a change of currentTime.
    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastMediaTime) {
      this.lastMediaTime = this.video.currentTime;
      this._process(now, 'animation frame');
    }
    this._schedule();
  }

  _onFrame(now, meta) {
    this._schedule();
    // captureTime (when supported) is the camera capture instant on the performance clock;
    // otherwise the frame-callback time is used and sample age is measured from there.
    if (meta.captureTime != null) this._process(meta.captureTime, 'capture');
    else this._process(now, 'frame callback');
  }

  _process(captureMs, clock) {
    this.clock = clock;
    if (!this.ready || !this.running) return;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return;
    // Camera cadence from every delivered frame (processed or dropped).
    if (this.lastCapture != null) {
      const dt = captureMs - this.lastCapture;
      if (dt > 0 && dt < 1000) this.intervalEma = this.intervalEma == null ? dt : this.intervalEma * 0.9 + dt * 0.1;
    }
    this.lastCapture = captureMs;
    if (this.busy) {
      // Never queue: drop this frame. (A worker that is merely slow keeps its single in-flight
      // frame; resetting here would queue frames inside the worker and add latency.)
      this.stats.dropped++;
      const stuck = performance.now() - this.busySince;
      if (stuck > 5000 && !this._slowWarned) {
        this._slowWarned = true;
        this.onStatus({ type: 'model', state: 'slow', message: `Hand inference is very slow (>5 s for one frame). If this persists, reload with ?delegate=cpu.` });
      }
      return;
    }
    const ts = Math.max(this.lastTs + 1, Math.round(captureMs)); // strictly increasing for VIDEO mode
    this.lastTs = ts;
    const inputW = Math.min(vw, WIDTH_STEPS[this.widthIdx]);
    const inputH = Math.round((vh * inputW) / vw);
    const id = ++this.frameId;
    this.busy = true;
    this.busySince = performance.now();
    const meta = { id, captureMs, width: vw, height: vh, inputW, inputH };
    if (this.mode === 'worker') {
      createImageBitmap(this.video, { resizeWidth: inputW, resizeHeight: inputH, resizeQuality: 'low' })
        .then((bitmap) => {
          this._pending = meta;
          this.worker.postMessage({ type: 'frame', bitmap, ts, id }, [bitmap]);
        })
        .catch((err) => {
          this.busy = false;
          this.stats.errors++;
          console.warn('createImageBitmap failed', err);
        });
    } else {
      let src = this.video;
      if (inputW < vw) {
        if (!this._canvas) this._canvas = document.createElement('canvas');
        this._canvas.width = inputW;
        this._canvas.height = inputH;
        this._canvas.getContext('2d').drawImage(this.video, 0, 0, inputW, inputH);
        src = this._canvas;
      }
      try {
        const t0 = performance.now();
        const res = this.landmarker.detectForVideo(src, ts);
        const inferMs = performance.now() - t0;
        const hands = (res.landmarks || []).map((lm, i) => {
          const image = new Float32Array(63), world = new Float32Array(63);
          lm.forEach((p, k) => image.set([p.x, p.y, p.z], k * 3));
          (res.worldLandmarks?.[i] || []).forEach((p, k) => world.set([p.x, p.y, p.z], k * 3));
          const cat = (res.handedness || res.handednesses)?.[i]?.[0];
          return { image, world, label: cat?.categoryName || 'Right', score: cat?.score ?? null };
        });
        this._deliver(meta, hands, inferMs);
      } catch (err) {
        this.busy = false;
        this.stats.errors++;
        console.warn('detectForVideo failed', err);
      }
    }
  }

  _onWorkerMessage(m) {
    if (m.type === 'result') {
      const meta = this._pending && this._pending.id === m.id ? this._pending : null;
      if (meta) this._deliver(meta, m.hands, m.inferMs);
      else this.busy = false;
    } else if (m.type === 'frameError') {
      this.busy = false;
      this.stats.errors++;
      console.warn('worker inference error:', m.message);
    }
  }

  _deliver(meta, hands, inferMs) {
    this.busy = false;
    if (!this.running) return;
    this.stats.processed++;
    this.inferEma = this.inferEma == null ? inferMs : this.inferEma * 0.9 + inferMs * 0.1;
    this._adapt();
    this.onResult({ t: meta.captureMs / 1000, width: meta.width, height: meta.height, hands, inferMs, captureMs: meta.captureMs, clock: this.clock, inputW: meta.inputW, inputH: meta.inputH });
  }

  // Adaptive load control. Inference frequency already adapts (frames are dropped while busy).
  // The input size is lowered when inference cannot keep up with the camera, but only kept if
  // that actually helped: MediaPipe resizes internally, so on some devices a smaller input saves
  // little time and only costs landmark precision. Raised again when there is ample headroom.
  _adapt() {
    const now = performance.now();
    if (this.inferEma == null || this.intervalEma == null) return;
    if (this.pendingCheck && now - this.pendingCheck.t > 1500) {
      if (this.inferEma > 0.85 * this.pendingCheck.before) {
        this.widthIdx = this.pendingCheck.idx; // no real gain: revert and stop shrinking
        this.adaptFrozen = true;
      }
      this.pendingCheck = null;
      this.lastAdapt = now;
    }
    if (this.pendingCheck || now - this.lastAdapt < 1000) return;
    if (!this.adaptFrozen && this.inferEma > 0.85 * this.intervalEma && this.widthIdx < WIDTH_STEPS.length - 1) {
      this.pendingCheck = { t: now, before: this.inferEma, idx: this.widthIdx };
      this.widthIdx++;
      this.lastAdapt = now;
    } else if (this.inferEma < 0.35 * this.intervalEma && this.widthIdx > 0) {
      this.widthIdx--;
      this.lastAdapt = now;
    }
  }
}

export function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission denied. Allow camera access for this site in the browser settings, then press Start camera again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found (or the selected camera is unavailable).';
    case 'NotReadableError':
    case 'AbortError':
      return 'Windows reports the camera as busy or blocked. Close other apps and browser tabs that may use it (Teams, Zoom, Discord, OBS, the Camera app), check Settings > Privacy & security > Camera allows desktop apps and your browser, check any privacy shutter or camera key on the laptop, then reload this page.';
    case 'NoMediaDevices':
      return err.message;
    case 'NotSupportedError':
      return 'Camera access is not supported here (browser policy or insecure origin). Use https:// or http://localhost.';
    default:
      return `Camera error: ${err?.message || err}`;
  }
}
