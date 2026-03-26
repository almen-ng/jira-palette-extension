const DEFAULT_LABELS = ["bug", "urgent", "customer", "follow-up"];
const LABELS_KEY = "labels";
const MODE_KEY = "mode";
const JIRA_BASE_URL_KEY = "jiraBaseUrl";
const JIRA_EMAIL_KEY = "jiraEmail";
const JIRA_TOKEN_KEY = "jiraApiToken";
const PRESET_PROJECT_KEY = "presetProjectKey";
const OVERLAY_ENABLED_KEY = "overlayEnabled";
const CLAUDE_MODEL_KEY = "claudeModel";
const CLAUDE_ENDPOINT_KEY = "claudeEndpoint";

const labelsInput = document.getElementById("labelsInput");
const modeSelect = document.getElementById("modeSelect");
const overlayEnabledInput = document.getElementById("overlayEnabledInput");
const jiraBaseUrlInput = document.getElementById("jiraBaseUrlInput");
const jiraEmailInput = document.getElementById("jiraEmailInput");
const jiraTokenInput = document.getElementById("jiraTokenInput");
const presetProjectKeyInput = document.getElementById("presetProjectKeyInput");
const claudeEndpointInput = document.getElementById("claudeEndpointInput");
const claudeModelInput = document.getElementById("claudeModelInput");
const saveBtn = document.getElementById("saveBtn");
const loadPresetBtn = document.getElementById("loadPresetBtn");
const statusEl = document.getElementById("status");

async function load() {
  const syncResult = await chrome.storage.sync.get({
    [LABELS_KEY]: DEFAULT_LABELS,
    [MODE_KEY]: "auto",
    [OVERLAY_ENABLED_KEY]: true,
    [JIRA_BASE_URL_KEY]: "",
    [JIRA_EMAIL_KEY]: "",
    [PRESET_PROJECT_KEY]: "ACM",
    [CLAUDE_MODEL_KEY]: "sonnet",
    [CLAUDE_ENDPOINT_KEY]: "http://localhost:8787/suggest-labels"
  });
  const localResult = await chrome.storage.local.get({ [JIRA_TOKEN_KEY]: "" });

  const labels = Array.isArray(syncResult[LABELS_KEY]) ? syncResult[LABELS_KEY] : DEFAULT_LABELS;
  labelsInput.value = labels.join("\n");
  modeSelect.value = syncResult[MODE_KEY];
  overlayEnabledInput.checked = Boolean(syncResult[OVERLAY_ENABLED_KEY]);
  jiraBaseUrlInput.value = syncResult[JIRA_BASE_URL_KEY];
  jiraEmailInput.value = syncResult[JIRA_EMAIL_KEY];
  jiraTokenInput.value = localResult[JIRA_TOKEN_KEY];
  presetProjectKeyInput.value = syncResult[PRESET_PROJECT_KEY];
  claudeEndpointInput.value = syncResult[CLAUDE_ENDPOINT_KEY];
  claudeModelInput.value = syncResult[CLAUDE_MODEL_KEY];
}

function parseInput(value) {
  const deduped = new Set();
  const lines = value
    .split("\n")
    .map((label) => label.trim())
    .filter(Boolean);

  for (const label of lines) {
    deduped.add(label);
  }

  return [...deduped];
}

async function save() {
  const labels = parseInput(labelsInput.value);
  const mode = modeSelect.value;
  const overlayEnabled = overlayEnabledInput.checked;
  const jiraBaseUrl = jiraBaseUrlInput.value.trim().replace(/\/+$/, "");
  const jiraEmail = jiraEmailInput.value.trim();
  const jiraApiToken = jiraTokenInput.value.trim();
  const presetProjectKey = presetProjectKeyInput.value.trim().toUpperCase() || "ACM";
  const claudeEndpoint = claudeEndpointInput.value.trim().replace(/\/+$/, "");
  const claudeModel = claudeModelInput.value.trim() || "sonnet";

  await chrome.storage.sync.set({
    [LABELS_KEY]: labels,
    [MODE_KEY]: mode,
    [OVERLAY_ENABLED_KEY]: overlayEnabled,
    [JIRA_BASE_URL_KEY]: jiraBaseUrl,
    [JIRA_EMAIL_KEY]: jiraEmail,
    [PRESET_PROJECT_KEY]: presetProjectKey,
    [CLAUDE_MODEL_KEY]: claudeModel,
    [CLAUDE_ENDPOINT_KEY]: claudeEndpoint
  });
  await chrome.storage.local.set({ [JIRA_TOKEN_KEY]: jiraApiToken });
  statusEl.textContent = "Saved.";
}

