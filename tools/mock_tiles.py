"""Local stand-in for OpenFreeMap, used only by the offline test (tools/test.py).

Serves the site/ folder plus:
  /tilejson                 TileJSON like https://tiles.openfreemap.org/planet
  /t/{z}/{x}/{y}.pbf        vector tiles in the OpenMapTiles layout (transportation, water, park, building)
with a made-up street grid, so the real map-drawing code runs end to end.
"""
import functools, http.server, json, math, random, re, sys
import mapbox_vector_tile

EXTENT = 4096

def tile_bounds(z, x, y):
    n = 2 ** z
    lon0, lon1 = x / n * 360 - 180, (x + 1) / n * 360 - 180
    lat = lambda t: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * t / n))))
    return lon0, lat(y + 1), lon1, lat(y)

def to_tile(lon, lat, z, x, y):
    n = 2 ** z
    ux = (lon + 180) / 360 * n - x
    s = math.sin(math.radians(lat)); uy = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n - y
    return (ux * EXTENT, (1 - uy) * EXTENT)   # encoder flips y by default

def build(z, x, y):
    lon0, lat0, lon1, lat1 = tile_bounds(z, x, y)
    roads, step = [], 0.0012
    r = random.Random(1)
    i = math.floor(lon0 / step)
    while i * step <= lon1:
        lon = i * step; cls = "primary" if i % 7 == 0 else ("tertiary" if i % 3 == 0 else "minor")
        roads.append({"geometry": "LINESTRING (%s)" % ", ".join("%f %f" % to_tile(lon + 0.0002 * math.sin(k), lat0 + (lat1 - lat0) * k / 8, z, x, y) for k in range(9)), "properties": {"class": cls}})
        i += 1
    j = math.floor(lat0 / (step * 0.68))
    while j * step * 0.68 <= lat1:
        lat = j * step * 0.68; cls = "secondary" if j % 5 == 0 else "minor"
        roads.append({"geometry": "LINESTRING (%f %f, %f %f)" % (*to_tile(lon0, lat, z, x, y), *to_tile(lon1, lat + 0.0003, z, x, y)), "properties": {"class": cls}})
        j += 1
    # a lake in the south-east like Lake Zurich
    lake = [(8.536, 47.3655), (8.60, 47.3655), (8.60, 47.30), (8.536, 47.30)]
    water = [{"geometry": "POLYGON ((%s))" % ", ".join("%f %f" % to_tile(lo, la, z, x, y) for lo, la in lake + lake[:1]), "properties": {"class": "lake"}}]
    park = [{"geometry": "POLYGON ((%s))" % ", ".join("%f %f" % to_tile(lo, la, z, x, y) for lo, la in [(8.528, 47.369), (8.532, 47.369), (8.532, 47.367), (8.528, 47.367), (8.528, 47.369)]), "properties": {"class": "park"}}]
    layers = [{"name": "transportation", "features": roads}, {"name": "water", "features": water}, {"name": "park", "features": park}]
    return mapbox_vector_tile.encode(layers, default_options={"extents": EXTENT, "y_coord_down": False})

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/tilejson"):
            host = self.headers.get("Host")
            body = json.dumps({"tilejson": "3.0.0", "tiles": [f"http://{host}/t/{{z}}/{{x}}/{{y}}.pbf"], "minzoom": 0, "maxzoom": 14,
                               "vector_layers": [{"id": n} for n in ("transportation", "water", "park", "building", "landcover", "waterway")]}).encode()
            return self.send(body, "application/json")
        m = re.match(r"/t/(\d+)/(\d+)/(\d+)\.pbf", self.path)
        if m:
            return self.send(build(*map(int, m.groups())), "application/x-protobuf")
        return super().do_GET()
    def send(self, body, ctype):
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory="site")).serve_forever()
