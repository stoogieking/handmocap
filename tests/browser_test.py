"""Headless-Chrome checks of the static app (dev only; needs Python Playwright + Chromium).

CDN requests are answered from local copies (node_modules/three, an unpacked
@mediapipe/tasks-vision@1.0.1 package dir, and a hand_landmarker.task file), so the run is
offline; any other external request fails the run. Usage:

  python3 tests/browser_test.py --vision-dir DIR --model FILE [--only a,b] [--shots DIR]
      [--video hands.y4m] [--gesture-video gestures.y4m] [--delegate cpu|gpu]

Suites: playback, camera, fallback, handedness*, gestures*, denied, nocamera, nogl, modelfail,
file. (*) need clips for Chrome's fake camera, built with tests/make_y4m.py from photos:
  --video: palms toward the camera, a LEFT hand on the image left and a RIGHT hand on the right.
  --gesture-video: 5 s each of pointing, fist, OK-sign and open hand, palm toward the camera.
Headless Chrome uses SwiftShader, so CPU inference (--delegate cpu, default) is used.
"""
import argparse, http.server, json, os, socketserver, sys, threading, time, functools
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument('--vision-dir', required=True)
ap.add_argument('--model', required=True)
ap.add_argument('--video', default=None)
ap.add_argument('--gesture-video', default=None)
ap.add_argument('--only', default=None)
ap.add_argument('--port', type=int, default=8123)
ap.add_argument('--delegate', default='cpu', help='headless SwiftShader is far too slow for the GPU delegate')
ap.add_argument('--shots', default=None, help='directory for screenshots')
args = ap.parse_args()

