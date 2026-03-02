let activeDownloads = new Map();
let currentSearchTimestamp = 0;

// DATA STORAGE
let allSearchResults = [];
let filteredResults = [];
let currentPage = 0;
const RESULTS_PER_PAGE = 20;

// --- INITIALIZATION ---
window.onload = async () => {
  const config = await window.api.getConfig();
  if (document.getElementById("pathDisplay")) {
    document.getElementById("pathDisplay").value = config.downloadPath;
  }
};

function handleEnter(e) {
  if (e.key === "Enter") search();
}

// Helper: Convert bytes to readable size
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + " " + sizes[i];
}

function formatSpeed(bytesPerSecond) {
  const speed = Number(bytesPerSecond || 0);
  if (!Number.isFinite(speed) || speed <= 0) return "0 B/s";
  if (speed >= 1024 * 1024) return `${(speed / 1024 / 1024).toFixed(2)} MB/s`;
  if (speed >= 1024) return `${(speed / 1024).toFixed(1)} KB/s`;
  return `${Math.round(speed)} B/s`;
}

function formatProgressPercent(value) {
  const progress = Number(value || 0);
  if (!Number.isFinite(progress) || progress <= 0) return "0%";
  if (progress < 0.01) return "<0.01%";
  if (progress < 1) return `${progress.toFixed(2)}%`;
  return `${progress.toFixed(1)}%`;
}

function setSidebarOpen(isOpen) {
  const sidebar = document.getElementById("downloadSidebar");
  if (!sidebar) return;
  sidebar.classList.toggle("open", Boolean(isOpen));
  document.body.classList.toggle("sidebar-open", Boolean(isOpen));
}

function toggleSidebar() {
  const sidebar = document.getElementById("downloadSidebar");
  if (!sidebar) return;
  setSidebarOpen(!sidebar.classList.contains("open"));
}

async function changeFolder() {
  const newPath = await window.api.selectFolder();
  if (newPath) document.getElementById("pathDisplay").value = newPath;
}

// ---------------------------------------------------------
// SEARCH LOGIC
// ---------------------------------------------------------
async function search() {
  const query = document.getElementById("searchInput").value;
  const searchBtn = document.getElementById("searchBtn");
  const cancelBtn = document.getElementById("cancelSearchBtn");

  // Get the UI elements
  const tableContainer = document.querySelector(".results-container"); // The wrapper
  const emptyState = document.getElementById("emptyState");
  const tbody = document.getElementById("resultsBody");
  const loadMoreDiv = document.getElementById("loadMoreContainer");

  if (!query) return;

  const mySearchId = Date.now();
  currentSearchTimestamp = mySearchId;

  // UI UPDATES:
  searchBtn.style.display = "none";
  cancelBtn.style.display = "inline-block";

  // 1. Hide Empty State immediately
  emptyState.style.display = "none";

  // 2. Clear table and Hide it while loading
  tbody.innerHTML = "";
  tableContainer.style.display = "none";

  document.getElementById("resultCount").innerText = "Searching...";
  loadMoreDiv.style.display = "none";

  currentPage = 0;
  allSearchResults = [];
  filteredResults = [];

  try {
    const results = await window.api.searchMovies(query);

    if (currentSearchTimestamp !== mySearchId) return;

    allSearchResults = results;

    if (results.length === 0) {
      document.getElementById("resultCount").innerText = "0 results found.";
      // If no results, show Empty State again (or a specific 'No Results' view)
      emptyState.style.display = "block";
      emptyState.innerHTML =
        '<i class="fas fa-search-minus empty-state-icon"></i><p>No results found</p>';
    } else {
      applyFilters();
    }
  } catch (err) {
    if (currentSearchTimestamp === mySearchId) {
      document.getElementById("resultCount").innerText = "Error occurred.";
      emptyState.style.display = "block"; // Show state on error
    }
  } finally {
    if (currentSearchTimestamp === mySearchId) {
      searchBtn.style.display = "inline-block";
      cancelBtn.style.display = "none";
    }
  }
}

function cancelSearch() {
  currentSearchTimestamp = 0;
  document.getElementById("searchBtn").style.display = "inline-block";
  document.getElementById("cancelSearchBtn").style.display = "none";
  document.getElementById("resultCount").innerText = "";

  // SWITCH LOGIC: Hide Table, Show Empty State
  document.querySelector(".results-container").style.display = "none";

  const emptyState = document.getElementById("emptyState");
  emptyState.style.display = "block";
  // Reset text back to original
  emptyState.innerHTML =
    '<i class="fas fa-film empty-state-icon"></i><p>Ready to search</p>';
}

