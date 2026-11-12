# MRC ZH (mrc-route-poster)

A phone app for the Mikkeller Running Club Zürich captains: choose a GPX file, type the title, and get a route post in the MRC style, ready to share to Instagram.

It replaces the old Inkscape workflow (GPX → SVG converter → Snazzy Maps screenshot → line up by hand → node editing → export).

## What it does

### Route post tab

Everything here stays on your own phone; nobody else sees your edits.

- Shows distance, climb and 🚦 traffic lights for the GPX. The run date comes from the schedule; tap the date on the post to change it.
- Two routes (**+ Add a second route** opens a sheet: pick from the saved routes, with distance filters and map pictures, or **Upload a GPX file**): where they share streets they run side by side, the shorter one on the inside, each at its normal width; the shared stretch of the shorter route is snapped onto the longer one so GPS wobble doesn't show. Each route has a ✕: remove either one; removing the main route makes the second the main one (it keeps its colour; the title stays as it is).
- Load a GPX file, or tap **Paste a GPX** to paste a copied GPX file (in Files: press and hold → Copy; on a laptop, Cmd+V anywhere works; GPX text works too). The **✕** next to the route info removes it; with only one route that clears everything and goes back to the start.
- Reads the GPX on the phone (nothing is uploaded unless you save it to the route library): the **distance** comes straight from the GPX, the **title** from its name (`261014_MRC_LITTLE-DIPPER` becomes LITTLE DIPPER, editable), the **date** from the next run in the schedule.
- Draws the MRC grey street map with the route on top in **burgundy `#882c29`** or **blue `#3584ba`**.
- Title, distance, **FREE BEER!** and date in **MikkelWind**, like the earlier route posts. Title, distance and FREE BEER! can each be dragged with one finger and turned (any angle) and resized with two; Like on Instagram, text sticks to the centre lines (with a guide line) and to straight angles when it gets close, and comes off when you move further. “Put text back in place” resets them. FREE BEER! is always there.
- **Two route options:** add a second GPX; it's drawn in the other colour and both distances are shown, each in its route's colour.
- Formats: **Post 4:5** (1080×1350), **Square** (1080×1080), and **Transparent**: a transparent PNG of just the line(s), cropped tight around the route, to use as a sticker on a photo.
- Drag the map to move it, pinch with two fingers to zoom. **Reset layout** appears once you move the map or the text and puts both back as they were. The text you're handling gets a dashed outline (only on screen, never in the image).
- The three sections (Route post, Schedule, Routes) are in a tab bar at the bottom, within thumb reach.
- **Tap to edit, right on the post** (hint under it: “Tap · drag · pinch”): tap the **title** and type (the post changes as you type, Enter/Done closes the keyboard), tap the **route** to switch burgundy ⇄ blue (with two routes they swap), tap the **date** to pick another. Line width (10) and GPS-wobble smoothing (8 m) are fixed; there are no sliders. While you type, the title uses `site/fonts/MikkelWind-typing.ttf` (MikkelWind plus Ä Ö Ü built from its own letters and full stops, made with `tools/make_typing_font.py`), so umlauts look the same while typing as on the post.
- **Share** opens the phone's share sheet (Instagram, Photos, WhatsApp…). 

### Routes tab

Every route we've run, shortest first, each with a picture of the line on the map, its distance and, when the GPX has elevation, the climb (↑ metres; rises under 3 m are ignored as GPS noise).

- **Use** opens the route in Route post; **GPX** opens the share sheet (Save to Files, Garmin Connect, Komoot…) on phones, or downloads it on a computer. It never opens the file itself: in the home-screen app on iPhone that preview has no way back.
- Captains add routes with **Save to route library** in Route post (title, distance, run date and the GPX file), or **Add GPX files** in Routes for older runs (several at once). **Edit** on a route changes its title and run date, or removes it. If it's the same route as one already there (similar distance and the lines within about 60 m of each other, or the same name), the app shows the new one, the saved one and both overlaid, and asks: replace it, keep both, or skip.
- Saved routes have a heading with the count; once there are 6 or more, filter by distance (All · ≤5 km · 5–7 km · 7+ km). Suggested loops have a dashed outline until saved.
- Everyone signed in can browse and download; only captains can add or remove (remove: tap twice).
- Stored with the schedule in the Durable Object (`routes` table); very large GPX files are rewritten from their points.

