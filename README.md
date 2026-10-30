# MRC Route Poster

A phone app for the Mikkeller Run Club Zürich captains: choose a GPX file, type the title, and get a route post in the MRC style, ready to share to Instagram.

It replaces the old Inkscape workflow (GPX → SVG converter → Snazzy Maps screenshot → line up by hand → node editing → export).

## What it does

- Reads the GPX on the phone (nothing is uploaded) and fills in the **distance**, the **title** (from the GPX name) and the **date** (next Wednesday).
- Draws a light-grey street map around the route with the route on top in **burgundy `#882c29`** or **blue `#3584ba`**.
- Writes the title, distance, **FREE BEER!** and date in **MikkelWind**, like the earlier route posts.
- Formats: **Post 4:5** (1080×1350), **Story 9:16** (1080×1920), **Square** (1080×1080), and **Route only**: a transparent PNG of just the line, to put on a group photo.
- Drag the picture to move the map, pinch or use the slider to zoom, and crop a strip off the bottom (the date and FREE BEER! move up with it).
- Smooth out GPS wobble, round corners, line width, and **trim** a few metres off the start or finish (for when the start and finish lines don't quite meet at the bar).
- Writes a draft caption with the title, day, distance, @mikkellerzurich, start time, who leads, free beer and “The slowest runner sets the pace”. Six style buttons (Classic, Short, Playful, Newcomers, Who’s in?, Rain or shine) each give a different version; edit it and copy it.
- **Share** opens the phone's share sheet (Instagram, Photos, WhatsApp…). **Download PNG** saves the file.

### Schedule tab

Replaces the old `MRC-leads.xlsx` availability sheet (its rows up to January 2027 were imported).

- Each captain links their login email to their name once (Felix, Kate, Ale, Andrea, Fabio, or a new captain) and adds their Instagram handle.
- For every run: **Coming / Not coming / Don't know**, everyone's answers at a glance, and how many are coming.
- Any captain can pick the **lead**; the app shows who set it, and the lead is marked as coming.
- Every Wednesday 18:30 and first Sunday 15:00 appear automatically about three months ahead. Special runs (e.g. the anniversary run) can be added; runs can be retimed, noted or cancelled.
- The route post takes the **date, start time and “Led by” handle** of the next run from here.

It costs nothing to run: a static page plus a small Cloudflare Worker (`src/worker.js`) that stores the schedule in a SQLite Durable Object, which Cloudflare creates on deploy. Only people let in by Cloudflare Access can use it; the Worker reads their email from the header Access adds. Settings like route colour are remembered on each phone.

## Folders

| Path | What's in it |
|---|---|
| `site/index.html` | The whole app: layout, styles and code. |
| `site/vendor/` | MapLibre GL JS, which draws the map. |
| `site/fonts/` | MikkelWind, Windsor Bold, Gotham Black and Gotham Book. |
| `site/manifest.webmanifest`, `site/icon-*.png` | Home-screen name and icon. |
| `site/_headers`, `site/robots.txt` | Keep search engines out. |
| `src/worker.js` | The schedule API (`/api/*`) and its storage. |
| `src/seed.json` | The old spreadsheet's runs and answers, imported on first start. |
| `wrangler.jsonc` | Cloudflare config: the site, the Worker and its storage. |
| `tools/test.py` | End-to-end check of the route post in a headless browser, offline, with locally generated vector map tiles. |
| `tools/test_schedule.py` | End-to-end check of the Schedule tab against the Worker running locally (`wrangler dev`). |
| `test/sample.gpx` | A test route. |

## Keep this repository private

The Gotham and Windsor fonts are commercial fonts supplied by Mikkeller for brand use. Keep the repo private and the live site (https://mrc-route-poster.kate-pratsinis.workers.dev) behind Cloudflare Access (see `SETUP.md`) so they aren't published openly.

## Map tiles

The map is drawn in the phone's browser from [OpenFreeMap](https://openfreemap.org) vector tiles (OpenStreetMap data in the OpenMapTiles format): no API key, no account, no usage limits. The MRC look (grey ground, white streets, no labels) is the only map style; it's defined in `mapStyle()` in `site/index.html`, with the colours in `PALETTE.grey`. The drawing library is MapLibre GL JS, bundled in `site/vendor/` (BSD licence). OpenStreetMap and OpenMapTiles require a credit. It isn't drawn on the image; instead the app adds “Map: © OpenStreetMap contributors, OpenMapTiles” as the last line of the caption, which OpenStreetMap's guidelines accept for images. Leave that line in when posting.

## Making a change

1. Edit `site/index.html`. The layout per format (where the title, FREE BEER! and the date sit, and the box the route is fitted into) is the `FORMATS` block near the top of the script. The caption styles are in `CAPTIONS`; who sees them is `CAPTION_EMAILS`. The schedule screen is `renderSchedule()`, its API is `src/worker.js`.
2. Optional: run the check
   ```bash
   pip install playwright pillow && python3 -m playwright install chromium
   python3 tools/test.py              # route post, writes test/out/*.png
   python3 tools/test_schedule.py     # schedule (needs npx wrangler)
   ```
3. Commit and push to `main`. Cloudflare publishes the new version within a minute or two.

## Ideas for later

- Use your own Snazzy Maps screenshot as the background.
- Several routes on one image (e.g. Sunday long-run options).
- A recap template for the group photo.
