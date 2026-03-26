function getVisibleLabelInput() {
  const selectors = [
    // Jira field-specific patterns first.
    '[data-testid="issue.views.field.labels"] input',
    '[data-testid="issue.views.field.labels"] [role="textbox"]',
    '[data-testid="issue.views.field.labels"] [contenteditable="true"]',
    '[data-testid="issue-field-labels.ui.input"]',
    '[data-testid*="label"] input[role="combobox"]',
    '[data-testid*="label"] input',
    'input[aria-label="Labels"]',
    'input[aria-label*="labels" i]',
    'input[placeholder="Add label"]',
    'input[placeholder*="label" i]',
    'input[data-test-id="labels-field.ui.input"]',
    'input[name="labels"]',
    'input[id*="labels"]',
    '[data-testid="labels-field"] input',
    '[data-testid*="labels"] input',
    '[aria-label="Labels"] [role="textbox"]',
    '[aria-label*="labels" i] [role="textbox"]',
    '[role="combobox"][aria-label*="label" i] input',
    '[role="combobox"][aria-label*="label" i] [role="textbox"]',
    '[contenteditable="true"][aria-label*="label" i]',
    '[contenteditable="true"][data-testid*="labels"]'
  ];

  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (isVisible(el) && !el.disabled && el.getAttribute("aria-hidden") !== "true") {
        return el;
      }
    }
  }

  // Last-resort heuristic: look for a "Labels" section and grab its textbox/input.
  const labelishContainers = Array.from(
    document.querySelectorAll('[data-testid*="labels"], [id*="labels"], [aria-label*="labels" i]')
  ).filter(isVisible);

  for (const container of labelishContainers) {
    const candidate = container.querySelector(
      'input, [role="textbox"], [contenteditable="true"]'
    );
    if (
      candidate &&
      isVisible(candidate) &&
      candidate.getAttribute("aria-hidden") !== "true"
    ) {
      return candidate;
    }
  }

  return null;
}

function dispatchInputEvents(input) {
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function isVisible(el) {
  if (!el || !(el instanceof Element)) {
    return false;
  }

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  return el.getClientRects().length > 0;
}

function normalizeLabel(value) {
  return String(value || "").trim().toLowerCase();
}

function getExistingLabels() {
  const selectors = [
    '[data-testid="issue.views.field.labels"] [data-testid="issue-field-labels.ui.label"]',
    '[data-testid="labels-field"] [data-testid="issue-field-labels.ui.label"]',
    '[id*="labels"] [data-testid*="label"]',
    '[aria-label="Labels"] ~ * [role="listitem"]',
    '[aria-label*="labels" i] [role="listitem"]'
  ];

  const values = new Set();
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      const text = normalizeLabel(node.textContent);
      if (text) {
        values.add(text);
      }
    }
  }

  return values;
}

function focusAndOpenLabelInput(input) {
  input.focus();
  input.click();
}

function findLabelsContainers() {
  const containers = new Set([
    ...document.querySelectorAll('[data-testid="issue.views.field.labels"]'),
    ...document.querySelectorAll('[data-testid*="labels-field"]'),
    ...document.querySelectorAll('[data-testid*="labels"]'),
    ...document.querySelectorAll('[id*="labels"]'),
    ...document.querySelectorAll('[aria-label*="labels" i]')
  ]);

  // Heuristic for sections titled "Labels" in Jira panels.
  for (const labelNode of document.querySelectorAll("*")) {
    const text = normalizeLabel(labelNode.textContent);
    if (text !== "labels") {
      continue;
    }
    const panel = labelNode.closest(
      '[role="group"], section, article, [data-testid], [class*="field"], [class*="item"]'
    );
    if (panel) {
      containers.add(panel);
    }
  }

  return Array.from(containers).filter(isVisible);
}

function openLabelsEditor() {
  const containers = findLabelsContainers();

  for (const container of containers) {
    const editTriggers = container.querySelectorAll(
      [
        'button[aria-label*="edit" i]',
        '[data-testid*="edit"] button',
        'button[data-testid*="labels"]',
        '[role="button"][aria-label*="labels" i]',
        '[role="button"][aria-label*="edit" i]',
        '[aria-haspopup="listbox"]'
      ].join(", ")
    );

    for (const trigger of editTriggers) {
      if (isVisible(trigger)) {
        trigger.click();
      }
    }

    // Also click container itself; Jira often enters inline edit on click.
    container.click();
  }
}