### Traffic lights and loop suggestions (Routes tab)

- Every route shows **🚦 n** (counted once when it's added, then stored with the route): the traffic lights (road signals and signalled crossings, from OpenStreetMap) within 15 m of the line; lights within 40 m of each other count as one junction. The list of lights comes from the Overpass API through `/api/map/signals`, cached a week by the Worker and on the phone.
- **Suggest a loop**: tap a distance (4–8 km); tapping another distance replaces the results, **Clear** hides them. The app plans loops from the bar (where most saved routes start) in six directions with BRouter (brouter.de) and our running profile `src/mrc-run.brf`: paths, parks and quiet streets first, big roads avoided, each traffic light counted as a 400 m detour, and other street crossings as shorter ones: 120 m for a zebra or unmarked crossing, 60 m for tram or rail tracks, 120–320 m for crossing a main road where nothing is marked (BRouter's estimate of how busy it is). The numbers are at the top of `src/mrc-run.brf`. Each loop goes through two points either side of its direction; every 90° turn costs 40 m so straighter routes win, and there-and-back stretches of any length are cut (a detour that loops around something stays); a suggestion that is out and back overall is dropped. Loops off by more than 10 % are rescaled once. Ties on lights go to the smoother loop (fewer turns per km). The four with the fewest lights are shown; **Use** opens one in Route post, **GPX** downloads it to check first, **Save to library** adds it to the routes.
- Overpass and BRouter are free community services, so the app only asks them when someone taps. Check a suggested loop before posting it: the data doesn't know about lighting, building sites or how busy a path is.

### Only for Kate

- The ⋯ menu has **View as: Me · Captain · Guest**, to see the app the way others do (on Kate's phone only; nothing changes for anyone else). A small tag next to the logo shows which view is on; tap it to go back.
- The menu also lists **what only Kate sees** (who last changed a run).

### Schedule tab

Replaces the old `MRC-leads.xlsx` availability sheet (its rows up to January 2027 were imported).

- Captains are recognised from their login email (`src/captains.js`); nobody has to pick who they are. A login that isn't in that list (a guest) sees “View only”: route posts and the schedule, but no schedule changes.
- For every run, one row of captain names. **Tap a name** to pick that captain's answer: coming, lead, tbd or not coming (everyone starts as tbd). Any number of leads; leads count as coming.
- **Anyone can change anyone** (e.g. fill in for someone who texted); each run shows who made the last change.
- Every Wednesday 18:30 and first Sunday 15:00 appear automatically about three months ahead. Special runs can be added; runs can be retimed, noted or cancelled.
- **Live:** while the Schedule is open it picks up other captains’ changes every 15 seconds and when the app comes back to the foreground (paused while you’re editing a run).
- **History (12 months)**: a table per captain (runs led, runs they said they’d come to) and the past runs by month, with leads, cancellations and notes. Leads before the app come from the spreadsheet’s green cells.
- A **cancelled** run shows a to-do for the captain who was going to lead: post a story, edit the run post, update the board in the bar, tell the other captains.

It costs nothing to run: a static page plus a small Cloudflare Worker (`src/worker.js`) that stores the schedule in a SQLite Durable Object, which Cloudflare creates on deploy. Only people let in by Cloudflare Access can use it; the Worker reads their email from the header Access adds.

## Colours

The app uses the Mikkeller brand book, in two themes, each with Zurich blue `#3584ba` (the blue of the Mikkeller Zurich logo at the bar) for ZH and the buttons plus one more colour. **Light:** Paper `#eee5d2` ground, Peach `#f0b7ad` for coming, a deeper peach ring for lead. **Dark:** warm near-black `#14120f` ground (easy on the eyes), Moss Green `#357c4f` for coming, a lighter green ring for lead. Fine lines stay neutral. tbd is plain, a lead is a coming chip with a ring, not coming is faded and crossed out. Fonts: Windsor for headings, Gotham Black for labels, Gotham Book for text, MikkelWind on the posts. The colours are the variables at the top of `site/index.html`. Route lines on the posts stay Burgundy / Blue. The map on posts follows the hand-made posts (`POST_MAP = "classic"` at the top of `site/app.js`: white water, grey motorways and rail, soft buildings, faint dashed paths, and less detail: no driveways or rail yards, buildings and paths only when zoomed far in); set it to `"grey"` for the earlier look. The **QR button** next to ⋯ (on every tab) shows the WhatsApp community QR code full screen on white, for new runners to scan (`site/img/whatsapp-community.png`; replace that file to change it). The **⋯ menu** (top right) sets the theme: Auto (follows the phone), Light or Dark, or the **Print look** (Light / Dark with 2 px outlines and hard offset shadows, like the crew handbook), remembered per phone. In Dark the route pictures use a dark map; the route line stays Burgundy. Anyone still on a removed colour theme is moved to Light or Dark.

## Adding a captain or an email

1. Add the email to the Cloudflare Access policy **MRC-captains** (so they can log in).
2. Add it to `src/captains.js` (so the app knows who they are), with their Instagram handle. Commit and push.

## Folders

| Path | What's in it |
|---|---|
| `site/index.html` | The app's layout and styles. |
| `site/app.js` | The app's code: route post and schedule screens. |
| `site/vendor/` | MapLibre GL JS, which draws the map. |
| `site/fonts/` | MikkelWind, Windsor Bold, Gotham Black and Gotham Book. |
| `site/manifest.webmanifest`, `site/icon-*.png` | Home-screen name and icon. |
| `site/_headers`, `site/robots.txt` | Keep search engines out. |
| `src/worker.js` | The schedule API (`/api/*`) and its storage. |
| `src/captains.js` | Captains: name, login email(s), Instagram handle. |
| `src/seed.json` | The old spreadsheet's runs and answers, imported on first start. |
| `wrangler.jsonc` | Cloudflare config: the site, the Worker and its storage. |
| `tools/test.py` | End-to-end check of the route post in a headless browser, offline, with locally generated vector map tiles. |
| `tools/test_schedule.py` | End-to-end check of the Schedule tab against the Worker running locally (`wrangler dev`). |
| `test/sample.gpx`, `test/sample2.gpx` | Test routes. |

## Keep this repository private

The Gotham and Windsor fonts are commercial fonts supplied by Mikkeller for brand use. Keep the repo private and the live site (https://mrc-route-poster.kate-pratsinis.workers.dev) behind Cloudflare Access (see `SETUP.md`) so they aren't published openly.

## Map tiles

The map is drawn in the phone's browser from [OpenFreeMap](https://openfreemap.org) vector tiles (OpenStreetMap data in the OpenMapTiles format): no API key, no account, no usage limits. The MRC look (grey ground, white streets, no labels) is the only map style; it's defined in `mapStyle()` in `site/index.html`, with the colours in `PALETTE.grey`. The drawing library is MapLibre GL JS, bundled in `site/vendor/` (BSD licence). OpenStreetMap and OpenMapTiles require a credit. It isn't drawn on the image; the credit is in the app's footer, and “Map: © OpenStreetMap contributors, OpenMapTiles” can go in a post's caption.

## Making a change

1. Edit `site/app.js` (or `site/index.html` for layout and styles). The layout per format (where the title, FREE BEER! and the date sit, and the box the route is fitted into) is `FORMATS` at the top of `site/app.js`. The schedule screen is `renderSchedule()`, its API is `src/worker.js`.
2. Optional: run the check
   ```bash
   pip install playwright pillow && python3 -m playwright install chromium
   python3 tools/test.py              # route post, writes test/out/*.png
   python3 tools/test_schedule.py     # schedule (needs npx wrangler)
   ```
3. Commit and push to `main`. Cloudflare publishes the new version within a minute or two.

## Ideas for later

- Use your own Snazzy Maps screenshot as the background.
- A recap template for the group photo.
