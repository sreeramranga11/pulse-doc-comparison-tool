const form = document.getElementById("compare-form");
const statusEl = document.getElementById("status");
const additionsLabelEl = document.getElementById("summary-additions-label");
const additionsEl = document.getElementById("summary-additions");
const removalsLabelEl = document.getElementById("summary-removals-label");
const removalsEl = document.getElementById("summary-removals");
const totalLabelEl = document.getElementById("summary-total-label");
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
const submitBtn = form.querySelector('button[type="submit"]');
const tabsInnerEl = document.querySelector(".tabs-inner");

const structuredEnabledEl = document.getElementById("structured-enabled");
const structuredConfigEl = document.getElementById("structured-config");
const structuredPresetEl = document.getElementById("structured-preset");
const structuredPromptEl = document.getElementById("structured-prompt");
const structuredSchemaEl = document.getElementById("structured-schema");

const insightsAddedEl = document.getElementById("insights-added");
const insightsRemovedEl = document.getElementById("insights-removed");
const structuredDiffCountEl = document.getElementById("structured-diff-count");
const structuredDiffRowsEl = document.getElementById("structured-diff-rows");

const structuredPresets = {
  contract: {
    prompt:
      "Extract contract details. Focus on key dates, parties, payment terms, and termination. Format dates as YYYY-MM-DD.",
    schema: {
      type: "object",
      properties: {
        document_title: { type: "string", description: "Title of the document" },
        effective_date: { type: "string", format: "date", description: "Effective date" },
        parties: { type: "array", items: { type: "string" }, description: "List of parties" },
        term_end_date: { type: "string", format: "date", description: "End/expiration date" },
        payment_terms: { type: "string", description: "Payment terms summary" },
        governing_law: { type: "string", description: "Governing law / jurisdiction" },
        termination: { type: "string", description: "Termination clause summary" }
      },
      required: ["document_title"]
    }
  },
  invoice: {
    prompt:
      "Extract invoice details. Include vendor/customer, invoice number/date, totals, and all line items. Currency amounts as numbers without symbols. Format dates as YYYY-MM-DD.",
    schema: {
      type: "object",
      properties: {
        invoice_number: { type: "string" },
        invoice_date: { type: "string", format: "date" },
        vendor: {
          type: "object",
          properties: { name: { type: "string" }, address: { type: "string" } }
        },
        customer: {
          type: "object",
          properties: { name: { type: "string" }, address: { type: "string" } }
        },
        subtotal: { type: "number" },
        tax: { type: "number" },
        total: { type: "number" },
        line_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unit_price: { type: "number" },
              amount: { type: "number" }
            },
            required: ["description", "amount"]
          }
        }
      },
      required: ["invoice_number", "total"]
    }
  }
};

const setActiveTab = (tabId) => {
  if (!tabId) return;
  navTabs.forEach((t) => t.classList.remove("is-active"));
  document.getElementById(tabId)?.classList.add("is-active");
};

const getHeaderOffset = () => {
  const navbar = document.querySelector(".navbar");
  return navbar?.offsetHeight || 0;
};

const SECTION_STEPS = [
  { sectionId: "upload", tabId: "tab-upload", requiresResults: false },
  { sectionId: "inline", tabId: "tab-inline", requiresResults: true },
  { sectionId: "side-by-side", tabId: "tab-side", requiresResults: true }
];

