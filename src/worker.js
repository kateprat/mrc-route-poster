// MRC ZH: serves the app (./site) and the captains' schedule API (/api/*).
//
// Who is calling: Cloudflare Access sits in front of the whole app and adds the
// signed-in email as the `cf-access-authenticated-user-email` header. Requests
// without it are refused. src/captains.js links each email to a captain; emails
// that aren't in that list can look at the schedule but not change it.
//
// Storage: one SQLite-backed Durable Object ("Schedule"). Cloudflare creates it
// on deploy (see wrangler.jsonc); no database to set up by hand.

import { DurableObject } from "cloudflare:workers";
import SEED from "./seed.json";
import CAPTAINS from "./captains.js";
import RUN_PROFILE from "./mrc-run.brf";

/** The captain for a login email, from src/captains.js (or null). */
function captainFor(email) {
  return CAPTAINS.find((c) => c.emails.map((e) => e.toLowerCase()).includes(email)) || null;
}

const STATUSES = ["yes", "no", "tbd"];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isTime = (s) => /^\d{2}:\d{2}$/.test(s || "");
const clean = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export class Schedule extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS captains (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, email TEXT UNIQUE, handle TEXT);
      CREATE TABLE IF NOT EXISTS runs (date TEXT PRIMARY KEY, time TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', cancelled INTEGER NOT NULL DEFAULT 0,
                                       lead INTEGER, lead_by TEXT, lead_at TEXT);
      CREATE TABLE IF NOT EXISTS avail (date TEXT NOT NULL, captain INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (date, captain));
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS leads (date TEXT NOT NULL, captain INTEGER NOT NULL, PRIMARY KEY (date, captain));
      CREATE TABLE IF NOT EXISTS routes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, km REAL NOT NULL,
                                         pts TEXT NOT NULL, gpx TEXT NOT NULL, run_date TEXT, added_by TEXT, added_at TEXT);
    `);
    // Elevation gain of each library route (metres), worked out from the GPX.
    try { this.sql.exec("ALTER TABLE routes ADD COLUMN up REAL"); } catch {}
    // Who last changed a run's answers (anyone can change anyone's, so it's shown on the run).
    try { this.sql.exec("ALTER TABLE runs ADD COLUMN changed_by TEXT"); } catch {}
    // A run can have several leads. Move any single lead from the earlier version into the leads table.
    this.sql.exec("INSERT OR IGNORE INTO leads (date, captain) SELECT date, lead FROM runs WHERE lead IS NOT NULL");
    this.sql.exec("UPDATE runs SET lead = NULL WHERE lead IS NOT NULL");
    const seeded = this.sql.exec("SELECT v FROM meta WHERE k='seeded'").toArray().length;
    if (!seeded) this.seed();
    this.importSheetLeads();
    this.fixOnce("fix-2026-09-16", () => {   // the sheet was wrong: Fabio led on 16 Sep, not Andrea
      const fabio = this.sql.exec("SELECT id FROM captains WHERE name = 'Fabio'").toArray()[0];
      if (!fabio) return;
      this.sql.exec("DELETE FROM leads WHERE date = '2026-09-16'");
      this.sql.exec("INSERT INTO leads (date, captain) VALUES ('2026-09-16', ?)", fabio.id);
      this.sql.exec("INSERT OR REPLACE INTO avail (date, captain, status) VALUES ('2026-09-16', ?, 'yes')", fabio.id);
    });
    // In the old sheet 0 ("not attending") was the default for anyone who hadn't answered. For runs
    // still to come that nobody has touched in the app, treat those as "no answer yet" (tbd).
    this.fixOnce("sheet-default-0-to-tbd", () => {
      this.sql.exec(`DELETE FROM avail WHERE status = 'no' AND date >= '2026-10-31'
                     AND date IN (SELECT date FROM runs WHERE changed_by IS NULL)
                     AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.date = avail.date AND l.captain = avail.captain)`);
    });
  }

  // One-off data corrections: each runs once, recorded in meta.
  fixOnce(key, fn) {
    if (this.sql.exec("SELECT 1 FROM meta WHERE k = ?", key).toArray().length) return;
    fn();
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", key, new Date().toISOString());
  }

  // The old spreadsheet marked each run's lead with a green cell; those are in src/seed.json as "leads".
  // Runs once. A run that already has a lead set in the app keeps it.
  importSheetLeads() {
    if (this.sql.exec("SELECT v FROM meta WHERE k='leads_imported'").toArray().length) return;
    const ids = Object.fromEntries(this.sql.exec("SELECT id, name FROM captains").toArray().map((r) => [r.name, r.id]));
    for (const r of SEED.runs) {
      if (!r.leads?.length || this.sql.exec("SELECT 1 FROM leads WHERE date = ?", r.date).toArray().length) continue;
      for (const name of r.leads) if (ids[name]) this.sql.exec("INSERT OR IGNORE INTO leads (date, captain) VALUES (?, ?)", r.date, ids[name]);
    }
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('leads_imported', ?)", new Date().toISOString());
  }

  seed() {
    // First start: import the old spreadsheet (MRC-leads.xlsx), converted to src/seed.json.
    for (const name of SEED.captains) this.sql.exec("INSERT OR IGNORE INTO captains (name) VALUES (?)", name);
    const ids = Object.fromEntries(this.sql.exec("SELECT id, name FROM captains").toArray().map((r) => [r.name, r.id]));
    for (const r of SEED.runs) {
      this.sql.exec("INSERT OR IGNORE INTO runs (date, time, note, cancelled) VALUES (?, ?, ?, ?)", r.date, r.time, r.note || "", r.cancelled ? 1 : 0);
      for (const [name, status] of Object.entries(r.avail || {}))
        if (ids[name]) this.sql.exec("INSERT OR REPLACE INTO avail (date, captain, status) VALUES (?, ?, ?)", r.date, ids[name], status);
    }
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('seeded', ?)", new Date().toISOString());
  }

  // src/captains.js is the source of truth for names and handles.
  syncRoster() {
    for (const c of CAPTAINS) {
      this.sql.exec("INSERT OR IGNORE INTO captains (name) VALUES (?)", c.name);
      this.sql.exec("UPDATE captains SET handle = ? WHERE name = ?", c.handle || "", c.name);
    }
  }

  // Every Wednesday 18:30 and the first Sunday of each month 15:00, about three months ahead.
  ensureRegularRuns(today) {
    const d = new Date(today + "T12:00:00Z");
    for (let i = 0; i < 100; i++) {
      const iso = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      if (dow === 3) this.sql.exec("INSERT OR IGNORE INTO runs (date, time) VALUES (?, '18:30')", iso);
      if (dow === 0 && d.getUTCDate() <= 7) this.sql.exec("INSERT OR IGNORE INTO runs (date, time) VALUES (?, '15:00')", iso);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }

  me(name) {
    return name ? this.sql.exec("SELECT id, name, handle FROM captains WHERE name = ?", name).toArray()[0] || null : null;
  }

  requireMe(viewer) {
    const me = this.me(viewer.name);
    if (!me) throw new HttpError(403, "View only: changes to the schedule are made by the captains.");
    return me;
  }

  state(viewer, today) {
    this.syncRoster();
    this.ensureRegularRuns(today);
    const captains = this.sql.exec("SELECT id, name, handle FROM captains ORDER BY id").toArray()
      .map((c) => ({ id: c.id, name: c.name, handle: c.handle || "" }));
    const avail = {};
    for (const a of this.sql.exec("SELECT date, captain, status FROM avail").toArray()) (avail[a.date] ||= {})[a.captain] = a.status;
    const leads = {};
    for (const l of this.sql.exec("SELECT date, captain FROM leads ORDER BY captain").toArray()) (leads[l.date] ||= []).push(l.captain);
    const runs = this.sql.exec("SELECT date, time, note, cancelled, changed_by FROM runs ORDER BY date").toArray()
      .map((r) => ({ date: r.date, time: r.time, note: r.note, cancelled: !!r.cancelled, leads: leads[r.date] || [], changedBy: r.changed_by || "", avail: avail[r.date] || {} }));
    const me = this.me(viewer.name);
    return { me: { email: viewer.email, captain: me ? { id: me.id, name: me.name, handle: me.handle || "" } : null }, captains, runs };
  }

  // Any captain can set any captain's state for a run: no / tbd / yes / lead (lead = coming and leading).
  setCaptain(viewer, { date, captain, state }) {
    const me = this.requireMe(viewer);
    if (!isDate(date) || !["no", "tbd", "yes", "lead"].includes(state)) throw new HttpError(400, "Bad date or state.");
    if (!this.sql.exec("SELECT 1 FROM runs WHERE date = ?", date).toArray().length) throw new HttpError(404, "No run on that date.");
    const id = Number(captain);
    if (!this.sql.exec("SELECT 1 FROM captains WHERE id = ?", id).toArray().length) throw new HttpError(404, "Unknown captain.");
    this.sql.exec("INSERT OR REPLACE INTO avail (date, captain, status) VALUES (?, ?, ?)", date, id, state === "lead" ? "yes" : state);
    if (state === "lead") this.sql.exec("INSERT OR IGNORE INTO leads (date, captain) VALUES (?, ?)", date, id);
    else this.sql.exec("DELETE FROM leads WHERE date = ? AND captain = ?", date, id);
    this.sql.exec("UPDATE runs SET changed_by = ? WHERE date = ?", me.name, date);
  }

  setStatus(viewer, { date, status }) {
    const me = this.requireMe(viewer);
    if (!isDate(date) || !STATUSES.includes(status)) throw new HttpError(400, "Bad date or status.");
    if (!this.sql.exec("SELECT 1 FROM runs WHERE date = ?", date).toArray().length) throw new HttpError(404, "No run on that date.");
    this.sql.exec("INSERT OR REPLACE INTO avail (date, captain, status) VALUES (?, ?, ?)", date, me.id, status);
    this.sql.exec("UPDATE runs SET changed_by = ? WHERE date = ?", me.name, date);
  }

  // The leads of a run: any number of captains (none, one, or several).
  setLeads(viewer, { date, leads, lead }) {
    const me = this.requireMe(viewer);
    if (!isDate(date)) throw new HttpError(400, "Bad date.");
    if (!this.sql.exec("SELECT 1 FROM runs WHERE date = ?", date).toArray().length) throw new HttpError(404, "No run on that date.");
    if (leads === undefined) leads = lead ? [lead] : [];          // older app version sent a single lead
    const ids = [...new Set((Array.isArray(leads) ? leads : []).map(Number))];
    for (const id of ids) if (!this.sql.exec("SELECT 1 FROM captains WHERE id = ?", id).toArray().length) throw new HttpError(404, "Unknown captain.");
    this.sql.exec("DELETE FROM leads WHERE date = ?", date);
    // Picking a lead doesn't answer for them: their own Coming / Not coming stays as they set it.
    for (const id of ids) this.sql.exec("INSERT INTO leads (date, captain) VALUES (?, ?)", date, id);
    this.sql.exec("UPDATE runs SET changed_by = ? WHERE date = ?", me.name, date);
  }

  // Route library: every route we've run, with its GPX. Anyone signed in can browse and download;
  // captains add (or replace) and remove. pts is a thinned-out [[lat, lon], …] for the pictures.
  /* Traffic lights list (text, one "lat<TAB>lon" per line), kept here between Overpass downloads. */
  async getSignals() { return (await this.ctx.storage.get("signals")) || null; }
  async putSignals(text) { await this.ctx.storage.put("signals", { t: Date.now(), text }); }

  listRoutes(viewer) {
    // routes saved before elevation was shown: work it out once (-1 = the GPX has no elevation)
    for (const r of this.sql.exec("SELECT id, gpx FROM routes WHERE up IS NULL").toArray())
      this.sql.exec("UPDATE routes SET up = ? WHERE id = ?", climbOf(r.gpx) ?? -1, r.id);
    const routes = this.sql.exec("SELECT id, name, km, up, pts, run_date, added_by, added_at FROM routes ORDER BY km, name").toArray()
      .map((r) => ({ id: r.id, name: r.name, km: r.km, up: r.up >= 0 ? r.up : null, pts: JSON.parse(r.pts), date: r.run_date || "", addedBy: r.added_by || "", addedAt: r.added_at || "" }));
    return { routes, canEdit: !!this.me(viewer.name) };
  }

  routeGpx(id) {
    return this.sql.exec("SELECT name, gpx FROM routes WHERE id = ?", Number(id)).toArray()[0] || null;
  }

  addRoute(viewer, { name, km, pts, gpx, date, replace }) {
    const me = this.requireMe(viewer);
    name = clean(name, 80); km = Number(km);
    if (!name || !(km > 0 && km < 300)) throw new HttpError(400, "Bad route name or distance.");
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > 400 || !pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
      throw new HttpError(400, "Bad route points.");
    if (typeof gpx !== "string" || gpx.length > 1800000 || !/<gpx[\s>]/i.test(gpx)) throw new HttpError(400, "Bad GPX file.");
    if (date && !isDate(date)) throw new HttpError(400, "Bad date.");
    const now = new Date().toISOString(), P = JSON.stringify(pts);
    if (replace) {
      if (!this.sql.exec("SELECT 1 FROM routes WHERE id = ?", Number(replace)).toArray().length) throw new HttpError(404, "Unknown route.");
      this.sql.exec("UPDATE routes SET name = ?, km = ?, pts = ?, gpx = ?, run_date = COALESCE(?, run_date), added_by = ?, added_at = ?, up = ? WHERE id = ?",
        name, km, P, gpx, date || null, me.name, now, climbOf(gpx) ?? -1, Number(replace));
    } else {
      this.sql.exec("INSERT INTO routes (name, km, pts, gpx, run_date, added_by, added_at, up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", name, km, P, gpx, date || null, me.name, now, climbOf(gpx) ?? -1);
    }
    return this.listRoutes(viewer);
  }

  editRoute(viewer, { id, name, date }) {
    this.requireMe(viewer);
    name = clean(name, 80);
    if (!name) throw new HttpError(400, "Please give the route a name.");
    if (date && !isDate(date)) throw new HttpError(400, "Bad date.");
    this.sql.exec("UPDATE routes SET name = ?, run_date = ? WHERE id = ?", name, date || null, Number(id));
    return this.listRoutes(viewer);
  }

  removeRoute(viewer, { id }) {
    this.requireMe(viewer);
    this.sql.exec("DELETE FROM routes WHERE id = ?", Number(id));
    return this.listRoutes(viewer);
  }

  saveRun(viewer, { date, time, note, cancelled }) {
    this.requireMe(viewer);
    if (!isDate(date) || !isTime(time)) throw new HttpError(400, "Please give a date and a time.");
    this.sql.exec(`INSERT INTO runs (date, time, note, cancelled) VALUES (?, ?, ?, ?)
                   ON CONFLICT(date) DO UPDATE SET time = excluded.time, note = excluded.note, cancelled = excluded.cancelled`,
      date, time, clean(note), cancelled ? 1 : 0);
  }
}

/* Metres climbed, from the <ele> values in a GPX file (in order). Rises smaller than 3 m are
   GPS noise and ignored; null when the file has no elevation. Same rule as climb() in site/app.js. */
function climbOf(gpx) {
  const ele = [...gpx.matchAll(/<(?:trkpt|rtept)\b[^>]*>[\s\S]*?<ele>\s*(-?[\d.]+)\s*<\/ele>/g)].map((m) => parseFloat(m[1])).filter(Number.isFinite);
  if (ele.length < 2) return null;
  let up = 0, ref = ele[0];
  for (const e of ele) { if (e > ref + 3) { up += e - ref; ref = e; } else if (e < ref - 3) ref = e; }
  return Math.round(up);
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function zurichToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/* ---------- map helpers for the Routes tab ----------
   Traffic lights come from OpenStreetMap (Overpass API); loop suggestions from BRouter (brouter.de)
   with our own running profile (src/mrc-run.brf), which treats every traffic light as a long detour.
   Both are free community services: answers are cached, and the app asks only when someone taps. */
const UA = "MRC-ZH route app (github.com/kateprat/mrc-route-poster)";
const ZURICH_BOX = "47.30,8.40,47.47,8.65";   // south,west,north,east
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
async function signals(env, stub) {
  const kept = await stub.getSignals();
  const text = (t) => new Response(t, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  if (kept && Date.now() - kept.t < 7 * 864e5) return text(kept.text);
  const q = `[out:csv(::lat,::lon;false)][timeout:90];(node["highway"="traffic_signals"](${ZURICH_BOX});node["crossing"="traffic_signals"](${ZURICH_BOX});node["crossing:signals"="yes"](${ZURICH_BOX}););out;`;
  const tried = [];
  for (const base of env.OVERPASS_URL ? [env.OVERPASS_URL] : OVERPASS) {
    try {
      const r = await fetch(base, { method: "POST", headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
      const t = await r.text();
      if (r.ok && /^\s*\d/.test(t)) {
        const compact = t.trim().split("\n").map((l) => l.split("\t").map((v) => (+v).toFixed(6)).join("\t")).join("\n");
        await stub.putSignals(compact);
        return text(compact);
      }
      tried.push(`${new URL(base).host} ${r.status}`);
    } catch (e) { tried.push(`${new URL(base).host} ${e.message}`); }
  }
  if (kept) return text(kept.text);   // older list beats none
  throw new HttpError(502, "Couldn’t load the traffic lights (" + tried.join(", ") + ").");
}
let profileId = null;   // BRouter custom profile, uploaded once per Worker instance
async function uploadProfile(base) {
  const r = await fetch(base + "/brouter/profile", { method: "POST", headers: { "user-agent": UA, "content-type": "text/plain" }, body: RUN_PROFILE });
  const j = await r.json().catch(() => ({}));
  if (!j.profileid || j.error) throw new HttpError(502, "The route planner didn’t accept our running profile.");
  return j.profileid;
}
async function planRoute(env, url) {
  const base = env.BROUTER_URL || "https://brouter.de";
  const lonlats = url.searchParams.get("lonlats") || "";
  if (!/^-?[\d.]+,-?[\d.]+(\|-?[\d.]+,-?[\d.]+){1,8}$/.test(lonlats)) throw new HttpError(400, "Bad waypoints.");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!profileId) profileId = await uploadProfile(base);
    const r = await fetch(`${base}/brouter?lonlats=${lonlats}&profile=${profileId}&alternativeidx=0&format=geojson`, { headers: { "user-agent": UA } });
    const text = await r.text();
    if (r.ok && text.trim().startsWith("{")) return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (/profile/i.test(text) && attempt === 0) { profileId = null; continue; }   // profile expired on the server: upload again
    throw new HttpError(422, text.trim().slice(0, 160) || "No route found.");
  }
}

async function api(request, env, url, ctx) {
  const email = (request.headers.get("cf-access-authenticated-user-email") || "").trim().toLowerCase();
  if (!email) return json({ error: "Not signed in." }, 401);
  const viewer = { email, name: captainFor(email)?.name || null };
  const stub = env.SCHEDULE.get(env.SCHEDULE.idFromName("mrc-zurich"));
  try {
    if (request.method === "GET" && url.pathname === "/api/state") return json(await stub.state(viewer, zurichToday()));
    if (request.method === "GET" && url.pathname === "/api/map/signals") return await signals(env, stub);
    if (request.method === "GET" && url.pathname === "/api/map/route") return await planRoute(env, url);
    if (request.method === "GET" && url.pathname === "/api/routes") return json(await stub.listRoutes(viewer));
    if (request.method === "GET" && url.pathname === "/api/routes/gpx") {
      const r = await stub.routeGpx(url.searchParams.get("id"));
      if (!r) return json({ error: "Unknown route." }, 404);
      const file = (r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "route") + ".gpx";
      return new Response(r.gpx, { headers: { "content-type": "application/gpx+xml", "content-disposition": `attachment; filename="mrc-${file}"`, "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/api/routes/add") return json(await stub.addRoute(viewer, await request.json().catch(() => ({}))));
    if (request.method === "POST" && url.pathname === "/api/routes/edit") return json(await stub.editRoute(viewer, await request.json().catch(() => ({}))));
    if (request.method === "POST" && url.pathname === "/api/routes/remove") return json(await stub.removeRoute(viewer, await request.json().catch(() => ({}))));
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    const actions = { "/api/captain": "setCaptain", "/api/status": "setStatus", "/api/leads": "setLeads", "/api/lead": "setLeads", "/api/run": "saveRun" };
    const action = actions[url.pathname];
    if (!action) return json({ error: "Not found." }, 404);
    await stub[action](viewer, body);
    return json(await stub.state(viewer, zurichToday()));
  } catch (e) {
    // Errors thrown inside the Durable Object arrive as plain errors; keep their message.
    const status = e.status || (/linked|View only/i.test(e.message) ? 403 : /Bad|Please|Unknown|No run/i.test(e.message) ? 400 : 500);
    return json({ error: e.message || "Something went wrong." }, status);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url, ctx);
    return env.ASSETS.fetch(request);
  },
};
