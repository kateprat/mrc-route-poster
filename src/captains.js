// The captains: who they are, the email(s) they log in with (Cloudflare Access),
// and their Instagram handle. Logging in with one of these emails = being that captain.
//
// To add a captain or an email: edit this list, commit and push. Emails in lower case.
// Every email here must also be in the Cloudflare Access policy "MRC-captains",
// otherwise that person can't log in at all.
export default [
  { name: "Felix",  emails: [],                            handle: "" },
  { name: "Kate",   emails: ["captain@example.com"],  handle: "@kates.turn" },
  { name: "Ale",    emails: [],                            handle: "" },
  { name: "Andrea", emails: [],                            handle: "" },
  { name: "Fabio",  emails: [],                            handle: "" },
];
