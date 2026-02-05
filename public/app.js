const form = document.getElementById("compare-form");
const statusEl = document.getElementById("status");
const additionsEl = document.getElementById("summary-additions");
const removalsEl = document.getElementById("summary-removals");
const totalEl = document.getElementById("summary-total");
const diffLeft = document.getElementById("diff-left");
const diffRight = document.getElementById("diff-right");
const diffInline = document.getElementById("diff-inline");
const extractLeft = document.getElementById("extract-left");
const extractRight = document.getElementById("extract-right");
const structuredLeft = document.getElementById("structured-left");
const structuredRight = document.getElementById("structured-right");
const debugPanel = document.getElementById("debug-panel");
const debugLogsEl = document.getElementById("debug-logs");
const debugToggle = document.getElementById("debug-toggle");
const clearLogs = document.getElementById("clear-logs");
const resetBtn = document.getElementById("reset-btn");

const logClient = (message) => {
  const timestamp = new Date().toISOString();
  debugLogsEl.textContent += `[${timestamp}] ${message}\n`;
};

const setStatus = (message, type = "info") => {
  statusEl.textContent = message;
  statusEl.classList.remove("hidden", "error");
  if (type === "error") {
    statusEl.classList.add("error");
  }
};

const clearStatus = () => {
  statusEl.textContent = "";
  statusEl.classList.add("hidden");
};

const resetResults = () => {
  additionsEl.textContent = "0";
  removalsEl.textContent = "0";
  totalEl.textContent = "0";
  diffLeft.innerHTML = "";
  diffRight.innerHTML = "";
  diffInline.innerHTML = "";
  extractLeft.textContent = "";
  extractRight.textContent = "";
  structuredLeft.textContent = "";
  structuredRight.textContent = "";
};

const toggleDebugPanel = () => {
  debugPanel.style.display = debugToggle.checked ? "block" : "none";
};

debugToggle.addEventListener("change", toggleDebugPanel);
clearLogs.addEventListener("click", () => {
  debugLogsEl.textContent = "";
});
resetBtn.addEventListener("click", () => {
  form.reset();
  clearStatus();
  resetResults();
  logClient("Reset comparison form and results.");
});

toggleDebugPanel();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();

  const leftFile = document.getElementById("left-file").files[0];
  const rightFile = document.getElementById("right-file").files[0];

  if (!leftFile || !rightFile) {
    setStatus("Please upload both documents.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("left", leftFile);
  formData.append("right", rightFile);

  setStatus("Extracting documents with Pulse API...", "info");
  logClient(`Submitting comparison for ${leftFile.name} and ${rightFile.name}`);

  try {
    const response = await fetch("/api/compare", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Comparison failed");
    }

    additionsEl.textContent = data.summary.additions;
    removalsEl.textContent = data.summary.removals;
    totalEl.textContent = data.summary.totalParts;

    diffLeft.innerHTML = data.sideBySideHtml.left;
    diffRight.innerHTML = data.sideBySideHtml.right;
    diffInline.innerHTML = data.inlineHtml;

    extractLeft.textContent = data.extracted.left || "No text returned.";
    extractRight.textContent = data.extracted.right || "No text returned.";

    structuredLeft.textContent = data.structuredOutput?.left
      ? JSON.stringify(data.structuredOutput.left, null, 2)
      : "No structured output returned.";
    structuredRight.textContent = data.structuredOutput?.right
      ? JSON.stringify(data.structuredOutput.right, null, 2)
      : "No structured output returned.";

    if (data.debug?.length) {
      data.debug.forEach((entry) => logClient(entry));
    }

    setStatus("Comparison complete. Review the highlighted differences below.");
  } catch (error) {
    setStatus(error.message, "error");
    logClient(`Error: ${error.message}`);
  }
});
