const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pipeline } = require("stream");
const { URL } = require("url");
const WebTorrent = require("webtorrent");
const TorrentSearchApi = require("torrent-search-api");
const { getRuntimeConfig } = require("./lib/env");
const runtimeConfig = getRuntimeConfig();

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACTIVE_DOWNLOADS_PATH = path.join(DATA_DIR, "active_downloads.json");
const DEFAULT_DOWNLOAD_PATH = path.join(ROOT_DIR, "downloads");
const SERVER_DOWNLOAD_PATH = path.resolve(
  process.env.SERVER_DOWNLOAD_PATH || DEFAULT_DOWNLOAD_PATH
);
const PORT = runtimeConfig.PORT;
const HOST = runtimeConfig.HOST;
const PUBLIC_BASE_URL = runtimeConfig.PUBLIC_BASE_URL;
const COMPLETED_TTL_MS = Number(process.env.COMPLETED_TTL_MS || 0);
const STALL_RESTART_MS = Number(process.env.STALL_RESTART_MS || 180000);
const MAX_STALL_RESTARTS = Number(process.env.MAX_STALL_RESTARTS || 3);
const EXTRA_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.cyberia.is:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://opentor.org:2710/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.files.fm:7073/announce",
];

const client = new WebTorrent({
  dht: true,
  tracker: true,
  lsd: true,
  maxConns: 200,
});
const downloads = new Map();
const magnetToId = new Map();
const cleanupLocks = new Set();

let config = { downloadPath: SERVER_DOWNLOAD_PATH };
let providersEnabled = false;

const PUBLIC_STATIC_PATHS = new Set(
  ["index.html", "icon.ico", "icon.png", "icon.icns"].map((item) =>
    path.resolve(path.join(ROOT_DIR, item))
  )
);
const PUBLIC_STATIC_DIRS = [path.resolve(path.join(ROOT_DIR, "src"))];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".icns": "image/icns",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

function ensureProviders() {
  if (!providersEnabled) {
    TorrentSearchApi.enablePublicProviders();
    providersEnabled = true;
  }
}

async function ensureDataDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(config.downloadPath, { recursive: true });
}

async function loadConfig() {
  // Download path is server-managed and not user-configurable via API.
  config = { downloadPath: SERVER_DOWNLOAD_PATH };

  try {
    await fsp.access(CONFIG_PATH, fs.constants.F_OK);
  } catch (error) {
    // Ignore missing config file.
  }
}

async function saveConfig() {
  await ensureDataDirs();
  await fsp.writeFile(
    CONFIG_PATH,
    JSON.stringify(
      {
        downloadPath: config.downloadPath,
        pathLocked: true,
      },
      null,
      2
    ),
    "utf8"
  );
}

function normalizeMagnet(value) {
  if (typeof value !== "string") return "";

  let magnet = value.trim().replace(/^"+|"+$/g, "");
  if (!magnet) return "";

  if (/^magnet%3A%3F/i.test(magnet)) {
    try {
      magnet = decodeURIComponent(magnet);
    } catch (error) {
      return "";
    }
  }

  if (/^urn:btih:/i.test(magnet)) {
    magnet = `magnet:?xt=${magnet}`;
  }

  if (!/^magnet:\?/i.test(magnet)) {
    return "";
  }

  try {
    const url = new URL(magnet);
    const xt = url.searchParams.get("xt");
    if (!xt) return "";

    const parts = [`xt=${xt}`];
    const dn = url.searchParams.get("dn");
    if (dn) {
      parts.push(`dn=${encodeURIComponent(dn)}`);
    }

    const seen = new Set();
    url.searchParams.getAll("tr").forEach((tracker) => {
      if (!tracker || seen.has(tracker)) return;
      seen.add(tracker);
      parts.push(`tr=${encodeURIComponent(tracker)}`);
    });

    return `magnet:?${parts.join("&")}`;
  } catch (error) {
    return "";
  }
}

