const receivedMeta = document.getElementById("receivedMeta");
const receivedList = document.getElementById("receivedList");
const statusFilter = document.getElementById("statusFilter");
const refreshBtn = document.getElementById("refreshBtn");
const exportBtn = document.getElementById("exportBtn");
const metricTotal = document.getElementById("metricTotal");
const metricSuccess = document.getElementById("metricSuccess");
const metricErrors = document.getElementById("metricErrors");
const metricAvgBytes = document.getElementById("metricAvgBytes");

let currentSpeech = null;
let isFetchingReceived = false;
let allItems = [];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTimestamp(isoValue) {
  if (!isoValue) {
    return "Unknown time";
  }

  const date = new Date(isoValue);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function speakText(text) {
  if (!text || !text.trim()) {
    return;
  }

  if (!("speechSynthesis" in window)) {
    return;
  }

  if (currentSpeech) {
    window.speechSynthesis.cancel();
    currentSpeech = null;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.onend = () => {
    currentSpeech = null;
  };
  utterance.onerror = () => {
    currentSpeech = null;
  };

  currentSpeech = utterance;
  window.speechSynthesis.speak(utterance);
}

function getEntryViewStatus(entry) {
  const payload = entry?.payload || {};
  if (entry?.statusCode >= 400 || payload?.error) {
    return "error";
  }

  const analysisStatus = payload?.analysis?.status;
  if (analysisStatus === "completed") {
    return "completed";
  }

  if (analysisStatus === "skipped") {
    return "skipped";
  }

  return "unknown";
}

function getFilteredItems(items) {
  const selected = statusFilter.value;
  if (selected === "all") {
    return items;
  }

  return items.filter((entry) => getEntryViewStatus(entry) === selected);
}

function updateKpis(items) {
  const total = items.length;
  const successCount = items.filter((entry) => entry.statusCode >= 200 && entry.statusCode < 300).length;
  const errorCount = items.filter((entry) => entry.statusCode >= 400).length;
  const byteValues = items
    .map((entry) => Number(entry?.payload?.reconstruction?.bytesReceived))
    .filter((value) => Number.isFinite(value) && value > 0);
  const avgBytes = byteValues.length > 0
    ? Math.round(byteValues.reduce((sum, value) => sum + value, 0) / byteValues.length)
    : 0;

  metricTotal.textContent = String(total);
  metricSuccess.textContent = String(successCount);
  metricErrors.textContent = String(errorCount);
  metricAvgBytes.textContent = String(avgBytes);
}

function exportItemsToCsv(items) {
  const headers = [
    "timestamp",
    "statusCode",
    "callerIp",
    "bytes",
    "mimeType",
    "analysisStatus",
    "analysisText"
  ];

  const rows = items.map((entry) => {
    const payload = entry.payload || {};
    const reconstruction = payload.reconstruction || {};
    const analysis = payload.analysis || {};
    const values = [
      payload?.meta?.timestamp || "",
      String(entry.statusCode || ""),
      entry?.caller?.ip || "",
      String(reconstruction?.bytesReceived ?? payload?.request?.byteSize ?? ""),
      reconstruction?.mimeType || payload?.request?.mimeType || "",
      analysis?.status || "",
      (analysis?.text || payload?.error?.message || "").replace(/\s+/g, " ").trim()
    ];

    return values
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(",");
  });

  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "received-api-calls.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderReceivedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    receivedList.innerHTML = "<p class=\"subtitle\">No API calls captured yet.</p>";
    return;
  }

  receivedList.innerHTML = items.map((entry) => {
    const payload = entry.payload || {};
    const reconstruction = payload.reconstruction || {};
    const analysis = payload.analysis || {};
    const error = payload.error || null;
    const isSuccess = entry.statusCode >= 200 && entry.statusCode < 300;
    const time = formatTimestamp(payload?.meta?.timestamp);
    const callerIp = entry?.caller?.ip || "unknown";
    const mime = reconstruction.mimeType || payload?.request?.mimeType || "n/a";
    const bytes = reconstruction.bytesReceived ?? payload?.request?.byteSize ?? "n/a";

    const imageMarkup = reconstruction.imageDataUrl
      ? `<img src=\"${escapeHtml(reconstruction.imageDataUrl)}\" alt=\"Reconstructed from API caller\" />`
      : "";

    const analysisTextValue = analysis.text || (error ? error.message : "No analysis text.");
    const canSpeak = typeof analysisTextValue === "string" && analysisTextValue.trim().length > 0;
    const encodedText = encodeURIComponent(analysisTextValue);

    return `
      <article class="received-item">
        <div class="received-head">
          <span class="pill ${isSuccess ? "ok" : "err"}">${isSuccess ? "SUCCESS" : "ERROR"}</span>
          <span class="pill">${escapeHtml(String(entry.statusCode))}</span>
          <span class="pill">${escapeHtml(callerIp)}</span>
          <span class="pill">${escapeHtml(time)}</span>
          <span class="pill">${escapeHtml(String(bytes))} bytes</span>
          <span class="pill">${escapeHtml(String(mime))}</span>
          <span class="pill">${escapeHtml(analysis.status || "unknown")}</span>
        </div>
        ${imageMarkup}
        <pre class="received-analysis">${escapeHtml(analysisTextValue)}</pre>
        <div class="received-actions">
          <button class="button speak-entry-btn" data-text="${encodedText}" ${canSpeak ? "" : "disabled"}>
            Speak This Analysis
          </button>
        </div>
      </article>
    `;
  }).join("");
}

async function refreshReceivedData() {
  if (isFetchingReceived) {
    return;
  }

  isFetchingReceived = true;
  try {
    const response = await fetch("/api/received-data?limit=15");
    if (!response.ok) {
      throw new Error("Failed to fetch received data history.");
    }

    const payload = await response.json();
    allItems = Array.isArray(payload.items) ? payload.items : [];

    const filteredItems = getFilteredItems(allItems);
    updateKpis(filteredItems);
    receivedMeta.textContent = `Showing ${filteredItems.length} of ${payload.total} calls. Last refresh: ${new Date().toLocaleTimeString()}.`;
    renderReceivedItems(filteredItems);
  } catch (_error) {
    receivedMeta.textContent = "Unable to refresh received data right now.";
  } finally {
    isFetchingReceived = false;
  }
}

receivedList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest(".speak-entry-btn");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const text = decodeURIComponent(button.dataset.text || "");
  speakText(text);
});

statusFilter.addEventListener("change", () => {
  const filteredItems = getFilteredItems(allItems);
  updateKpis(filteredItems);
  renderReceivedItems(filteredItems);
});

refreshBtn.addEventListener("click", () => {
  refreshReceivedData();
});

exportBtn.addEventListener("click", () => {
  const filteredItems = getFilteredItems(allItems);
  exportItemsToCsv(filteredItems);
});

refreshReceivedData();
setInterval(refreshReceivedData, 4000);
