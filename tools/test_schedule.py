"""End-to-end check of the Schedule tab against the real Worker running locally.

Needs wrangler (npx wrangler) and Playwright. Starts `wrangler dev` with a fresh local
database, fake map tiles (tools/mock_tiles.py), and pretends to be Cloudflare Access by
adding the signed-in email header to /api calls.

    python3 tools/test_schedule.py [path/to/wrangler]
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request
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
        check(kate.is_visible("#taphint"), "Kate is recognised from her email; tap hint shown")
        own = [n.split()[0] for n in kate.locator(".run").first.locator(".who button[data-cap]").all_inner_texts()]
        check(own == ["Felix", "Kate", "Andrea", "Fabio"], f"Kate's own view leaves Ale out (OWNER_HIDES): {own}")
        # the rest of the test runs as "View as: Captain", which shows every captain
        kate.evaluate("localStorage.setItem('mrc-view','captain')"); kate.reload(); kate.click("#tabbtn-schedule"); kate.wait_for_timeout(1500)
        first = kate.locator(".run").first
        date = first.get_attribute("data-date")
        names = [n.split()[0] for n in first.locator(".who button[data-cap]").all_inner_texts()]
        check(names == ["Felix", "Kate", "Ale", "Andrea", "Fabio"], f"each captain listed once: {names}")
        check(first.locator(".nexttab", has_text="Next run").count() == 1, f"next run highlighted: {date}")
        check(first.locator(".mine, .leadpick").count() == 0, "no separate availability buttons or lead dropdown")
        state = lambda who, d=date: kate.locator(f'.run[data-date="{d}"] .who button[data-cap]', has_text=re.compile(rf"^{who}(lead)?$", re.I)).get_attribute("class")
        def pick(who, st, d=date, pg=None):
            pg = pg or kate
            pg.locator(f'.run[data-date="{d}"] .who button[data-cap]', has_text=re.compile(rf"^{who}(lead)?$", re.I)).click()
            pg.locator(f'#statepick [data-state="{st}"]').click()
        # Ale had the sheet's default 0 (no answer) for this run: she starts as tbd; tap through the whole cycle
        # tapping a name opens a picker with the four answers
        kate.locator(f'.run[data-date="{date}"] .who button[data-cap]', has_text=re.compile(r"^Ale(lead)?$", re.I)).click()
        opts = kate.locator("#statepick [data-state]").all_inner_texts()
        check(kate.is_visible("#statepick") and opts == ["Coming", "Lead", "tbd", "Not coming"], f"picker shows the four answers: {opts}")
        check(kate.locator('#statepick [aria-pressed="true"]').get_attribute("data-state") == "tbd", "current answer is marked")
        kate.locator("#statepick").screenshot(path=os.path.join(OUT, "picker.png"))
        kate.mouse.click(5, 5); kate.wait_for_timeout(200)
        check(not kate.is_visible("#statepick") and state("Ale") == "tbd", "tapping outside closes it without changing anything")
        seen = []
        for st in ["yes", "no", "tbd", "lead"]: pick("Ale", st); kate.wait_for_timeout(500); seen.append(state("Ale"))
        check(seen == ["yes", "no", "tbd", "lead"], f"each answer can be picked directly: {seen}")
        kate.wait_for_timeout(800)
        kate.reload(); kate.click("#tabbtn-schedule"); kate.wait_for_timeout(1200)
        check(state("Ale") == "lead", "saved: still lead after reloading")
        meta = kate.locator(".run").first.locator(".run-meta").last.inner_text()
        check("last change by" not in meta, f"View as Captain hides who changed the run: {meta!r}")
        kate.evaluate("localStorage.setItem('mrc-view','me')"); kate.reload(); kate.click("#tabbtn-schedule"); kate.wait_for_timeout(1200)
        meta = kate.locator(".run").first.locator(".run-meta").last.inner_text()
        check("last change by Kate" in meta, f"Kate sees who changed the run: {meta!r}")
        check(state("Ale") == "lead", "Ale still shown in Kate's view when she leads")
        kate.evaluate("localStorage.setItem('mrc-view','captain')"); kate.reload(); kate.click("#tabbtn-schedule"); kate.wait_for_timeout(1200)
        pick("Kate", "lead"); kate.wait_for_timeout(1500)
        leadnames = [n for n in kate.locator(".run").first.locator(".who button[data-cap]").evaluate_all("bs=>bs.filter(b=>b.classList.contains('lead')).map(b=>b.textContent.trim())")]
        check(len(leadnames) >= 2 and any(n.startswith("Kate") for n in leadnames) and any(n.startswith("Ale") for n in leadnames), f"several leads: {leadnames!r}")
        coming = kate.locator(".run").first.locator(".run-head").inner_text()
        check("4 coming" in coming, f"leads count as coming: {coming!r}")

        # Cancel the second run that has leads: to-do names them
        d2 = kate.locator(".run").nth(1).get_attribute("data-date")
        for who in ("Felix", "Kate"):
            pick(who, "lead", d2); kate.wait_for_timeout(400)
        kate.wait_for_timeout(800)
        run2 = kate.locator(f'.run[data-date="{d2}"]')
        run2.locator("[data-editrun]").click(); run2.locator('[data-f="cancelled"]').check(); run2.locator("[data-saverun]").click(); kate.wait_for_timeout(700)
        todo = kate.locator(f'.run[data-date="{d2}"] .todo')
        check(todo.count() == 1 and "To do for" in todo.inner_text() and "Kate" in todo.inner_text(), f"cancelled run shows action item: {todo.inner_text()[:60] if todo.count() else None!r}")
        kate.screenshot(path=os.path.join(OUT, "schedule-kate.png"), full_page=True)

        # Live updates: a second captain has the schedule open while Kate changes her answer
        other = page_for(b, "someone@example.com", "&poll=1000")
        other.click("#tabbtn-schedule"); other.wait_for_timeout(1200)
        d3 = kate.locator(".run").nth(2).get_attribute("data-date")
        before = other.locator(f'.run[data-date="{d3}"] .who button[data-cap]', has_text=re.compile(r"^Andrea(lead)?$", re.I)).get_attribute("class")
        pick("Andrea", "no" if before != "no" else "yes", d3); kate.wait_for_timeout(800)
        expected = state("Andrea", d3)
        other.wait_for_timeout(2500)   # no reload, just waiting
        after = other.locator(f'.run[data-date="{d3}"] .who button[data-cap]', has_text=re.compile(r"^Andrea(lead)?$", re.I)).get_attribute("class")
        check(before != after == expected, f"other captain sees Kate's change to Andrea without reloading ({before} -> {after})")
        # ...but not while they're in the middle of editing a run
        other.close()
        kate2 = page_for(b, "captain@example.com", "&poll=1000")
        kate2.click("#tabbtn-schedule"); kate2.wait_for_timeout(1200)
        kate2.locator(f'.run[data-date="{d3}"] [data-editrun]').click()
        pick("Fabio", "lead", d3); kate.wait_for_timeout(2500)
        check(kate2.locator(f'.run[data-date="{d3}"] details:not(.leadpick)[open]').count() == 1, "open 'Edit run' isn't wiped by a refresh")
        kate2.close()

        # History: last 12 months, per-captain tally, grouped by month
        kate.click('#schedview button[data-v="history"]'); kate.wait_for_timeout(400)
        check(kate.is_visible("#history") and not kate.is_visible("#runs"), "History view replaces the upcoming list")
        rows = kate.locator("#history .hist-table tbody tr").all_inner_texts()
        check(len(rows) == 5, f"tally per captain: {rows}")
        led = {r.split("\t")[0]: int(r.split("\t")[1]) for r in rows}
        # runs keep moving into the history as the weeks pass, so only check the sheet's counts as a minimum
        check(set(led) == {"Felix","Kate","Ale","Andrea","Fabio"} and all(led[k] >= v for k, v in {"Felix": 4, "Kate": 8, "Ale": 2, "Andrea": 5, "Fabio": 6}.items()), f"leads from the spreadsheet's green cells: {led}")
        check("Led by Fabio" in kate.locator('#history .hist-run', has_text="Wed 16 Sep").inner_text(), "16 Sep led by Fabio")
        check("Led by Felix" in kate.locator('#history .hist-run', has_text="Wed 28 Oct").inner_text(), "28 Oct led by Felix")
        months = kate.locator("#history .hist-month").all_inner_texts()
        import datetime as _dt
        _m = [_dt.datetime.strptime(m.title(), "%B %Y") for m in months]
        check(len(months) >= 4 and _m == sorted(_m, reverse=True), f"months newest first: {months[:3]}")
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

        # Route library: save the loaded route, then the same one again (ask: skip / replace), add an old GPX, use, download, remove
        kate.wait_for_selector("#libsave:not(.hidden)")
        kate.click("#libsavebtn"); kate.wait_for_timeout(1000)
        check("Saved" in kate.inner_text("#libstatus"), f"route saved to the library: {kate.inner_text('#libstatus')!r}")
        kate.click("#libsavebtn"); kate.wait_for_selector("#libdup:not(.hidden)")
        check("already in the library" in kate.inner_text("#libdup"), "same route again: asks replace or skip")
        kate.click('#libdup [data-a="skip"]'); kate.wait_for_timeout(500)
        check("Skipped" in kate.inner_text("#libstatus"), f"skip: {kate.inner_text('#libstatus')!r}")
        kate.fill("#title", "LITTLE DIPPER v2"); kate.click("#libsavebtn"); kate.wait_for_selector("#libdup:not(.hidden)")
        kate.click('#libdup [data-a="replace"]'); kate.wait_for_timeout(1000)
        check("Replaced" in kate.inner_text("#libstatus"), f"replace: {kate.inner_text('#libstatus')!r}")
        kate.click("#tabbtn-routes"); kate.wait_for_timeout(800)
        kate.set_input_files("#gpx3", [os.path.join(ROOT, "test", "sample2.gpx"), os.path.join(ROOT, "test", "sample.gpx")])
        kate.wait_for_selector("#adddup:not(.hidden)")   # second file is the same route as one already saved
        check(kate.locator("#adddup .cmp svg").count() == 3 and kate.locator("#adddup .cmp svg").nth(2).locator("path").count() == 2, "compare: new, saved and both overlaid")
        kate.locator("#adddup").screenshot(path=os.path.join(OUT, "dup.png"))
        check(kate.locator('#adddup [data-a="both"]').count() == 1, "'Keep both' offered")
        kate.click('#adddup [data-a="skip"]'); kate.wait_for_timeout(800)
        check("Saved" in kate.inner_text("#routesstatus") and "Skipped" in kate.inner_text("#routesstatus"), f"several files at once: {kate.inner_text('#routesstatus')!r}")
        cards = kate.locator("#routelist .rcard")
        kms = [float(t.split()[0]) for t in kate.locator("#routelist .rcard .km").all_inner_texts()]
        check(cards.count() == 2 and kms == sorted(kms), f"two routes, shortest first: {kms}")
        ups = kate.locator("#routelist .rcard .km").all_inner_texts()
        check(any("↑" in t and "M" in t.upper() for t in ups) and any("↑" not in t for t in ups), f"climb shown when the GPX has elevation: {ups}")
        check("LITTLE DIPPER V2" in kate.inner_text("#routelist").upper() and kate.locator("#routelist .thumb svg path").count() == 2, "names and route pictures shown")
        kate.locator("#routelist").screenshot(path=os.path.join(OUT, "routes.png"))
        rid = kate.locator("#routelist .rcard").first.get_attribute("data-id")
        g = kate.evaluate("(id)=>fetch('/api/routes/gpx?id='+id).then(async r=>[r.status, r.headers.get('content-disposition'), (await r.text()).slice(0,200)])", rid)
        check(g[0] == 200 and "attachment" in g[1] and "<gpx" in g[2], f"GPX download: {g[:2]}")
        with kate.expect_download() as dl:
            kate.locator("#routelist .rcard").first.locator("[data-gpx]").click()
        check(dl.value.suggested_filename.endswith(".gpx") and "/api/" not in kate.url, f"GPX button downloads without leaving the app: {dl.value.suggested_filename} {kate.url}")
        kate.locator("#routelist .rcard").first.locator("[data-use]").click(); kate.wait_for_timeout(2500)
        check(kate.is_visible("#tab-poster") and kate.locator("#editor:not(.hidden)").count() == 1, "'Make a post' opens the route in Route post")
        kate.click("#tabbtn-routes"); kate.wait_for_timeout(600)
        last = kate.locator("#routelist .rcard").last; rid2 = last.get_attribute("data-id")
        last.locator("[data-edit]").click(); kate.fill(f"#en-{rid2}", "the long one"); kate.fill(f"#ed-{rid2}", "2026-08-12")
        kate.locator(f'[data-save="{rid2}"]').click(); kate.wait_for_timeout(800)
        txt = kate.locator(f'#routelist .rcard[data-id="{rid2}"]').inner_text()
        check("THE LONG ONE" in txt and "12 Aug 2026" in txt, f"rename and date an uploaded route: {txt[:80]!r}")
        last = kate.locator(f'#routelist .rcard[data-id="{rid2}"]'); last.locator("[data-edit]").click()
        rm = last.locator("[data-rm]"); rm.click(); rm.click(); kate.wait_for_timeout(800)
        check(kate.locator("#routelist .rcard").count() == 1, "remove (tap twice) works")

        # An email that isn't in src/captains.js can look but not change anything
        guest = page_for(b, "someone@example.com")
        guest.click("#tabbtn-schedule"); guest.wait_for_timeout(1500)
        check(guest.locator("#unlinked").count() == 0, "no 'View only' note for guests")
        check(guest.locator(".who button[data-cap]").first.is_disabled() and not guest.is_visible("#taphint"), "unlinked email can't change anything")
        r = guest.evaluate("fetch('/api/captain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:'%s',captain:1,state:'yes'})}).then(r=>r.status)" % date)
        check(r == 403, f"API refuses changes from an unlinked email ({r})")
        guest.click("#tabbtn-routes"); guest.wait_for_timeout(800)
        check(guest.locator("#routelist .rcard").count() == 1 and guest.locator("#routelist [data-rm]").count() == 0 and not guest.is_visible("#routeadd"), "guest sees routes but can't add or remove")
        r = guest.evaluate("fetch('/api/routes/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:1})}).then(r=>r.status)")
        check(r == 403, f"API refuses route changes from a guest ({r})")
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
