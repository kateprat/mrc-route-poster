"""Offline end-to-end check: serves site/ with fake map tiles, loads test/sample.gpx
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
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        tiles = f"http://127.0.0.1:{PORT}/tiles/{{style}}/{{z}}/{{x}}/{{y}}.png"
        pg.goto(f"http://127.0.0.1:{PORT}/index.html?tiles={tiles}")
        pg.screenshot(path=os.path.join(OUT, "phone-start.png"))
        pg.set_input_files("#gpx", os.path.join(ROOT, "test", "sample.gpx"))
        pg.wait_for_selector("#editor:not(.hidden)")
        pg.wait_for_timeout(1500)
        print("distance field:", pg.input_value("#dist"), "| title:", pg.input_value("#title"), "| date:", pg.input_value("#date"))
        print("caption:", pg.input_value("#cap"))
        pg.screenshot(path=os.path.join(OUT, "phone-editor.png"), full_page=True)
        for fmt in ["feed", "story", "square", "route"]:
            pg.click(f'#fmt button[data-v="{fmt}"]'); pg.wait_for_timeout(1200)
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
        with pg.expect_download() as dl:
            pg.click("#save")
        dl.value.save_as(os.path.join(OUT, "download.png"))
        print("download:", dl.value.suggested_filename)
        b.close()
finally:
    srv.terminate()
print("errors:", errors or "none")
sys.exit(1 if errors else 0)
