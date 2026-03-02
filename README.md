# Dolphin Movie Downloader

A desktop and web-enabled movie downloader project built with Electron and Node.js.

## Overview

This repository supports two runtimes:
- Desktop app (Electron)
- EC2/VPS web server (`server.js`) that serves frontend + REST API

## Tech Stack

Frontend:
- HTML
- CSS
- JavaScript

Backend:
- Node.js
- WebTorrent
- torrent-search-api
- Electron (desktop mode)

## Disclaimer

This project is provided for educational purposes.
Users are responsible for complying with local laws and content rights.

## EC2 Server Mode

### Environment file
1. Copy `.env.example` to `.env`
2. Update values for your environment
3. `server.js` and test/proxy scripts automatically read `.env`
4. `PUBLIC_BASE_URL` should match the real externally reachable URL (include `:PORT` if not using 80/443)

### Entry point
- `server.js`

### API endpoints
- `GET /api/health`
- `GET /api/search-movies?q=...`
- `GET /api/search-debug?q=...` (diagnostics for provider availability)
- `POST /api/get-magnet`
- `GET /api/get-config`
- `POST /api/select-folder` (locked, returns `403`)
- `POST /api/start-download`
- `POST /api/pause-download`
- `POST /api/resume-download`
- `POST /api/cancel-download`
- `GET /api/download-status`
- `GET /api/downloads`
- `GET /api/preview-file?id=...`
- `GET /api/download-file?id=...`

### File lifecycle on EC2
- Files are temporarily stored on EC2 while downloading.
- When a user downloads through `GET /api/download-file?id=...` and the transfer completes successfully, the server deletes downloaded artifacts for that job.
- This keeps EC2 storage clean after delivery.
- Download path is server-managed and hidden from API/UI clients.
- Optional: set `COMPLETED_TTL_MS` to auto-delete completed files after a timeout even if no user downloads them.

### Local run
1. `npm install`
2. `npm run ec2:start`
3. Open `http://localhost`

### Local checks
1. `npm run web:test`
2. `npm run web:check`

### EC2 deployment
1. Install Node.js 18+ on EC2.
2. Clone the repository.
3. Install dependencies: `npm install --omit=dev`
4. Set `.env` (`PORT`, `HOST`, `PUBLIC_BASE_URL`) and run: `npm run ec2:start`
5. Put Nginx or Caddy in front of Node for TLS/reverse proxy.

## Vercel Support (Frontend + EC2 API Proxy)

Full torrent/download runtime is not suitable for Vercel serverless functions.
This project supports Vercel by hosting the UI on Vercel and proxying `/api/*` to your EC2 backend via `api/[...path].js`.

### Setup
1. Deploy `server.js` on EC2 and confirm API works:
   - `https://YOUR_EC2_DOMAIN/api/health`
2. In Vercel project settings, add environment variables:
   - `API_BASE_URL_PRODUCTION` -> e.g. `https://api.yourdomain.com`
   - `API_BASE_URL_PREVIEW` -> e.g. `https://staging-api.yourdomain.com`
   - `API_BASE_URL_DEVELOPMENT` -> e.g. `https://dev-api.yourdomain.com`
3. Optional fallback variable:
   - `API_BASE_URL` (used if env-specific var is missing)
4. Deploy this repo to Vercel.
5. Open your Vercel URL and test search/download flow.

### Troubleshooting 500 on Vercel `/api/*`
If you see `500`/`503` on `/api/get-config` or `/api/download-status`:
1. Verify Vercel env vars are set for the right environment (`Production`, `Preview`, `Development`).
2. Ensure the value is only base URL, for example:
   - `https://api.yourdomain.com`
   - not `https://api.yourdomain.com/api`
3. Make sure EC2 endpoint is reachable publicly over HTTPS.
4. Redeploy after changing env vars.

Accepted variable names:
- Preferred:
  - `API_BASE_URL_PRODUCTION`, `API_BASE_URL_PREVIEW`, `API_BASE_URL_DEVELOPMENT`
- Fallback:
  - `API_BASE_URL`, `EC2_API_BASE_URL`, `EC2_API_URL`, `UPSTREAM_API_BASE_URL`, `BACKEND_API_BASE_URL`

### Important
- Do not point API base URLs to localhost/private IP.
- Keep EC2 publicly reachable behind HTTPS.
- Download files and cleanup still happen on EC2 (as designed).
- The proxy auto-selects environment using `VERCEL_ENV` (`production`, `preview`, `development`).

### Reliability tuning (optional env vars)
- `SERVER_DOWNLOAD_PATH` (default `./downloads`): locked server-side download directory.
- `STALL_RESTART_MS` (default `180000`): if no meaningful transfer is detected for this long, server retries the torrent session.
- `MAX_STALL_RESTARTS` (default `8`): max auto-reconnect attempts per download before marking it failed.
- `STALL_MIN_PROGRESS_BYTES` (default `32768`): minimum bytes increase considered real progress (prevents false “active” state).
- `COMPLETED_TTL_MS` (default `0`): auto-delete completed files after timeout.
- `SEARCH_TIMEOUT_MS` (default `12000`): timeout per provider/category search call.
- `SEARCH_RESULT_LIMIT` (default `1000`): max candidate results per search stage.
- `SEARCH_PROVIDER_ORDER`: comma-separated provider priority list for fallback search.
- `SEARCH_DIRECT_FALLBACK` (default `1`): enables direct mirror APIs (YTS + TPB) if scraper providers are blocked on EC2.
- `YTS_DIRECT_MIRRORS`: comma-separated YTS API mirror list.
- `TPB_API_MIRRORS`: comma-separated PirateBay API mirror list.
- `SEARCH_DEBUG` (`0` or `1`): print provider-level search diagnostics in server logs.
