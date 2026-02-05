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
const resetBtn = document.getElementById("reset-btn");
const resultsSection = document.getElementById("results");
const navTabs = Array.from(document.querySelectorAll(".tabs-inner .tab"));

const setTabsEnabled = (hasResults) => {
  navTabs.forEach((tab) => {
    const requiresResults = tab.dataset.requiresResults === "true";
    if (!requiresResults) return;

    if (hasResults) {
      tab.classList.remove("is-disabled");
      tab.setAttribute("aria-disabled", "false");
      tab.removeAttribute("tabindex");
      return;
    }

    tab.classList.add("is-disabled");
    tab.setAttribute("aria-disabled", "true");
    tab.setAttribute("tabindex", "-1");
  });
};

navTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.classList.contains("is-disabled")) return;
    navTabs.forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
  });
});

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
  if (resultsSection) {
    resultsSection.dataset.hasResults = "false";
  }
  setTabsEnabled(false);
};

resetBtn.addEventListener("click", () => {
  form.reset();
  clearStatus();
  resetResults();
});

resetResults();

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

    if (resultsSection) {
      resultsSection.dataset.hasResults = "true";
    }
    setTabsEnabled(true);
    setStatus("Comparison complete. Review the highlighted differences below.");
    document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(error.message, "error");
  }
});
