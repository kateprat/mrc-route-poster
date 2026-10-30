# Setup: Cloudflare Pages + captain login

About 15 minutes, once. It's the same as the crew handbook, so your Cloudflare account and Zero Trust team already exist.

## 0. Create the repository (if it isn't there yet)

1. Go to https://github.com/new
   - Repository name: `mrc-route-poster`
   - Choose **Private**
   - Don't add a README, .gitignore or licence
   - **Create repository**
2. Push the project (from the unzipped `mrc-route-poster` folder):
   ```bash
   git remote add origin https://github.com/kateprat/mrc-route-poster.git
   git push -u origin main
   ```
   (Or ask Claude to push it once the empty repository exists.)

## 1. Let Cloudflare see the new repository

1. Go to https://github.com/settings/installations → **Cloudflare Workers and Pages** → **Configure**.
2. Under **Repository access** (Only select repositories), add `mrc-route-poster`. **Save**.

## 2. Publish it with Cloudflare Pages

1. https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** (may say *Import an existing Git repository*).
2. Choose `kateprat/mrc-route-poster`.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `site`
4. **Save and Deploy**. You get an address like `https://mrc-route-poster.pages.dev`.

The site is public at this moment, so do step 3 straight away.

## 3. Limit it to the captains (Cloudflare Access)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Application:
   - Name: `MRC Route Poster`
   - Session duration: **1 month**
   - Domain: `mrc-route-poster.pages.dev`
   - Second domain: `*.mrc-route-poster.pages.dev`
3. Policy: name `Captains`, Action **Allow**, Include → **Emails** → each captain's email (and yours).
4. Login method: **One-time PIN**. Save.
5. Test in a private browser window: you should get the Cloudflare email login.

The free plan covers 50 users in total across your Access apps, so the crew handbook and this app share that limit.

## 4. Share it with the captains

- Send them the link. On first visit they enter their email and the code they receive.
- iPhone: open in **Safari** → Share → **Add to Home Screen**. Android: Chrome menu → **Add to Home screen** / **Install app**. It shows the Little Dipper icon.
- Add or remove someone: **Zero Trust → Access → Applications → MRC Route Poster → Policies → Captains**.

## Updating

Push to `main` and Cloudflare publishes automatically.