function normalizeSeedCount(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function normalizeSize(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const mb = value / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(2)} MB`;
  }
  return "Unknown";
}

function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function resolveWithinBase(basePath, relativePath) {
  const resolved = path.resolve(basePath, relativePath || "");
  if (!isPathInside(basePath, resolved)) {
    return null;
  }
  return resolved;
}

function getPersistableDownloads() {
  return Array.from(downloads.values())
    .filter((state) => !state.completed && state.status !== "cancelled")
    .map((state) => ({
      id: state.id,
      title: state.title,
      magnet: state.magnet,
      path: state.path,
      paused: !!state.paused,
      restartCount: Number(state.restartCount || 0),
    }));
}

async function saveActiveDownloads() {
  await ensureDataDirs();
  await fsp.writeFile(
    ACTIVE_DOWNLOADS_PATH,
    JSON.stringify(getPersistableDownloads(), null, 2),
    "utf8"
  );
}

async function loadActiveDownloads() {
  try {
    const raw = await fsp.readFile(ACTIVE_DOWNLOADS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && item.id && item.title && item.magnet);
  } catch (error) {
    return [];
  }
}

function findStateByMagnet(magnet) {
  if (!magnet) return null;

  const directId = magnetToId.get(magnet);
  if (directId && downloads.has(directId)) {
    return downloads.get(directId);
  }

  for (const state of downloads.values()) {
    if (state.magnet === magnet) return state;
  }

  return null;
}

function findPrimaryVideoFile(torrent) {
  if (!torrent || !Array.isArray(torrent.files)) return null;

  return torrent.files
    .slice()
    .sort((a, b) => (b.length || 0) - (a.length || 0))
    .find((file) => /\.(mp4|mkv|avi)$/i.test(file.name || ""));
}

async function removeDownloadedArtifacts(state) {
  const targets = new Set();

  if (Array.isArray(state.storagePaths)) {
    state.storagePaths.forEach((targetPath) => {
      if (typeof targetPath === "string" && targetPath) {
        targets.add(targetPath);
      }
    });
  }

  if (state.fileAbsolutePath) {
    targets.add(state.fileAbsolutePath);
  }

  const sortedTargets = Array.from(targets).sort((a, b) => b.length - a.length);

  for (const targetPath of sortedTargets) {
    if (!isPathInside(state.path, targetPath)) continue;
    try {
      await fsp.rm(targetPath, { recursive: true, force: true });
    } catch (error) {
      console.error("Artifact cleanup failed:", targetPath, error.message);
    }
  }
}

async function finalizeDownloadDelivery(stateId) {
  if (!stateId || cleanupLocks.has(stateId)) return;
  if (!downloads.has(stateId)) return;

  cleanupLocks.add(stateId);
  const state = downloads.get(stateId);

  try {
    if (state.torrent && !state.torrent.destroyed) {
      try {
        client.remove(state.magnet, { destroyStore: true });
      } catch (error) {
        // Continue cleanup even if torrent remove fails.
      }
    }

    await removeDownloadedArtifacts(state);

    downloads.delete(state.id);
    magnetToId.delete(state.magnet);
    await saveActiveDownloads();
  } finally {
    cleanupLocks.delete(stateId);
  }
}

async function cleanupExpiredCompletedDownloads() {
  if (!Number.isFinite(COMPLETED_TTL_MS) || COMPLETED_TTL_MS <= 0) return;

  const now = Date.now();
  const staleIds = Array.from(downloads.values())
    .filter(
      (state) =>
        state.completed &&
        state.completedAt > 0 &&
        now - state.completedAt >= COMPLETED_TTL_MS
    )
    .map((state) => state.id);

  for (const id of staleIds) {
    try {
      await finalizeDownloadDelivery(id);
    } catch (error) {
      console.error("Expired cleanup failed:", id, error.message);
    }
  }
}

async function recoverStalledDownloads() {
  if (!Number.isFinite(STALL_RESTART_MS) || STALL_RESTART_MS <= 0) return;

  const now = Date.now();
  const candidates = Array.from(downloads.values()).filter((state) => {
    if (!state || state.completed || state.paused) return false;
    if (!state.torrent || state.torrent.destroyed) return false;

    const peers = state.torrent.numPeers || 0;
    const speed = state.torrent.downloadSpeed || 0;
    const downloaded = state.torrent.downloaded || 0;

    if (downloaded > (state.lastDownloaded || 0)) {
      state.lastDownloaded = downloaded;
      state.lastActivityAt = now;
      return false;
    }

    if (peers > 0 || speed > 0) {
      state.lastActivityAt = now;
      return false;
    }

    return now - (state.lastActivityAt || now) >= STALL_RESTART_MS;
  });

  for (const state of candidates) {
    try {
      state.status = "stalled";
      await restartStalledDownload(state);
    } catch (error) {
      state.status = "error";
      state.error = "Auto-reconnect failed";
      console.error("Stall recovery failed:", state.id, error.message);
    }
  }
}

function attachTorrentToState(state, torrent) {
  state.torrent = torrent;
  state.status = state.paused ? "paused" : "downloading";
  state.error = "";
  state.lastActivityAt = Date.now();
  state.lastDownloaded = 0;

  torrent.on("download", () => {
    state.lastActivityAt = Date.now();
    state.lastDownloaded = torrent.downloaded || state.lastDownloaded || 0;
  });

  torrent.on("wire", () => {
    state.lastActivityAt = Date.now();
  });

  torrent.on("done", async () => {
    state.completed = true;
    state.completedAt = Date.now();
    state.paused = false;
    state.status = "completed";
    state.error = "";

    if (Array.isArray(torrent.files)) {
      state.storagePaths = torrent.files
        .map((item) => resolveWithinBase(state.path, item.path || item.name))
        .filter(Boolean);
    } else {
      state.storagePaths = [];
    }

    const file = findPrimaryVideoFile(torrent) || (torrent.files && torrent.files[0]);
    if (file) {
      state.fileName = path.basename(file.path || file.name || "download.bin");
      state.fileAbsolutePath =
        resolveWithinBase(state.path, file.path || state.fileName) || "";
      state.downloadUrl = `/api/download-file?id=${encodeURIComponent(state.id)}`;
      state.previewUrl = `/api/preview-file?id=${encodeURIComponent(state.id)}`;
    }

    try {
      await saveActiveDownloads();
    } catch (error) {
      console.error("saveActiveDownloads on done failed:", error);
    }
  });

  torrent.on("error", async (error) => {
    state.status = "error";
    state.error = (error && error.message) || "Download error";

    try {
      await saveActiveDownloads();
    } catch (saveError) {
      console.error("saveActiveDownloads on error failed:", saveError);
    }
  });
}

async function resolveMagnet(torrentData) {
  if (torrentData && torrentData.magnet) {
    const magnet = normalizeMagnet(torrentData.magnet);
    if (magnet) return magnet;
  }

  ensureProviders();
  const fetched = await TorrentSearchApi.getMagnet(torrentData);
  return normalizeMagnet(fetched);
}

function getSnapshot(state) {
  let progress = 0;
  let speed = 0;
  let speedBytes = 0;
  let downloaded = 0;
  let total = 0;
  let peers = 0;

  const torrent = state.torrent;
  if (torrent && !torrent.destroyed) {
    progress = Number(((torrent.progress || 0) * 100).toFixed(3));
    speedBytes = Number(torrent.downloadSpeed || 0);
    speed = Number((speedBytes / 1024 / 1024).toFixed(3));
    downloaded = torrent.downloaded || 0;
    total = torrent.length || 0;
    peers = torrent.numPeers || 0;
  }

  if (state.completed) {
    progress = 100;
    speed = 0;
  }

  if (state.paused) {
    speed = 0;
  }

  return {
    id: state.id,
    title: state.title,
    magnet: state.magnet,
    path: "Managed by server (hidden)",
    status: state.status,
    paused: !!state.paused,
    completed: !!state.completed,
    error: state.error || "",
    progress,
    speed,
    speedBytes,
    downloaded,
    total,
    peers,
    stalled: state.status === "stalled",
    downloadUrl: state.downloadUrl || "",
    previewUrl: state.previewUrl || "",
  };
}

function buildAnnounceList(magnet) {
  const announce = [];
  const seen = new Set();

  try {
    const url = new URL(magnet);
    url.searchParams.getAll("tr").forEach((tracker) => {
      if (!tracker || seen.has(tracker)) return;
      seen.add(tracker);
      announce.push(tracker);
    });
  } catch (error) {
    // ignore parse errors and fallback to extras
  }

  EXTRA_TRACKERS.forEach((tracker) => {
    if (!tracker || seen.has(tracker)) return;
    seen.add(tracker);
    announce.push(tracker);
  });

  return announce;
}

function addTorrentForState(state) {
  const announce = buildAnnounceList(state.magnet);
  const torrent = client.add(state.magnet, {
    path: state.path,
    announce,
  });

  attachTorrentToState(state, torrent);
  return torrent;
}

async function restartStalledDownload(state) {
  if (!state || state.completed || state.paused) return;
  if (state.restartCount >= MAX_STALL_RESTARTS) return;

  state.restartCount += 1;
  state.status = "reconnecting";
  state.error = "";
  state.lastActivityAt = Date.now();

  if (state.torrent && !state.torrent.destroyed) {
    try {
      client.remove(state.magnet);
    } catch (error) {
      // ignore and continue with re-add
    }
  }

  addTorrentForState(state);
  await saveActiveDownloads();
}

async function startDownloadInternal(torrentData) {
  if (!torrentData || !torrentData.id || !torrentData.title) {
    throw new Error("Invalid download payload");
  }

  const existing = downloads.get(torrentData.id);
  if (existing) {
    return existing;
  }

  const magnet = await resolveMagnet(torrentData);
  if (!magnet) {
    throw new Error("Magnet link not found");
  }

  const duplicate = findStateByMagnet(magnet);
  if (duplicate) {
    return duplicate;
  }

  // Path is always locked to server configuration, client values are ignored.
  const downloadPath = path.resolve(config.downloadPath);

  await fsp.mkdir(downloadPath, { recursive: true });

  const state = {
    id: String(torrentData.id),
    title: String(torrentData.title || "Untitled"),
    magnet,
    path: downloadPath,
    paused: false,
    completed: false,
    completedAt: 0,
    status: "starting",
    error: "",
    downloadUrl: "",
    previewUrl: "",
    fileAbsolutePath: "",
    fileName: "",
    storagePaths: [],
    restartCount: Number(torrentData.restartCount || 0),
    lastDownloaded: 0,
    lastActivityAt: Date.now(),
    torrent: null,
  };

  downloads.set(state.id, state);
  magnetToId.set(state.magnet, state.id);

  addTorrentForState(state);

  await saveActiveDownloads();
  return state;
}

async function resumeDownloadInternal(payload) {
  const id = payload && payload.id ? String(payload.id) : "";
  const magnet = payload && payload.magnet ? normalizeMagnet(payload.magnet) : "";

  let state = id ? downloads.get(id) : null;
  if (!state && magnet) {
    state = findStateByMagnet(magnet);
  }

  if (!state) {
    return startDownloadInternal(payload);
  }

  state.paused = false;
  state.status = "downloading";
  state.error = "";

  if (state.torrent && !state.torrent.destroyed) {
    if (typeof state.torrent.resume === "function") {
      state.torrent.resume();
    }
    await saveActiveDownloads();
    return state;
  }

  addTorrentForState(state);
  await saveActiveDownloads();
  return state;
}

async function pauseDownloadInternal(payload) {
  const magnet = payload && payload.magnet ? normalizeMagnet(payload.magnet) : "";
  const id = payload && payload.id ? String(payload.id) : "";

  let state = id ? downloads.get(id) : null;
  if (!state && magnet) {
    state = findStateByMagnet(magnet);
  }

  if (!state) {
    throw new Error("Download not found");
  }

  state.paused = true;
  state.status = "paused";
  state.error = "";

  if (state.torrent && !state.torrent.destroyed && typeof state.torrent.pause === "function") {
    state.torrent.pause();
  }

  await saveActiveDownloads();
  return state;
}

async function cancelDownloadInternal(payload) {
  const magnet = payload && payload.magnet ? normalizeMagnet(payload.magnet) : "";
  const id = payload && payload.id ? String(payload.id) : "";

  let state = id ? downloads.get(id) : null;
  if (!state && magnet) {
    state = findStateByMagnet(magnet);
  }

  if (!state) {
    throw new Error("Download not found");
  }

  if (state.torrent && !state.torrent.destroyed) {
    try {
      client.remove(state.magnet, { destroyStore: true });
    } catch (error) {
      // continue cleanup even if remove fails
    }
  }

  downloads.delete(state.id);
  magnetToId.delete(state.magnet);
  await saveActiveDownloads();
}

async function restoreDownloadsOnBoot() {
  if (process.env.SKIP_RESTORE === "1") return;

  const saved = await loadActiveDownloads();
  for (const item of saved) {
    try {
      await startDownloadInternal(item);
      if (item.paused) {
        await pauseDownloadInternal({ id: item.id });
      }
    } catch (error) {
      console.error("Restore failed for", item.id, error.message);
    }
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { "Content-Type": MIME_TYPES[".json"] });
  res.end(body);
}

function writeText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    const maxBytes = 1024 * 1024;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      data += chunk;
      if (Buffer.byteLength(data, "utf8") > maxBytes) {
        aborted = true;
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (aborted) return;
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (error) => {
      if (aborted) return;
      reject(error);
    });
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function isAllowedStaticPath(filePath) {
  const resolved = path.resolve(filePath);
  if (PUBLIC_STATIC_PATHS.has(resolved)) return true;
  return PUBLIC_STATIC_DIRS.some((baseDir) => isPathInside(baseDir, resolved));
}

async function serveFile(res, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      writeText(res, 404, "Not found");
      return;
    }
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(data);
  } catch (error) {
    writeText(res, 404, "Not found");
  }
}

async function streamVideoFile(res, absolutePath, options = {}) {
  const inline = !!options.inline;

  try {
    await fsp.access(absolutePath, fs.constants.R_OK);
  } catch (error) {
    writeText(res, 404, "File not found");
    return;
  }

  let fileStat;
  try {
    fileStat = await fsp.stat(absolutePath);
    if (!fileStat.isFile()) {
      writeText(res, 404, "File not found");
      return;
    }
  } catch (error) {
    writeText(res, 404, "File not found");
    return;
  }

  const fileName = path.basename(absolutePath);
  const headers = {
    "Content-Type": contentTypeFor(absolutePath),
    "Content-Length": fileStat.size,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileName}"`,
  };
  res.writeHead(200, headers);

  const readStream = fs.createReadStream(absolutePath);
  let bytesSent = 0;

  readStream.on("data", (chunk) => {
    bytesSent += chunk.length;
  });

  await new Promise((resolve) => {
    pipeline(readStream, res, async (error) => {
      if (!error && bytesSent === fileStat.size && typeof options.onComplete === "function") {
        try {
          await options.onComplete();
        } catch (cleanupError) {
          console.error("Post-download cleanup failed:", cleanupError);
        }
      }
      resolve();
    });
  });
}

