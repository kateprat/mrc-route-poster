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
    `);
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
    if (!me) throw new HttpError(403, "Your login isn't linked to a captain yet. Ask Kate to add it.");
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

  saveRun(viewer, { date, time, note, cancelled }) {
    this.requireMe(viewer);
    if (!isDate(date) || !isTime(time)) throw new HttpError(400, "Please give a date and a time.");
    this.sql.exec(`INSERT INTO runs (date, time, note, cancelled) VALUES (?, ?, ?, ?)
                   ON CONFLICT(date) DO UPDATE SET time = excluded.time, note = excluded.note, cancelled = excluded.cancelled`,
      date, time, clean(note), cancelled ? 1 : 0);
  }
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function zurichToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function api(request, env, url) {
  const email = (request.headers.get("cf-access-authenticated-user-email") || "").trim().toLowerCase();
  if (!email) return json({ error: "Not signed in." }, 401);
  const viewer = { email, name: captainFor(email)?.name || null };
  const stub = env.SCHEDULE.get(env.SCHEDULE.idFromName("mrc-zurich"));
  try {
    if (request.method === "GET" && url.pathname === "/api/state") return json(await stub.state(viewer, zurichToday()));
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    const actions = { "/api/captain": "setCaptain", "/api/status": "setStatus", "/api/leads": "setLeads", "/api/lead": "setLeads", "/api/run": "saveRun" };
    const action = actions[url.pathname];
    if (!action) return json({ error: "Not found." }, 404);
    await stub[action](viewer, body);
    return json(await stub.state(viewer, zurichToday()));
  } catch (e) {
    // Errors thrown inside the Durable Object arrive as plain errors; keep their message.
    const status = e.status || (/linked/i.test(e.message) ? 403 : /Bad|Please|Unknown|No run/i.test(e.message) ? 400 : 500);
    return json({ error: e.message || "Something went wrong." }, status);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
