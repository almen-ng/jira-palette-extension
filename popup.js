const DEFAULT_LABELS = ["bug", "urgent", "customer", "follow-up"];
const LABELS_KEY = "labels";
const MODE_KEY = "mode";
const JIRA_BASE_URL_KEY = "jiraBaseUrl";
const JIRA_EMAIL_KEY = "jiraEmail";
const JIRA_TOKEN_KEY = "jiraApiToken";
const PRESET_PROJECT_KEY = "presetProjectKey";
const OVERLAY_ENABLED_KEY = "overlayEnabled";
const OVERLAY_SHOW_LABELS_KEY = "overlayShowLabels";
const OVERLAY_SHOW_SEVERITY_KEY = "overlayShowSeverity";
const CLAUDE_MODEL_KEY = "claudeModel";
const CLAUDE_ENDPOINT_KEY = "claudeEndpoint";
const JIRA_SEVERITY_FIELD_ID_KEY = "jiraSeverityFieldId";
const JIRA_SEVERITY_FIELD_SHAPE_KEY = "jiraSeverityFieldShape";
const SEVERITY_FIELD_MANUAL_FALLBACK_MSG =
  "Could not auto-detect a Severity custom field. Set Bug Severity custom field ID in Additional settings (e.g. customfield_12345). Severity is not written to Jira Priority.";

const labelsContainer = document.getElementById("labels");
const suggestedLabelsContainer = document.getElementById("suggestedLabels");
const labelsStatusEl = document.getElementById("labelsStatus");
const severityStatusEl = document.getElementById("severityStatus");
const settingsStatusEl = document.getElementById("settingsStatus");
const paletteTabBtn = document.getElementById("paletteTabBtn");
const settingsTabBtn = document.getElementById("settingsTabBtn");
const paletteTab = document.getElementById("paletteTab");
const settingsTab = document.getElementById("settingsTab");
const openOptionsBtn = document.getElementById("openOptions");
const refreshSuggestionsBtn = document.getElementById("refreshSuggestionsBtn");
const suggestLabelsBtn = document.getElementById("suggestLabelsBtn");
const suggestSeverityBtn = document.getElementById("suggestSeverityBtn");
const applySeverityBtn = document.getElementById("applySeverityBtn");
const submitSelectedBtn = document.getElementById("submitSelectedBtn");
const overlayToggleInput = document.getElementById("overlayToggleInput");
const overlayShowLabelsInput = document.getElementById("overlayShowLabelsInput");
const overlayShowSeverityInput = document.getElementById("overlayShowSeverityInput");
const presetLabelsInput = document.getElementById("presetLabelsInput");
const savePresetLabelsBtn = document.getElementById("savePresetLabelsBtn");
const suggestionBoxEl = document.getElementById("suggestionBox");
const severityResultEl = document.getElementById("severityResult");
const severitySelectEl = document.getElementById("severitySelect");
const selectedLabels = new Set();

async function getLabels() {
  const result = await chrome.storage.sync.get({ [LABELS_KEY]: DEFAULT_LABELS });
  const labels = Array.isArray(result[LABELS_KEY]) ? result[LABELS_KEY] : DEFAULT_LABELS;
  return labels.filter(Boolean);
}

async function getSettings() {
  const syncResult = await chrome.storage.sync.get({
    [MODE_KEY]: "auto",
    [OVERLAY_ENABLED_KEY]: true,
    [OVERLAY_SHOW_LABELS_KEY]: true,
    [OVERLAY_SHOW_SEVERITY_KEY]: false,
    [JIRA_BASE_URL_KEY]: "",
    [JIRA_EMAIL_KEY]: "",
    [PRESET_PROJECT_KEY]: "RHACM",
    [CLAUDE_MODEL_KEY]: "sonnet",
    [CLAUDE_ENDPOINT_KEY]: "http://localhost:8787/suggest-labels",
    [JIRA_SEVERITY_FIELD_ID_KEY]: "",
    [JIRA_SEVERITY_FIELD_SHAPE_KEY]: "value"
  });
  const localResult = await chrome.storage.local.get({ [JIRA_TOKEN_KEY]: "" });

  return {
    mode: syncResult[MODE_KEY] || "auto",
    overlayEnabled: Boolean(syncResult[OVERLAY_ENABLED_KEY]),
    overlayShowLabels: Boolean(syncResult[OVERLAY_SHOW_LABELS_KEY]),
    overlayShowSeverity: Boolean(syncResult[OVERLAY_SHOW_SEVERITY_KEY]),
    jiraBaseUrl: String(syncResult[JIRA_BASE_URL_KEY] || "").trim().replace(/\/+$/, ""),
    jiraEmail: String(syncResult[JIRA_EMAIL_KEY] || "").trim(),
    jiraApiToken: String(localResult[JIRA_TOKEN_KEY] || "").trim(),
    presetProjectKey: String(syncResult[PRESET_PROJECT_KEY] || "RHACM").trim().toUpperCase(),
    claudeModel: String(syncResult[CLAUDE_MODEL_KEY] || "sonnet").trim(),
    claudeEndpoint: String(syncResult[CLAUDE_ENDPOINT_KEY] || "http://localhost:8787/suggest-labels")
      .trim()
      .replace(/\/+$/, ""),
    jiraSeverityFieldId: String(syncResult[JIRA_SEVERITY_FIELD_ID_KEY] || "").trim(),
    jiraSeverityFieldShape: normalizeSeverityFieldShape(syncResult[JIRA_SEVERITY_FIELD_SHAPE_KEY])
  };
}

function normalizeSeverityFieldShape(value) {
  const s = String(value || "value").toLowerCase();
  if (s === "name" || s === "string") {
    return s;
  }
  return "value";
}

function extractCustomFieldSeverityValue(raw) {
  if (raw == null) {
    return "";
  }
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (typeof raw === "object") {
    return String(raw.value ?? raw.name ?? "").trim();
  }
  return "";
}

