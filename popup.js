const DEFAULT_LABELS = ["bug", "urgent", "customer", "follow-up"];
const LABELS_KEY = "labels";

const labelsContainer = document.getElementById("labels");
const statusEl = document.getElementById("status");
const openOptionsBtn = document.getElementById("openOptions");

async function getLabels() {
  const result = await chrome.storage.sync.get({ [LABELS_KEY]: DEFAULT_LABELS });
  const labels = Array.isArray(result[LABELS_KEY]) ? result[LABELS_KEY] : DEFAULT_LABELS;
  return labels.filter(Boolean);
}

function setStatus(message) {
  statusEl.textContent = message;
}

async function sendAddLabel(label) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("No active tab.");
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "ADD_JIRA_LABEL",
    payload: { label }
  }).catch(() => null);

  if (!response || !response.ok) {
    setStatus(response?.error || "Could not add label. Open a Jira issue view first.");
    return;
  }

  if (response.skipped) {
    setStatus(response.message || `Label "${label}" already exists.`);
    return;
  }

  setStatus(response.message || `Added "${label}"`);
}

function renderLabels(labels) {
  labelsContainer.innerHTML = "";
  if (labels.length === 0) {
    setStatus("No labels configured. Click Manage labels.");
    return;
  }

  setStatus("");
  for (const label of labels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "label-btn";
    button.textContent = label;
    button.addEventListener("click", () => sendAddLabel(label));
    labelsContainer.appendChild(button);
  }
}

openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

getLabels().then(renderLabels);