async function handleApi(req, res, requestUrl) {
  const pathname = requestUrl.pathname;

  if (pathname === "/api/health") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      activeDownloads: downloads.size,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (pathname === "/api/search-movies") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const query = (requestUrl.searchParams.get("q") || "").trim();
    if (!query) {
      writeJson(res, 400, { error: "Missing query parameter: q" });
      return;
    }

    try {
      ensureProviders();
      // Match old Electron behavior exactly.
      const raw = await TorrentSearchApi.search(query, "All", 1000);
      const filtered = raw
        .filter((torrent) => {
          const title = (torrent && torrent.title) || "";
          const seeds = normalizeSeedCount(torrent && torrent.seeds);
          const isVideo =
            /1080p|720p|480p|BluRay|WEBRip|H\.264|x265|AVI|MKV|MP4/i.test(
              title
            );
          return seeds > 0 && isVideo;
        })
        .map((torrent, index) => ({
          ...torrent,
          id:
            torrent.id || `${torrent.provider || "provider"}-${Date.now()}-${index}`,
          title: torrent.title || "Untitled",
          seeds: normalizeSeedCount(torrent.seeds),
          size: normalizeSize(torrent.size),
        }));

      writeJson(res, 200, filtered);
    } catch (error) {
      console.error("search-movies failed:", error);
      writeJson(res, 500, []);
    }
    return;
  }

  if (pathname === "/api/get-magnet") {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      if (body && body.magnet) {
        const normalized = normalizeMagnet(body.magnet);
        if (!normalized) {
          writeJson(res, 400, { error: "Invalid magnet link" });
          return;
        }
        writeJson(res, 200, { magnet: normalized });
        return;
      }

      ensureProviders();
      const fetched = await TorrentSearchApi.getMagnet(body || {});
      const magnet = normalizeMagnet(fetched);
      if (!magnet) {
        writeJson(res, 404, { error: "Magnet link not found" });
        return;
      }
      writeJson(res, 200, { magnet });
    } catch (error) {
      console.error("get-magnet failed:", error);
      writeJson(res, 500, { error: "Failed to fetch magnet" });
    }
    return;
  }

  if (pathname === "/api/get-config") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    writeJson(res, 200, {
      downloadPath: "Managed by server (hidden)",
      pathLocked: true,
    });
    return;
  }

  if (pathname === "/api/select-folder") {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    writeJson(res, 403, { error: "Download path is locked on this server" });
    return;
  }

  if (pathname === "/api/start-download") {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const state = await startDownloadInternal(body);
      writeJson(res, 200, {
        id: state.id,
        title: state.title,
        magnet: state.magnet,
        status: state.status,
      });
    } catch (error) {
      writeJson(res, 400, { error: error.message || "Failed to start download" });
    }
    return;
  }

  if (pathname === "/api/resume-download") {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const state = await resumeDownloadInternal(body);
      writeJson(res, 200, {
        id: state.id,
        title: state.title,
        magnet: state.magnet,
        status: state.status,
      });
    } catch (error) {
      writeJson(res, 400, { error: error.message || "Failed to resume download" });
    }
    return;
  }

  if (pathname === "/api/pause-download") {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const state = await pauseDownloadInternal(body);
      writeJson(res, 200, {
        id: state.id,
        magnet: state.magnet,
        status: state.status,
      });
    } catch (error) {
      writeJson(res, 400, { error: error.message || "Failed to pause download" });
    }
    return;
  }

  if (pathname === "/api/cancel-download") {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const body = await readJsonBody(req);
      await cancelDownloadInternal(body);
      writeJson(res, 200, { ok: true });
    } catch (error) {
      writeJson(res, 400, { error: error.message || "Failed to cancel download" });
    }
    return;
  }

  if (pathname === "/api/download-status") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const list = Array.from(downloads.values()).map(getSnapshot);
    writeJson(res, 200, list);
    return;
  }

  if (pathname === "/api/downloads") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const list = Array.from(downloads.values())
      .filter((state) => !state.completed && state.status !== "cancelled")
      .map((state) => ({
        id: state.id,
        title: state.title,
        magnet: state.magnet,
        path: "Managed by server (hidden)",
        paused: !!state.paused,
      }));

    writeJson(res, 200, list);
    return;
  }

  if (pathname === "/api/preview-file" || pathname === "/api/download-file") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const id = (requestUrl.searchParams.get("id") || "").trim();
    if (!id || !downloads.has(id)) {
      writeText(res, 404, "Download not found");
      return;
    }

    const state = downloads.get(id);
    if (!state.fileAbsolutePath) {
      writeText(res, 404, "File not ready");
      return;
    }

    if (pathname === "/api/download-file" && !state.completed) {
      writeText(res, 409, "Download is not completed yet");
      return;
    }

    const isPreview = pathname === "/api/preview-file";
    await streamVideoFile(res, state.fileAbsolutePath, {
      inline: isPreview,
      onComplete: isPreview ? null : async () => finalizeDownloadDelivery(state.id),
    });
    return;
  }

  writeJson(res, 404, { error: "Endpoint not found" });
}