THREE = ROOT / 'node_modules' / 'three'
VISION = Path(args.vision_dir)
MODEL = Path(args.model)
SHOTS = Path(args.shots) if args.shots else None
if SHOTS: SHOTS.mkdir(parents=True, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
Quiet.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary'}
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(('127.0.0.1', args.port), functools.partial(Quiet, directory=str(ROOT)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://localhost:{args.port}/'

MIME = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.task': 'application/octet-stream'}
external = []

def route(r):
    url = r.request.url
    if url.startswith('https://cdn.jsdelivr.net/npm/three@0.186.1/'):
        p = THREE / url.split('three@0.186.1/', 1)[1]
    elif url.startswith('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/'):
        p = VISION / url.split('tasks-vision@1.0.1/', 1)[1]
    elif url.startswith('https://storage.googleapis.com/mediapipe-models/'):
        p = MODEL
    elif url.startswith(BASE) or url.startswith('data:') or url.startswith('blob:'):
        return r.continue_()
    else:
        external.append(url)
        return r.abort()
    if not p.exists():
        return r.fulfill(status=404, body='missing ' + str(p))
    r.fulfill(status=200, body=p.read_bytes(), headers={'Content-Type': MIME.get(p.suffix, 'application/octet-stream'), 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'})

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)

def new_context(pw, camera=True, deny=False, extra_args=()):
    a = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', *extra_args]
    if camera:
        a += ['--use-fake-device-for-media-stream']
        a += [] if deny else ['--use-fake-ui-for-media-stream']
        if args.video: a += [f'--use-file-for-fake-video-capture={args.video}']
    browser = pw.chromium.launch(headless=True, args=a)
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800}, accept_downloads=True, permissions=[] if deny else ['camera'])
    ctx.route('**/*', route)
    return browser, ctx

def page_with_logs(ctx):
    page = ctx.new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.on('worker', lambda w: w.on('console', lambda m: logs.append(f'worker {m.type}: {m.text}')))
    return page, logs

def status(page): return page.inner_text('#status')
def shot(page, name):
    if SHOTS: page.screenshot(path=str(SHOTS / f'{name}.png'))

def download(page, button):
    with page.expect_download() as d:
        page.click(button)
    path = d.value.path()
    return d.value.suggested_filename, Path(path).read_bytes()

def run_playback(pw):
    browser, ctx = new_context(pw, camera=False)
    page, logs = page_with_logs(ctx)
    page.goto(BASE + 'index.html')
    page.wait_for_function("window.handmocap && document.querySelector('#status').textContent.startsWith('Ready')", timeout=20000)
    check('app boots with no page errors', not any('pageerror' in l or l.startswith('error') for l in logs), '; '.join(logs[:3]))
    check('no tracking assets fetched before camera start', not page.evaluate("performance.getEntriesByType('resource').some(e => /tasks-vision|mediapipe-models/.test(e.name))"))
    shot(page, '01-boot')
    page.click('#recExample')
    page.wait_for_function("document.querySelector('#status').textContent.includes('Loaded example')")
    check('example recording labelled synthetic', 'synthetic' in status(page), status(page)[:120])
    page.click('#playBtn'); time.sleep(1.2)
    t1 = page.evaluate('window.handmocap.state.playTime')
    check('playback advances without a camera', 0.8 < t1 < 2.0, f'playTime {t1:.2f}')
    page.click('#playBtn')
    page.eval_on_selector('#scrub', "el => { el.value = '1.7'; el.dispatchEvent(new Event('input')); }")
    q = page.evaluate("(() => { const b = window.handmocap.state.rig.get('R_index2'); return [b.quaternion.x, b.quaternion.w]; })()")
    check('scrubbing to the fist poses the built-in index finger', abs(q[0]) > 0.3, f'R_index2 q.x {q[0]:.3f}')
    shot(page, '02-fist')
    for rig_btn, label in [(None, 'builtin'), ('#rigB', 'B'), ('#rigC', 'C')]:
        if rig_btn:
            page.click(rig_btn)
            page.wait_for_function("document.querySelector('#status').textContent.includes('Loaded')", timeout=20000)
            rep = page.inner_text('#mapReport')
            check(f'rig {label}: mapping suggested and valid', 'Error' not in rep and ('ok' in rep or 'partial' in rep), rep.split('\n')[0])
            page.eval_on_selector('#scrub', "el => { el.value = '1.7'; el.dispatchEvent(new Event('input')); }")
            time.sleep(0.3)
            shot(page, f'03-rig-{label}')
        name, data = download(page, '#exportGlb')
        page.wait_for_function("!document.querySelector('#exportResult').textContent.startsWith('Baking')")
        res = page.inner_text('#exportResult')
        check(f'rig {label}: GLB export + re-import check passes', 'check passed' in res and data[:4] == b'glTF', res[:160])
        (ROOT / 'tests' / 'out').mkdir(exist_ok=True)
        (ROOT / 'tests' / 'out' / f'export-{label}.glb').write_bytes(data)
    name, data = download(page, '#exportJson')
    j = json.loads(data)
    check('canonical JSON export', j['schema'] == 'handmocap.canonical-motion' and j['sampling']['fps'] == 30 and len(j['frames']) > 200, f'{len(j["frames"])} frames')
    (ROOT / 'tests' / 'out' / 'export-motion.json').write_bytes(data)
    check('raw landmark export disabled for a recording without raw data', page.is_disabled('#exportRaw'))
    # profile save -> load round trip in the UI
    name, data = download(page, '#profileSave')
    prof = json.loads(data)
    check('profile save', prof['schema'] == 'handmocap.rig-profile' and prof['mapping']['left'].get('index1') == 'index_01_l', name)
    page.set_input_files('#profileFile', files=[{'name': 'p.json', 'mimeType': 'application/json', 'buffer': data}])
    page.wait_for_function("document.querySelector('#status').textContent.includes('Loaded rig profile')")
    check('profile load', 'Warning' not in status(page), status(page)[:100])
    # invalid rig file
    page.set_input_files('#rigFile', files=[{'name': 'broken.glb', 'mimeType': 'model/gltf-binary', 'buffer': b'not a glb at all'}])
    page.wait_for_function("document.querySelector('#status').textContent.includes('Invalid rig')", timeout=10000)
    check('invalid rig reported', True, status(page)[:100])
    # import via the file input path (not the example button) for rig B
    page.set_input_files('#rigFile', files=[str(ROOT / 'examples' / 'rig-b-mixamo-style.glb')])
    page.wait_for_function("document.querySelector('#status').textContent.includes('Loaded rig')", timeout=10000)
    check('rig import through file input', 'rig-b' in page.inner_text('#rigName'))
    # Remaining controls: mapping clear/suggest, built-in rig, recording file load, settings.
    page.click('#mapDetails summary')
    page.click('#mapClear')
    check('Map bones: Clear', 'left: none, right: none' in page.inner_text('#mapReport'), page.inner_text('#mapReport')[:60])
    page.click('#mapSuggest')
    check('Map bones: Suggest', 'left: ok, right: ok' in page.inner_text('#mapReport'), page.inner_text('#mapReport')[:60])
    page.eval_on_selector('select[data-map="left"][data-joint="index3"]', "el => { el.value = ''; }")
    page.click('#mapApply')
    check('Map bones: Apply (manual edit -> partial + folded segment)', 'left: partial' in page.inner_text('#mapReport') and 'folded' in page.inner_text('#mapReport'), page.inner_text('#mapReport')[:120])
    page.eval_on_selector('input[data-axis="left"][data-joint="index1"]', "el => { el.value = '0 0 180'; }")
    page.click('#mapApply')
    page.eval_on_selector('#scrub', "el => { el.value = '1.7'; el.dispatchEvent(new Event('input')); }")
    time.sleep(0.3)
    check('axis correction applied to the adapter', page.evaluate("window.handmocap.state.axisOverrides.left.index1?.[2] === 180"))
    page.click('#rigBuiltin')
    check('Built-in hands button', page.inner_text('#rigName').startswith('Rig: built-in'))
    page.set_input_files('#recFile', files=[str(ROOT / 'tests' / 'out' / 'export-motion.json')])
    page.wait_for_function("document.querySelector('#status').textContent.includes('Loaded export-motion.json')")
    check('Load recording (re-import of an exported canonical JSON)', page.evaluate('window.handmocap.state.recording.frames.length') == len(j['frames']))
    page.click('summary:has-text("Advanced")')
    page.select_option('#rootPolicy', 'approx-screen'); page.select_option('#wristMode', 'relative'); page.select_option('#lossPose', 'rest')
    page.fill('#holdMs', '200'); page.fill('#blendMs', '400'); page.fill('#thumbTwist', '10'); page.select_option('#hands', 'left')
    page.eval_on_selector('#smoothing', "el => { el.value = '0.6'; el.dispatchEvent(new Event('input')); }")
    s = page.evaluate('window.handmocap.pipeline.settings')
    check('tracking settings reach the pipeline', s['rootPolicy'] == 'approx-screen' and s['hands'] == 'left' and abs(s['holdTime'] - 0.2) < 1e-9 and abs(s['blendTime'] - 0.4) < 1e-9 and s['lossPose'] == 'rest' and abs(s['smoothing'] - 0.6) < 1e-9, json.dumps(s)[:160])
    page.click('#viewReset')
    check('no page errors during playback/export session', not any('pageerror' in l for l in logs), '; '.join([l for l in logs if 'pageerror' in l][:3]))
    check('no undeclared network requests', not external, ', '.join(external[:3]))
    browser.close()

def run_camera(pw, worker='on'):
    browser, ctx = new_context(pw, camera=True)
    page, logs = page_with_logs(ctx)
    page.goto(BASE + f'index.html?delegate={args.delegate}&worker={worker}')
    page.wait_for_function('window.handmocap')
    page.click('#camStart')
    try:
        page.wait_for_function("document.querySelector('#status').textContent.includes('tracking with') || document.querySelector('#status').classList.contains('error')", timeout=120000)
    except Exception as e:
        print('timeout waiting for tracking', status(page), logs[-10:])
    st = status(page)
    check('camera + model start', 'tracking with' in st, st[:200])
    mode = page.evaluate('[window.handmocap.tracker.mode, window.handmocap.tracker.delegate]')
    print('   tracker mode/delegate:', mode)
    check(f'inference runs in the expected place (worker={worker})', mode[0] == ('worker' if worker == 'on' else 'main'), str(mode))
    try:  # this sandbox's CPU inference is ~0.5-1 s/frame; wait for a few results
        page.wait_for_function('window.handmocap.tracker.stats.processed >= 3', timeout=30000)
    except Exception:
        pass
    stats = page.evaluate('({...window.handmocap.tracker.stats, infer: window.handmocap.tracker.inferEma, w: window.handmocap.state.lastResult && window.handmocap.state.lastResult.inputW})')
    check('frames processed by the tracker', stats['processed'] >= 3, json.dumps(stats))
    if stats['processed'] <= 5: print('   last logs:\n     ' + '\n     '.join(logs[-15:]))
    diag = page.inner_text('#diag')
    check('diagnostics show render fps, inference and sample age separately', 'render' in diag and 'inference' in diag and 'sample age' in diag, diag.split('\n')[0])
    shot(page, '10-camera')
    page.click('#recBtn'); time.sleep(2); page.click('#recBtn')
    n = page.evaluate('window.handmocap.state.recording && window.handmocap.state.recording.frames.length')
    check('recording from live tracking', (n or 0) >= 2, f'{n} samples')
    hands = page.evaluate("window.handmocap.state.recording.frames.filter(f => f.hands.left || f.hands.right).length")
    print(f'   samples with a hand: {hands}')
    # camera stop releases tracks
    page.click('#camStop')
    live = page.evaluate("document.querySelector('#video').srcObject")
    check('camera stop releases the stream', live is None)
    check('no page errors with camera', not any('pageerror' in l for l in logs), '; '.join([l for l in logs if 'pageerror' in l or 'error' in l][:4]))
    check('no undeclared network requests', not external, ', '.join(external[:3]))
    browser.close()
    return hands

def run_handedness(pw):
    # Requires --video with palms facing the camera: a LEFT hand on the image left and a RIGHT
    # hand on the image right (e.g. a crop of a photo of raised hands). Verifies the label
    # convention, side assignment, the palm-facing calibration check and recording of real
    # MediaPipe output end to end.
    if not args.video:
        print('   (skipped: no --video)'); return
    browser, ctx = new_context(pw, camera=True)
    page, logs = page_with_logs(ctx)
    page.goto(BASE + 'index.html?delegate=' + args.delegate)
    page.wait_for_function('window.handmocap')
    page.click('#camStart')
    page.wait_for_function("document.querySelector('#status').textContent.includes('tracking with')", timeout=120000)
    page.wait_for_function("(() => { const a = window.handmocap.pipeline.lastAssign; return a && a.left && a.right; })()", timeout=90000)
    info = page.evaluate('''(() => { const a = window.handmocap.pipeline.lastAssign; const cx = (d) => [0,5,9,13,17].reduce((s,i)=>s+d.image[i*3],0)/5;
      return { left: { label: a.left.det.label, score: a.left.det.score, x: cx(a.left.det) }, right: { label: a.right.det.label, score: a.right.det.score, x: cx(a.right.det) } }; })()''')
    print('   MediaPipe raw labels:', json.dumps(info))
    check('anatomical sides match the image (left hand on image left, right on image right)', info['left']['x'] < info['right']['x'], json.dumps({k: round(v['x'], 3) for k, v in info.items()}))
    check("MediaPipe labels match anatomical side on unmirrored input ('reported' convention)", info['left']['label'] == 'Left' and info['right']['label'] == 'Right', f"left hand labelled {info['left']['label']}, right hand labelled {info['right']['label']}")
    # mirror toggle must not change assignment
    page.click('#mirror'); time.sleep(3)
    info2 = page.evaluate("(() => { const a = window.handmocap.pipeline.lastAssign; const cx = (d) => [0,5,9,13,17].reduce((s,i)=>s+d.image[i*3],0)/5; return [a.left && cx(a.left.det), a.right && cx(a.right.det)]; })()")
    check('mirrored preview does not change side assignment', info2[0] is not None and info2[1] is not None and info2[0] < info2[1], str(info2))
    shot(page, '20-handedness')
    page.evaluate("(() => { const p = window.handmocap.pipeline; p.calibrator.start(p.lastFrame.t, ['left','right'], { countdown: 0.3, maxCapture: 120, framesNeeded: 8 }); })()")
    page.wait_for_function("['done','failed','idle'].includes(window.handmocap.pipeline.calibrator.state) && document.querySelector('#calResult').textContent.startsWith('Calibrat') && !document.querySelector('#calResult').textContent.startsWith('Calibrating')", timeout=240000)
    res = page.inner_text('#calResult')
    facing = page.evaluate("[window.handmocap.pipeline.calibration.left?.palmFacing, window.handmocap.pipeline.calibration.right?.palmFacing]")
    check('calibration on real MediaPipe output passes the palm-facing check for both hands', facing[0] is not None and facing[1] is not None and facing[0] > 0.3 and facing[1] > 0.3, f'{res[:160]} | palmFacing {facing}')
    page.click('summary:has-text("Advanced")'); page.check('#recordRaw')
    page.click('#recBtn'); time.sleep(6); page.click('#recBtn')
    n = page.evaluate("window.handmocap.state.recording ? window.handmocap.state.recording.frames.filter(f => f.hands.left && f.hands.right && f.hands.left.observed).length : 0")
    name, raw = download(page, '#exportRaw')
    rj = json.loads(raw)
    check('raw landmark export (MediaPipe labels, image + world landmarks)', rj['schema'] == 'handmocap.raw-landmarks' and len(rj['frames']) >= 1 and len(rj['frames'][0]['hands']['left']['world']) == 63, f"{len(rj['frames'])} frames")
    check('recording contains real tracked samples for both hands', n >= 2, f'{n} samples')
    name, data = download(page, '#exportGlb')
    page.wait_for_function("!document.querySelector('#exportResult').textContent.startsWith('Baking')")
    check('GLB export of a real-tracking recording verifies', 'check passed' in page.inner_text('#exportResult'), page.inner_text('#exportResult')[:120])
    # Opposite convention must be caught (and corrected) by calibration.
    page.evaluate("(() => { const el = document.getElementById('labelConvention'); el.value = 'swap'; el.dispatchEvent(new Event('change')); })()"); time.sleep(4)
    page.evaluate("(() => { const p = window.handmocap.pipeline; p.calibrator.start(p.lastFrame.t, ['left','right'], { countdown: 0.3, maxCapture: 120, framesNeeded: 8 }); })()")
    page.wait_for_function("document.querySelector('#calResult').textContent.includes('failed') || (document.querySelector('#calResult').textContent.startsWith('Calibrated —') && window.handmocap.pipeline.calibrator.state === 'idle')", timeout=240000)
    res2 = page.inner_text('#calResult')
    conv = page.evaluate("[window.handmocap.pipeline.associator.labelConvention, document.getElementById('labelConvention').value]")
    check('inverted label convention is detected and switched back at calibration', 'switched automatically' in res2 and conv == ['reported', 'reported'], res2[-140:] + ' ' + str(conv))
    check('no page errors (real tracking)', not any('pageerror' in l for l in logs), '; '.join([l for l in logs if 'pageerror' in l][:3]))
    browser.close()

def run_gestures(pw):
    # Requires --gesture-video: 5 s each of pointing, fist, OK/pinch, open hand (palm to camera).
    if not args.gesture_video:
        print('   (skipped: no --gesture-video)'); return
    global external
    a = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', f'--use-file-for-fake-video-capture={args.gesture_video}']
    browser = pw.chromium.launch(headless=True, args=a)
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800}, permissions=['camera'])
    ctx.route('**/*', route)
    page, logs = page_with_logs(ctx)
    page.goto(BASE + 'index.html?delegate=' + args.delegate)
    page.wait_for_function('window.handmocap')
    page.click('#mirror')  # unmirrored preview, webcam view: easiest to compare with the photo
    page.click('#camStart')
    page.wait_for_function("document.querySelector('#status').textContent.includes('tracking with')", timeout=120000)
    page.wait_for_function("(() => { const f = window.handmocap.state.liveFrame; return f && (f.hands.left || f.hands.right) && (f.hands.left||f.hands.right).observed; })()", timeout=90000)
    t0 = time.time()
    # Fake capture loops the clip from when the camera opened; sample mid-segment.
    js = '''(() => { const f = window.handmocap.state.liveFrame; const h = f.hands.right && f.hands.right.observed ? f.hands.right : f.hands.left;
      if (!h) return null; const ang = (i) => { const q = h.joints.slice(i*4, i*4+4); return 2 * Math.atan2(q[0], q[3]) * 180 / Math.PI; };
      const tw = (i) => { const q = h.joints.slice(i*4, i*4+4); return 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI; };
      return { side: h.side, status: h.status, index: [ang(3), ang(4), ang(5)], middle: [ang(6), ang(7), ang(8)], ring: [ang(9), ang(10)], thumb: [tw(0), tw(1), tw(2)] }; })()'''
    out = {}
    # The fake camera loops the 20 s clip; align on the video's media time.
    for k, name in enumerate(['point', 'fist', 'pinch', 'open']):
        target = k * 5 + 4.3
        page.wait_for_function(f"(() => {{ const t = document.getElementById('video').currentTime % 20; return t > {target} && t < {target + 0.6}; }})()", timeout=60000, polling=100)
        out[name] = page.evaluate(js)
        shot(page, f'30-gesture-{name}')
        print(f'   {name}: {json.dumps(out[name])}')
    def flex(g, f): return sum(out[g][f][:2]) if out.get(g) else None
    check('real fist: index and middle strongly flexed (MCP+PIP > 120°)', flex('fist', 'index') and flex('fist', 'index') > 120 and flex('fist', 'middle') > 120, f"index {flex('fist','index')}, middle {flex('fist','middle')}")
    check('real open hand: fingers nearly straight (MCP+PIP < 40°)', out.get('open') and abs(flex('open', 'index')) < 40 and abs(flex('open', 'middle')) < 40, f"index {flex('open','index')}, middle {flex('open','middle')}")
    check('real pointing: index straight, middle flexed', out.get('point') and flex('point', 'index') < 50 and flex('point', 'middle') > 100, f"index {flex('point','index')}, middle {flex('point','middle')}")
    check('real pinch (OK sign): index flexed, thumb rotated', out.get('pinch') and flex('pinch', 'index') > 40 and out['pinch']['thumb'][0] > 10, f"index {flex('pinch','index')}, thumb {out.get('pinch',{}).get('thumb')}")
    browser.close()