function setFieldValue(input, value) {
  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
    input.value = value;
    return;
  }

  if (input.isContentEditable) {
    input.textContent = value;
    return;
  }

  // Fallback for textbox-like elements.
  input.textContent = value;
}

function keyEvent(type, key) {
  return new KeyboardEvent(type, {
    key,
    code: key,
    bubbles: true,
    cancelable: true
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveLabelInput() {
  let input = getVisibleLabelInput();
  if (input) {
    return input;
  }

  openLabelsEditor();

  // Retry briefly in case Jira mounts the editor lazily.
  for (let i = 0; i < 5; i += 1) {
    await sleep(120);
    input = getVisibleLabelInput();
    if (input) {
      return input;
    }
  }

  return null;
}

async function addJiraLabel(label) {
  const cleanedLabel = normalizeLabel(label);
  if (!cleanedLabel) {
    return { ok: false, error: "No label provided." };
  }

  const input = await resolveLabelInput();
  if (!input) {
    return { ok: false, error: "Jira label input not found on this page." };
  }

  const existingLabels = getExistingLabels();
  if (existingLabels.has(cleanedLabel)) {
    return { ok: true, skipped: true, message: `Label "${cleanedLabel}" already exists.` };
  }

  focusAndOpenLabelInput(input);
  setFieldValue(input, cleanedLabel);
  dispatchInputEvents(input);

  // Jira often needs Enter to confirm tokenized labels.
  const target = document.activeElement && isVisible(document.activeElement) ? document.activeElement : input;
  target.dispatchEvent(keyEvent("keydown", "Enter"));
  target.dispatchEvent(keyEvent("keypress", "Enter"));
  target.dispatchEvent(keyEvent("keyup", "Enter"));

  // Re-check to confirm Jira accepted it.
  const afterLabels = getExistingLabels();
  if (afterLabels.has(cleanedLabel)) {
    return { ok: true };
  }

  // Some Jira screens update labels lazily; report success with caution.
  return { ok: true, message: "Label submitted. Verify it appears in the Labels field." };
}

const OVERLAY_ROOT_ID = "jira-palette-overlay";
const OVERLAY_STYLE_ID = "jira-palette-overlay-style";
const OVERLAY_POSITION_KEY = "overlayPosition";
const OVERLAY_ENABLED_KEY = "overlayEnabled";
const OVERLAY_SHOW_LABELS_KEY = "overlayShowLabels";
const OVERLAY_SHOW_SEVERITY_KEY = "overlayShowSeverity";
const LABELS_KEY = "labels";
const JIRA_BASE_URL_KEY = "jiraBaseUrl";
const JIRA_EMAIL_KEY = "jiraEmail";
const JIRA_TOKEN_KEY = "jiraApiToken";
const DEFAULT_LABELS = ["bug", "urgent", "customer", "follow-up"];
const overlaySelectedLabels = new Set();

function canUseChromeStorage() {
  return Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id);
}

async function safeStorageLocalSet(value) {
  if (!canUseChromeStorage()) {
    return;
  }
  try {
    await chrome.storage.local.set(value);
  } catch (_error) {
    // Ignore storage failures to avoid breaking drag interactions.
  }
}

async function safeStorageLocalGet(defaults) {
  if (!canUseChromeStorage()) {
    return defaults;
  }
  try {
    return await chrome.storage.local.get(defaults);
  } catch (_error) {
    return defaults;
  }
}

function getOverlayPositionStorageKey() {
  return `${OVERLAY_POSITION_KEY}:${location.host}`;
}

function createOverlayStyles() {
  if (document.getElementById(OVERLAY_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = OVERLAY_STYLE_ID;
  style.textContent = `
    #${OVERLAY_ROOT_ID} {
      position: fixed;
      top: 88px;
      right: 24px;
      width: 320px;
      z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #151515;
      background: #ffffff;
      border: 1px solid #d2d2d2;
      border-radius: 12px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }
    #${OVERLAY_ROOT_ID} * { box-sizing: border-box; }
    #${OVERLAY_ROOT_ID} .jp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
      background: linear-gradient(180deg, #ee0000 0%, #c9190b 100%);
      color: #ffffff;
      padding: 8px 10px;
      font-weight: 600;
      font-size: 12px;
    }
    #${OVERLAY_ROOT_ID} .jp-header button {
      border: 0;
      background: rgba(255, 255, 255, 0.18);
      color: #fff;
      border-radius: 6px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 11px;
    }
    #${OVERLAY_ROOT_ID} .jp-body {
      padding: 10px;
      background: #f8f8f8;
      max-height: 70vh;
      overflow: auto;
    }
    #${OVERLAY_ROOT_ID}.jp-minimized .jp-body {
      display: none;
    }
    #${OVERLAY_ROOT_ID} .jp-section {
      margin-bottom: 10px;
    }
    #${OVERLAY_ROOT_ID} .jp-section:last-of-type {
      margin-bottom: 0;
    }
    #${OVERLAY_ROOT_ID} .jp-section-title {
      font-size: 11px;
      font-weight: 700;
      color: #6a6e73;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      margin-bottom: 6px;
    }
    #${OVERLAY_ROOT_ID} .jp-labels {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      max-height: 180px;
      overflow: auto;
      padding: 2px;
    }
    #${OVERLAY_ROOT_ID} .jp-chip {
      border: 1px solid #c7c7c7;
      border-radius: 999px;
      background: #fff;
      color: #151515;
      padding: 5px 9px;
      font-size: 12px;
      cursor: pointer;
    }
    #${OVERLAY_ROOT_ID} .jp-chip:hover {
      border-color: #ee0000;
      background: #fff2f2;
    }
    #${OVERLAY_ROOT_ID} .jp-chip.selected {
      background: #ffe9e8;
      border-color: #ee0000;
      color: #7a0000;
      box-shadow: inset 0 0 0 1px rgba(238, 0, 0, 0.2);
    }
    #${OVERLAY_ROOT_ID} .jp-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    #${OVERLAY_ROOT_ID} .jp-submit {
      border: 0;
      border-radius: 8px;
      background: linear-gradient(180deg, #ee0000 0%, #c9190b 100%);
      color: #fff;
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      flex: 1;
    }
    #${OVERLAY_ROOT_ID} .jp-submit:disabled {
      background: #9a9a9a;
      cursor: not-allowed;
    }
    #${OVERLAY_ROOT_ID} .jp-clear {
      border: 1px solid #8a8d90;
      border-radius: 8px;
      background: #fff;
      color: #2f3133;
      padding: 8px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    #${OVERLAY_ROOT_ID} .jp-status {
      min-height: 16px;
      font-size: 12px;
      color: #4f5255;
      margin-top: 8px;
    }
    #${OVERLAY_ROOT_ID} .jp-severity-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    #${OVERLAY_ROOT_ID} .jp-severity-select {
      flex: 1;
      border: 1px solid #c7c7c7;
      border-radius: 8px;
      background: #fff;
      color: #151515;
      font-size: 12px;
      padding: 7px 8px;
    }
    #${OVERLAY_ROOT_ID} .jp-severity-apply {
      border: 0;
      border-radius: 8px;
      background: linear-gradient(180deg, #6a6e73 0%, #4f5255 100%);
      color: #fff;
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    #${OVERLAY_ROOT_ID} .jp-severity-apply:disabled {
      background: #9a9a9a;
      cursor: not-allowed;
    }
    #${OVERLAY_ROOT_ID} .jp-empty-config {
      display: none;
      font-size: 12px;
      color: #4f5255;
      border: 1px dashed #c7c7c7;
      border-radius: 8px;
      background: #fff;
      padding: 8px;
      margin-bottom: 8px;
    }
  `;
  document.head.appendChild(style);
}

function setOverlayStatus(root, message) {
  const statusEl = root.querySelector(".jp-status");
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function updateOverlaySubmitButton(root) {
  const submitBtn = root.querySelector(".jp-submit");
  if (!submitBtn) {
    return;
  }
  submitBtn.textContent = `Submit selected (${overlaySelectedLabels.size})`;
  submitBtn.disabled = overlaySelectedLabels.size === 0;
}

async function getOverlayComponentSettings() {
  const result = await chrome.storage.sync.get({
    [OVERLAY_SHOW_LABELS_KEY]: true,
    [OVERLAY_SHOW_SEVERITY_KEY]: false
  });
  return {
    showLabels: Boolean(result[OVERLAY_SHOW_LABELS_KEY]),
    showSeverity: Boolean(result[OVERLAY_SHOW_SEVERITY_KEY])
  };
}

function applyOverlayComponentVisibility(root, settings) {
  const labelsSection = root.querySelector(".jp-labels-section");
  const severitySection = root.querySelector(".jp-severity-section");
  const emptyConfigEl = root.querySelector(".jp-empty-config");
  const showLabels = Boolean(settings?.showLabels);
  const showSeverity = Boolean(settings?.showSeverity);

  if (labelsSection) {
    labelsSection.style.display = showLabels ? "" : "none";
  }
  if (severitySection) {
    severitySection.style.display = showSeverity ? "" : "none";
  }
  if (emptyConfigEl) {
    emptyConfigEl.style.display = showLabels || showSeverity ? "none" : "block";
  }
  ensureOverlayInViewport(root);
}

function ensureOverlayInViewport(root) {
  if (!(root instanceof HTMLElement)) {
    return;
  }
  const rect = root.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

  left = Math.min(Math.max(left, margin), maxLeft);
  top = Math.min(Math.max(top, margin), maxTop);

  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.style.right = "auto";
}

function renderOverlayLabels(root, labels) {
  const labelsEl = root.querySelector(".jp-labels");
  if (!labelsEl) {
    return;
  }

  labelsEl.innerHTML = "";
  for (const label of labels) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "jp-chip";
    chip.textContent = label;
    if (overlaySelectedLabels.has(label)) {
      chip.classList.add("selected");
    }
    chip.addEventListener("click", () => {
      if (overlaySelectedLabels.has(label)) {
        overlaySelectedLabels.delete(label);
        chip.classList.remove("selected");
      } else {
        overlaySelectedLabels.add(label);
        chip.classList.add("selected");
      }
      updateOverlaySubmitButton(root);
    });
    labelsEl.appendChild(chip);
  }
}

async function applyOverlaySelectedLabels(root) {
  if (!overlaySelectedLabels.size) {
    setOverlayStatus(root, "Select at least one label.");
    return;
  }

  setOverlayStatus(root, "Applying labels...");
  const submitBtn = root.querySelector(".jp-submit");
  if (submitBtn) {
    submitBtn.disabled = true;
  }

  try {
    const issueKey = parseIssueKeyFromLocation();
    if (!issueKey) {
      throw new Error("Could not detect issue key from this Jira URL.");
    }

    const settings = await getApiSettings();
    if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
      throw new Error("API settings missing. Configure Jira URL, email, and token in Manage labels.");
    }

    const authHeader = getApiAuthHeader(settings.jiraEmail, settings.jiraApiToken);
    const existing = await fetchIssueLabelsViaApi(settings.jiraBaseUrl, issueKey, authHeader);
    const merged = new Set(existing);
    for (const label of overlaySelectedLabels) {
      merged.add(normalizeLabel(label));
    }

    await setIssueLabelsViaApi(settings.jiraBaseUrl, issueKey, [...merged], authHeader);
    const added = [...overlaySelectedLabels].filter((label) => !existing.has(normalizeLabel(label))).length;
    overlaySelectedLabels.clear();
    updateOverlaySubmitButton(root);
    renderOverlayLabels(
      root,
      Array.from(root.querySelectorAll(".jp-chip")).map((el) => el.textContent || "").filter(Boolean)
    );
    setOverlayStatus(root, `Applied ${added} new label(s). Refreshing...`);
    location.reload();
  } catch (error) {
    setOverlayStatus(root, error.message || "Could not apply selected labels.");
  } finally {
    updateOverlaySubmitButton(root);
  }
}

async function applyOverlaySeverity(root) {
  const applyBtn = root.querySelector(".jp-severity-apply");
  const severitySelect = root.querySelector(".jp-severity-select");
  if (!(severitySelect instanceof HTMLSelectElement)) {
    return;
  }

  if (applyBtn instanceof HTMLButtonElement) {
    applyBtn.disabled = true;
  }
  setOverlayStatus(root, "Applying severity...");

  try {
    const issueKey = parseIssueKeyFromLocation();
    if (!issueKey) {
      throw new Error("Could not detect issue key from this Jira URL.");
    }

    const settings = await getApiSettings();
    if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
      throw new Error("API settings missing. Configure Jira URL, email, and token in Manage labels.");
    }

    const authHeader = getApiAuthHeader(settings.jiraEmail, settings.jiraApiToken);
    await setIssuePriorityViaApi(settings.jiraBaseUrl, issueKey, severitySelect.value, authHeader);
    setOverlayStatus(root, `Applied Jira priority: ${severitySelect.value}. Refreshing...`);
    location.reload();
  } catch (error) {
    setOverlayStatus(root, error.message || "Could not apply severity.");
  } finally {
    if (applyBtn instanceof HTMLButtonElement) {
      applyBtn.disabled = false;
    }
  }
}

function parseIssueKeyFromLocation() {
  const url = window.location.href;
  const browseMatch = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)(?:[/?#]|$)/i);
  if (browseMatch) {
    return browseMatch[1].toUpperCase();
  }

  const selectedIssueMatch = url.match(/[?&]selectedIssue=([A-Z][A-Z0-9_]+-\d+)/i);
  if (selectedIssueMatch) {
    return selectedIssueMatch[1].toUpperCase();
  }

  return null;
}

function getApiAuthHeader(email, token) {
  return `Basic ${btoa(`${email}:${token}`)}`;
}

async function getApiSettings() {
  const syncResult = await chrome.storage.sync.get({
    [JIRA_BASE_URL_KEY]: "",
    [JIRA_EMAIL_KEY]: ""
  });
  const localResult = await chrome.storage.local.get({ [JIRA_TOKEN_KEY]: "" });

  return {
    jiraBaseUrl: String(syncResult[JIRA_BASE_URL_KEY] || "").trim().replace(/\/+$/, ""),
    jiraEmail: String(syncResult[JIRA_EMAIL_KEY] || "").trim(),
    jiraApiToken: String(localResult[JIRA_TOKEN_KEY] || "").trim()
  };
}

async function fetchIssueLabelsViaApi(jiraBaseUrl, issueKey, authHeader) {
  const response = await fetch(
    `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=labels`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed reading issue labels (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const labels = Array.isArray(data?.fields?.labels) ? data.fields.labels : [];
  return new Set(labels.map((entry) => normalizeLabel(entry)).filter(Boolean));
}

async function setIssueLabelsViaApi(jiraBaseUrl, issueKey, labels, authHeader) {
  const response = await fetch(`${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader
    },
    body: JSON.stringify({
      fields: { labels }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed updating issue labels (${response.status}): ${errorText || response.statusText}`);
  }
}

async function setIssuePriorityViaApi(jiraBaseUrl, issueKey, priority, authHeader) {
  const response = await fetch(`${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader
    },
    body: JSON.stringify({
      fields: { priority: { name: priority } }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed updating issue priority (${response.status}): ${errorText || response.statusText}`);
  }
}

function makeOverlayDraggable(root) {
  if (!(root instanceof HTMLElement)) {
    return;
  }

  const header = root.querySelector(".jp-header");
  if (!(header instanceof HTMLElement)) {
    return;
  }

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const onPointerMove = (event) => {
    if (!dragging) {
      return;
    }
    const nextLeft = Math.max(4, originLeft + (event.clientX - startX));
    const nextTop = Math.max(4, originTop + (event.clientY - startY));
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
    root.style.right = "auto";
  };

  const onPointerUp = async () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    await safeStorageLocalSet({
      [getOverlayPositionStorageKey()]: {
        left: root.style.left,
        top: root.style.top
      }
    });
  };

  header.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.tagName === "BUTTON") {
      return;
    }
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = root.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  });
}

