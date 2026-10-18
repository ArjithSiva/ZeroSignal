# Deploying ZeroSignal on the free tiers (no shell needed)

**Vercel** hosts the client. **Render** hosts the API. **MongoDB Atlas** (free M0) holds the data.
Nothing here needs a terminal on the host: the first admin and the optional sample history are created from environment variables.

## Why the "one root folder" question matters

The repo has three folders: `shared/`, `server/`, `client/`. Both `server` and `client` import `shared`.

| Platform | Root Directory | Why |
|---|---|---|
| **Render** (API) | **leave EMPTY** (repo root) | Render does not expose files outside the Root Directory at build *or run* time, so `server` alone would lose `shared/` and the install would fail. The build/start commands below already limit the work to `shared` + `server`. |
| **Vercel** (client) | **`client`** | Vercel's "Include source files outside of the Root Directory in the Build Step" option (on by default for projects created after Aug 2020) lets the build reach `../shared`. Check it is ticked under Settings → General → Root Directory. |

## 0. Generate two secrets (once, anywhere)

You need two random values. Nothing is installed and no project folder is involved: the command only **prints** text, which you copy into Render's environment variables. Use whichever is easiest:

**A. Your browser (no install).** Open any page, press `F12` → **Console**, paste, press Enter:
```js
[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('')
```
Run it twice. First result → `ALERT_SIGNING_SEED` (64 characters). Second → `JWT_SECRET`.

**B. Terminal with Node installed (any folder):**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the printed value only: no quotes, no spaces, no `#` comment. `ALERT_SIGNING_SEED` must be exactly 64 characters from `0-9a-f`. Keep it safe: changing it later invalidates the verification of alerts already sent. On a manual Web Service (not a Blueprint) Render does **not** generate `JWT_SECRET` for you, so set it yourself.

## 1. MongoDB Atlas
1. Create a free **M0** cluster, a database user, and under *Network Access* allow `0.0.0.0/0` (Render's free tier has no fixed outbound IP).
2. Copy the connection string and add the database name: `mongodb+srv://USER:PASS@cluster.xxxx.mongodb.net/zerosignal?retryWrites=true&w=majority`

## 2. Render (API)
**New → Blueprint → pick this repo** (uses `render.yaml`), *or* **New → Web Service** with:

| Setting | Value |
|---|---|
| Root Directory | *(empty)* |
| Runtime | Node |
| Build Command | `npm ci --omit=dev --workspace=shared --workspace=server` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Instance type | Free |

Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `TRUST_PROXY` | `1` |
| `MONGODB_URI` | your Atlas string |
| `JWT_SECRET` | the second value from step 0 (32+ characters) |
| `ALERT_SIGNING_SEED` | the 64-hex value from step 0 |
| `CLIENT_ORIGINS` | your Vercel URL, e.g. `https://zerosignal.vercel.app` (no trailing `/`; add custom domains comma-separated) |
| `APP_BASE_URL` | the same Vercel URL |
| `BOOTSTRAP_ADMIN_EMAIL` | your email (creates the first admin) |
| `BOOTSTRAP_ADMIN_NAME` | your name |
| `RATE_LIMIT_AUTH_MAX` | `60` (everyone arrives through Vercel's proxy, so they share a few IPs) |
| `GROQ_API_KEY` | optional |
| `SEED_ON_BOOT` / `SEED_EMAIL_DOMAIN` | optional: `true` / `responders.example.org` to pre-load sample history once |

Deploy, then open **Logs**. You will see:

```
✔ [bootstrap] Admin you@example.org created.
  One-time setup link (valid 72 h, shown in this log only):
  https://zerosignal.vercel.app/setup-account?token=…
```
Open that link (after step 3 is done) and choose your password. If you restart before using it, a fresh link is printed; once the password is set, nothing more happens.

Note your service URL, e.g. `https://zerosignal-api.onrender.com`.

## 3. Vercel (client)
1. **Add New → Project**, import the repo, **Root Directory = `client`**. Framework: Vite (detected). Leave the build settings alone: `client/vercel.json` sets them.
2. **Edit `client/vercel.json` once** and replace `YOUR-API.onrender.com` with your Render host, then commit. (Vercel cannot read environment variables inside rewrites.)
3. **Environment Variables** (must exist *before* the build):
   - `VITE_SOCKET_URL` = `https://zerosignal-api.onrender.com` (Vercel cannot proxy WebSockets, so the browser connects to Render directly for live updates)
   - leave `VITE_API_URL` **unset** (REST goes through the same-origin `/api` rewrite, which keeps the sign-in cookie first-party)
4. Deploy. Then make sure Render's `CLIENT_ORIGINS` / `APP_BASE_URL` match the final Vercel URL exactly.

## 4. First sign-in
Open the setup link from the Render log → set your password → you are the admin. Create broadcasters in **Admin → Users** (they receive a one-time link, which also appears in the Render log while `MAIL_TRANSPORT=console`; set `MAIL_TRANSPORT=smtp` + `SMTP_URL` for real email).

## What to expect on free tiers
- **Render sleeps after ~15 min idle**; the first request takes up to a minute. The sign-in page shows a "waking the server" state instead of an error. Open the app a minute before a demo, or ping `/api/health` (e.g. UptimeRobot, 5-minute interval).
- A restart wipes in-memory live state (connected receivers); the database is untouched and receivers reconnect on their own.
- **Real video:** the simulated feed always works. For real WebRTC create a free LiveKit Cloud project and set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` on Render. HLS needs FFmpeg, which Render's native Node runtime does not include, so leave it off.
- Atlas M0 is 512 MB: fine for a demo.

## Troubleshooting
| Symptom | Cause |
|---|---|
| Build fails with `Cannot find module '@zerosignal/shared'` | Render Root Directory was set to `server`. Clear it. |
| Live updates never arrive, REST works | `VITE_SOCKET_URL` missing at Vercel build time. Add it and **redeploy**. |
| Everything says "waking the server" forever | `YOUR-API.onrender.com` still in `client/vercel.json`, or wrong Render host. |
| Sign-in works, then you are signed out on refresh | `CLIENT_ORIGINS`/`APP_BASE_URL` differ from the real Vercel URL, or `COOKIE_SAMESITE` was changed from `lax`. |
| `ALERT_SIGNING_SEED must be exactly 64 hex characters` | pasted value has quotes/spaces or is the wrong length; regenerate with step 0 |
| Vercel: `Rewrite … has invalid source pattern` | use the `client/vercel.json` from this version (plain `/(.*)` fallback) |
| Service crashes on boot with "Missing required environment variables" | one of `MONGODB_URI`, `JWT_SECRET`, `ALERT_SIGNING_SEED`, `CLIENT_ORIGINS` is empty. |
| `MAIL_TRANSPORT=smtp needs SMTP_URL` | set `SMTP_URL`, or use `MAIL_TRANSPORT=console`. |
