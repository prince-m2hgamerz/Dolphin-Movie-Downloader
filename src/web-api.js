(function () {
  if (typeof window === "undefined") return;
  if (window.api) return;

  const listeners = {
    started: [],
    progress: [],
    complete: [],
    error: [],
    updateMessage: [],
    updateStatus: [],
    restore: [],
  };

  const knownStates = new Map();
  let pollTimer = null;
  let nextStatusAttemptAt = 0;
  let cachedConfig = {
    downloadPath: "Managed by server (hidden)",
    pathLocked: true,
  };

  const emit = (type, payload) => {
    const callbacks = listeners[type] || [];
    callbacks.forEach((callback) => {
      try {
        callback(payload);
      } catch (error) {
        console.error("Listener error:", error);
      }
    });
  };

  const on = (type, callback) => {
    if (typeof callback === "function") {
      listeners[type].push(callback);
    }
  };

  const request = async (url, options = {}) => {
    const method = options.method || "GET";
    const headers = { ...(options.headers || {}) };
    const fetchOptions = { method, headers };

    if (options.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, fetchOptions);
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const message =
        (payload && (payload.error || payload.detail)) ||
        `Request failed (${response.status})`;
      throw new Error(message);
    }

    return payload;
  };

  const toSeedNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : 0;
  };

  const normalizeSearchResult = (item) => ({
    ...item,
    seeds: toSeedNumber(item && item.seeds),
    size:
      item && typeof item.size === "string" && item.size.trim()
        ? item.size
        : "Unknown",
  });

  const getConfig = async () => {
    try {
      const payload = await request("/api/get-config");
      if (payload && typeof payload.downloadPath === "string") {
        cachedConfig = {
          downloadPath: payload.downloadPath,
          pathLocked: payload.pathLocked !== false,
        };
      }
    } catch (error) {
      emit("updateMessage", error.message || "Failed to fetch config");
    }
    return cachedConfig;
  };

  const selectFolder = async () => {
    emit("updateMessage", "Download path is locked by server policy.");
    return null;
  };

  const searchMovies = async (query) => {
    const payload = await request(
      `/api/search-movies?q=${encodeURIComponent(query || "")}`
    );
    if (!Array.isArray(payload)) return [];
    return payload.map(normalizeSearchResult);
  };

  const startDownload = async (torrent) => {
    try {
      const payload = await request("/api/start-download", {
        method: "POST",
        body: torrent || {},
      });
      if (payload && payload.id) {
        emit("started", { id: payload.id, magnet: payload.magnet || "" });
      }
    } catch (error) {
      emit("error", {
        id: torrent && torrent.id ? torrent.id : "unknown",
        message: error.message || "Failed to start download",
      });
    }
  };

  const pauseDownload = async (magnet) => {
    try {
      await request("/api/pause-download", {
        method: "POST",
        body: { magnet },
      });
    } catch (error) {
      emit("updateMessage", error.message || "Failed to pause download");
    }
  };

  const resumeDownload = async (torrent) => {
    try {
      const payload = await request("/api/resume-download", {
        method: "POST",
        body: torrent || {},
      });
      if (payload && payload.id) {
        emit("started", { id: payload.id, magnet: payload.magnet || "" });
      }
    } catch (error) {
      emit("error", {
        id: torrent && torrent.id ? torrent.id : "unknown",
        message: error.message || "Failed to resume download",
      });
    }
  };

  const cancelDownload = async (magnet) => {
    try {
      await request("/api/cancel-download", {
        method: "POST",
        body: { magnet },
      });
    } catch (error) {
      emit("updateMessage", error.message || "Failed to cancel download");
    }
  };

  const showItemInFolder = (filePath) => {
    if (!filePath) return;

    if (/^https?:\/\//i.test(filePath)) {
      window.open(filePath, "_blank", "noopener,noreferrer");
      return;
    }

    if (filePath.startsWith("/")) {
      window.open(filePath, "_blank", "noopener,noreferrer");
      return;
    }

    emit(
      "updateMessage",
      "This is a server-side file path. Use the Open button to download."
    );
  };

  const previewFile = (id) => {
    if (!id) return;
    window.open(
      `/api/preview-file?id=${encodeURIComponent(id)}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const openMagnet = (magnet) => {
    if (typeof magnet !== "string" || !magnet.startsWith("magnet:?")) {
      return false;
    }
    const anchor = document.createElement("a");
    anchor.href = magnet;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  };

  const copyText = async (value) => {
    if (typeof value !== "string" || !value) return false;
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      return false;
    }
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      return false;
    }
  };

  const syncRestore = async () => {
    try {
      const payload = await request("/api/downloads");
      if (Array.isArray(payload) && payload.length > 0) {
        emit("restore", payload);
      }
    } catch (error) {
      emit("updateMessage", error.message || "Failed to restore downloads");
    }
  };

  const syncStatus = async () => {
    if (Date.now() < nextStatusAttemptAt) return;

    let statuses = [];

    try {
      const payload = await request("/api/download-status");
      if (Array.isArray(payload)) statuses = payload;
      nextStatusAttemptAt = 0;
    } catch (error) {
      emit("updateStatus", "Disconnected from server");
      nextStatusAttemptAt = Date.now() + 5000;
      return;
    }

    emit("updateStatus", "Connected to EC2 server");

    const seen = new Set();

    statuses.forEach((state) => {
      if (!state || !state.id) return;
      const id = String(state.id);
      seen.add(id);

      const prev = knownStates.get(id);
      const magnet = state.magnet || "";

      if (!prev) {
        emit("started", { id, magnet });
      }

      if (state.status === "error") {
        if (!prev || prev.error !== state.error) {
          emit("error", {
            id,
            message: state.error || "Download error",
            magnet,
          });
        }
        knownStates.set(id, state);
        return;
      }

      if (state.status === "completed") {
        if (!prev || prev.status !== "completed") {
          emit("complete", {
            id,
            title: state.title || "Download",
            path: state.previewUrl || state.downloadUrl || "",
            previewPath: state.previewUrl || "",
            downloadPath: state.downloadUrl || "",
          });
        }
        knownStates.set(id, state);
        return;
      }

      emit("progress", {
        id,
        progress: Number(state.progress || 0).toFixed(3),
        speed: Number(state.speed || 0).toFixed(3),
        speedBytes: Number(state.speedBytes || 0),
        downloaded: Number(state.downloaded || 0),
        total: Number(state.total || 0),
        peers: Number(state.peers || 0),
        stalled: !!state.stalled,
        status: String(state.status || ""),
        error: String(state.error || ""),
        magnet,
      });

      knownStates.set(id, state);
    });

    Array.from(knownStates.keys()).forEach((id) => {
      if (!seen.has(id)) {
        knownStates.delete(id);
      }
    });
  };

  const startPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    syncStatus().catch(() => null);
    pollTimer = setInterval(() => {
      syncStatus().catch(() => null);
    }, 1000);
  };

  syncRestore()
    .then(getConfig)
    .finally(startPolling);

  window.addEventListener("beforeunload", () => {
    if (pollTimer) clearInterval(pollTimer);
  });

  window.api = {
    searchMovies,
    selectFolder,
    getConfig,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    showItemInFolder,
    previewFile,
    openMagnet,
    copyText,
    onStarted: (callback) => on("started", callback),
    onProgress: (callback) => on("progress", callback),
    onComplete: (callback) => on("complete", callback),
    onError: (callback) => on("error", callback),
    onUpdateMessage: (callback) => on("updateMessage", callback),
    onUpdateStatus: (callback) => on("updateStatus", callback),
    onRestore: (callback) => on("restore", callback),
  };
})();
