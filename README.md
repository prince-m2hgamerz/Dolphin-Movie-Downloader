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

Vercel serverless mode has been removed.

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

### Reliability tuning (optional env vars)
- `SERVER_DOWNLOAD_PATH` (default `./downloads`): locked server-side download directory.
- `STALL_RESTART_MS` (default `180000`): if a download has zero peers/zero speed for this long, server retries the torrent session.
- `MAX_STALL_RESTARTS` (default `3`): max auto-reconnect attempts per download.
- `COMPLETED_TTL_MS` (default `0`): auto-delete completed files after timeout.
