"""Local stand-in for map tiles, used only by the offline test (tools/test.py).
Serves the site/ folder plus fake grey street tiles at /tiles/{style}/{z}/{x}/{y}.png."""
import http.server, io, random, re, sys, functools
from PIL import Image, ImageDraw

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        m = re.match(r"/tiles/[^/]+/(\d+)/(\d+)/(\d+)", self.path)
        if not m:
            return super().do_GET()
        z, x, y = map(int, m.groups())
        r = random.Random(z * 1_000_003 + x * 7919 + y)
        im = Image.new("RGB", (512, 512), (242, 242, 240)); d = ImageDraw.Draw(im)
        for _ in range(14):
            if r.random() < .5: yy = r.randrange(512); d.line([(0, yy), (512, yy + r.randrange(-60, 60))], fill="white", width=r.choice([6, 10, 16]))
            else: xx = r.randrange(512); d.line([(xx, 0), (xx + r.randrange(-60, 60), 512)], fill="white", width=r.choice([6, 10, 16]))
        d.rectangle([2, 2, 509, 509], outline=(225, 225, 225)); d.text((10, 10), f"{z}/{x}/{y}", fill=(180, 180, 180))
        b = io.BytesIO(); im.save(b, "PNG")
        self.send_response(200); self.send_header("Content-Type", "image/png"); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(b.getvalue())
    def log_message(self, *a): pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory="site")).serve_forever()