def run_denied(pw):
    browser, ctx = new_context(pw, camera=True, deny=True)
    page, logs = page_with_logs(ctx)
    # Headless Chrome cannot show (or be scripted to deny) the permission prompt; it reports
    # NotSupportedError. Simulate the browser's denial result to check the app's handling.
    page.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));")
    page.goto(BASE + 'index.html')
    page.wait_for_function('window.handmocap')
    page.click('#camStart')
    page.wait_for_function("document.querySelector('#status').classList.contains('error')", timeout=30000)
    check('permission denied state (simulated NotAllowedError)', 'denied' in status(page).lower() and page.is_enabled('#camStart'), status(page)[:120])
    check('camera preview hidden after denial', page.is_hidden('#cam'))
    browser.close()

def run_nocamera(pw):
    browser, ctx = new_context(pw, camera=False)
    page, logs = page_with_logs(ctx)
    page.goto(BASE + 'index.html')
    page.wait_for_function('window.handmocap')
    page.click('#camStart')
    page.wait_for_function("document.querySelector('#status').classList.contains('error')", timeout=30000)
    check('unavailable camera state', 'camera' in status(page).lower(), status(page)[:120])
    browser.close()

def run_nogl(pw):
    browser = pw.chromium.launch(headless=True, args=['--disable-gpu', '--disable-software-rasterizer', '--disable-webgl'])
    ctx = browser.new_context(); ctx.route('**/*', route)
    page, logs = page_with_logs(ctx)
    page.goto(BASE + 'index.html')
    page.wait_for_function('window.handmocap', timeout=20000)
    check('unsupported graphics state', 'WebGL' in status(page), status(page)[:120])
    page.click('#recExample'); time.sleep(0.5)
    check('playback controls still work without WebGL', page.is_enabled('#playBtn') and page.is_enabled('#exportJson'))
    browser.close()

