# Flux Batch Lab

A small web app that turns a list of prompts (and optional reference images)
into a batch of AI-generated images using Cloudflare Workers AI's
**FLUX.2 [klein] 4B** model, then lets you download everything as a ZIP.

- Frontend: plain HTML/CSS/JS, no build step, no framework
- Backend: one Netlify Function that proxies requests to Cloudflare (so your
  API token never reaches the browser)
- Hosting: Netlify (free tier is fine for personal use)

## How it works

```
Your browser  --->  Netlify Function  --->  Cloudflare Workers AI
(prompts +          (adds your secret       (@cf/black-forest-labs/
 reference imgs)      API token)              flux-2-klein-4b)
```

The frontend never talks to Cloudflare directly — it can't, because that
would require putting your Cloudflare API token in client-side JavaScript,
which anyone could copy out of the page. Instead, the browser calls
`/api/generate-image` on your own Netlify site, and the function attaches
your token server-side before forwarding the request.

## 1. Get a Cloudflare API token and account ID

1. Log into the [Cloudflare dashboard](https://dash.cloudflare.com/) and go to
   **Workers AI**.
2. Select **Use REST API**.
3. Select **Create a Workers AI API Token** → **Create API Token** → copy it.
   (This prefilled template already has the right `Workers AI - Read` and
   `Workers AI - Edit` permissions, so you don't have to configure scopes by
   hand.)
4. On the same page, copy your **Account ID**.

You'll need both values in step 3 below.

## 2. Run it locally (optional but recommended)

```bash
npm install -g netlify-cli
git clone <your-fork-of-this-repo>
cd flux-klein-batch-lab
cp .env.example .env
# edit .env and paste in your CF_ACCOUNT_ID and CF_API_TOKEN
netlify dev
```

This serves the site at `http://localhost:8888` with the function running
locally, reading credentials from `.env`.

## 3. Deploy on Netlify

1. Push this repo to your own GitHub account.
2. In Netlify: **Add new site → Import an existing project → GitHub** → pick
   the repo.
3. Build settings are already defined in `netlify.toml` (publish directory
   `public`, functions directory `netlify/functions`) — you shouldn't need to
   change anything.
4. Before your first deploy finishes generating images, go to **Site
   settings → Environment variables** and add:
   - `CF_ACCOUNT_ID`
   - `CF_API_TOKEN`
5. Deploy. Your app is live at the Netlify URL, with `/api/generate-image`
   automatically routed to the function.

## Using the app

1. Paste your prompts into the text box, one per line.
2. Optionally drop in up to 4 reference images. These are shared across the
   whole batch (useful for keeping a character or style consistent across
   many prompts) — they're not assigned per-prompt in this version.
3. Adjust width/height/guidance/seed if you want; defaults are sensible.
4. Select **Generate batch**. Images appear in the grid on the right as they
   finish (2 at a time, to stay well under Cloudflare's rate limits).
5. Select **Download images** to get a ZIP with every finished image, named
   in order, plus a `prompts.txt` manifest listing the prompt behind each
   file (and the error message for anything that failed).
6. Failed prompts show a **Retry** button on their card.

## Things worth knowing

- **Steps are fixed at 4.** This is the distilled Klein model — that's what
  makes it fast, but it also means there's no "quality" slider to turn up.
- **Reference images must be under 512×512.** The app resizes anything
  larger automatically before sending it.
- **Width/height range is 256–1920px.**
- **Netlify's functions have a response-size ceiling (a few MB).** At very
  high resolutions, a base64-encoded PNG can get close to that. If you hit
  errors only at large sizes, dial the resolution back.
- **Concurrency is set to 2** in `public/app.js` (`CONCURRENCY`). Cloudflare
  has occasionally reported latency spikes on this model, so raising this
  number will get you a faster batch most of the time but a higher chance of
  timeouts on a bad day.
- **Pricing** is usage-based on Cloudflare's side: roughly $0.00006 per input
  512×512 tile and $0.00029 per output 512×512 tile at the time this was
  written — check the [model pricing page](https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/)
  for current numbers.

## Extending it

Some natural next steps if you want to take this further:
- Per-prompt reference images (e.g. a CSV upload with a prompt + image path
  per row) instead of one shared reference set.
- A "cancel" button that aborts an in-progress batch.
- Persist results (e.g. to Netlify Blobs or S3) so a page refresh mid-batch
  doesn't lose progress.
- Swap in `flux-2-klein-9b` for higher quality at a slightly higher cost —
  it's a one-line change to `MODEL_ID` in
  `netlify/functions/generate-image.mjs`.