async function fetchJiraFields(jiraBaseUrl, authHeader) {
  const url = `${jiraBaseUrl}/rest/api/3/field`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader
    }
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to list Jira fields (${response.status}): ${errorText || response.statusText}`);
  }
  return response.json();
}

function isJiraCustomFieldDef(field) {
  if (!field || typeof field !== "object") {
    return false;
  }
  if (field.custom === true) {
    return true;
  }
  return /^customfield_\d+$/i.test(String(field.id || ""));
}

function pickSeverityCustomFieldId(fields) {
  if (!Array.isArray(fields)) {
    return "";
  }
  const custom = fields.filter(isJiraCustomFieldDef);
  const exactNames = [
    "Severity",
    "SEVERITY",
    "Bug severity",
    "Bug Severity",
    "Bug Severity Level"
  ];
  for (const want of exactNames) {
    const wantLower = want.toLowerCase();
    const hit = custom.find((f) => String(f.name || "").toLowerCase() === wantLower);
    if (hit?.id) {
      return String(hit.id).trim();
    }
  }
  const loose = custom.find((f) => /\bseverity\b/i.test(String(f.name || "")));
  if (loose?.id) {
    return String(loose.id).trim();
  }
  return "";
}

async function resolveSeverityFieldId(jiraBaseUrl, authHeader, manualId) {
  const manual = String(manualId || "").trim();
  if (manual) {
    return manual;
  }
  const fieldList = await fetchJiraFields(jiraBaseUrl, authHeader);
  const id = pickSeverityCustomFieldId(fieldList);
  if (!id) {
    throw new Error(SEVERITY_FIELD_MANUAL_FALLBACK_MSG);
  }
  return id;
}

function buildSeverityUpdateFields(severityValue, severityFieldId, severityFieldShape) {
  const trimmedId = String(severityFieldId || "").trim();
  if (!trimmedId) {
    throw new Error(SEVERITY_FIELD_MANUAL_FALLBACK_MSG);
  }
  const shape = severityFieldShape || "value";
  if (shape === "name") {
    return { [trimmedId]: { name: severityValue } };
  }
  if (shape === "string") {
    return { [trimmedId]: severityValue };
  }
  return { [trimmedId]: { value: severityValue } };
}

function setLabelsStatus(message) {
  if (labelsStatusEl) {
    labelsStatusEl.textContent = message;
  }
}

function setSeverityStatus(message) {
  if (severityStatusEl) {
    severityStatusEl.textContent = message;
  }
}

function setSettingsStatus(message) {
  if (settingsStatusEl) {
    settingsStatusEl.textContent = message;
  }
}

function setActiveTab(tabName) {
  const paletteActive = tabName === "palette";
  paletteTab.classList.toggle("active", paletteActive);
  settingsTab.classList.toggle("active", !paletteActive);
  paletteTabBtn.classList.toggle("active", paletteActive);
  settingsTabBtn.classList.toggle("active", !paletteActive);
}

function setSeverityResult(message) {
  severityResultEl.textContent = message;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setSuggestionItems(items) {
  if (!items.length) {
    suggestionBoxEl.textContent = "No specific additions detected from current guidance.";
    return;
  }
  suggestionBoxEl.innerHTML = `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function parseIssueKeyFromUrl(url) {
  if (!url) {
    return null;
  }

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

function getAuthHeader(email, token) {
  return `Basic ${btoa(`${email}:${token}`)}`;
}

async function fetchIssueLabels(jiraBaseUrl, issueKey, authHeader) {
  const url = `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=labels`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to read labels (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const labels = Array.isArray(data?.fields?.labels) ? data.fields.labels : [];
  return new Set(labels.map((entry) => String(entry || "").trim()).filter(Boolean));
}

async function fetchIssueType(jiraBaseUrl, issueKey, authHeader) {
  const url = `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuetype`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to read issue type (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  return String(data?.fields?.issuetype?.name || "").trim().toLowerCase();
}

async function fetchIssueDetails(jiraBaseUrl, issueKey, authHeader, severityFieldId = "") {
  const extra = String(severityFieldId || "").trim();
  const fieldList = extra
    ? `labels,fixVersions,issuetype,versions,${extra}`
    : "labels,fixVersions,issuetype,versions";
  const url = `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fieldList)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to read issue details (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const affectsVersions = Array.isArray(data?.fields?.versions)
    ? data.fields.versions.map((entry) => String(entry?.name || "").trim()).filter(Boolean)
    : [];
  const fields = data?.fields || {};
  let severityDisplay = "";
  if (extra) {
    severityDisplay = extractCustomFieldSeverityValue(fields[extra]);
  }
  return {
    labels: Array.isArray(fields?.labels) ? fields.labels.map((l) => String(l || "").trim()).filter(Boolean) : [],
    fixVersions: Array.isArray(fields?.fixVersions)
      ? fields.fixVersions.map((entry) => String(entry?.name || "").trim()).filter(Boolean)
      : [],
    affectsVersions,
    priorityName: severityDisplay,
    issueType: String(fields?.issuetype?.name || "").trim()
  };
}

async function setIssueLabels(jiraBaseUrl, issueKey, labels, authHeader) {
  const url = `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader
    },
    body: JSON.stringify({
      fields: {
        labels
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to set labels (${response.status}): ${errorText || response.statusText}`);
  }
}

async function setIssueSeverity(jiraBaseUrl, issueKey, severityValue, authHeader, severityFieldId, severityFieldShape) {
  const url = `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  const fields = buildSeverityUpdateFields(severityValue, severityFieldId, severityFieldShape);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader
    },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to set severity (${response.status}): ${errorText || response.statusText}`);
  }
}

async function fetchAvailableLabels(jiraBaseUrl, authHeader) {
  const labels = [];
  let startAt = 0;
  const maxResults = 100;

  for (let page = 0; page < 10; page += 1) {
    const url = `${jiraBaseUrl}/rest/api/3/label?startAt=${startAt}&maxResults=${maxResults}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Failed to read available labels (${response.status}): ${errorText || response.statusText}`);
    }

    const data = await response.json();
    const pageValues = Array.isArray(data?.values) ? data.values : [];
    labels.push(...pageValues);

    const isLast = Boolean(data?.isLast) || pageValues.length < maxResults;
    if (isLast) {
      break;
    }

    startAt += maxResults;
  }

  return uniqueLabelsByKey(labels);
}

async function fetchProjectIssueTypeLabels(jiraBaseUrl, authHeader, projectKey) {
  const counts = new Map();
  const displayByKey = new Map();
  let startAt = 0;
  const maxResults = 100;
  const maxPages = 10;
  const jql = `project = "${projectKey}" AND issuetype in (Story, Task, Epic) AND labels is not EMPTY ORDER BY updated DESC`;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      jql,
      startAt: String(startAt),
      maxResults: String(maxResults),
      fields: "labels"
    });
    const response = await fetch(`${jiraBaseUrl}/rest/api/3/search/jql?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to read ${projectKey} Story/Task/Epic labels (${response.status}): ${errorText || response.statusText}`
      );
    }

    const data = await response.json();
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    for (const issue of issues) {
      const labels = Array.isArray(issue?.fields?.labels) ? issue.fields.labels : [];
      for (const label of labels) {
        const rawLabel = String(label || "").trim();
        const key = labelKey(rawLabel);
        if (!key) {
          continue;
        }
        if (!displayByKey.has(key)) {
          displayByKey.set(key, rawLabel);
        }
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    startAt += maxResults;
    if (startAt >= Number(data?.total || 0) || issues.length < maxResults) {
      break;
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => displayByKey.get(key))
    .filter(Boolean);
}

function extractSimilarityTerms(context) {
  const source = [context?.summary, context?.description, context?.title]
    .join(" ")
    .toLowerCase();

  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "into",
    "when",
    "then",
    "jira",
    "acm",
    "task",
    "story",
    "epic"
  ]);

  const counts = new Map();
  for (const token of source.split(/[^a-z0-9]+/g)) {
    if (token.length < 4 || stopWords.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([term]) => term);
}

async function fetchSimilarIssueLabels(jiraBaseUrl, authHeader, projectKey, issueKey, context) {
  const terms = extractSimilarityTerms(context);
  if (!terms.length) {
    return [];
  }

  const textClause = terms
    .map((term) => `text ~ "\\\"${term}\\\""`)
    .join(" OR ");
  const whereClauses = [
    `project = "${projectKey}"`,
    "issuetype in (Story, Task, Epic)",
    "labels is not EMPTY",
    issueKey ? `key != "${issueKey}"` : "",
    `(${textClause})`
  ]
    .filter(Boolean)
    .join(" AND ");
  const jql = `${whereClauses} ORDER BY updated DESC`;

  const params = new URLSearchParams({
    jql,
    startAt: "0",
    maxResults: "50",
    fields: "labels"
  });
  const response = await fetch(`${jiraBaseUrl}/rest/api/3/search/jql?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to read similar ${projectKey} issues (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const counts = new Map();
  const displayByKey = new Map();
  for (const issue of issues) {
    const labels = Array.isArray(issue?.fields?.labels) ? issue.fields.labels : [];
    for (const label of labels) {
      const rawLabel = String(label || "").trim();
      const key = labelKey(rawLabel);
      if (!key) {
        continue;
      }
      if (!displayByKey.has(key)) {
        displayByKey.set(key, rawLabel);
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => displayByKey.get(key))
    .filter(Boolean);
}

function labelKey(label) {
  return String(label || "").trim().toLowerCase();
}

/** Merge for PUT labels: keep Jira/API casing; dedupe only by case-insensitive key. */
function mergeIssueLabelsPreserveCasing(existingLabels, selectedLabelsIterable) {
  const out = [];
  const seen = new Set();
  for (const l of existingLabels) {
    const raw = String(l || "").trim();
    const key = labelKey(raw);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(raw);
  }
  for (const label of selectedLabelsIterable) {
    const raw = String(label || "").trim();
    const key = labelKey(raw);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function uniqueLabelsByKey(labels) {
  const byKey = new Map();
  for (const label of labels) {
    const rawLabel = String(label || "").trim();
    const key = labelKey(rawLabel);
    if (!key || byKey.has(key)) {
      continue;
    }
    byKey.set(key, rawLabel);
  }
  return [...byKey.values()];
}

function updateSubmitButtonState() {
  const count = selectedLabels.size;
  submitSelectedBtn.textContent = `Submit selected (${count})`;
  submitSelectedBtn.disabled = count === 0;
}

function toggleSelectedLabel(label) {
  if (selectedLabels.has(label)) {
    selectedLabels.delete(label);
  } else {
    selectedLabels.add(label);
  }
  updateSubmitButtonState();
}

function renderLabelButtons(container, labels) {
  container.innerHTML = "";
  for (const label of labels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `label-btn${selectedLabels.has(label) ? " selected" : ""}`;
    button.textContent = label;
    button.addEventListener("click", () => {
      toggleSelectedLabel(label);
      button.classList.toggle("selected", selectedLabels.has(label));
    });
    container.appendChild(button);
  }
}

function renderSuggestedLabels(labels) {
  renderLabelButtons(suggestedLabelsContainer, labels);
}

async function extractJiraContext(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pickText = (selectors) => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const text = el?.textContent?.trim();
          if (text) {
            return text;
          }
        }
        return "";
      };

      const summary = pickText([
        '[data-testid="issue.views.issue-base.foundation.summary.heading"]',
        '[data-testid*="summary"]',
        "#summary-val",
        "h1"
      ]);
      const description = pickText([
        '[data-testid="issue.views.field.rich-text.description"]',
        '[data-testid*="description"]',
        "#description-val",
        '[aria-label="Description"]'
      ]);

      const keyFromPage = pickText([
        '[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]',
        '[data-testid*="issue-key"]'
      ]);
      const issueType = pickText([
        '[data-testid="issue.views.field.issuetype"] [data-testid*="issue-type"]',
        '[data-testid*="issue.views.field.issuetype"]',
        '[id*="issuetype-val"]'
      ]);

      return {
        url: window.location.href,
        title: document.title || "",
        issueKey: keyFromPage,
        issueType,
        summary,
        description
      };
    }
  });

  return result || null;
}

function parseSuggestedLabelsFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return [];
  }

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) {
        return arr;
      }
    } catch (_error) {
      // Fall through to line parsing.
    }
  }

  return raw
    .split(/\n|,/g)
    .map((entry) => entry.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
}