async function initOverlay(forceRebuild = false) {
  if (!document.body) {
    return;
  }
  if (forceRebuild) {
    destroyOverlay();
  } else if (document.getElementById(OVERLAY_ROOT_ID)) {
    return;
  }

  createOverlayStyles();

  const root = document.createElement("aside");
  root.id = OVERLAY_ROOT_ID;
  root.innerHTML = `
    <div class="jp-header">
      <span>Jira Palette</span>
      <button type="button" class="jp-min-toggle">Minimize</button>
    </div>
    <div class="jp-body">
      <div class="jp-empty-config">Overlay has no visible components. Enable Labels or Severity in popup Settings.</div>
      <div class="jp-section jp-labels-section">
        <div class="jp-section-title">Labels</div>
        <div class="jp-labels"></div>
        <div class="jp-actions">
          <button type="button" class="jp-submit">Submit selected (0)</button>
          <button type="button" class="jp-clear">Clear</button>
        </div>
      </div>
      <div class="jp-section jp-severity-section">
        <div class="jp-section-title">Severity</div>
        <div class="jp-severity-row">
          <select class="jp-severity-select" aria-label="Overlay Jira priority">
            <option value="Critical">Critical</option>
            <option value="Important" selected>Important</option>
            <option value="Moderate">Moderate</option>
            <option value="Low">Low</option>
            <option value="Informational">Informational</option>
          </select>
          <button type="button" class="jp-severity-apply">Apply</button>
        </div>
      </div>
      <div class="jp-status"></div>
    </div>
  `;
  document.body.appendChild(root);

  const stored = await safeStorageLocalGet({ [getOverlayPositionStorageKey()]: null });
  const position = stored[getOverlayPositionStorageKey()];
  if (position?.left && position?.top) {
    root.style.left = position.left;
    root.style.top = position.top;
    root.style.right = "auto";
  }

  const labelResult = await chrome.storage.sync.get({ [LABELS_KEY]: DEFAULT_LABELS });
  const labels = Array.isArray(labelResult[LABELS_KEY]) ? labelResult[LABELS_KEY] : DEFAULT_LABELS;
  const componentSettings = await getOverlayComponentSettings();
  applyOverlayComponentVisibility(root, componentSettings);
  ensureOverlayInViewport(root);
  renderOverlayLabels(root, labels);
  updateOverlaySubmitButton(root);

  const submitBtn = root.querySelector(".jp-submit");
  const clearBtn = root.querySelector(".jp-clear");
  const minBtn = root.querySelector(".jp-min-toggle");
  const severityApplyBtn = root.querySelector(".jp-severity-apply");

  if (submitBtn) {
    submitBtn.addEventListener("click", () => applyOverlaySelectedLabels(root));
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      overlaySelectedLabels.clear();
      renderOverlayLabels(root, labels);
      updateOverlaySubmitButton(root);
      setOverlayStatus(root, "");
    });
  }
  if (minBtn) {
    minBtn.addEventListener("click", () => {
      const minimized = root.classList.toggle("jp-minimized");
      minBtn.textContent = minimized ? "Expand" : "Minimize";
    });
  }
  if (severityApplyBtn) {
    severityApplyBtn.addEventListener("click", () => applyOverlaySeverity(root));
  }

  makeOverlayDraggable(root);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    if (changes[LABELS_KEY]) {
      const nextLabels = Array.isArray(changes[LABELS_KEY].newValue)
        ? changes[LABELS_KEY].newValue
        : DEFAULT_LABELS;
      const allowed = new Set(nextLabels);
      for (const value of Array.from(overlaySelectedLabels)) {
        if (!allowed.has(value)) {
          overlaySelectedLabels.delete(value);
        }
      }
      renderOverlayLabels(root, nextLabels);
      updateOverlaySubmitButton(root);
    }

    if (changes[OVERLAY_SHOW_LABELS_KEY] || changes[OVERLAY_SHOW_SEVERITY_KEY]) {
      applyOverlayComponentVisibility(root, {
        showLabels: changes[OVERLAY_SHOW_LABELS_KEY]
          ? Boolean(changes[OVERLAY_SHOW_LABELS_KEY].newValue)
          : Boolean(
              root.querySelector(".jp-labels-section") &&
                root.querySelector(".jp-labels-section").style.display !== "none"
            ),
        showSeverity: changes[OVERLAY_SHOW_SEVERITY_KEY]
          ? Boolean(changes[OVERLAY_SHOW_SEVERITY_KEY].newValue)
          : Boolean(
              root.querySelector(".jp-severity-section") &&
                root.querySelector(".jp-severity-section").style.display !== "none"
            )
      });
    }
  });
}

function destroyOverlay() {
  const root = document.getElementById(OVERLAY_ROOT_ID);
  if (root) {
    root.remove();
  }
  overlaySelectedLabels.clear();
}

async function applyOverlayEnabledState(forceRebuild = false) {
  const result = await chrome.storage.sync.get({ [OVERLAY_ENABLED_KEY]: true });
  const enabled = Boolean(result[OVERLAY_ENABLED_KEY]);
  if (enabled) {
    await initOverlay(forceRebuild);
  } else {
    destroyOverlay();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ADD_JIRA_LABEL") {
    return;
  }

  addJiraLabel(message.payload?.label || "")
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }
  if (OVERLAY_ENABLED_KEY in changes) {
    applyOverlayEnabledState().catch(() => {});
    return;
  }
  if (OVERLAY_SHOW_LABELS_KEY in changes || OVERLAY_SHOW_SEVERITY_KEY in changes) {
    applyOverlayEnabledState(true).catch(() => {});
  }
});

applyOverlayEnabledState().catch(() => {
  // Non-blocking: overlay failure should not break popup-driven flow.
});