const getAvailableSteps = () => {
  const hasResults = resultsSection?.dataset?.hasResults === "true";
  return SECTION_STEPS.filter((step) => {
    if (step.requiresResults && !hasResults) return false;
    return Boolean(document.getElementById(step.sectionId) && document.getElementById(step.tabId));
  });
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const lerp = (a, b, t) => a + (b - a) * t;

const getSectionTop = (el) => {
  const rect = el.getBoundingClientRect();
  return rect.top + window.scrollY;
};

const updateTabsProgress = () => {
  if (!tabsInnerEl) return;
  const steps = getAvailableSteps();
  if (steps.length <= 1) {
    tabsInnerEl.style.setProperty("--tabs-progress-width", "0px");
    setActiveTab("tab-upload");
    return;
  }

  const headerOffset = getHeaderOffset();
  const y = window.scrollY + headerOffset + 18;

  const sectionEls = steps.map((s) => document.getElementById(s.sectionId));
  const sectionTops = sectionEls.map((el) => getSectionTop(el) - headerOffset);

  const tabsRect = tabsInnerEl.getBoundingClientRect();
  const centers = steps.map((s) => {
    const tab = document.getElementById(s.tabId);
    const rect = tab.getBoundingClientRect();
    return rect.left - tabsRect.left + rect.width / 2;
  });

  let activeIndex = 0;
  for (let i = 0; i < sectionTops.length; i += 1) {
    if (sectionTops[i] <= y) activeIndex = i;
  }

  let t = 0;
  if (activeIndex < sectionTops.length - 1) {
    const start = sectionTops[activeIndex];
    const end = sectionTops[activeIndex + 1];
    const span = Math.max(1, end - start);
    t = clamp01((y - start) / span);
  } else {
    t = 1;
  }

  const targetX =
    activeIndex < centers.length - 1
      ? lerp(centers[activeIndex], centers[activeIndex + 1], t)
      : centers[centers.length - 1];

  const progressWidth = Math.max(0, Math.min(tabsRect.width, targetX));
  tabsInnerEl.style.setProperty("--tabs-progress-width", `${Math.round(progressWidth)}px`);
  setActiveTab(steps[activeIndex].tabId);
};

let progressRaf = 0;
const scheduleTabsProgress = () => {
  if (progressRaf) return;
  progressRaf = window.requestAnimationFrame(() => {
    progressRaf = 0;
    updateTabsProgress();
  });
};

window.addEventListener("scroll", scheduleTabsProgress, { passive: true });
window.addEventListener("resize", scheduleTabsProgress);

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
  tab.addEventListener("click", (event) => {
    if (tab.classList.contains("is-disabled")) return;
    event.preventDefault();
    const href = tab.getAttribute("href");
    const target = href ? document.querySelector(href) : null;
    setActiveTab(tab.id);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    scheduleTabsProgress();
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

const setLoading = (isLoading) => {
  if (!submitBtn) return;
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? "Comparing..." : "Compare Documents";
};

const resetResults = () => {
  additionsEl.textContent = "0";
  removalsEl.textContent = "0";
  totalEl.textContent = "0";
  if (additionsLabelEl) additionsLabelEl.textContent = "Words added";
  if (removalsLabelEl) removalsLabelEl.textContent = "Words removed";
  if (totalLabelEl) totalLabelEl.textContent = "Diff chunks";
  diffLeft.innerHTML = "";
  diffRight.innerHTML = "";
  diffInline.innerHTML = "";
  extractLeft.textContent = "";
  extractRight.textContent = "";
  structuredLeft.textContent = "";
  structuredRight.textContent = "";
  if (insightsAddedEl) insightsAddedEl.innerHTML = "";
  if (insightsRemovedEl) insightsRemovedEl.innerHTML = "";
  if (structuredDiffCountEl) structuredDiffCountEl.textContent = "0 changes";
  if (structuredDiffRowsEl) structuredDiffRowsEl.innerHTML = "";
  if (resultsSection) {
    resultsSection.dataset.hasResults = "false";
  }
  setTabsEnabled(false);
  setActiveTab("tab-upload");
  scheduleTabsProgress();
};

const toggleStructuredConfig = () => {
  const enabled = Boolean(structuredEnabledEl?.checked);
  structuredConfigEl?.classList.toggle("hidden", !enabled);
  if (enabled && structuredSchemaEl && !structuredSchemaEl.value.trim()) {
    loadPreset(structuredPresetEl?.value === "invoice" ? "invoice" : "contract");
  }
};

const loadPreset = (presetKey) => {
  const preset = structuredPresets[presetKey];
  if (!preset) return;
  structuredPromptEl.value = preset.prompt;
  structuredSchemaEl.value = JSON.stringify(preset.schema, null, 2);
};

structuredEnabledEl?.addEventListener("change", toggleStructuredConfig);
structuredPresetEl?.addEventListener("change", () => {
  const value = structuredPresetEl.value;
  if (value === "custom") return;
  loadPreset(value);
});

toggleStructuredConfig();

resetBtn.addEventListener("click", () => {
  form.reset();
  clearStatus();
  resetResults();
  toggleStructuredConfig();
});

resetResults();
scheduleTabsProgress();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  setLoading(true);

  const leftFile = document.getElementById("left-file").files[0];
  const rightFile = document.getElementById("right-file").files[0];

  if (!leftFile || !rightFile) {
    setStatus("Please upload both documents.", "error");
    setLoading(false);
    return;
  }

  resetResults();

  const formData = new FormData();
  formData.append("left", leftFile);
  formData.append("right", rightFile);

  const diffMode = form.querySelector('input[name="diff_mode"]:checked')?.value || "words";
  formData.append("diff_mode", diffMode);

  const structuredEnabled = Boolean(structuredEnabledEl?.checked);
  formData.append("structured_enabled", structuredEnabled ? "true" : "false");
  if (structuredEnabled) {
    formData.append("structured_schema", structuredSchemaEl.value || "");
    formData.append("structured_prompt", structuredPromptEl.value || "");
  }

  setStatus("Extracting documents with Pulse API...", "info");

  try {
    const response = await fetch("/api/compare", {
      method: "POST",
      body: formData
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Comparison failed");
    }

    additionsEl.textContent = data.summary.additions;
    removalsEl.textContent = data.summary.removals;
    totalEl.textContent = data.summary.totalParts;

    const unit = data.summary?.unit === "lines" ? "Lines" : "Words";
    if (additionsLabelEl) additionsLabelEl.textContent = `${unit} added`;
    if (removalsLabelEl) removalsLabelEl.textContent = `${unit} removed`;
    if (totalLabelEl) totalLabelEl.textContent = "Diff chunks";

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

    const renderInsights = (target, insight) => {
      target.innerHTML = "";
      const entries = Object.entries(insight || {}).filter(([, v]) => v?.count > 0);
      if (!entries.length) {
        const div = document.createElement("div");
        div.className = "kv";
        div.textContent = "No notable changes detected in this category.";
        target.appendChild(div);
        return;
      }

      entries.forEach(([key, value]) => {
        const item = document.createElement("div");
        item.className = "kv";

        const row = document.createElement("div");
        row.className = "kv-row";

        const label = document.createElement("strong");
        label.textContent = key;

        const count = document.createElement("span");
        count.textContent = `${value.count}`;

        row.appendChild(label);
        row.appendChild(count);
        item.appendChild(row);

        if (value.unique?.length) {
          const samples = document.createElement("div");
          samples.className = "samples";
          samples.textContent = value.unique.join(" · ");
          item.appendChild(samples);
        }

        target.appendChild(item);
      });
    };

    if (insightsAddedEl) renderInsights(insightsAddedEl, data.insights?.added);
    if (insightsRemovedEl) renderInsights(insightsRemovedEl, data.insights?.removed);

    const structuredTotal = Number(data.structuredDiff?.total || 0);
    if (structuredDiffCountEl) {
      structuredDiffCountEl.textContent = `${structuredTotal} change${structuredTotal === 1 ? "" : "s"}`;
    }
    if (structuredDiffRowsEl) {
      structuredDiffRowsEl.innerHTML = "";
      const changes = data.structuredDiff?.changes || [];
      const breakdown = changes.reduce((acc, change) => {
        const key = change?.type || "changed";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      if (structuredDiffCountEl) {
        const breakdownText = ["added", "removed", "changed"]
          .filter((key) => breakdown[key])
          .map((key) => `${breakdown[key]} ${key}`)
          .join(", ");
        structuredDiffCountEl.title = breakdownText || "";
      }

      const maxRows = 50;
      changes.slice(0, maxRows).forEach((change) => {
        const row = document.createElement("div");
        row.className = "table-row";

        const field = document.createElement("div");
        field.className = "cell-mono cell-field";

        const badge = document.createElement("span");
        badge.className = `badge badge-${change.type || "changed"}`;
        badge.textContent = change.type || "changed";

        const path = document.createElement("div");
        path.className = "cell-path";
        path.textContent = change.path || "(root)";

        field.appendChild(badge);
        field.appendChild(path);

        const left = document.createElement("div");
        left.className = "cell-mono";
        left.textContent =
          change.left === null ? "—" : typeof change.left === "string" ? change.left : JSON.stringify(change.left);

        const right = document.createElement("div");
        right.className = "cell-mono";
        right.textContent =
          change.right === null
            ? "—"
            : typeof change.right === "string"
              ? change.right
              : JSON.stringify(change.right);

        row.appendChild(field);
        row.appendChild(left);
        row.appendChild(right);
        structuredDiffRowsEl.appendChild(row);
      });

      if (structuredTotal > maxRows) {
        const row = document.createElement("div");
        row.className = "kv";
        row.textContent = `Showing ${maxRows} of ${structuredTotal} structured changes.`;
        structuredDiffRowsEl.appendChild(row);
      }
    }

    if (resultsSection) {
      resultsSection.dataset.hasResults = "true";
    }
    setTabsEnabled(true);
    scheduleTabsProgress();
    setStatus("Comparison complete. Review the highlighted differences below.");
    document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setLoading(false);
  }
});