function applyFilters() {
  // 1. Get Filter Values
  const quality = document.getElementById("qualityFilter").value;
  const sort = document.getElementById("sortFilter").value;

  // 2. Filter by Quality
  let temp = allSearchResults.filter((t) => {
    if (quality === "all") return true;
    return t.title.toLowerCase().includes(quality);
  });

  // 3. Sort Logic
  temp.sort((a, b) => {
    if (sort === "seeds_desc") return b.seeds - a.seeds;
    if (sort === "seeds_asc") return a.seeds - b.seeds;

    const parseSize = (str) => {
      const num = parseFloat(str);
      if (str.includes("GB")) return num * 1024;
      return num; // MB
    };

    if (sort === "size_desc") return parseSize(b.size) - parseSize(a.size);
    if (sort === "size_asc") return parseSize(a.size) - parseSize(b.size);
  });

  // 4. Update State & Reset Page
  filteredResults = temp;
  currentPage = 0;

  // Update Stats text
  document.getElementById(
    "resultCount"
  ).innerText = `${filteredResults.length} results`;

  // 5. Render
  document.getElementById("resultsBody").innerHTML = ""; // Clear rows
  renderPage();
}

function loadMore() {
  currentPage++;
  renderPage();
}

function renderPage() {
  const tableContainer = document.querySelector(".results-container");
  const tbody = document.getElementById("resultsBody");
  const loadMoreDiv = document.getElementById("loadMoreContainer");
  const emptyState = document.getElementById("emptyState");

  // SWITCH LOGIC:
  if (filteredResults.length > 0) {
    // ✅ CORRECT FIX: Use 'flex' so the scrollbar works!
    tableContainer.style.display = "flex";
    emptyState.style.display = "none";
  } else {
    tableContainer.style.display = "none";
    emptyState.style.display = "block";
    return;
  }

  const start = currentPage * RESULTS_PER_PAGE;
  const end = start + RESULTS_PER_PAGE;
  const itemsToShow = filteredResults.slice(start, end);

  itemsToShow.forEach((t) => {
    if (!t.id) t.id = `search-${Math.random().toString(36).substr(2, 9)}`;

    // Use the formatBytes helper if available, else raw size
    let displaySize =
      typeof formatBytes === "function" && !isNaN(t.size)
        ? formatBytes(t.size)
        : t.size;

    const row = `
            <tr class="result-row">
                <td class="result-cell result-title" data-label="Title">${t.title}</td>
                <td class="result-cell" data-label="Size">${displaySize}</td>
                <td class="result-cell seeds-cell" data-label="Seeds">${t.seeds}</td>
                <td class="result-cell result-action" data-label="Action">
                    <button class="download-btn" onclick="startDownload('${t.id}')">
                        <i class="fas fa-download"></i> Download
                    </button>
                </td>
            </tr>
        `;
    tbody.innerHTML += row;
  });

  loadMoreDiv.style.display = end < filteredResults.length ? "block" : "none";
}

function preview(id) {
    window.api.previewFile(id);
}

// ---------------------------------------------------------
// DOWNLOAD MANAGER LOGIC
// ---------------------------------------------------------

function startDownload(id) {
  const torrent = filteredResults.find((t) => t.id === id);
  if (!torrent) return;

  addToSidebar(torrent);
  setSidebarOpen(true);
  window.api.startDownload(torrent);
}

function addToSidebar(torrent) {
  const list = document.getElementById("downloadList");
  if (list.querySelector(".empty-state")) list.innerHTML = "";

  const cardId = `card-${torrent.id}`;
  if (document.getElementById(cardId)) return;

  const cardHTML = `
        <div id="${cardId}" class="download-card">
            <div class="card-title" title="${torrent.title}">${torrent.title}</div>
            
            <div class="progress-info">
                <span id="speed-${torrent.id}">0 MB/s</span>
                <span id="size-${torrent.id}" class="progress-size">Waiting...</span>
                <span id="percent-${torrent.id}">0%</span>
            </div>
            
            <div class="progress-bar-bg">
                <div id="bar-${torrent.id}" class="progress-bar-fill"></div>
            </div>

            <div class="card-actions">
                <button class="action-icon-btn btn-preview" onclick="preview('${torrent.id}')" title="Preview Video">
                    <i class="fas fa-play-circle"></i>
                </button>

                <button class="action-icon-btn" onclick="pause('${torrent.id}')" id="btn-pause-${torrent.id}" title="Pause">
                    <i class="fas fa-pause"></i>
                </button>
                <button class="action-icon-btn btn-cancel" onclick="cancel('${torrent.id}')" title="Cancel">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        </div>
    `;

  list.innerHTML = cardHTML + list.innerHTML;
  activeDownloads.set(torrent.id, torrent);
  updateBadge();
}