function pickFallbackLabelsFromExisting(context, allowedLabels) {
  const issueText = [context.issueKey, context.summary, context.description, context.title]
    .join(" ")
    .toLowerCase();
  const tokens = new Set(issueText.split(/[^a-z0-9]+/g).filter((token) => token.length > 2));

  const scored = allowedLabels.map((label) => {
    const parts = label.split(/[-_.]/g).filter(Boolean);
    let score = 0;
    for (const part of parts) {
      if (tokens.has(part)) {
        score += 2;
      } else if (issueText.includes(part)) {
        score += 1;
      }
    }
    return { label, score };
  });

  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored
    .filter((entry) => entry.score > 0)
    .slice(0, 10)
    .map((entry) => entry.label);
}

const QE_CONFIDENCE_LABELS = ["QE-Confidence:Green", "QE-Confidence:Yellow", "QE-Confidence:Red"];

/** Preferred order when merging project labels into Claude candidates (must exist on the project). */
const QE_LABEL_CANDIDATE_HINTS = [
  "QE-ACM",
  "QE-Required",
  "QE-NotApplicable",
  ...QE_CONFIDENCE_LABELS
];

function hasQeConfidenceLabel(labels) {
  return labels.some((l) => /^qe-confidence:/i.test(String(l || "").trim()));
}

function hasQeAcmLabel(labels) {
  return labels.some((l) => labelKey(l) === "qe-acm");
}

function hasQeRequiredLabel(labels) {
  return labels.some((l) => labelKey(l) === "qe-required");
}

function hasQeNotApplicableLabel(labels) {
  return labels.some((l) => labelKey(l) === "qe-notapplicable");
}

function hasQeRequiredOrNotApplicable(labels) {
  return hasQeRequiredLabel(labels) || hasQeNotApplicableLabel(labels);
}

/** Drop conflicting QE-Required / QE-NotApplicable from suggestions vs existing issue labels. */
function applyQeRequiredNotApplicableGuards(suggested, existingLabels) {
  const existing = Array.isArray(existingLabels) ? existingLabels : [];
  let out = suggested.filter((l) => {
    const k = labelKey(l);
    if (hasQeRequiredLabel(existing) && k === "qe-notapplicable") {
      return false;
    }
    if (hasQeNotApplicableLabel(existing) && k === "qe-required") {
      return false;
    }
    return true;
  });
  const idxReq = out.findIndex((l) => labelKey(l) === "qe-required");
  const idxNa = out.findIndex((l) => labelKey(l) === "qe-notapplicable");
  if (idxReq !== -1 && idxNa !== -1) {
    const dropNotApplicable = idxReq < idxNa;
    out = out.filter((l) => {
      const k = labelKey(l);
      if (dropNotApplicable && k === "qe-notapplicable") {
        return false;
      }
      if (!dropNotApplicable && k === "qe-required") {
        return false;
      }
      return true;
    });
  }
  return out;
}

function issueTextSuggestsQeScope(summary, description, title) {
  const text = [summary, description, title].join(" ").toLowerCase();
  if (/\bqe\b/.test(text) || /\bquality engineering\b/.test(text)) {
    return true;
  }
  if (/\bqe[- ]task\b/.test(text) || /\btest automation\b/.test(text)) {
    return true;
  }
  if (/\bregression\b/.test(text) && /\b(test|qe)\b/.test(text)) {
    return true;
  }
  if (/\be2e\b/.test(text) || /\binterop\b/.test(text) || /\btest plan\b/.test(text)) {
    return true;
  }
  return false;
}