function authHeader(email, token) {
  return `Basic ${btoa(`${email}:${token}`)}`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

async function fetchTopProjectLabels({ jiraBaseUrl, jiraEmail, jiraApiToken, projectKey }) {
  const counts = new Map();
  let startAt = 0;
  const maxResults = 100;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      jql: `project = "${projectKey}" AND labels is not EMPTY ORDER BY updated DESC`,
      startAt: String(startAt),
      maxResults: String(maxResults),
      fields: "labels"
    });
    const url = `${jiraBaseUrl}/rest/api/3/search/jql?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader(jiraEmail, jiraApiToken)
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Failed loading project labels (${response.status}): ${errorText || response.statusText}`);
    }

    const data = await response.json();
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    for (const issue of issues) {
      const labels = Array.isArray(issue?.fields?.labels) ? issue.fields.labels : [];
      for (const label of labels) {
        const normalized = normalizeLabel(label);
        if (!normalized) {
          continue;
        }
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
      }
    }

    startAt += maxResults;
    if (startAt >= Number(data?.total || 0) || issues.length < maxResults) {
      break;
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25)
    .map(([label]) => label);
}

async function resolveProjectKey({ jiraBaseUrl, jiraEmail, jiraApiToken, projectHint }) {
  const hint = String(projectHint || "").trim();
  if (!hint) {
    throw new Error("Preset project key is empty.");
  }

  const response = await fetch(`${jiraBaseUrl}/rest/api/3/project/search?maxResults=200`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader(jiraEmail, jiraApiToken)
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed resolving project (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const values = Array.isArray(data?.values) ? data.values : [];
  const upperHint = hint.toUpperCase();
  const lowerHint = hint.toLowerCase();

  const exactKey = values.find((project) => String(project?.key || "").toUpperCase() === upperHint);
  if (exactKey?.key) {
    return exactKey.key;
  }

  // Common alias handling so "ACM" can resolve to RHACM.
  const aliasHints = new Set([upperHint]);
  if (upperHint === "ACM") {
    aliasHints.add("RHACM");
  }

  const aliasKey = values.find((project) => aliasHints.has(String(project?.key || "").toUpperCase()));
  if (aliasKey?.key) {
    return aliasKey.key;
  }

  const nameContains = values.find((project) =>
    String(project?.name || "")
      .toLowerCase()
      .includes(lowerHint)
  );
  if (nameContains?.key) {
    return nameContains.key;
  }

  const rhAcmByName = values.find((project) =>
    String(project?.name || "")
      .toLowerCase()
      .includes("advanced cluster management")
  );
  if (rhAcmByName?.key) {
    return rhAcmByName.key;
  }

  throw new Error(`Could not resolve Jira project from "${hint}". Try explicit key (for example RHACM).`);
}

async function loadProjectPreset() {
  const jiraBaseUrl = jiraBaseUrlInput.value.trim().replace(/\/+$/, "");
  const jiraEmail = jiraEmailInput.value.trim();
  const jiraApiToken = jiraTokenInput.value.trim();
  const projectKey = presetProjectKeyInput.value.trim().toUpperCase() || "ACM";

  if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) {
    statusEl.textContent = "Fill Jira URL, email, and API token first.";
    return;
  }

  loadPresetBtn.disabled = true;
  statusEl.textContent = `Loading preset labels from ${projectKey}...`;

  try {
    const resolvedProjectKey = await resolveProjectKey({
      jiraBaseUrl,
      jiraEmail,
      jiraApiToken,
      projectHint: projectKey
    });
    const labels = await fetchTopProjectLabels({
      jiraBaseUrl,
      jiraEmail,
      jiraApiToken,
      projectKey: resolvedProjectKey
    });
    if (!labels.length) {
      statusEl.textContent = `No labels found in project ${resolvedProjectKey}.`;
      return;
    }
    labelsInput.value = labels.join("\n");
    presetProjectKeyInput.value = resolvedProjectKey;
    statusEl.textContent = `Loaded ${labels.length} labels from ${resolvedProjectKey}. Click Save to persist.`;
  } catch (error) {
    statusEl.textContent = error.message || "Could not load project preset.";
  } finally {
    loadPresetBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", save);
loadPresetBtn.addEventListener("click", loadProjectPreset);
load();