async function handleStatic(res, requestUrl) {
  let pathname = requestUrl.pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const unsafePath = path.join(ROOT_DIR, decodeURIComponent(pathname));
  const safePath = path.normalize(unsafePath);
  if (!isPathInside(ROOT_DIR, safePath)) {
    writeText(res, 403, "Forbidden");
    return;
  }

  if (!isAllowedStaticPath(safePath)) {
    writeText(res, 403, "Forbidden");
    return;
  }

  await serveFile(res, safePath);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(req, res, requestUrl);
        return;
      }

      await handleStatic(res, requestUrl);
    } catch (error) {
      console.error("Server error:", error);
      writeJson(res, 500, { error: "Internal server error" });
    }
  });
}

function shutdown() {
  return (async () => {
    try {
      await saveActiveDownloads();
    } catch (error) {
      console.error("Failed to persist active downloads on shutdown:", error.message);
    }

    await new Promise((resolve) => {
      try {
        client.destroy(() => resolve());
      } catch (error) {
        resolve();
      }
    });
  })();
}

async function boot() {
  await loadConfig();
  await ensureDataDirs();
  await saveConfig();
  await restoreDownloadsOnBoot();
}

if (require.main === module) {
  boot()
    .then(() => {
      const server = createServer();
      server.listen(PORT, HOST, () => {
        const visibleBase = PUBLIC_BASE_URL.replace(/\/+$/, "");
        const runtimeBase =
          visibleBase || `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
        console.log(`Dolphin API server running on ${runtimeBase}`);
      });

      const cleanupTimer = setInterval(() => {
        cleanupExpiredCompletedDownloads()
          .catch((error) => {
            console.error("Periodic cleanup failed:", error.message);
          })
          .finally(() => {
            recoverStalledDownloads().catch((error) => {
              console.error("Stall recovery check failed:", error.message);
            });
          });
      }, 60 * 1000);

      let stopping = false;
      const stopServer = async (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`Received ${signal}, shutting down...`);

        clearInterval(cleanupTimer);
        await new Promise((resolve) => server.close(resolve));
        await shutdown();
        process.exit(0);
      };

      process.on("SIGINT", () => {
        stopServer("SIGINT").catch(() => process.exit(1));
      });
      process.on("SIGTERM", () => {
        stopServer("SIGTERM").catch(() => process.exit(1));
      });
    })
    .catch((error) => {
      console.error("Boot failed:", error);
      process.exit(1);
    });
}

module.exports = {
  createServer,
  boot,
  shutdown,
};
