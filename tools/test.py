"""Offline end-to-end check: serves site/ with locally generated vector map tiles, loads test/sample.gpx
in headless Chromium, renders every format and saves PNGs to test/out/.

    python3 tools/test.py
"""
import base64, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "out"); os.makedirs(OUT, exist_ok=True)
PORT = 8765
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "mock_tiles.py"), str(PORT)], cwd=ROOT)
time.sleep(1)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, timezone_id="Europe/Zurich")
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        # pretend Cloudflare Access: who is signed in
        def no_schedule(route):  # this test serves only site/, without the Worker API
            route.fulfill(status=200, content_type="application/json", body='{"me":{"email":"","captain":null},"captains":[],"runs":[]}')
        def who(email):
            return lambda route: route.fulfill(status=200, content_type="application/json", body='{"email":"%s"}' % email) if email else route.fulfill(status=404, body="")
        for email, label in [("someone.else@example.com", "other captain"), ("", "no login info")]:
            other = b.new_page(viewport={"width": 390, "height": 844})
            other.route("**/cdn-cgi/access/get-identity", who(email)); other.route("**/api/**", no_schedule)
            other.goto(f"http://127.0.0.1:{PORT}/index.html?source=http://127.0.0.1:{PORT}/tilejson")
            other.set_input_files("#gpx", os.path.join(ROOT, "test", "sample.gpx")); other.wait_for_timeout(800)
            print(f"{label}: caption visible={other.is_visible('#capcard')} credit note visible={other.is_visible('#creditnote')}")
            other.close()
        pg.route("**/cdn-cgi/access/get-identity", who("captain@example.com")); pg.route("**/api/**", no_schedule)
        pg.goto(f"http://127.0.0.1:{PORT}/index.html?source=http://127.0.0.1:{PORT}/tilejson")
        pg.screenshot(path=os.path.join(OUT, "phone-start.png"))
        pg.set_input_files("#gpx", os.path.join(ROOT, "test", "sample.gpx"))
        pg.wait_for_selector("#editor:not(.hidden)")
        pg.wait_for_timeout(4000)
        print("map loaded:", pg.evaluate("M.ready"), "| map error:", pg.evaluate("M.error"))
        print(f"kate: caption visible={pg.is_visible('#capcard')} credit note visible={pg.is_visible('#creditnote')} footer={pg.inner_text('#whoami')!r}")
        print("distance field:", pg.input_value("#dist"), "| title:", pg.input_value("#title"), "| date:", pg.input_value("#date"))
        print("caption:", pg.input_value("#cap"))
        pg.screenshot(path=os.path.join(OUT, "phone-editor.png"), full_page=True)
        for fmt in ["feed", "story", "square", "route"]:
            pg.click(f'#fmt button[data-v="{fmt}"]'); pg.wait_for_timeout(2500)
            data = pg.evaluate("document.getElementById('cv').toDataURL('image/png')")
            open(os.path.join(OUT, f"{fmt}.png"), "wb").write(base64.b64decode(data.split(",")[1]))
        # star marker + trim + drag
        pg.click('#fmt button[data-v="feed"]')
        pg.click("details summary >> text=Trim the ends"); pg.fill("#trimS", "200"); pg.dispatch_event("#trimS", "input")
        box = pg.locator("#cv").bounding_box()
        pg.mouse.move(box["x"] + 100, box["y"] + 200); pg.mouse.down(); pg.mouse.move(box["x"] + 140, box["y"] + 170, steps=5); pg.mouse.up()
        pg.wait_for_timeout(1200)
        data = pg.evaluate("document.getElementById('cv').toDataURL('image/png')")
        open(os.path.join(OUT, "feed-trim-drag.png"), "wb").write(base64.b64decode(data.split(",")[1]))
        for style in ["classic", "short", "playful", "invite", "whosin", "rain"]:
            pg.click(f'#capstyle button[data-v="{style}"]')
            print(f"[{style}]", pg.input_value("#cap").replace("\n", " / "))
        pg.fill("#lead", "kates.turn")
        pg.click('#capstyle button[data-v="classic"]')
        print("[classic + leader]", pg.input_value("#cap").replace("\n", " / "))
        print("controls:", {k: pg.locator(k).count() for k in ["#width", "#simplify", "#round", "#trimS", "#trimE", "#cropB", "#marker", "#mapstyle"]})
        pg.fill("#cropB", "200"); pg.dispatch_event("#cropB", "input"); pg.wait_for_timeout(1500)
        print("cropped size:", pg.evaluate("[cv.width, cv.height]"))
        data = pg.evaluate("document.getElementById('cv').toDataURL('image/png')")
        open(os.path.join(OUT, "feed-cropped.png"), "wb").write(base64.b64decode(data.split(",")[1]))
        with pg.expect_download() as dl:
            pg.click("#save")
        dl.value.save_as(os.path.join(OUT, "download.png"))
        print("download:", dl.value.suggested_filename)
        b.close()
finally:
    srv.terminate()
print("errors:", errors or "none")
sys.exit(1 if errors else 0)