function mergeQeHintsIntoCandidates(candidateLabels, ...pools) {
  const flat = pools.flat().filter(Boolean);
  const pool = uniqueLabelsByKey([...flat, ...candidateLabels]);
  const poolByKey = new Map(pool.map((l) => [labelKey(l), l]));
  const seen = new Set(candidateLabels.map((l) => labelKey(l)));
  const extra = [];
  for (const hint of QE_LABEL_CANDIDATE_HINTS) {
    const k = labelKey(hint);
    if (poolByKey.has(k) && !seen.has(k)) {
      extra.push(poolByKey.get(k));
      seen.add(k);
    }
  }
  return [...extra, ...candidateLabels];
}

const DELIVERY_SUGGESTION_GUIDELINES = [
  "Guidelines for what to add or set on the issue:",
  "1) cross-squad: If work involves multiple squads working concurrently, recommend adding label cross-squad.",
  "   Do NOT recommend cross-squad when it is only a dependency between components/squads (coordination handled between squads; no label needed).",
  "2) Early preview features: recommend dev-preview (development preview, no QE) OR tech-preview (technical preview, QE as needed)—pick the better fit from the issue text.",
  "3) Delivery Train: recommend setting the appropriate Train label for when the issue will be resolved and included.",
  "4) Fix Version/s: be intentional about which product/release the issue is delivered in; recommend specific fix version(s) when missing or unclear.",
  "5) spike: For investigation work where a Spike issue/task does not fit well (e.g. multi-squad investigation, not prescriptive on sprint), recommend label spike (including on Epic when appropriate).",
  "   Do NOT recommend label spike when the issue type is already Spike (redundant).",
  "6) side-train: If dev runs parallel to the train but content is not being delivered into an ACM release, recommend label side-train.",
  "7) ONLY when issue type is Epic: Epic – Reporting Epic Status (Engineering) — set the Color Status field to Green, Yellow, or Red based on current progress / engineering status:",
  "   Green = On track; Yellow = At risk to miss Train; Red = At high risk to miss Train or re-plan required.",
  "   For non-Epic issues, ignore this rule entirely (do not suggest Color Status).",
  "8) Story – Engineering status: use labels (exact text): `Eng-Status:Green` (on track), `Eng-Status:Yellow` (at risk to miss Train), `Eng-Status:Red` (high risk / re-plan).",
  "   Pick the label that matches the story’s status; only one primary Eng-Status label should apply.",
  "   EXCEPTION — Do NOT recommend Eng-Status labels if the issue is QE-related: issue type name indicates QE work (e.g. QE Task), OR the issue has label `qe` or a label clearly scoped to QE (e.g. starts with `qe-` or `qe:`).",
  "9) Bug: set Affects Version/s (which releases are impacted) and set the **Severity** field (Critical, Important, Moderate, Low, Informational)—not Jira system Priority unless your project maps them the same.",
  "10) QE — QE-ACM: For Epic, Story, or Sub-task that is QE team–specific work, recommend label `QE-ACM`. For Tasks raised under product Stories that require QE work (including automation that adds this label), recommend `QE-ACM` when that policy applies.",
  "11) QE — Confidence (Epics and Stories): Exactly one of `QE-Confidence:Green` (QE on track for the train), `QE-Confidence:Yellow` (some risk of missing the train; mitigation in progress), or `QE-Confidence:Red` (high risk of missing the train; corrective discussion needed).",
  "12) QE — Required vs not applicable (Stories; Epics follow the same policy when applicable): The issue MUST have exactly one of `QE-Required` (QE effort is needed) OR `QE-NotApplicable` (no QE effort; label by Engineering or QE no later than sprint planning). Never recommend both; if one is already on the issue, do not suggest the other. Use summary/description to choose when obvious (e.g. explicit no-QE / docs-only vs needs validation)."
].join("\n");

function parseSuggestionBoxFromClaude(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return [];
  }

  const tryParse = (slice) => {
    try {
      const arr = JSON.parse(slice);
      if (!Array.isArray(arr)) {
        return null;
      }
      const out = arr
        .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry || "").trim()))
        .filter(Boolean);
      return out.length ? out : null;
    } catch (_e) {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) {
    return direct.slice(0, 18);
  }

  const blockMatch = raw.match(/\[[\s\S]*\]/);
  if (blockMatch) {
    const fromBlock = tryParse(blockMatch[0]);
    if (fromBlock) {
      return fromBlock.slice(0, 18);
    }
  }

  return raw
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 18);
}

function buildSuggestionBoxPrompt(context, details, issueKey) {
  const qeRelated = isQeRelatedIssue({
    issueType: details.issueType || context?.issueType,
    labels: details.labels
  });
  const isSpikeIssueType =
    String(details.issueType || context?.issueType || "")
      .trim()
      .toLowerCase() === "spike";
  const isEpicIssueType =
    String(details.issueType || context?.issueType || "")
      .trim()
      .toLowerCase() === "epic";
  return [
    "You triage a Jira issue for delivery hygiene. Output ONLY a JSON array of strings.",
    "Each string is one concise, actionable recommendation (label names in backticks when referring to labels, e.g. `cross-squad`).",
    "Do not include markdown fences or commentary outside the JSON array. Max 14 items.",
    "If the issue already satisfies a guideline (label or fix version already set), you may skip that item or note it briefly.",
    qeRelated
      ? "This issue is QE-related — do NOT suggest Eng-Status:* labels or engineering-train status labels meant for dev stories."
      : "",
    isSpikeIssueType ? "Issue type is already Spike — do NOT recommend adding the `spike` label." : "",
    isEpicIssueType
      ? ""
      : "Issue type is not Epic — do NOT suggest Epic Color Status or “Reporting Epic Status” field changes.",
    "",
    DELIVERY_SUGGESTION_GUIDELINES,
    "",
    `QE-related (exclude Eng-Status suggestions if true): ${qeRelated ? "yes" : "no"}`,
    `Issue type is Spike (exclude spike label suggestions if true): ${isSpikeIssueType ? "yes" : "no"}`,
    `Issue type is Epic (Epic Color Status guideline applies only if true): ${isEpicIssueType ? "yes" : "no"}`,
    `Story or Epic: has QE-Required or QE-NotApplicable: ${hasQeRequiredOrNotApplicable(details.labels || []) ? "yes" : "no"}`,
    "",
    `Issue key: ${issueKey}`,
    `Issue type (Jira): ${details.issueType || context?.issueType || "unknown"}`,
    "If issue type is Spike, do not recommend the `spike` label (already a Spike).",
    `Summary/title: ${context?.summary || context?.title || ""}`,
    `Description: ${context?.description || ""}`,
    "",
    `Current labels on issue: ${JSON.stringify(details.labels)}`,
    `Current Fix Version/s: ${JSON.stringify(details.fixVersions)}`,
    `Current Affects Version/s: ${JSON.stringify(details.affectsVersions || [])}`,
    `Current Severity field value: ${details.priorityName || "(none)"}`
  ]
    .filter(Boolean)
    .join("\n");
}

