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

### Entry point
- `server.js`

### API endpoints
- `GET /api/health`
- `GET /api/search-movies?q=...`
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
3. Open `http://localhost:3000`

### Local checks
1. `npm run web:test`
2. `npm run web:check`

### EC2 deployment
1. Install Node.js 18+ on EC2.
2. Clone the repository.
3. Install dependencies: `npm install --omit=dev`
4. Run server: `PORT=3000 npm run ec2:start`
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

### Important
- Do not point API base URLs to localhost/private IP.
- Keep EC2 publicly reachable behind HTTPS.
- Download files and cleanup still happen on EC2 (as designed).
- The proxy auto-selects environment using `VERCEL_ENV` (`production`, `preview`, `development`).

### Reliability tuning (optional env vars)
- `SERVER_DOWNLOAD_PATH` (default `./downloads`): locked server-side download directory.
- `STALL_RESTART_MS` (default `180000`): if a download has zero peers/zero speed for this long, server retries the torrent session.
- `MAX_STALL_RESTARTS` (default `3`): max auto-reconnect attempts per download.
- `COMPLETED_TTL_MS` (default `0`): auto-delete completed files after timeout.
