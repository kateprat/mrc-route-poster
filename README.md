# MRC Route Poster

A phone app for the Mikkeller Run Club Zürich captains: choose a GPX file, type the title, and get a route post in the MRC style, ready to share to Instagram.

It replaces the old Inkscape workflow (GPX → SVG converter → Snazzy Maps screenshot → line up by hand → node editing → export).

## What it does

- Reads the GPX on the phone (nothing is uploaded) and fills in the **distance**, the **title** (from the GPX name) and the **date** (next Wednesday).
- Draws a light-grey street map around the route with the route on top in **burgundy `#882c29`** or **blue `#3584ba`**.
- Writes the title, distance, **FREE BEER!** and date in **MikkelWind**, like the earlier route posts.
- Start marker: north star, dot or none.
- Formats: **Post 4:5** (1080×1350), **Story 9:16** (1080×1920), **Square** (1080×1080), and **Route only**: a transparent PNG of just the line, to put on a group photo.
- Drag the picture to move the map, pinch or use the slider to zoom.
- Smooth out GPS wobble, round corners, line width, and **trim** a few metres off the start or finish (for when the start and finish lines don't quite meet at the bar).
- Writes a draft caption in the usual format (title, day, distance, @mikkellerzurich, start time, who leads, free beer, “The slowest runner sets the pace”) with a copy button.
- **Share** opens the phone's share sheet (Instagram, Photos, WhatsApp…). **Download PNG** saves the file.

It is a single static page with no server, no database and no running costs. Settings like route colour and your handle are remembered on each phone.

## Folders

| Path | What's in it |
|---|---|
| `site/index.html` | The whole app: layout, styles and code. |
| `site/vendor/` | MapLibre GL JS, which draws the map. |
| `site/fonts/` | MikkelWind, Windsor Bold, Gotham Black and Gotham Book. |
| `site/manifest.webmanifest`, `site/icon-*.png` | Home-screen name and icon. |
| `site/_headers`, `site/robots.txt` | Keep search engines out. |
| `wrangler.jsonc` | Cloudflare config: publish `./site`. |
| `tools/test.py` | End-to-end check in a headless browser, offline, with locally generated vector map tiles. |
| `test/sample.gpx` | A test route. |

## Keep this repository private

The Gotham and Windsor fonts are commercial fonts supplied by Mikkeller for brand use. Keep the repo private and the live site behind Cloudflare Access (see `SETUP.md`) so they aren't published openly.

## Map tiles

The map is drawn in the phone's browser from [OpenFreeMap](https://openfreemap.org) vector tiles (OpenStreetMap data in the OpenMapTiles format): no API key, no account, no usage limits. The MRC look (grey ground, white streets, no labels) is defined in `mapStyle()` in `site/index.html`; colours are in `PALETTE`. The drawing library is MapLibre GL JS, bundled in `site/vendor/` (BSD licence). OpenStreetMap and OpenMapTiles require a credit, which is the small line at the bottom of each image, so leave it in. If the map can't load (offline), choose **Map → No map**.

## Making a change

1. Edit `site/index.html`. The layout per format (where the title, FREE BEER! and the date sit, and the box the route is fitted into) is the `FORMATS` block near the top of the script. The caption template is in `captionText()`.
2. Optional: run the check
   ```bash
   pip install playwright pillow && python3 -m playwright install chromium
   python3 tools/test.py        # writes test/out/*.png
   ```
3. Commit and push to `main`. Cloudflare publishes the new version within a minute or two.

## Ideas for later

- Use your own Snazzy Maps screenshot as the background.
- Several routes on one image (e.g. Sunday long-run options).
- A recap template for the group photo.