async function requestClaudeSuggestionBox(context, settings, details, issueKey) {
  if (!settings.claudeEndpoint) {
    throw new Error("Local Claude endpoint is missing.");
  }

  const prompt = buildSuggestionBoxPrompt(context, details, issueKey);
  const response = await fetch(settings.claudeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      mode: "suggestion-box",
      model: settings.claudeModel || "sonnet",
      prompt,
      context: {
        issueKey,
        title: context?.summary || context?.title || "",
        description: context?.description || "",
        url: context?.url || ""
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Suggestion box Claude request failed (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();
  const text = String(data?.text || data?.response || "").trim();
  const items = parseSuggestionBoxFromClaude(text);
  if (!items.length) {
    throw new Error("Claude returned no parseable suggestion list.");
  }
  return items;
}

function hasEngStatusLabel(labels) {
  return labels.some((l) => /^eng-status:/i.test(String(l || "").trim()));
}

function isQeRelatedIssue({ issueType, labels }) {
  const typeNorm = String(issueType || "")
    .trim()
    .toLowerCase();
  if (typeNorm && /\bqe\b/.test(typeNorm)) {
    return true;
  }
  for (const raw of labels || []) {
    const lab = String(raw || "").trim().toLowerCase();
    if (lab === "qe" || lab.startsWith("qe:")) {
      return true;
    }
    if (lab.startsWith("qe-")) {
      if (
        lab === "qe-required" ||
        lab === "qe-notapplicable" ||
        lab === "qe-acm" ||
        lab.startsWith("qe-confidence:")
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function buildGuidelineSuggestions({ context, labels, fixVersions, affectsVersions, priorityName, issueType }) {
  const typeNorm = String(issueType || context?.issueType || "")
    .trim()
    .toLowerCase();
  const issueText = [context?.summary, context?.description, context?.title]
    .join(" ")
    .toLowerCase();
  const labelSet = new Set(labels.map((l) => String(l || "").trim().toLowerCase()));
  const suggestions = [];
  const qeRelated = isQeRelatedIssue({ issueType: issueType || context?.issueType, labels });

  const hasAny = (terms) => terms.some((term) => issueText.includes(term));
  const hasCrossSquadSignal = hasAny(["cross-squad", "cross squad", "multiple squads", "multi-squad", "multi squad"]);
  const hasDependencyOnlySignal = hasAny(["dependency on", "depends on", "blocked by", "waiting on"]);
  if (hasCrossSquadSignal && !hasDependencyOnlySignal && !labelSet.has("cross-squad")) {
    suggestions.push('Add label `cross-squad` (multiple squads working concurrently).');
  }

  const hasDevPreviewSignal = hasAny(["dev preview", "development preview"]);
  const hasTechPreviewSignal = hasAny(["tech preview", "technical preview"]);
  if (hasDevPreviewSignal && !labelSet.has("dev-preview")) {
    suggestions.push("Add label `dev-preview` (Development preview, no QE).");
  }
  if (hasTechPreviewSignal && !labelSet.has("tech-preview")) {
    suggestions.push("Add label `tech-preview` (Technical preview, QE as needed).");
  }
  if (hasAny(["early preview", "preview feature"]) && !hasDevPreviewSignal && !hasTechPreviewSignal) {
    suggestions.push("Early preview detected. Choose one label: `dev-preview` or `tech-preview`.");
  }

  const hasTrainLabel = [...labelSet].some((label) => label.includes("train"));
  if (!hasTrainLabel) {
    suggestions.push("Set the Delivery Train label for planned resolution/inclusion.");
  }

  if (!fixVersions.length) {
    suggestions.push("Set `Fix Version/s` intentionally for the product release target.");
  }

  const hasSpikeSignal = hasAny(["spike", "investigation", "investigate", "research"]);
  if (hasSpikeSignal && typeNorm !== "spike" && !labelSet.has("spike")) {
    suggestions.push("Add label `spike` for investigation work not tied to a prescriptive sprint plan.");
  }

  const hasSideTrainSignal = hasAny(["side-train", "side train", "not being delivered into acm release", "outside acm release"]);
  if (hasSideTrainSignal && !labelSet.has("side-train")) {
    suggestions.push("Add label `side-train` (parallel to train, not delivered in ACM release).");
  }

  if (typeNorm === "epic") {
    suggestions.push(
      "Epic – Reporting Epic Status (Engineering): set **Color Status** to Green, Yellow, or Red based on current progress (Green = on track; Yellow = at risk to miss Train; Red = high risk / re-plan required)."
    );
  }

  if (typeNorm === "story" && !qeRelated && !hasEngStatusLabel(labels)) {
    suggestions.push(
      "Story: set one engineering status label — `Eng-Status:Green`, `Eng-Status:Yellow`, or `Eng-Status:Red` — matching on-track / at-risk / high-risk."
    );
  }

  if (typeNorm === "bug") {
    const av = Array.isArray(affectsVersions) ? affectsVersions : [];
    if (!av.length) {
      suggestions.push("Bug: set **Affects Version/s** for impacted releases.");
    }
    const pri = String(priorityName || "").trim();
    if (!pri) {
      suggestions.push(
        "Bug: set **Severity** field (Critical, Important, Moderate, Low, Informational)."
      );
    }
  }

  const qeScope = qeRelated || issueTextSuggestsQeScope(context?.summary, context?.description, context?.title);
  const qeAcmTypes = new Set(["epic", "story", "sub-task", "subtask", "task"]);
  if (qeAcmTypes.has(typeNorm) && qeScope && !hasQeAcmLabel(labels)) {
    suggestions.push(
      "QE: add `QE-ACM` if this issue is QE team–specific work (Epic/Story/Sub-task), or a Task under a Story that requires QE."
    );
  }
  if ((typeNorm === "epic" || typeNorm === "story") && qeScope && !hasQeConfidenceLabel(labels)) {
    suggestions.push(
      "QE: set one `QE-Confidence:Green`, `QE-Confidence:Yellow`, or `QE-Confidence:Red` for train/release confidence (Epic/Story)."
    );
  }

  if (typeNorm === "story" || typeNorm === "epic") {
    if (!hasQeRequiredOrNotApplicable(labels)) {
      suggestions.push(
        "QE: set exactly one of `QE-Required` or `QE-NotApplicable` (QE effort needed vs not; Engineering/QE by sprint planning)."
      );
    }
  }

  return suggestions;
}

async function refreshSuggestionBox() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setSuggestionItems(["Open a Jira issue tab to generate suggestions."]);
    return;
  }

  refreshSuggestionsBtn.disabled = true;
  setSuggestionItems(["Generating suggestions with Claude…"]);
  try {
    const context = await extractJiraContext(tab.id);
    const settings = await getSettings();
    const issueKey = context?.issueKey || parseIssueKeyFromUrl(tab.url || "");
    if (!issueKey) {
      setSuggestionItems(["Could not detect issue key from this tab."]);
      return;
    }

    if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
      setSuggestionItems([
        "Configure Jira API URL/email/token in Additional settings to analyze labels and Fix Version/s."
      ]);
      return;
    }

    const authHeader = getAuthHeader(settings.jiraEmail, settings.jiraApiToken);
    let severityFieldId = "";
    try {
      severityFieldId = await resolveSeverityFieldId(
        settings.jiraBaseUrl,
        authHeader,
        settings.jiraSeverityFieldId
      );
    } catch (_resolveErr) {
      severityFieldId = "";
    }
    const details = await fetchIssueDetails(
      settings.jiraBaseUrl,
      issueKey,
      authHeader,
      severityFieldId
    );
    const fallback = buildGuidelineSuggestions({
      context,
      labels: details.labels,
      fixVersions: details.fixVersions,
      affectsVersions: details.affectsVersions,
      priorityName: details.priorityName,
      issueType: details.issueType
    });

    if (!settings.claudeEndpoint) {
      setSuggestionItems([
        "Set Local Claude endpoint in Additional settings (and run local-claude-bridge) for AI suggestion box.",
        ...fallback
      ]);
      return;
    }

    try {
      const fromClaude = await requestClaudeSuggestionBox(context, settings, details, issueKey);
      const qeRel = isQeRelatedIssue({ issueType: details.issueType, labels: details.labels });
      setSuggestionItems(
        qeRel
          ? fromClaude.filter((line) => !/eng-status:/i.test(String(line || "")))
          : fromClaude
      );
    } catch (_claudeError) {
      setSuggestionItems([
        `Claude suggestion failed (${_claudeError.message || "unknown"}). Rules-based fallback:`,
        ...fallback
      ]);
    }
  } catch (error) {
    setSuggestionItems([error.message || "Could not analyze issue suggestions."]);
  } finally {
    refreshSuggestionsBtn.disabled = false;
  }
}

async function requestClaudeLabelSuggestions(context, settings, allowedLabels, issueDetails) {
  if (!settings.claudeEndpoint) {
    throw new Error("Local Claude endpoint is missing. Add it in Additional settings.");
  }

  const details = issueDetails || {};
  const typeLine = details.issueType || context.issueType || "unknown";
  const onIssue = Array.isArray(details.labels) ? details.labels : [];
  const qeRelated = isQeRelatedIssue({
    issueType: details.issueType || context.issueType,
    labels: details.labels
  });
  const isSpikeIssueType = String(details.issueType || context.issueType || "")
    .trim()
    .toLowerCase() === "spike";
  const isEpicIssueType = String(details.issueType || context.issueType || "")
    .trim()
    .toLowerCase() === "epic";

  const prompt = [
    "You suggest Jira labels for an issue.",
    "Only use labels from ALLOWED_LABELS.",
    "Return only a JSON array of 5-10 labels.",
    "Copy each label EXACTLY as it appears in ALLOWED_LABELS (same case and punctuation).",
    "No explanations.",
    "",
    "Prioritize labels that fit the issue AND align with DELIVERY GUIDELINES when possible.",
    "Some guidelines are about Jira fields (Fix Version/s, Affects Version/s, Priority)—do not invent field values; still pick labels from ALLOWED_LABELS that match the situation. Epic Color Status applies only when issue type is Epic (not a label).",
    qeRelated
      ? "QE-related issue (QE issue type or label qe / qe-* / qe:*): do NOT suggest any `Eng-Status:*` labels even if they appear in ALLOWED_LABELS."
      : "Examples: concurrent multi-squad work (not dependency-only) → `cross-squad` if in list; Story status → `Eng-Status:Green`, `Eng-Status:Yellow`, or `Eng-Status:Red` if in list; previews → `dev-preview` or `tech-preview`; train / side-train / spike when the text matches and the label exists in ALLOWED_LABELS.",
    "QE labels (when scope fits AND the label appears in ALLOWED_LABELS): `QE-ACM` for QE-owned Epic/Story/Sub-task or Tasks tied to Stories requiring QE; exactly one `QE-Confidence:Green|Yellow|Red` for Epic/Story when QE train confidence applies; for Story or Epic, exactly one of `QE-Required` OR `QE-NotApplicable` when neither is on the issue—never both; use text to choose (QE-NotApplicable = no QE effort per policy).",
    "",
    DELIVERY_SUGGESTION_GUIDELINES,
    "",
    `QE-related (never suggest Eng-Status if yes): ${qeRelated ? "yes" : "no"}`,
    `QE scope by text (QE-ACM / Confidence): ${
      issueTextSuggestsQeScope(context.summary, context.description, context.title) || qeRelated ? "yes" : "no"
    }`,
    `Story or Epic: QE-Required / QE-NotApplicable already on issue: ${hasQeRequiredOrNotApplicable(onIssue) ? "yes" : "no"}`,
    `Issue type is Spike (do not suggest label spike): ${isSpikeIssueType ? "yes" : "no"}`,
    `Issue type is Epic (Color Status / epic reporting applies only if yes): ${isEpicIssueType ? "yes" : "no"}`,
    "",
    `Issue key: ${context.issueKey || parseIssueKeyFromUrl(context.url) || "unknown"}`,
    `Issue type: ${typeLine}`,
    `Issue title: ${context.summary || context.title || ""}`,
    `Issue description: ${context.description || ""}`,
    "",
    `Labels already on this issue (do not suggest duplicates): ${JSON.stringify(onIssue)}`,
    `Fix Version/s: ${JSON.stringify(details.fixVersions || [])}`,
    `Affects Version/s: ${JSON.stringify(details.affectsVersions || [])}`,
    `Severity field (current): ${details.priorityName || "(unset)"}`,
    "",
    `ALLOWED_LABELS: ${JSON.stringify(allowedLabels.slice(0, 500))}`
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(settings.claudeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.claudeModel || "sonnet",
      prompt,
      context: {
        issueKey: context.issueKey || parseIssueKeyFromUrl(context.url) || "unknown",
        title: context.summary || context.title || "",
        description: context.description || "",
        url: context.url || ""
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Local Claude request failed (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();
  const text = Array.isArray(data?.labels)
    ? JSON.stringify(data.labels)
    : String(data?.text || data?.response || "");

  const allowedByKey = new Map();
  for (const allowed of allowedLabels) {
    const rawAllowed = String(allowed || "").trim();
    const key = labelKey(rawAllowed);
    if (key && !allowedByKey.has(key)) {
      allowedByKey.set(key, rawAllowed);
    }
  }

  const matched = [];
  const seen = new Set();
  for (const suggested of parseSuggestedLabelsFromText(text)) {
    const key = labelKey(suggested);
    if (!key || seen.has(key) || !allowedByKey.has(key)) {
      continue;
    }
    const canonical = allowedByKey.get(key);
    if (qeRelated && /^eng-status:/i.test(String(canonical || "").trim())) {
      continue;
    }
    if (isSpikeIssueType && key === "spike") {
      continue;
    }
    seen.add(key);
    matched.push(canonical);
    if (matched.length >= 10) {
      break;
    }
  }
  return matched;
}

async function suggestLabels() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setLabelsStatus("No active Jira tab.");
    return;
  }

  setLabelsStatus("Generating suggestions...");
  suggestLabelsBtn.disabled = true;

  try {
    const settings = await getSettings();
    const context = await extractJiraContext(tab.id);
    if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
      throw new Error("Configure Jira API URL, email, and token to suggest existing labels.");
    }

    const issueKey = context?.issueKey || parseIssueKeyFromUrl(context?.url || "");
    if (!issueKey) {
      throw new Error("Could not detect issue key for this Jira tab.");
    }

    const authHeader = getAuthHeader(settings.jiraEmail, settings.jiraApiToken);
    let severityFieldId = "";
    try {
      severityFieldId = await resolveSeverityFieldId(
        settings.jiraBaseUrl,
        authHeader,
        settings.jiraSeverityFieldId
      );
    } catch (_resolveErr) {
      severityFieldId = "";
    }
    const [similarLabels, projectLabels, issueDetails] = await Promise.all([
      fetchSimilarIssueLabels(
        settings.jiraBaseUrl,
        authHeader,
        settings.presetProjectKey || "ACM",
        issueKey,
        context
      ),
      fetchProjectIssueTypeLabels(settings.jiraBaseUrl, authHeader, settings.presetProjectKey || "ACM"),
      fetchIssueDetails(settings.jiraBaseUrl, issueKey, authHeader, severityFieldId)
    ]);
    const issueLabelKeys = new Set(issueDetails.labels.map((label) => labelKey(label)));
    const mergedRanked = uniqueLabelsByKey([...similarLabels, ...projectLabels]);
    let candidateLabels = mergedRanked.filter((label) => !issueLabelKeys.has(labelKey(label)));

    // Fallback to global label list only if project-scoped result is empty.
    let globalLabelsForQePool = [];
    if (!candidateLabels.length) {
      globalLabelsForQePool = await fetchAvailableLabels(settings.jiraBaseUrl, authHeader);
      candidateLabels = globalLabelsForQePool.filter((label) => !issueLabelKeys.has(labelKey(label)));
    }

    candidateLabels = mergeQeHintsIntoCandidates(
      candidateLabels,
      projectLabels,
      similarLabels,
      globalLabelsForQePool
    );

    if (!candidateLabels.length) {
      throw new Error("No existing Jira labels available to suggest.");
    }

    let suggestions = await requestClaudeLabelSuggestions(context, settings, candidateLabels, issueDetails);
    if (!suggestions.length) {
      suggestions = pickFallbackLabelsFromExisting(context, candidateLabels);
    }
    suggestions = applyQeRequiredNotApplicableGuards(suggestions, issueDetails.labels);
    if (isQeRelatedIssue({ issueType: issueDetails.issueType, labels: issueDetails.labels })) {
      suggestions = suggestions.filter((label) => !/^eng-status:/i.test(String(label || "").trim()));
    }
    if (String(issueDetails.issueType || "").trim().toLowerCase() === "spike") {
      suggestions = suggestions.filter((label) => labelKey(label) !== "spike");
    }

    renderSuggestedLabels(suggestions);
    setLabelsStatus(
      suggestions.length
        ? `Suggested labels ready from similar ${settings.presetProjectKey || "ACM"} work.`
        : "No suggestions returned."
    );
  } catch (error) {
    setLabelsStatus(error.message || "Could not generate suggestions.");
  } finally {
    suggestLabelsBtn.disabled = false;
  }
}

function getSeveritySuggestion(context) {
  const text = [context?.summary, context?.description, context?.title].join(" ").toLowerCase();

  const criticalSignals = [
    "stop ship",
    "hang",
    "freeze",
    "requires restart",
    "restart required",
    "data loss",
    "data corruption",
    "corrupt",
    "wrong data",
    "harm"
  ];
  const importantSignals = [
    "major impact",
    "cannot uninstall",
    "uninstall",
    "cleanup",
    "serviceability",
    "missing documentation",
    "inaccurate documentation",
    "docs missing"
  ];
  const moderateSignals = [
    "usability",
    "user experience",
    "ux"
  ];
  const lowSignals = [
    "cosmetic",
    "layout",
    "spacing",
    "alignment"
  ];
  const informationalSignals = [
    "grammar",
    "spelling",
    "wording",
    "minor documentation"
  ];

  const hasSignal = (signals) => signals.some((signal) => text.includes(signal));
  if (hasSignal(criticalSignals)) {
    return {
      priority: "Critical",
      rationale: "Matched stop-ship/data-loss/hang/restart-risk indicators."
    };
  }
  if (hasSignal(importantSignals)) {
    return {
      priority: "Important",
      rationale: "Matched major feature impact/serviceability/documentation-impact indicators."
    };
  }
  if (hasSignal(informationalSignals)) {
    return {
      priority: "Informational",
      rationale: "Matched minor documentation refinement/grammar/spelling indicators."
    };
  }
  if (hasSignal(lowSignals)) {
    return {
      priority: "Low",
      rationale: "Matched cosmetic UI/layout indicators."
    };
  }
  if (hasSignal(moderateSignals)) {
    return {
      priority: "Moderate",
      rationale: "Matched usability-impact indicators."
    };
  }

  return {
    priority: "Important",
    rationale:
      "No explicit stop-ship, cosmetic-only, or minor-doc signals were found, so this is treated as potentially feature-impacting and set to Important."
  };
}

function parseClaudeSeverityPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (!objectMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(objectMatch[0]);
    const priority = String(parsed?.priority ?? parsed?.severity ?? "").trim();
    const reason = String(parsed?.reason || "").trim();
    if (!priority) {
      return null;
    }
    return { priority, reason };
  } catch (_error) {
    return null;
  }
}

function normalizePriority(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "critical") return "Critical";
  if (normalized === "important") return "Important";
  if (normalized === "moderate") return "Moderate";
  if (normalized === "low") return "Low";
  if (normalized === "informational" || normalized === "info") return "Informational";
  return "";
}

async function requestClaudeSeveritySuggestion(context, settings) {
  if (!settings.claudeEndpoint) {
    throw new Error("Local Claude endpoint is missing. Add it in Additional settings.");
  }

  const prompt = [
    "You are suggesting the Severity custom field value for a BUG issue (not Jira system Priority).",
    "Use only one of these exact severity values: Critical, Important, Moderate, Low, Informational.",
    "Guidelines:",
    "- Critical: stop ship, hang, requires restart, data loss/corruption, harmful wrong data.",
    "- Important: major feature impact without full block, uninstall/cleanup/serviceability, missing/inaccurate docs.",
    "- Moderate/Low/Informational: usability, cosmetic UI/layout, minor documentation refinement/grammar/spelling.",
    "",
    "Return ONLY JSON object with shape:",
    "{\"priority\":\"<one-of-allowed>\",\"reason\":\"<one sentence>\"} (severity key accepted instead of priority)",
    "",
    `Issue key: ${context.issueKey || parseIssueKeyFromUrl(context.url) || "unknown"}`,
    `Issue title: ${context.summary || context.title || ""}`,
    `Issue description: ${context.description || ""}`
  ].join("\n");

  const response = await fetch(settings.claudeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      mode: "severity",
      model: settings.claudeModel || "sonnet",
      prompt,
      context: {
        issueKey: context.issueKey || parseIssueKeyFromUrl(context.url) || "unknown",
        title: context.summary || context.title || "",
        description: context.description || "",
        url: context.url || ""
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Local Claude severity request failed (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const payload = parseClaudeSeverityPayload(data?.text || data?.response || "");
  if (!payload) {
    throw new Error("Claude returned invalid severity format.");
  }

  const normalizedPriority = normalizePriority(payload.priority);
  if (!normalizedPriority) {
    throw new Error(`Claude returned unsupported priority: ${payload.priority}`);
  }

  return {
    priority: normalizedPriority,
    rationale: payload.reason || "Claude analysis completed."
  };
}

async function suggestSeverity() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setSeverityStatus("No active Jira tab.");
    return;
  }

  suggestSeverityBtn.disabled = true;
  setSeverityStatus("Assessing severity...");
  try {
    const context = await extractJiraContext(tab.id);
    const settings = await getSettings();
    const issueKey = context?.issueKey || parseIssueKeyFromUrl(tab.url || "");
    let issueType = String(context?.issueType || "").toLowerCase();

    if ((!issueType || issueType === "unknown") && settings.jiraBaseUrl && settings.jiraEmail && settings.jiraApiToken && issueKey) {
      const authHeader = getAuthHeader(settings.jiraEmail, settings.jiraApiToken);
      issueType = await fetchIssueType(settings.jiraBaseUrl, issueKey, authHeader);
    }

    if (issueType !== "bug") {
      setSeverityStatus("");
      setSeverityResult(
        `Severity suggestions only run for Bugs. Current issue type: ${issueType || "unknown"}.`
      );
      return;
    }

    if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
      setSeverityStatus("");
      setSeverityResult("Configure Jira API URL, email, and token in Additional settings.");
      return;
    }

    const authHeader = getAuthHeader(settings.jiraEmail, settings.jiraApiToken);
    await resolveSeverityFieldId(settings.jiraBaseUrl, authHeader, settings.jiraSeverityFieldId);

    let result;
    try {
      result = await requestClaudeSeveritySuggestion(context, settings);
    } catch (_error) {
      result = getSeveritySuggestion(context);
    }

    severitySelectEl.value = result.priority;
    setSeverityResult(`Suggested severity: ${result.priority}. ${result.rationale}`);
    setSeverityStatus("");
  } catch (error) {
    setSeverityStatus(error.message || "Could not suggest severity.");
  } finally {
    suggestSeverityBtn.disabled = false;
  }
}

async function applySeverity() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setSeverityStatus("No active Jira tab.");
    return;
  }

  applySeverityBtn.disabled = true;
  setSeverityStatus("Applying severity...");
  try {
    const settings = await getSettings();
    if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
      throw new Error("Configure Jira API URL, email, and token in Additional settings.");
    }

    const issueKey = parseIssueKeyFromUrl(tab.url || "");
    if (!issueKey) {
      throw new Error("Could not detect issue key from this Jira URL.");
    }

    const selectedPriority = severitySelectEl.value;
    const authHeader = getAuthHeader(settings.jiraEmail, settings.jiraApiToken);
    const severityFieldId = await resolveSeverityFieldId(
      settings.jiraBaseUrl,
      authHeader,
      settings.jiraSeverityFieldId
    );
    await setIssueSeverity(
      settings.jiraBaseUrl,
      issueKey,
      selectedPriority,
      authHeader,
      severityFieldId,
      settings.jiraSeverityFieldShape
    );
    setSeverityStatus("");
    setSeverityResult(`Applied Severity field: ${selectedPriority}.`);
    await chrome.tabs.reload(tab.id);
  } catch (error) {
    setSeverityStatus(error.message || "Could not apply severity.");
  } finally {
    applySeverityBtn.disabled = false;
  }
}

