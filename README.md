# MRC Route Poster

A phone app for the Mikkeller Run Club Zürich captains: choose a GPX file, type the title, and get a route post in the MRC style, ready to share to Instagram.

It replaces the old Inkscape workflow (GPX → SVG converter → Snazzy Maps screenshot → line up by hand → node editing → export).

## What it does

### Route post tab

Everything here stays on your own phone; nobody else sees your edits.

- Reads the GPX on the phone (nothing is uploaded): the **distance** comes straight from the GPX, the **title** from its name (`261014_MRC_LITTLE-DIPPER` becomes LITTLE DIPPER, editable), the **date** from the next run in the schedule.
- Draws the MRC grey street map with the route on top in **burgundy `#882c29`** or **blue `#3584ba`**.
- Title, distance, **FREE BEER!** and date in **MikkelWind**, like the earlier route posts. FREE BEER! is always there; drag it to move it, turn and resize it with two fingers or the Size and Angle sliders, and “Put FREE BEER! back” returns it to its usual spot.
- **Two route options:** add a second GPX; it's drawn in the other colour and both distances are shown, each in its route's colour.
- Formats: **Post 4:5** (1080×1350), **Story 9:16** (1080×1920), **Square** (1080×1080), and **Route only**: a transparent PNG of just the line(s), to put on a group photo.
- Drag the map to move it, pinch or use the slider to zoom.
- **Advanced settings** (folded away, with “Reset to standard”): line width, smoothing GPS wobble, round corners, trimming the ends.
- **Share** opens the phone's share sheet (Instagram, Photos, WhatsApp…). **Download PNG** saves the file.

### Schedule tab

Replaces the old `MRC-leads.xlsx` availability sheet (its rows up to January 2027 were imported).

- Captains are recognised from their login email (`src/captains.js`); nobody has to pick who they are. A login that isn't in that list can look but not change anything.
- For every run, one row of captain names. **Tap a name** to move that captain on: not coming → tbd → coming → lead → not coming. Any number of leads; leads count as coming.
- **Anyone can change anyone** (e.g. fill in for someone who texted); each run shows who made the last change.
- Every Wednesday 18:30 and first Sunday 15:00 appear automatically about three months ahead. Special runs can be added; runs can be retimed, noted or cancelled.
- **Live:** while the Schedule is open it picks up other captains’ changes every 15 seconds and when the app comes back to the foreground (paused while you’re editing a run).
- **History (12 months)**: a table per captain (runs led, runs they said they’d come to) and the past runs by month, with leads, cancellations and notes. Leads before the app come from the spreadsheet’s green cells.
- A **cancelled** run shows a to-do for the captain who was going to lead: post a story, edit the run post, update the board in the bar, tell the other captains.

It costs nothing to run: a static page plus a small Cloudflare Worker (`src/worker.js`) that stores the schedule in a SQLite Durable Object, which Cloudflare creates on deploy. Only people let in by Cloudflare Access can use it; the Worker reads their email from the header Access adds.

## Colours

The app uses the Mikkeller brand book: **Evening Blue `#0f0f54`** on **Paper `#eee5d2`** for the interface, **Moss Green `#357c4f`** for coming, **Yellow `#f5e14b`** for tbd, Evening Blue for lead. In dark mode the background is Evening Blue with **Peach `#f0b7ad`** highlights. Fonts: Windsor for headings, Gotham Black for labels, Gotham Book for text, MikkelWind on the posts. The colours are the variables at the top of `site/index.html`. Route lines on the posts stay Burgundy / Blue.

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

The map is drawn in the phone's browser from [OpenFreeMap](https://openfreemap.org) vector tiles (OpenStreetMap data in the OpenMapTiles format): no API key, no account, no usage limits. The MRC look (grey ground, white streets, no labels) is the only map style; it's defined in `mapStyle()` in `site/index.html`, with the colours in `PALETTE.grey`. The drawing library is MapLibre GL JS, bundled in `site/vendor/` (BSD licence). OpenStreetMap and OpenMapTiles require a credit. It isn't drawn on the image; the app reminds you to add “Map: © OpenStreetMap contributors, OpenMapTiles” to the post's caption, which OpenStreetMap's guidelines accept for images.

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
