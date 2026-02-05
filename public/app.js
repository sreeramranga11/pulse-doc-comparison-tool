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
const insightsSummaryEl = document.getElementById("insights-summary");
const insightsMetaEl = document.getElementById("insights-meta");
const insightsCategoriesEl = document.getElementById("insights-categories");
const insightsChecksEl = document.getElementById("insights-checks");
const insightsRisksEl = document.getElementById("insights-risks");
const insightsConfidenceEl = document.getElementById("insights-confidence");
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
  { sectionId: "summary", tabId: "tab-summary", requiresResults: true },
  { sectionId: "insights", tabId: "tab-insights", requiresResults: true },
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
  if (insightsSummaryEl) insightsSummaryEl.textContent = "";
  if (insightsMetaEl) insightsMetaEl.textContent = "";
  if (insightsCategoriesEl) insightsCategoriesEl.innerHTML = "";
  if (insightsChecksEl) insightsChecksEl.innerHTML = "";
  if (insightsRisksEl) insightsRisksEl.innerHTML = "";
  if (insightsConfidenceEl) insightsConfidenceEl.innerHTML = "";
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

    const renderEmptyKv = (target, message) => {
      if (!target) return;
      target.innerHTML = "";
      const div = document.createElement("div");
      div.className = "kv";
      div.textContent = message;
      target.appendChild(div);
    };

    const renderHighlights = (target, highlights, emptyMessage) => {
      if (!target) return;
      target.innerHTML = "";
      const items = Array.isArray(highlights) ? highlights : [];
      if (!items.length) {
        renderEmptyKv(target, emptyMessage);
        return;
      }
      items.forEach((h) => {
        const item = document.createElement("div");
        item.className = "kv";

        const row = document.createElement("div");
        row.className = "kv-row";

        const label = document.createElement("strong");
        label.textContent = h?.title || "Highlight";

        row.appendChild(label);
        item.appendChild(row);

        if (h?.evidence) {
          const samples = document.createElement("div");
          samples.className = "samples";
          samples.textContent = h.evidence;
          item.appendChild(samples);
        }

        target.appendChild(item);
      });
    };

    const renderCategories = (target, categories) => {
      if (!target) return;
      target.innerHTML = "";
      const items = Array.isArray(categories) ? categories : [];
      if (!items.length) {
        renderEmptyKv(target, "No categories detected.");
        return;
      }
      items.forEach((c) => {
        const item = document.createElement("div");
        item.className = "kv";

        const row = document.createElement("div");
        row.className = "kv-row";

        const label = document.createElement("strong");
        label.textContent = c?.category ? c.category.replaceAll("_", " ") : "other";

        row.appendChild(label);
        item.appendChild(row);

        if (c?.summary) {
          const samples = document.createElement("div");
          samples.className = "samples";
          samples.textContent = c.summary;
          item.appendChild(samples);
        }

        target.appendChild(item);
      });
    };

    const renderChecks = (target, checks) => {
      if (!target) return;
      target.innerHTML = "";
      const items = Array.isArray(checks) ? checks : [];
      if (!items.length) {
        renderEmptyKv(target, "No suggested checks.");
        return;
      }
      items.forEach((text) => {
        const item = document.createElement("div");
        item.className = "kv";
        item.textContent = text;
        target.appendChild(item);
      });
    };

    const renderRisks = (target, risks) => {
      if (!target) return;
      target.innerHTML = "";
      const items = Array.isArray(risks) ? risks : [];
      if (!items.length) {
        renderEmptyKv(target, "No risks flagged.");
        return;
      }
      items.forEach((r) => {
        const level = (r?.severity || "unknown").toString().toLowerCase();
        const item = document.createElement("div");
        item.className = `kv kv-risk kv-risk-${level}`;

        const row = document.createElement("div");
        row.className = "kv-row";

        const label = document.createElement("strong");
        label.textContent = r?.message || "Risk";

        const sev = document.createElement("span");
        sev.textContent = r?.severity || "";

        row.appendChild(label);
        row.appendChild(sev);
        item.appendChild(row);

        target.appendChild(item);
      });
    };

    const renderConfidence = (target, confidence) => {
      if (!target) return;
      target.innerHTML = "";
      const item = document.createElement("div");
      const level = (confidence || "unknown").toString().toLowerCase();
      item.className = `kv kv-confidence kv-confidence-${level}`;
      item.textContent = confidence ? String(confidence) : "unknown";
      target.appendChild(item);
    };

    const insights = data.insights || {};
    const result = insights?.result || null;
    if (!insights?.enabled || !result) {
      if (insightsSummaryEl) {
        insightsSummaryEl.textContent = insights?.error
          ? `Insights unavailable: ${insights.error}`
          : "Insights unavailable.";
      }
      if (insightsMetaEl) {
        insightsMetaEl.textContent =
          insights?.provider === "openai" && !insights?.enabled
            ? "Set OPENAI_API_KEY in .env to enable AI-powered insights."
            : "";
      }
      renderEmptyKv(insightsAddedEl, "No insights.");
      renderEmptyKv(insightsRemovedEl, "No insights.");
      renderEmptyKv(insightsCategoriesEl, "No insights.");
      renderEmptyKv(insightsChecksEl, "No insights.");
      renderEmptyKv(insightsRisksEl, "No insights.");
      renderConfidence(insightsConfidenceEl, "");
    } else {
      if (insightsSummaryEl) insightsSummaryEl.textContent = result.overall_summary || "";
      if (insightsMetaEl) {
        const meta = [];
        if (insights.provider) meta.push(insights.provider);
        if (insights.model) meta.push(insights.model);
        if (result.confidence) meta.push(`confidence: ${result.confidence}`);
        insightsMetaEl.textContent = meta.join(" • ");
      }

      renderHighlights(insightsAddedEl, result.added_highlights, "No added highlights.");
      renderHighlights(insightsRemovedEl, result.removed_highlights, "No removed highlights.");
      renderCategories(insightsCategoriesEl, result.change_categories);
      renderChecks(insightsChecksEl, result.suggested_checks);
      renderRisks(insightsRisksEl, result.risks);
      renderConfidence(insightsConfidenceEl, result.confidence);
    }

    const isCitationPath = (path) => {
      const p = String(path || "");
      return p === "citations" || p.startsWith("citations.") || p.startsWith("citations[");
    };

    const formatStructuredValue = (value) => {
      if (value === null || value === undefined) return "—";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    };

    const normalizeStructuredPath = (path) => {
      const p = String(path || "");
      if (!p) return "(root)";
      if (p === "values") return "(values)";
      if (p.startsWith("values.")) return p.slice("values.".length);
      return p;
    };

    if (structuredDiffRowsEl) {
      structuredDiffRowsEl.innerHTML = "";
      const allChanges = data.structuredDiff?.changes || [];
      const visibleChanges = allChanges.filter((change) => !isCitationPath(change?.path));
      const hiddenCitations = Math.max(0, allChanges.length - visibleChanges.length);

      const breakdown = visibleChanges.reduce((acc, change) => {
        const key = change?.type || "changed";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      if (structuredDiffCountEl) {
        const structuredTotal = visibleChanges.length;
        structuredDiffCountEl.textContent = `${structuredTotal} change${structuredTotal === 1 ? "" : "s"}`;
        const breakdownText = ["added", "removed", "changed"]
          .filter((key) => breakdown[key])
          .map((key) => `${breakdown[key]} ${key}`)
          .join(", ");
        const extra = hiddenCitations ? `Hidden evidence refs: ${hiddenCitations}` : "";
        structuredDiffCountEl.title = [breakdownText, extra].filter(Boolean).join(" • ");
      }

      const maxRows = 50;
      if (!visibleChanges.length) {
        const row = document.createElement("div");
        row.className = "table-row";

        const field = document.createElement("div");
        field.className = "cell-mono";
        field.textContent = hiddenCitations
          ? "No value changes detected (evidence refs hidden)."
          : "No value changes detected.";

        const left = document.createElement("div");
        left.className = "cell-mono";
        left.textContent = "";

        const right = document.createElement("div");
        right.className = "cell-mono";
        right.textContent = "";

        row.appendChild(field);
        row.appendChild(left);
        row.appendChild(right);
        structuredDiffRowsEl.appendChild(row);
      }

      visibleChanges.slice(0, maxRows).forEach((change) => {
        const row = document.createElement("div");
        row.className = "table-row";

        const field = document.createElement("div");
        field.className = "cell-mono cell-field";

        const badge = document.createElement("span");
        badge.className = `badge badge-${change.type || "changed"}`;
        badge.textContent = change.type || "changed";

        const path = document.createElement("div");
        path.className = "cell-path";
        path.textContent = normalizeStructuredPath(change.path);

        field.appendChild(badge);
        field.appendChild(path);

        const left = document.createElement("div");
        left.className = "cell-mono";
        left.textContent = formatStructuredValue(change.left);

        const right = document.createElement("div");
        right.className = "cell-mono";
        right.textContent = formatStructuredValue(change.right);

        row.appendChild(field);
        row.appendChild(left);
        row.appendChild(right);
        structuredDiffRowsEl.appendChild(row);
      });

      if (visibleChanges.length > maxRows) {
        const row = document.createElement("div");
        row.className = "kv";
        row.textContent = `Showing ${maxRows} of ${visibleChanges.length} structured changes.`;
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
