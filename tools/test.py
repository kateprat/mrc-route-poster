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
        check(pg.inner_text("#distinfo").startswith("4.6 km"), f"distance read from GPX: {pg.inner_text('#distinfo')}")
        check(pg.locator("#dist, #cropB, #beer, #capcard, #cap, #marker, #mapstyle").count() == 0, "removed: distance box, crop, FREE BEER switch, caption, marker, map style")
        check(not pg.is_visible("#width"), "advanced settings folded away")
        check(pg.input_value("#title") == "THE LITTLE DIPPER" and pg.input_value("#date") >= "2026-11-04", f"title and date filled: {pg.input_value('#date')}")
        check("Signed in as captain@example.com" in pg.inner_text("#whoami"), "signed-in line")
        for fmt in ["feed", "square", "route"]:
            pg.click(f'#fmt button[data-v="{fmt}"]'); pg.wait_for_timeout(2000); save(pg, f"{fmt}.png")
        pg.click('#fmt button[data-v="feed"]'); pg.wait_for_timeout(1500)

        # every text item: drag it, then two fingers to turn (past 45°) and resize; map stays put
        pg.evaluate("document.getElementById('cv').scrollIntoView({block:'start'})"); pg.wait_for_timeout(200)
        check(pg.locator("#beersize, #beerrot").count() == 0, "no size/angle sliders any more")
        for key, ddx, ddy in (("beer", -80, -120), ("dist", -90, 380), ("title", 60, 200)):
            h = pg.evaluate(f"S.hits.{key}"); box = pg.locator("#cv").bounding_box(); k = box["width"] / 1080
            sx, sy = box["x"] + h["cx"] * k, box["y"] + h["cy"] * k
            pg.mouse.move(sx, sy); pg.mouse.down(); pg.mouse.move(sx + ddx * k, sy + ddy * k, steps=6); pg.mouse.up(); pg.wait_for_timeout(300)
            m = pg.evaluate(f"itemOf('{key}')")
            check(abs(m["dx"] - ddx) < 3 and abs(m["dy"] - ddy) < 3, f"{key} dragged by {m}")
            res = pg.evaluate("""(key) => { const h=S.hits[key], r=cv.getBoundingClientRect(), k=r.width/cv.width;
              const cx=r.left+h.cx*k, cy=r.top+h.cy*k;
              const ev=(t,id,x,y)=>cv.dispatchEvent(new PointerEvent(t,{pointerId:id,clientX:x,clientY:y,bubbles:true,isPrimary:id===1}));
              ev("pointerdown",1,cx-20,cy); ev("pointerdown",2,cx+20,cy);
              ev("pointermove",2,cx-20,cy+40);   // twist about +90°
              ev("pointermove",1,cx-20,cy-40);   // spread
              ev("pointerup",1,cx-20,cy-40); ev("pointerup",2,cx-20,cy+40);
              return itemOf(key); }""", key)
            check(res["rot"] > 60 and res["scale"] > 1.2, f"two fingers turn {key} past 45° and enlarge it: rot {res['rot']:.0f}°, size {res['scale']:.2f}")
        # sticky centre line: FREE BEER! (already moved left) dragged back near the middle sticks to it, then comes off
        h = pg.evaluate("S.hits.beer"); box = pg.locator("#cv").bounding_box(); k = box["width"] / 1080
        sx, sy = box["x"] + h["cx"] * k, box["y"] + h["cy"] * k
        pg.mouse.move(sx, sy); pg.mouse.down(); pg.mouse.move(sx + (540 - h["cx"] + 15) * k, sy + 40 * k, steps=8); pg.wait_for_timeout(200)
        snapped = pg.evaluate("[S.hits.beer.cx, S.guides && S.guides.v]")
        check(abs(snapped[0] - 540) < 1 and snapped[1], f"sticks to the centre line with a guide: {snapped}")
        pg.mouse.move(sx + (540 - h["cx"] + 80) * k, sy + 40 * k, steps=4); pg.wait_for_timeout(200)
        off = pg.evaluate("[S.hits.beer.cx, !!(S.guides && S.guides.v)]")
        check(off[0] > 600 and not off[1], f"comes off when moved further: {off}")
        pg.mouse.up(); pg.wait_for_timeout(200)
        check(pg.evaluate("S.guides") is None, "guide lines gone after letting go")
        h = pg.evaluate("S.hits.title"); box = pg.locator("#cv").bounding_box(); k = box["width"] / 1080
        pg.mouse.move(box["x"] + h["cx"] * k, box["y"] + h["cy"] * k); pg.mouse.down(); pg.wait_for_timeout(100)
        check(pg.evaluate("S.sel") == "title", "touched text gets an outline")
        pg.mouse.up(); pg.wait_for_timeout(1500)
        check(pg.evaluate("S.sel") is None, "outline fades after letting go")
        check(pg.evaluate("S.pan.x === 0 && S.pan.y === 0 && S.zoom === 1"), "map didn't move or zoom while handling text")
        check(pg.is_visible("#beerreset"), "'Reset layout' appears")
        save(pg, "feed-text-moved.png")
        pg.click("#beerreset"); pg.wait_for_timeout(300)
        check(pg.evaluate("S.items.feed") is None and not pg.is_visible("#beerreset"), "everything back in place")
        pg.evaluate("S.zoom=1.4; S.pan={x:0.00001,y:0}; draw()"); pg.wait_for_timeout(200)
        check(pg.is_visible("#beerreset") and pg.locator("#zoom").count()==0, "zoomed map: 'Reset layout' shows, no zoom slider")
        pg.click("#beerreset"); pg.wait_for_timeout(200)
        check(pg.evaluate("S.zoom===1 && S.pan.x===0 && S.pan.y===0") and not pg.is_visible("#beerreset"), "map zoom and position reset")
        check(pg.evaluate("getComputedStyle(document.documentElement).touchAction") == "manipulation", "no double-tap zoom")

        # dragging elsewhere still moves the map
        pg.locator("#cv").scroll_into_view_if_needed(); box = pg.locator("#cv").bounding_box()
        pg.mouse.move(box["x"] + 60, box["y"] + 260); pg.mouse.down(); pg.mouse.move(box["x"] + 100, box["y"] + 230, steps=5); pg.mouse.up()
        check(pg.evaluate("S.pan.x !== 0"), "map drag still works")

        # advanced settings + reset
        pg.click("#advanced summary")
        pg.fill("#width", "18"); pg.dispatch_event("#width", "input")
        pg.click("#advreset"); pg.wait_for_timeout(200)
        check(pg.evaluate("S.width===10 && S.simplify===8"), "advanced reset to standard")

        # second route
        pg.set_input_files("#gpx2", os.path.join(ROOT, "test", "sample2.gpx")); pg.wait_for_timeout(2500)
        check(pg.evaluate("S.routes.length") == 2, "second route loaded")
        check(pg.inner_text("#distinfo").count("km") == 2, f"both distances shown: {pg.inner_text('#distinfo')}")
        check("↑" in pg.inner_text("#distinfo"), f"climb from the GPX elevation: {pg.inner_text('#distinfo')}")
        save(pg, "feed-two-routes.png")
        pg.click('#fmt button[data-v="route"]'); pg.wait_for_timeout(800); save(pg, "route-two-routes.png")
        pg.click('#fmt button[data-v="feed"]')
        pg.click("#route2remove"); pg.wait_for_timeout(500)
        check(pg.evaluate("S.routes.length") == 1, "second route removed")

        with pg.expect_download() as dl:
            pg.click("#share")
        dl.value.save_as(os.path.join(OUT, "download.png"))
        check(dl.value.suggested_filename == "mrc-the-little-dipper-feed.png", "Share downloads the PNG where there is no share sheet")
        # every tab still shows its content (catches broken page structure)
        for tab, el in (("schedule", "#tab-schedule"), ("routes", "#sugopen"), ("poster", "#editor")):
            pg.click(f"#tabbtn-{tab}"); pg.wait_for_timeout(300)
            check(pg.is_visible(el), f"{tab} tab shows its content")
        b.close()
finally:
    srv.terminate()
print("page errors:", errors or "none")
sys.exit(0 if ok and not errors else 1)