async function submitSelectedLabels() {
  if (!selectedLabels.size) {
    setLabelsStatus("Select at least one label.");
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setLabelsStatus("No active Jira tab.");
    return;
  }

  submitSelectedBtn.disabled = true;
  setLabelsStatus("Applying selected labels...");

  try {
    const settings = await getSettings();
    if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
      throw new Error("Configure Jira API URL, email, and token in Additional settings.");
    }

    const issueKey = parseIssueKeyFromUrl(tab.url || "");
    if (!issueKey) {
      throw new Error("Could not detect issue key from this Jira URL.");
    }

    const authHeader = getAuthHeader(settings.jiraEmail, settings.jiraApiToken);
    const existing = await fetchIssueLabels(settings.jiraBaseUrl, issueKey, authHeader);
    const merged = mergeIssueLabelsPreserveCasing(existing, selectedLabels);

    await setIssueLabels(settings.jiraBaseUrl, issueKey, merged, authHeader);
    const existingKeys = new Set([...existing].map((l) => labelKey(l)));
    const addedCount = [...selectedLabels].filter((label) => !existingKeys.has(labelKey(label))).length;
    selectedLabels.clear();
    updateSubmitButtonState();
    setLabelsStatus(`Applied ${addedCount} new label(s). Refreshing page...`);
    await chrome.tabs.reload(tab.id);
  } catch (error) {
    setLabelsStatus(error.message || "Could not submit selected labels.");
  } finally {
    updateSubmitButtonState();
  }
}