// --- ACTIONS (Pause/Resume/Cancel) ---

function pause(id) {
  const torrent = activeDownloads.get(id);
  if (!torrent || !torrent.magnet) {
    alert("Still connecting. Please wait 2 seconds.");
    return;
  }

  window.api.pauseDownload(torrent.magnet);

  const btn = document.getElementById(`btn-pause-${id}`);
  btn.innerHTML = '<i class="fas fa-play"></i>';
  btn.setAttribute("onclick", `resume('${id}')`);
  btn.title = "Resume";

  document.getElementById(`speed-${id}`).innerText = "Paused";
}

function resume(id) {
  const torrent = activeDownloads.get(id);
  if (!torrent || !torrent.magnet) return;

  window.api.resumeDownload(torrent);

  const btn = document.getElementById(`btn-pause-${id}`);
  btn.innerHTML = '<i class="fas fa-pause"></i>';
  btn.setAttribute("onclick", `pause('${id}')`);
  btn.title = "Pause";
  document.getElementById(`speed-${id}`).innerText = "Resuming...";
}

function cancel(id) {
  const torrent = activeDownloads.get(id);
  if (!torrent) return;

  if (torrent.magnet) {
    window.api.cancelDownload(torrent.magnet);
  }

  // Remove from UI
  const card = document.getElementById(`card-${id}`);
  if (card) card.remove();
  activeDownloads.delete(id);
  updateBadge();

  if (activeDownloads.size === 0) {
    document.getElementById("downloadList").innerHTML =
      '<div class="empty-state">No active downloads</div>';
  }
}

function updateBadge() {
  const count = activeDownloads.size;
  const badge = document.getElementById("activeCount");
  if (badge) {
    badge.innerText = count;
    badge.style.display = count > 0 ? "flex" : "none";
  }
}

// --- LISTENERS ---

window.api.onProgress((data) => {
  const torrent = activeDownloads.get(data.id);

  if (torrent) {
    if (!torrent.magnet) torrent.magnet = data.magnet;

    const bar = document.getElementById(`bar-${data.id}`);
    const percentText = document.getElementById(`percent-${data.id}`);
    const speedText = document.getElementById(`speed-${data.id}`);
    const sizeText = document.getElementById(`size-${data.id}`);

    const progressValue = Number(data.progress || 0);
    const speedBytes = Number(
      data.speedBytes || Number(data.speed || 0) * 1024 * 1024
    );

    if (bar) bar.style.width = `${Math.max(0, Math.min(100, progressValue))}%`;
    if (percentText) percentText.innerText = formatProgressPercent(progressValue);
    if (speedText) {
      speedText.classList.remove("status-error");
      speedText.classList.remove("status-complete");

      if (data.status === "reconnecting" || data.stalled) {
        speedText.innerText = "Reconnecting peers...";
      } else if (Number(data.peers || 0) > 0 && speedBytes <= 0) {
        speedText.innerText = "Connected, waiting for data...";
      } else {
        speedText.innerText = formatSpeed(speedBytes);
      }
    }

    if (sizeText && data.total) {
      const downStr = formatBytes(data.downloaded);
      const totalStr = formatBytes(data.total);
      const peers = Number(data.peers || 0);
      sizeText.innerText = `${downStr} / ${totalStr} | ${peers} peers`;
    }
  }
});

window.api.onComplete((data) => {
    // Update the internal tracker with the final file path
    const torrent = activeDownloads.get(data.id);
    if (torrent) {
        torrent.filePath = data.path;
    }

    const card = document.getElementById(`card-${data.id}`);
    if (!card) return;

    // Mark progress as complete
    const bar = document.getElementById(`bar-${data.id}`);
    const percentText = document.getElementById(`percent-${data.id}`);
    const speedText = document.getElementById(`speed-${data.id}`);

    if (bar) {
        bar.style.width = "100%";
        bar.style.backgroundColor = "#22c55e";
    }
    if (percentText) percentText.innerText = "100%";
    
    // Show completed text
    if (speedText) {
        speedText.classList.remove("status-error");
        speedText.classList.add("status-complete");
        speedText.innerText = "Download Completed";
    }

    // Swap action buttons after completion
    const actionDiv = card.querySelector('.card-actions');
    actionDiv.innerHTML = `
        <button class="action-icon-btn btn-preview" onclick="preview('${data.id}')" title="Play Video">
            <i class="fas fa-play-circle"></i>
        </button>
        <button class="action-icon-btn action-pill btn-open" onclick="locateFile('${data.id}')" title="Open Folder">
            <i class="fas fa-folder-open"></i> Open
        </button>
    `;

    new Notification("Download Finished", { body: data.title });
});

