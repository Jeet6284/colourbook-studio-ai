# ColourBook Studio AI

Create printable colouring books for kids and adults. Type a topic, pick pages (10/20/30/50) and an age group
(3–5, 6–8, 9–12, adults) and the server draws black-and-white line art with an AI image API, builds a cover, title page and
numbered pages, and exports a **print-ready A4 PDF**, individual PNG pages, or a ZIP of all images.

Responsive web app (Android, tablet, desktop), installable as a PWA, and packageable as an **Android APK** and a **Windows EXE** (see below).

## Status – what is tested and what is not

| Area | State |
|---|---|
| Accounts, plans/limits, projects (create / rename / duplicate / delete), per-user isolation | Automated tests pass |
| Page generation queue, progress, errors, retry, replace, reorder, add/delete pages | Automated tests pass |
| **PDF export** (A4 portrait, 15 mm margins, cover + title page + numbered pages, pure black/white 1-bit art) | Automated tests pass; output validated with `pdfinfo` and `qpdf --check`, rendered with `pdftoppm` |
| PNG per page, cover PNG, ZIP of all pages | Automated tests pass |
| Photo → outline conversion (upload) | Automated tests pass |
| OpenAI image provider code path (auth header, request body, base64, 429 retry, safety-filter errors) | Tested against a **local mock** of the OpenAI Images API |
| Frontend (all 10 screens, buttons, download, print dialog call) | Smoke-tested in jsdom against the real server (no script errors) – **not yet checked in a real phone browser** |
| Calls to the real OpenAI API with a real key | **Not tested** (no key / no internet access in the build environment) |
| Stripe checkout / customer portal | **Not tested live.** Webhook signature check is unit-tested. Disabled until Stripe variables are set |
| Android APK / Windows EXE build | Packaging files provided, **not built** here (needs Android SDK / Windows runner) |
| Hindi / non-Latin cover titles | Needs Noto fonts on the server (the Dockerfile installs them); not visually verified |

Without `OPENAI_API_KEY` the app runs in **demo mode**: the "AI" is a built-in vector drawing generator (simple flowers, cars, fish…) so you can try the whole workflow. A banner in the UI says so. Set the key to get real AI illustrations.

## Run locally

```bash
npm install
cp .env.example .env        # optional for local use: demo mode needs no settings
npm start                   # http://localhost:3000
npm test                    # 20 automated tests
```
Requires Node 20.6+ (Node 22 recommended). To try Premium locally add `ALLOW_DEV_PLAN_SWITCH=true` to `.env` (Settings then shows a Free/Premium toggle; ignored in production).

## Turn on real AI illustrations

1. Create an API key at <https://platform.openai.com/api-keys> (the account must have image-generation access; check current pricing – a 50-page book is 50 images).
2. Put it in the **server** environment: `OPENAI_API_KEY=sk-...` and `IMAGE_PROVIDER=openai`.
3. Restart. `GET /healthz` now reports `"provider":"openai"`.

The key is only read by the server (`server/config.js`); it is never sent to the browser. Other OpenAI-compatible image APIs work by setting `OPENAI_BASE_URL`. To add another provider, add a file in `server/providers/` that exports `generate({prompt})` returning a PNG/JPEG buffer.

Every generated image is normalised (`server/imaging.js`): white background, grayscale, upscaled to about 2048×3072 px (≈300 DPI on the printable area) and thresholded to pure black outlines. In the PDF each page is a 1-bit image, so files stay small (a 20-page book ≈ 0.7 MB) and print sharply.

## Environment variables

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | **Required in production.** Random string for signing login cookies (`openssl rand -hex 32`) |
| `PUBLIC_URL` | Your public https URL (payment redirects) |
| `OPENAI_API_KEY`, `IMAGE_PROVIDER`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`, `OPENAI_BASE_URL` | AI image generation |
| `DATA_DIR` | Where users and books are stored. **Mount a persistent disk here** |
| `GEN_CONCURRENCY`, `FREE_DAILY_GENERATIONS`, `PREMIUM_DAILY_GENERATIONS` | Cost control: parallel image requests and per-user daily image caps |
| `SIGNUPS_OPEN=false` | Close registration |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Payments (see below) |
| `ANDROID_PACKAGE`, `ANDROID_SHA256` | Android app link file (APK section) |
| `TRUST_PROXY` | Number of reverse proxies in front of the app (default 1 in production) |

## Deploy online (HTTPS is required for login cookies, PWA and APK)

### Option A – Render (easiest)
1. Push this folder to a GitHub repository.
2. Render → **New → Blueprint** → pick the repo (it reads `render.yaml`: Docker build, 10 GB persistent disk, generated `SESSION_SECRET`).
3. In the service's Environment tab set `OPENAI_API_KEY` and `PUBLIC_URL` (your `https://….onrender.com` URL).
4. Open the URL, create an account, generate a book. Health check: `/healthz`.

### Option B – any VPS / Docker host (Railway, Fly.io, DigitalOcean…)
```bash
docker build -t colourbook .
docker run -d --name colourbook --restart unless-stopped -p 3000:3000 \
  -v colourbook-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) -e OPENAI_API_KEY=sk-... -e PUBLIC_URL=https://books.example.com \
  colourbook
```
Put a TLS reverse proxy in front, e.g. Caddy: `books.example.com { reverse_proxy localhost:3000 }`.
Set `/data` on a persistent volume or you will lose users and books on redeploy.

### Option C – plain Node
`NODE_ENV=production SESSION_SECRET=… OPENAI_API_KEY=… DATA_DIR=/var/lib/colourbook node server/index.js` behind nginx/Caddy. Install `fonts-noto-core` for non-Latin titles.

