"""Build a Y4M (YUV420) clip for Chrome's fake camera from still images (dev/test only).
usage: python3 tests/make_y4m.py out.y4m WIDTH HEIGHT FPS SECONDS_PER_IMAGE img[:x0,y0,x1,y1][:mirror] ..."""
import sys
from PIL import Image, ImageOps
out, W, H, fps, secs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
frames = []
for spec in sys.argv[6:]:
    parts = spec.split(':')
    im = Image.open(parts[0]).convert('RGB')
    for p in parts[1:]:
        if p == 'mirror': im = ImageOps.mirror(im)
        elif p: im = im.crop(tuple(int(v) for v in p.split(',')))
    s = min(W / im.width, H / im.height)
    im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    canvas = Image.new('RGB', (W, H), (128, 160, 200))
    canvas.paste(im, ((W - im.width) // 2, (H - im.height) // 2))
    y, u, v = canvas.convert('YCbCr').split()
    data = y.tobytes() + u.resize((W // 2, H // 2)).tobytes() + v.resize((W // 2, H // 2)).tobytes()
    frames += [data] * max(1, int(fps * secs))
with open(out, 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F{fps}:1 Ip A1:1 C420jpeg\n'.encode())
    for fr in frames:
        f.write(b'FRAME\n' + fr)
print(out, len(frames), 'frames')
