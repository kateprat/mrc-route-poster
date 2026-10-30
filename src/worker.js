// MRC Route Poster: serves the app (./site) and the captains' schedule API (/api/*).
//
// Who is calling: Cloudflare Access sits in front of the whole app and adds the
// signed-in email as the `cf-access-authenticated-user-email` header. Requests
// without it are refused, so only captains on the Access list can read or write.
//
// Storage: one SQLite-backed Durable Object ("Schedule"). Cloudflare creates it
// on deploy (see wrangler.jsonc); no database to set up by hand.

import { DurableObject } from "cloudflare:workers";
import SEED from "./seed.json";

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
    `);
    const seeded = this.sql.exec("SELECT v FROM meta WHERE k='seeded'").toArray().length;
    if (seeded) return;
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

  me(email) {
    return this.sql.exec("SELECT id, name, email, handle FROM captains WHERE email = ?", email).toArray()[0] || null;
  }

  requireMe(email) {
    const me = this.me(email);
    if (!me) throw new HttpError(409, "Tell the app which captain you are first.");
    return me;
  }

  state(email, today) {
    this.ensureRegularRuns(today);
    const captains = this.sql.exec("SELECT id, name, handle, email IS NOT NULL AS linked FROM captains ORDER BY id").toArray()
      .map((c) => ({ id: c.id, name: c.name, handle: c.handle || "", linked: !!c.linked }));
    const avail = {};
    for (const a of this.sql.exec("SELECT date, captain, status FROM avail").toArray()) (avail[a.date] ||= {})[a.captain] = a.status;
    const runs = this.sql.exec("SELECT date, time, note, cancelled, lead, lead_by, lead_at FROM runs ORDER BY date").toArray()
      .map((r) => ({ date: r.date, time: r.time, note: r.note, cancelled: !!r.cancelled, lead: r.lead ?? null, leadBy: r.lead_by || "", avail: avail[r.date] || {} }));
    const me = this.me(email);
    return { me: { email, captain: me ? { id: me.id, name: me.name, handle: me.handle || "" } : null }, captains, runs };
  }

  // "I am Felix" (link this email to an existing captain) or a new captain.
  claim(email, { id, name, handle }) {
    if (this.me(email)) {
      this.sql.exec("UPDATE captains SET handle = ? WHERE email = ?", clean(handle, 40).replace(/^@?/, handle ? "@" : ""), email);
      return;
    }
    handle = clean(handle, 40); if (handle && !handle.startsWith("@")) handle = "@" + handle;
    if (id) {
      const c = this.sql.exec("SELECT id, email FROM captains WHERE id = ?", Number(id)).toArray()[0];
      if (!c) throw new HttpError(404, "Unknown captain.");
      if (c.email) throw new HttpError(409, "That captain is already linked to another email.");
      this.sql.exec("UPDATE captains SET email = ?, handle = ? WHERE id = ?", email, handle, c.id);
    } else {
      name = clean(name, 40);
      if (!name) throw new HttpError(400, "Please enter your name.");
      if (this.sql.exec("SELECT 1 FROM captains WHERE name = ?", name).toArray().length) throw new HttpError(409, "That name is taken. Pick it from the list instead.");
      this.sql.exec("INSERT INTO captains (name, email, handle) VALUES (?, ?, ?)", name, email, handle);
    }
  }

  setStatus(email, { date, status }) {
    const me = this.requireMe(email);
    if (!isDate(date) || !STATUSES.includes(status)) throw new HttpError(400, "Bad date or status.");
    if (!this.sql.exec("SELECT 1 FROM runs WHERE date = ?", date).toArray().length) throw new HttpError(404, "No run on that date.");
    this.sql.exec("INSERT OR REPLACE INTO avail (date, captain, status) VALUES (?, ?, ?)", date, me.id, status);
  }

  setLead(email, { date, lead }) {
    const me = this.requireMe(email);
    if (!isDate(date)) throw new HttpError(400, "Bad date.");
    const leadId = lead ? Number(lead) : null;
    if (leadId && !this.sql.exec("SELECT 1 FROM captains WHERE id = ?", leadId).toArray().length) throw new HttpError(404, "Unknown captain.");
    const changed = this.sql.exec("UPDATE runs SET lead = ?, lead_by = ?, lead_at = ? WHERE date = ?", leadId, leadId ? me.name : null, new Date().toISOString(), date);
    if (!changed.rowsWritten) throw new HttpError(404, "No run on that date.");
    // Whoever leads is obviously coming.
    if (leadId) this.sql.exec("INSERT OR REPLACE INTO avail (date, captain, status) VALUES (?, ?, 'yes')", date, leadId);
  }

  saveRun(email, { date, time, note, cancelled }) {
    this.requireMe(email);
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
  const stub = env.SCHEDULE.get(env.SCHEDULE.idFromName("mrc-zurich"));
  try {
    if (request.method === "GET" && url.pathname === "/api/state") return json(await stub.state(email, zurichToday()));
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    const actions = { "/api/claim": "claim", "/api/status": "setStatus", "/api/lead": "setLead", "/api/run": "saveRun" };
    const action = actions[url.pathname];
    if (!action) return json({ error: "Not found." }, 404);
    await stub[action](email, body);
    return json(await stub.state(email, zurichToday()));
  } catch (e) {
    // Errors thrown inside the Durable Object arrive as plain errors; keep their message.
    const status = e.status || (/first|taken|already/i.test(e.message) ? 409 : /Bad|Please|Unknown|No run/i.test(e.message) ? 400 : 500);
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