async function savePresetLabelsFromInput() {
  savePresetLabelsBtn.disabled = true;
  setSettingsStatus("Saving preset labels...");
  try {
    const labels = String(presetLabelsInput.value || "")
      .split(/\r?\n/g)
      .filter((entry) => String(entry || "").trim().length > 0);
    const uniqueLabels = Array.from(new Set(labels));

    if (!uniqueLabels.length) {
      throw new Error("Add at least one preset label.");
    }

    await chrome.storage.sync.set({ [LABELS_KEY]: uniqueLabels });
    presetLabelsInput.value = uniqueLabels.join("\n");
    selectedLabels.clear();
    renderLabels(uniqueLabels);
    renderSuggestedLabels([]);
    setSettingsStatus(`Saved ${uniqueLabels.length} preset label(s).`);
  } catch (error) {
    setSettingsStatus(error.message || "Could not save preset labels.");
  } finally {
    savePresetLabelsBtn.disabled = false;
  }
}

function renderLabels(labels) {
  if (labels.length === 0) {
    labelsContainer.innerHTML = "";
    setLabelsStatus("No labels configured. Add preset labels in Settings.");
    return;
  }

  renderLabelButtons(labelsContainer, labels);
  setLabelsStatus("");
  updateSubmitButtonState();
}

openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
paletteTabBtn.addEventListener("click", () => setActiveTab("palette"));
settingsTabBtn.addEventListener("click", () => setActiveTab("settings"));
suggestLabelsBtn.addEventListener("click", suggestLabels);
suggestSeverityBtn.addEventListener("click", suggestSeverity);
applySeverityBtn.addEventListener("click", applySeverity);
submitSelectedBtn.addEventListener("click", submitSelectedLabels);
savePresetLabelsBtn.addEventListener("click", savePresetLabelsFromInput);
refreshSuggestionsBtn.addEventListener("click", refreshSuggestionBox);
overlayToggleInput.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [OVERLAY_ENABLED_KEY]: overlayToggleInput.checked });
  setSettingsStatus(`Overlay ${overlayToggleInput.checked ? "enabled" : "disabled"}.`);
});
overlayShowLabelsInput.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [OVERLAY_SHOW_LABELS_KEY]: overlayShowLabelsInput.checked });
  setSettingsStatus(`Overlay Labels ${overlayShowLabelsInput.checked ? "shown" : "hidden"}.`);
});
overlayShowSeverityInput.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [OVERLAY_SHOW_SEVERITY_KEY]: overlayShowSeverityInput.checked });
  setSettingsStatus(`Overlay Severity ${overlayShowSeverityInput.checked ? "shown" : "hidden"}.`);
});

Promise.all([getLabels(), getSettings()]).then(([labels, settings]) => {
  renderLabels(labels);
  presetLabelsInput.value = labels.join("\n");
  overlayToggleInput.checked = settings.overlayEnabled;
  overlayShowLabelsInput.checked = settings.overlayShowLabels;
  overlayShowSeverityInput.checked = settings.overlayShowSeverity;
  setSeverityResult("");
  refreshSuggestionBox().catch(() => {});
});
