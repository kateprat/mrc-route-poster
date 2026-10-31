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

def page_for(browser, email, extra=""):
    pg = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, timezone_id="Europe/Zurich")
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.route("**/cdn-cgi/access/get-identity", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"email": email})))
    pg.route("**/api/**", lambda r: r.continue_(headers={**r.request.headers, "cf-access-authenticated-user-email": email}))
    pg.goto(f"http://127.0.0.1:{APP}/index.html?source=http://127.0.0.1:{TILES}/tilejson{extra}")
    return pg

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        kate = page_for(b, "captain@example.com")
        kate.click("#tabbtn-schedule"); kate.wait_for_timeout(1500)
        check(not kate.is_visible("#unlinked") and kate.is_visible("#schedhelp"), "Kate is recognised from her email; tap help shown")
        first = kate.locator(".run").first
        date = first.get_attribute("data-date")
        names = [n.split()[0] for n in first.locator(".who button").all_inner_texts()]
        check(names == ["Felix", "Kate", "Ale", "Andrea", "Fabio"], f"each captain listed once: {names}")
        check(first.locator(".tag", has_text="Next run").count() == 1, f"next run highlighted: {date}")
        check(first.locator(".mine, .leadpick").count() == 0, "no separate availability buttons or lead dropdown")
        state = lambda who, d=date: kate.locator(f'.run[data-date="{d}"] .who button', has_text=who).get_attribute("class")
        tap = lambda who, d=date: kate.locator(f'.run[data-date="{d}"] .who button', has_text=who).click()
        # Ale is 'not coming' in the sheet: tap through the whole cycle
        seen = [state("Ale")]
        for _ in range(4): tap("Ale"); kate.wait_for_timeout(500); seen.append(state("Ale"))
        check(seen == ["no", "tbd", "yes", "lead", "no"], f"tapping Ale cycles not coming -> don't know -> coming -> lead -> not coming: {seen}")
        # quick taps are kept in order
        for _ in range(3): tap("Ale")
        kate.wait_for_timeout(1500)
        check(state("Ale") == "lead", f"three quick taps land on lead: {state('Ale')}")
        kate.reload(); kate.click("#tabbtn-schedule"); kate.wait_for_timeout(1200)
        check(state("Ale") == "lead", "saved: still lead after reloading")
        meta = kate.locator(".run").first.locator(".run-meta").last.inner_text()
        check("Lead" in meta and "Ale" in meta and "last change by Kate" in meta, f"run shows lead and who changed it: {meta!r}")
        tap("Kate"); tap("Kate"); tap("Kate"); kate.wait_for_timeout(1500)   # Kate: no -> tbd -> yes -> lead
        meta = kate.locator(".run").first.locator(".run-meta").last.inner_text()
        check(meta.startswith("Leads:") and "Kate" in meta and "Ale" in meta, f"several leads: {meta!r}")
        coming = kate.locator(".run").first.locator(".run-head").inner_text()
        check("4 coming" in coming, f"leads count as coming: {coming!r}")

        # Cancel the second run that has leads: to-do names them
        d2 = kate.locator(".run").nth(1).get_attribute("data-date")
        for who in ("Felix", "Kate"):
            while state(who, d2) != "lead": tap(who, d2); kate.wait_for_timeout(400)
        kate.wait_for_timeout(800)
        run2 = kate.locator(f'.run[data-date="{d2}"]')
        run2.locator("details:not(.leadpick) summary").click(); run2.locator('[data-f="cancelled"]').check(); run2.locator("[data-saverun]").click(); kate.wait_for_timeout(700)
        todo = kate.locator(f'.run[data-date="{d2}"] .todo')
        check(todo.count() == 1 and "To do for Felix & Kate" in todo.inner_text(), f"cancelled run shows action item: {todo.inner_text()[:60] if todo.count() else None!r}")
        kate.screenshot(path=os.path.join(OUT, "schedule-kate.png"), full_page=True)

        # Live updates: a second captain has the schedule open while Kate changes her answer
        other = page_for(b, "someone@example.com", "&poll=1000")
        other.click("#tabbtn-schedule"); other.wait_for_timeout(1200)
        d3 = kate.locator(".run").nth(2).get_attribute("data-date")
        before = other.locator(f'.run[data-date="{d3}"] .who button', has_text="Andrea").get_attribute("class")
        kate.locator(f'.run[data-date="{d3}"] .who button', has_text="Andrea").click(); kate.wait_for_timeout(800)
        expected = state("Andrea", d3)
        other.wait_for_timeout(2500)   # no reload, just waiting
        after = other.locator(f'.run[data-date="{d3}"] .who button', has_text="Andrea").get_attribute("class")
        check(before != after == expected, f"other captain sees Kate's change to Andrea without reloading ({before} -> {after})")
        # ...but not while they're in the middle of editing a run
        other.close()
        kate2 = page_for(b, "captain@example.com", "&poll=1000")
        kate2.click("#tabbtn-schedule"); kate2.wait_for_timeout(1200)
        kate2.locator(f'.run[data-date="{d3}"] details:not(.leadpick) summary').click()
        tap("Fabio", d3); kate.wait_for_timeout(2500)
        check(kate2.locator(f'.run[data-date="{d3}"] details:not(.leadpick)[open]').count() == 1, "open 'Edit run' isn't wiped by a refresh")
        kate2.close()

        # History: last 12 months, per-captain tally, grouped by month
        kate.click('#schedview button[data-v="history"]'); kate.wait_for_timeout(400)
        check(kate.is_visible("#history") and not kate.is_visible("#runs"), "History view replaces the upcoming list")
        rows = kate.locator("#history .hist-table tbody tr").all_inner_texts()
        check(len(rows) == 5, f"tally per captain: {rows}")
        led = {r.split("\t")[0]: int(r.split("\t")[1]) for r in rows}
        check(led == {"Felix": 4, "Kate": 8, "Ale": 2, "Andrea": 5, "Fabio": 6}, f"leads from the spreadsheet's green cells: {led}")
        check("Led by Fabio" in kate.locator('#history .hist-run', has_text="Wed 16 Sep").inner_text(), "16 Sep led by Fabio")
        check("Led by Felix" in kate.locator('#history .hist-run', has_text="Wed 28 Oct").inner_text(), "28 Oct led by Felix")
        months = kate.locator("#history .hist-month").all_inner_texts()
        check(len(months) >= 4 and months[0].upper().startswith("OCTOBER"), f"months newest first: {months[:3]}")
        check(kate.locator("#history .hist-run.cancelled").count() >= 1, "cancelled runs shown as cancelled (4 Oct half marathon)")
        kate.locator("#history").screenshot(path=os.path.join(OUT, "history.png"))
        kate.click('#schedview button[data-v="upcoming"]'); kate.wait_for_timeout(300)
        check(kate.is_visible("#runs") and not kate.is_visible("#history"), "back to Upcoming")

        # Add a special run
        kate.click("#addrun summary"); kate.fill("#newdate", "2026-12-24"); kate.fill("#newtime", "10:00"); kate.fill("#newnote", "Christmas Eve jog"); kate.click("#newsave"); kate.wait_for_timeout(800)
        check(kate.locator('.run[data-date="2026-12-24"]').count() == 1, "special run added")

        # Route post takes the next run's date; hint names the lead
        kate.click("#tabbtn-poster")
        kate.set_input_files("#gpx", os.path.join(ROOT, "test", "sample.gpx")); kate.wait_for_timeout(2500)
        check(kate.input_value("#date") == date, f"poster date = next run ({kate.input_value('#date')})")
        check("led by" in kate.inner_text("#nextrun-hint") and "Ale" in kate.inner_text("#nextrun-hint") and "Kate" in kate.inner_text("#nextrun-hint"), f"hint: {kate.inner_text('#nextrun-hint')}")

        # An email that isn't in src/captains.js can look but not change anything
        guest = page_for(b, "someone@example.com")
        guest.click("#tabbtn-schedule"); guest.wait_for_timeout(1500)
        check(guest.is_visible("#unlinked") and "someone@example.com" in guest.inner_text("#unlinked"), "unlinked email gets the 'not linked yet' note")
        check(guest.locator(".who button").first.is_disabled() and not guest.is_visible("#schedhelp"), "unlinked email can't change anything")
        r = guest.evaluate("fetch('/api/captain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:'%s',captain:1,state:'yes'})}).then(r=>r.status)" % date)
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
