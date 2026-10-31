"""End-to-end check of the Schedule tab against the real Worker running locally.

Needs wrangler (npx wrangler) and Playwright. Starts `wrangler dev` with a fresh local
database, fake map tiles (tools/mock_tiles.py), and pretends to be Cloudflare Access by
adding the signed-in email header to /api calls.

    python3 tools/test_schedule.py [path/to/wrangler]
"""
import json, os, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "out"); os.makedirs(OUT, exist_ok=True)
WRANGLER = sys.argv[1] if len(sys.argv) > 1 else "npx wrangler"
APP, TILES = 8787, 8765
shutil.rmtree(os.path.join(ROOT, ".wrangler"), ignore_errors=True)
dev = subprocess.Popen(f"{WRANGLER} dev --port {APP} --ip 127.0.0.1", shell=True, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
tiles = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "mock_tiles.py"), str(TILES)], cwd=ROOT)
for _ in range(60):
    try: urllib.request.urlopen(f"http://127.0.0.1:{APP}/"); break
    except Exception: time.sleep(1)
errors, ok = [], True

def check(cond, label):
    global ok
    print(("PASS " if cond else "FAIL ") + label); ok &= bool(cond)

def page_for(browser, email):
    pg = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, timezone_id="Europe/Zurich")
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.route("**/cdn-cgi/access/get-identity", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"email": email})))
    pg.route("**/api/**", lambda r: r.continue_(headers={**r.request.headers, "cf-access-authenticated-user-email": email}))
    pg.goto(f"http://127.0.0.1:{APP}/index.html?source=http://127.0.0.1:{TILES}/tilejson")
    return pg

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        kate = page_for(b, "captain@example.com")
        kate.click("#tabbtn-schedule"); kate.wait_for_timeout(1500)
        check(not kate.is_visible("#unlinked") and kate.locator("#claimcard").count() == 0, "Kate is recognised from her email, nothing to pick")
        chips = kate.locator(".run").first.locator(".who li").all_inner_texts()
        check([c.split()[0] for c in chips] == ["Felix", "Kate", "Ale", "Andrea", "Fabio"], f"captains from the roster: {chips}")
        first = kate.locator(".run").first
        date = first.get_attribute("data-date")
        check(first.locator(".tag", has_text="Next run").count() == 1, f"next run highlighted: {date}")
        first.locator('.mine button[data-s="yes"]').click(); kate.wait_for_timeout(600)
        check(kate.locator(".run").first.locator('.mine button[data-s="yes"]').get_attribute("aria-pressed") == "true", "Kate marks herself Coming")
        kate.locator(".run").first.locator("select[data-lead]").select_option(label="Kate ✓"); kate.wait_for_timeout(600)
        check("Set by Kate" in kate.locator(".run").first.inner_text(), "lead set, shows who set it")

        # Cancel the second upcoming run after giving it a lead: action item for that lead
        second = kate.locator(".run").nth(1); d2 = second.get_attribute("data-date")
        second.locator("select[data-lead]").select_option(label="Kate ✓" if "Kate ✓" in second.locator("select[data-lead]").inner_text() else "Kate"); kate.wait_for_timeout(600)
        run2 = kate.locator(f'.run[data-date="{d2}"]')
        run2.locator("details summary").click(); run2.locator('[data-f="cancelled"]').check(); run2.locator("[data-saverun]").click(); kate.wait_for_timeout(700)
        todo = kate.locator(f'.run[data-date="{d2}"] .todo')
        check(todo.count() == 1 and "To do for Kate" in todo.inner_text() and "Instagram" in todo.inner_text(), f"cancelled run shows action item: {todo.inner_text()[:90] if todo.count() else None!r}")
        kate.screenshot(path=os.path.join(OUT, "schedule-kate.png"), full_page=True)

        # Add a special run
        kate.click("#addrun summary"); kate.fill("#newdate", "2026-12-24"); kate.fill("#newtime", "10:00"); kate.fill("#newnote", "Christmas Eve jog"); kate.click("#newsave"); kate.wait_for_timeout(800)
        check(kate.locator('.run[data-date="2026-12-24"]').count() == 1, "special run added")

        # Route post takes the next run's date; hint names the lead
        kate.click("#tabbtn-poster")
        kate.set_input_files("#gpx", os.path.join(ROOT, "test", "sample.gpx")); kate.wait_for_timeout(2500)
        check(kate.input_value("#date") == date, f"poster date = next run ({kate.input_value('#date')})")
        check("led by Kate" in kate.inner_text("#nextrun-hint"), f"hint: {kate.inner_text('#nextrun-hint')}")

        # An email that isn't in src/captains.js can look but not change anything
        guest = page_for(b, "someone@example.com")
        guest.click("#tabbtn-schedule"); guest.wait_for_timeout(1500)
        check(guest.is_visible("#unlinked") and "someone@example.com" in guest.inner_text("#unlinked"), "unlinked email gets the 'not linked yet' note")
        check(guest.locator(".mine").count() == 0 and guest.locator("select[data-lead]").first.is_disabled(), "unlinked email can't change anything")
        r = guest.evaluate("fetch('/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:'%s',status:'yes'})}).then(r=>r.status)" % date)
        check(r == 403, f"API refuses changes from an unlinked email ({r})")
        guest.close()

        # Without the Access header the API refuses
        anon = b.new_page()
        anon.goto(f"http://127.0.0.1:{APP}/index.html")
        anon.click("#tabbtn-schedule"); anon.wait_for_timeout(1200)
        check("Not signed in" in anon.inner_text("#schedstatus"), "no login, no schedule")
        b.close()
finally:
    dev.terminate(); tiles.terminate()
    subprocess.run("pkill -x workerd", shell=True)
print("page errors:", errors or "none")
sys.exit(0 if ok and not errors else 1)
