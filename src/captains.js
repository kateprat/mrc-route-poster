// The captains: who they are and their Instagram handle. owner: true = the one who runs the app.
//
// Login emails are NOT here (the repo is public). They're in the Cloudflare secret
// CAPTAIN_EMAILS as "Name=email" pairs (see SETUP.md). Every email there must also be
// in the Cloudflare Access policy "MRC-captains", otherwise that person can't log in at all.
export default [
  { name: "Felix",  handle: "@_nordic_by_nature" },
  { name: "Kate",   handle: "@kates.turn", owner: true },
  { name: "Ale",    handle: "" },
  { name: "Andrea", handle: "@abecker86" },
  { name: "Fabio",  handle: "@vic2vic2vic" },
];
