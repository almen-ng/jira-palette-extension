const DEFAULT_LABELS = ["bug", "urgent", "customer", "follow-up"];
const LABELS_KEY = "labels";

const labelsInput = document.getElementById("labelsInput");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

async function load() {
  const result = await chrome.storage.sync.get({ [LABELS_KEY]: DEFAULT_LABELS });
  const labels = Array.isArray(result[LABELS_KEY]) ? result[LABELS_KEY] : DEFAULT_LABELS;
  labelsInput.value = labels.join("\n");
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
  await chrome.storage.sync.set({ [LABELS_KEY]: labels });
  statusEl.textContent = "Saved.";
}

saveBtn.addEventListener("click", save);
load();
