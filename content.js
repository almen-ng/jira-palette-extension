function getVisibleLabelInput() {
  const selectors = [
    'input[aria-label="Labels"]',
    'input[placeholder="Add label"]',
    'input[data-test-id="labels-field.ui.input"]',
    'input[name="labels"]',
    'input[id*="labels"]'
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.offsetParent !== null) {
      return el;
    }
  }

  return null;
}

function dispatchInputEvents(input) {
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function isVisible(el) {
  return Boolean(el && el.offsetParent !== null);
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

function keyEvent(type, key) {
  return new KeyboardEvent(type, {
    key,
    code: key,
    bubbles: true,
    cancelable: true
  });
}

async function addJiraLabel(label) {
  const cleanedLabel = normalizeLabel(label);
  if (!cleanedLabel) {
    return { ok: false, error: "No label provided." };
  }

  const input = getVisibleLabelInput();
  if (!input) {
    return { ok: false, error: "Jira label input not found on this page." };
  }

  const existingLabels = getExistingLabels();
  if (existingLabels.has(cleanedLabel)) {
    return { ok: true, skipped: true, message: `Label "${cleanedLabel}" already exists.` };
  }

  focusAndOpenLabelInput(input);
  input.value = cleanedLabel;
  dispatchInputEvents(input);

  // Jira often needs Enter to confirm tokenized labels.
  input.dispatchEvent(keyEvent("keydown", "Enter"));
  input.dispatchEvent(keyEvent("keypress", "Enter"));
  input.dispatchEvent(keyEvent("keyup", "Enter"));

  // Re-check to confirm Jira accepted it.
  const afterLabels = getExistingLabels();
  if (afterLabels.has(cleanedLabel)) {
    return { ok: true };
  }

  // Some Jira screens update labels lazily; report success with caution.
  return { ok: true, message: "Label submitted. Verify it appears in the Labels field." };
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