def run_modelfail(pw):
    browser, ctx = new_context(pw, camera=True)
    ctx.unroute('**/*')
    def r404(r):
        if 'mediapipe-models' in r.request.url: return r.fulfill(status=404, body='gone')
        return route(r)
    ctx.route('**/*', r404)
    page, logs = page_with_logs(ctx)
    page.goto(BASE + 'index.html?delegate=cpu')
    page.wait_for_function('window.handmocap')
    page.click('#camStart')
    page.wait_for_function("document.querySelector('#status').classList.contains('error')", timeout=180000)
    check('model initialisation error state', 'model failed to load' in status(page), status(page)[:140])
    browser.close()

def run_file(pw):
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto((ROOT / 'index.html').as_uri())
    time.sleep(1)
    check('file:// explains how to serve the app', 'file://' in page.inner_text('#status'), page.inner_text('#status')[:100])
    browser.close()

with sync_playwright() as pw:
    for name, fn in [('playback', run_playback), ('camera', run_camera), ('fallback', lambda pw: run_camera(pw, 'off')), ('handedness', run_handedness), ('gestures', run_gestures), ('denied', run_denied), ('nocamera', run_nocamera), ('nogl', run_nogl), ('modelfail', run_modelfail), ('file', run_file)]:
        if args.only and name not in args.only.split(','): continue
        print(f'== {name}', flush=True)
        try:
            fn(pw)
        except Exception as e:
            check(f'{name} ran without exceptions', False, repr(e)[:300])
httpd.shutdown()
failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)}/{len(results)} browser checks passed')
sys.exit(1 if failed else 0)