function locateFile(id) {
  const torrent = activeDownloads.get(id);
  if (torrent && torrent.filePath) {
    window.api.showItemInFolder(torrent.filePath);
  } else {
    alert("File path not found. It might have been moved.");
  }
}

function openMagnetFallback(id) {
  const torrent = activeDownloads.get(id);
  if (!torrent || !torrent.magnet || typeof window.api.openMagnet !== "function") {
    alert("Magnet link is unavailable.");
    return;
  }
  window.api.openMagnet(torrent.magnet);
}

async function copyMagnetFallback(id) {
  const torrent = activeDownloads.get(id);
  if (!torrent || !torrent.magnet || typeof window.api.copyText !== "function") {
    alert("Magnet link is unavailable.");
    return;
  }

  const copied = await window.api.copyText(torrent.magnet);
  if (copied) {
    alert("Magnet copied.");
  } else {
    alert("Could not copy magnet automatically.");
  }
}

window.api.onStarted((data) => {
  const torrent = activeDownloads.get(data.id);
  if (torrent) {
    torrent.magnet = data.magnet;
    updateCardButtons(data.id, data.magnet);
  }
});

function updateCardButtons(id, magnet) {
  const pauseBtn = document.getElementById(`btn-pause-${id}`);
  if (pauseBtn) {
    pauseBtn.setAttribute("onclick", `pause('${id}')`);
  }
}

window.api.onError((data) => {
  const card = document.getElementById(`card-${data.id}`);
  if (card) {
    const torrent = activeDownloads.get(data.id);
    if (torrent && data.magnet && !torrent.magnet) {
      torrent.magnet = data.magnet;
    }

    const progressText = document.getElementById(`speed-${data.id}`);
    if (progressText) {
      progressText.classList.remove("status-complete");
      progressText.classList.add("status-error");
      progressText.innerText = `Warning: ${data.message}`;
    }

    const canUseMagnetFallback =
      torrent &&
      torrent.magnet &&
      (typeof window.api.openMagnet === "function" ||
        typeof window.api.copyText === "function");

    if (
      canUseMagnetFallback &&
      typeof data.message === "string" &&
      (
        data.message.toLowerCase().includes("no web peers") ||
        data.message.toLowerCase().includes("invalid torrent identifier") ||
        data.message.toLowerCase().includes("invalid magnet")
      )
    ) {
      const actionDiv = card.querySelector(".card-actions");
      if (actionDiv) {
        actionDiv.innerHTML = `
          <button class="action-icon-btn action-pill btn-open-magnet" onclick="openMagnetFallback('${data.id}')" title="Open in torrent app">
            <i class="fas fa-external-link-alt"></i> Open Magnet
          </button>
          <button class="action-icon-btn action-pill btn-copy-magnet" onclick="copyMagnetFallback('${data.id}')" title="Copy magnet">
            <i class="fas fa-copy"></i> Copy
          </button>
        `;
      }
    }
  }
});

// CLICK OUTSIDE TO CLOSE SIDEBAR
document.addEventListener("click", (event) => {
  const sidebar = document.getElementById("downloadSidebar");
  const toggleBtn = document.querySelector(".toggle-downloads-btn");
  const isDownloadBtn = event.target.closest(".download-btn");

  if (
    sidebar &&
    toggleBtn &&
    sidebar.classList.contains("open") &&
    !sidebar.contains(event.target) &&
    !toggleBtn.contains(event.target) &&
    !isDownloadBtn
  ) {
    setSidebarOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const sidebar = document.getElementById("downloadSidebar");
  if (sidebar && sidebar.classList.contains("open")) {
    setSidebarOpen(false);
  }
});

if (window.api.onRestore) {
  window.api.onRestore((savedList) => {
    console.log("Restoring session:", savedList);

    savedList.forEach((item) => {
      // Add card to UI
      addToSidebar(item);

      // Track internally
      activeDownloads.set(item.id, item);

      // Update status text
      const speedText = document.getElementById(`speed-${item.id}`);
      if (speedText) speedText.innerText = "Resuming...";
    });

    // Open Sidebar
    if (savedList.length > 0) {
      setSidebarOpen(true);
      updateBadge();
    }
  });
}