## Payments (free and premium plans)

Plans are defined in `server/config.js` (Free: 10 pages/book, 3 books, 30 images/day, small PDF footer. Premium: 50 pages, 200 books, 300 images/day, no footer).
Payments stay **off** until all three Stripe variables exist; the Upgrade button then tells the user payments are not configured.

1. Stripe Dashboard → create a recurring **Product/Price** → copy the price id → `STRIPE_PRICE_ID`.
2. Copy the secret key → `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint `https://YOUR-SITE/api/billing/webhook` for events `checkout.session.completed` and `customer.subscription.deleted` → copy the signing secret → `STRIPE_WEBHOOK_SECRET`.
4. Test in Stripe **test mode** first (card `4242 4242 4242 4242`). This flow has not been run against live Stripe yet – verify it before charging real customers.

Card data never touches this server (Stripe-hosted Checkout). The webhook verifies Stripe's HMAC signature with a 5-minute tolerance.

## Android APK

The app is a PWA (manifest, icons, service worker), so on Android Chrome you can already use **⋮ → Install app**. To get a real `.apk`/`.aab`:

**Easiest – PWABuilder (no coding):**
1. Deploy first (HTTPS URL required).
2. Go to <https://www.pwabuilder.com>, enter your URL, press **Package for stores → Android**.
3. Choose package id (e.g. `app.colourbook.studio`), download the zip – it contains the `.apk`, the `.aab` for Google Play, and a **signing key file plus its SHA-256 fingerprint**.
4. Set on your server `ANDROID_PACKAGE=app.colourbook.studio` and `ANDROID_SHA256=<fingerprint from PWABuilder>`; the server then serves `/.well-known/assetlinks.json`, which removes the browser address bar inside the app.
5. Install the `.apk` on a phone (allow "install unknown apps"), or upload the `.aab` to Google Play Console (one-time $25 developer fee).

An APK built this way is a Trusted Web Activity: it runs your deployed site in Chrome's engine, so downloads of PDFs/ZIPs work normally. (A plain WebView wrapper such as default Capacitor cannot save blob downloads without extra native plugins – prefer TWA.)
Keep the signing key safe; you need the same key for every future update.

## Windows EXE

`desktop/` is a small Electron shell that opens your deployed site in its own window (with a Save dialog for PDF/ZIP downloads).
Build it in the cloud, no Windows PC needed: push to GitHub → **Actions → Build Windows EXE → Run workflow** → paste your https URL → download the artifact (installer `.exe` and portable `.exe`). Locally on Windows: `cd desktop && npm install && echo https://your-site > app-url.txt && npm run dist`.
Unsigned EXEs trigger a Windows SmartScreen warning; a code-signing certificate removes it. Alternatively users can install the PWA from Edge/Chrome ("Install ColourBook Studio AI").
This packaging has not been built in the authoring environment.

## Architecture

```
public/            SPA (no build step): app.js, style.css, sw.js, manifest, icons
server/index.js    Express app, security headers (CSP), static files, webhook mount
server/api.js      REST API: auth, books, pages, images, exports, billing
server/jobs.js     Generation queue (concurrency, retries with backoff, error states)
server/providers/  openai.js (real AI) and demo.js (offline drawings)
server/imaging.js  Print pipeline, photo→outline, cover and title page rendering
server/pdf.js      pdf-lib: A4 pages, margins, numbering, 1-bit image embedding
server/store.js    File storage (users.json, data/books/<id>/book.json + pages/*.png)
test/              e2e (demo provider), mock-OpenAI provider test, jsdom UI smoke test
```

API summary: `POST /api/auth/signup|login|logout`, `GET/PATCH/DELETE /api/me`, `POST /api/books`, `GET /api/books[/:id]`,
`PATCH /api/books/:id` (title, cover, order, settings), `POST /api/books/:id/duplicate`, `POST|PATCH|DELETE /api/books/:id/pages[/:pid]`,
`POST …/pages/:pid/regenerate`, `POST …/pages/upload`, `POST …/retry-failed`, `GET …/pages/:pid/image`, `GET …/cover`, `GET …/pdf`, `GET …/images.zip`.

## Security notes
- API keys only in server env; the frontend never sees them (test asserts a key does not appear in API output).
- Passwords: scrypt with per-user salt. Sessions: HMAC-signed, `HttpOnly`, `SameSite=Lax`, `Secure` in production. CSRF: state-changing requests require an `X-Requested-With: fetch` header.
- Every book/page route checks ownership (other users get 404). Files are served only through authenticated routes; IDs are random 96-bit values (no path traversal).
- Rate limits on auth, generation and exports; per-user daily image caps protect your AI bill. Upload limits: 10 MB, JPG/PNG/WebP/GIF, validated by decoding.
- Helmet security headers with a strict Content-Security-Policy.
- Prompts to the AI are built server-side from the user's topic; the image provider's safety filter errors are shown as friendly messages. For public launches add your own content moderation on topics.

## Known limitations / next steps
- Storage is a single-node file store: run **one instance** with a persistent disk. For multiple instances swap `server/store.js` for Postgres + S3 and `server/jobs.js` for a queue (BullMQ/SQS).
- Generation jobs are in-process; a server restart marks unfinished pages as failed with a Retry button.
- No email verification or password-reset email yet (needs an email provider).
- Page ideas come from built-in topic banks (any other topic uses scene templates). Plugging an LLM in `server/ideas.js` would give more varied, topic-specific ideas.
- Edit tools are idea-based (rewrite the description and redraw) – there is no freehand eraser/pen.
