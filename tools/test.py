"""Offline end-to-end check of the Route post tab: serves site/ with locally generated vector
map tiles, loads test/sample.gpx (and test/sample2.gpx as a second route) in headless Chromium,
renders every format and saves PNGs to test/out/.

    python3 tools/test.py
"""
import base64, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "out"); os.makedirs(OUT, exist_ok=True)
PORT = 8765
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "mock_tiles.py"), str(PORT)], cwd=ROOT)
time.sleep(1)
errors, ok = [], True

def check(cond, label):
    global ok
    print(("PASS " if cond else "FAIL ") + label); ok &= bool(cond)

def save(pg, name):
    data = pg.evaluate("document.getElementById('cv').toDataURL('image/png')")
    open(os.path.join(OUT, name), "wb").write(base64.b64decode(data.split(",")[1]))

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, timezone_id="Europe/Zurich")
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        # this test serves only site/, without the Worker API: give it an empty schedule
        pg.route("**/api/**", lambda r: r.fulfill(status=200, content_type="application/json", body='{"me":{"email":"","captain":null},"captains":[],"runs":[]}'))
        pg.route("**/cdn-cgi/access/get-identity", lambda r: r.fulfill(status=200, content_type="application/json", body='{"email":"captain@example.com"}'))
        pg.goto(f"http://127.0.0.1:{PORT}/index.html?source=http://127.0.0.1:{PORT}/tilejson")
        pg.set_input_files("#gpx", os.path.join(ROOT, "test", "sample.gpx"))
        pg.wait_for_selector("#editor:not(.hidden)"); pg.wait_for_timeout(4000)
        check(pg.evaluate("M.ready") and not pg.evaluate("M.error"), "map loads")
        check(pg.inner_text("#distinfo") == "4.6 km", f"distance read from GPX: {pg.inner_text('#distinfo')}")
        check(pg.locator("#dist, #cropB, #beer, #capcard, #cap, #marker, #mapstyle").count() == 0, "removed: distance box, crop, FREE BEER switch, caption, marker, map style")
        check(not pg.is_visible("#width"), "advanced settings folded away")
        check(pg.input_value("#title") == "THE LITTLE DIPPER" and pg.input_value("#date") >= "2026-11-04", f"title and date filled: {pg.input_value('#date')}")
        check("Signed in as captain@example.com" in pg.inner_text("#whoami"), "signed-in line")
        for fmt in ["feed", "story", "square", "route"]:
            pg.click(f'#fmt button[data-v="{fmt}"]'); pg.wait_for_timeout(2000); save(pg, f"{fmt}.png")
        pg.click('#fmt button[data-v="feed"]'); pg.wait_for_timeout(1500)

        # drag FREE BEER! up and to the left, then reset it
        bb = pg.evaluate("S.beerHit"); box = pg.locator("#cv").bounding_box(); k = box["width"] / 1080
        sx, sy = box["x"] + bb["cx"] * k, box["y"] + bb["cy"] * k
        pg.mouse.move(sx, sy); pg.mouse.down(); pg.mouse.move(sx - 80, sy - 120, steps=6); pg.mouse.up(); pg.wait_for_timeout(400)
        moved = pg.evaluate("S.beer.feed")
        check(moved is not None and moved["y"] < 1350 * 0.865 - 100, f"FREE BEER! dragged to {moved}")
        check(pg.evaluate("S.pan.x === 0 && S.pan.y === 0"), "map did not move while dragging FREE BEER!")
        check(pg.is_visible("#beerreset"), "reset button appears")
        # size and angle sliders
        pg.fill("#beersize", "150"); pg.dispatch_event("#beersize", "input")
        pg.fill("#beerrot", "-12"); pg.dispatch_event("#beerrot", "input"); pg.wait_for_timeout(300)
        b2 = pg.evaluate("beerState()")
        check(abs(b2["scale"] - 1.5) < 1e-6 and b2["rot"] == -12 and abs(b2["x"] - moved["x"]) < 1e-6, f"size 150% and angle -12° keep the position: {b2}")
        # two fingers on FREE BEER!: spread and twist (synthetic pointer events, like a phone)
        res = pg.evaluate("""() => { const h=S.beerHit, r=cv.getBoundingClientRect(), k=r.width/cv.width;
          const cx=r.left+h.cx*k, cy=r.top+h.cy*k;
          const ev=(t,id,x,y)=>cv.dispatchEvent(new PointerEvent(t,{pointerId:id,clientX:x,clientY:y,bubbles:true,isPrimary:id===1}));
          ev("pointerdown",1,cx-20,cy); ev("pointerdown",2,cx+20,cy);
          ev("pointermove",2,cx+20,cy+20);            // twist: about +45°
          ev("pointermove",1,cx-40,cy-20);            // spread
          ev("pointerup",1,cx-40,cy-20); ev("pointerup",2,cx+20,cy+20);
          return beerState(); }""")
        check(res["rot"] > b2["rot"] + 20 and res["scale"] > b2["scale"], f"two-finger twist and spread on FREE BEER!: {res}")
        check(pg.evaluate("S.zoom") == 1, "map zoom unchanged by the FREE BEER! gesture")
        save(pg, "feed-beer-moved.png")
        pg.click("#beerreset"); pg.wait_for_timeout(300)
        check(pg.evaluate("S.beer.feed") is None and not pg.is_visible("#beerreset") and pg.input_value("#beersize") == "100" and pg.input_value("#beerrot") == "0", "FREE BEER! back in place, size and angle reset")

        # dragging elsewhere still moves the map
        pg.locator("#cv").scroll_into_view_if_needed(); box = pg.locator("#cv").bounding_box()
        pg.mouse.move(box["x"] + 60, box["y"] + 260); pg.mouse.down(); pg.mouse.move(box["x"] + 100, box["y"] + 230, steps=5); pg.mouse.up()
        check(pg.evaluate("S.pan.x !== 0"), "map drag still works")

        # advanced settings + reset
        pg.click("#advanced summary")
        pg.fill("#width", "18"); pg.dispatch_event("#width", "input"); pg.fill("#trimS", "200"); pg.dispatch_event("#trimS", "input")
        pg.click("#advreset"); pg.wait_for_timeout(200)
        check(pg.evaluate("S.width===10 && S.simplify===8 && S.trimS===0 && !S.round"), "advanced reset to standard")

        # second route
        pg.set_input_files("#gpx2", os.path.join(ROOT, "test", "sample2.gpx")); pg.wait_for_timeout(2500)
        check(pg.evaluate("S.routes.length") == 2, "second route loaded")
        check(pg.inner_text("#distinfo").count("km") == 2, f"both distances shown: {pg.inner_text('#distinfo')}")
        save(pg, "feed-two-routes.png")
        pg.click('#fmt button[data-v="route"]'); pg.wait_for_timeout(800); save(pg, "route-two-routes.png")
        pg.click('#fmt button[data-v="feed"]')
        pg.click("#route2remove"); pg.wait_for_timeout(500)
        check(pg.evaluate("S.routes.length") == 1, "second route removed")

        with pg.expect_download() as dl:
            pg.click("#save")
        dl.value.save_as(os.path.join(OUT, "download.png"))
        check(dl.value.suggested_filename == "mrc-the-little-dipper-feed.png", "download works")
        b.close()
finally:
    srv.terminate()
print("page errors:", errors or "none")
sys.exit(0 if ok and not errors else 1)
