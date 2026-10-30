# Setup: Cloudflare Worker + captain login

Live address: **https://mrc-route-poster.kate-pratsinis.workers.dev** (login required).

This is already done. The steps are here in case it ever needs redoing or moving to another account. About 15 minutes.

## 1. Repository and GitHub access

1. The code lives in the private repo `kateprat/mrc-route-poster`.
2. Cloudflare needs to see it: https://github.com/settings/installations → **Cloudflare Workers and Pages** → **Configure** → **Repository access** → add `mrc-route-poster` → **Save**.

## 2. Publish it as a Cloudflare Worker

1. https://dash.cloudflare.com → **Workers & Pages → Create** → import a repository → `kateprat/mrc-route-poster`.
2. Build command: *(leave empty)*. Deploy command: keep the default `npx wrangler deploy`. `wrangler.jsonc` tells Cloudflare to publish the `site` folder.
3. Preview builds: off.
4. **Deploy**. The address is `mrc-route-poster.<account-subdomain>.workers.dev`.

The site is public at this moment, so do step 3 straight away.

## 3. Limit it to the captains (Cloudflare Access)

1. **Workers & Pages → mrc-route-poster → Domains**.
2. On the **Production** row, click **Enable Access →**.
3. Add a policy: name `Captains`, Action **Allow**, Include → **Emails** → each captain's email (and yours). Login method: **One-time PIN**.
4. On the **Preview** row, switch the toggle **off** (preview links aren't needed).
5. Test in a private browser window: you should get the Cloudflare email login before the app.

The free plan covers 50 users in total across your Access apps, so the crew handbook and this app share that limit.

## 4. Share it with the captains

- Send them the link. On first visit they enter their email and the code they receive.
- iPhone: open in **Safari** → Share → **Add to Home Screen**. Android: Chrome menu → **Add to Home screen** / **Install app**. It shows the Little Dipper icon.
- Add or remove someone: **Zero Trust → Access → Applications → mrc-route-poster → Policies → Captains**.

## Updating

Push to `main` and Cloudflare publishes automatically.
