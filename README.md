# Jira Palette (Chrome Extension)

Click-to-apply labels and triage helpers for Jira Cloud from a Chrome popup, with optional **local Claude** for suggestions.

## What it does

- **Palette tab**: preset labels (multi-select), **Suggest labels** (Claude picks from existing Jira labels using your delivery rules), **Submit selected** via REST API, then refresh the issue.
- **Severity** (bugs): **Suggest severity** / **Apply severity** using Jira priorities (Critical, Important, Moderate, Low, Informational) and your guidelines; status shows in the severity section.
- **Suggestion box** (top of popup): Claude-generated checklist from your **delivery guidelines** (cross-squad, previews, train, fix versions, spike, side-train, Epic Color Status for **Epics only**, Story `Eng-Status:*` for non–QE-related stories, bugs, etc.). QE-related issues skip Eng-Status suggestions; Spike **issue type** skips redundant `spike` label hints.
- **Settings tab**: edit **preset labels** (one per line), overlay toggles (enable overlay, show **Labels** / **Severity** sections), link to full options.
- **Options**: Jira URL / email / API token, Claude endpoint & model, mode (API / DOM / Auto), project key for label discovery, legacy preset loader — tokens stay in `chrome.storage.local`.
- **Floating overlay** on Jira (optional): same preset labels + optional severity control; positions saved per host.
- **Labels** are stored exactly as you type them (no normalization). Suggestion matching may compare case-insensitively but keeps canonical spelling from Jira / your list.

## Project structure

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, host permissions (`*.atlassian.net`, local bridge) |
| `popup.*` | Main UI: suggestion box, tabs, labels, severity, per-section status |
| `options.*` | Full settings and label textarea |
| `content.js` | Jira page: label field helpers, draggable overlay |
| `local-claude-bridge.js` | Node server: `POST /suggest-labels` → local `claude` CLI |
| `icons/` | `16`, `48`, `128` PNGs |

## Run locally

1. Open `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
2. Start the bridge (default `http://127.0.0.1:8787/suggest-labels`):
   ```bash
   cd /path/to/jira-label-palette-extension
   node local-claude-bridge.js
   ```
   If `claude` is not on `PATH`:
   ```bash
   CLAUDE_BIN="/absolute/path/to/claude" node local-claude-bridge.js
   ```
3. **Manage labels** (options): Jira base URL, email, API token, Claude endpoint, model, mode.
4. Open an issue (`…/browse/KEY-123` or `selectedIssue=`). Use the extension icon: pick labels, **Submit selected**, or use **Suggest labels** / **Suggestion box** / severity as needed.

## Local bridge API

`POST /suggest-labels` with JSON body:

- `model` (e.g. `sonnet`)
- `prompt` (full prompt text)
- `context` (optional metadata for logging)
- `mode`:
  - **`labels`** (default): response `{ labels?: string[], text: string }` — `text` is parsed for a JSON label array if needed
  - **`severity`**: `{ text: string }` — JSON object with `priority` / `reason` parsed in the extension
  - **`suggestion-box`**: `{ text: string }` — JSON array of suggestion lines

 CORS enabled for browser `fetch` from the extension.

## Storage

| Data | Where |
|------|--------|
| Labels, Jira URL/email, mode, overlay flags, Claude endpoint/model, project key | `chrome.storage.sync` |
| API token | `chrome.storage.local` |
| Overlay drag position | `chrome.storage.local` (per host) |

## Notes

- Label apply uses `PUT /rest/api/3/issue/{issueKey}` (`fields.labels`, `fields.priority` for severity).
- JQL uses `GET /rest/api/3/search/jql` where applicable.
- **Suggestion box** and **Suggest labels** need a working bridge + Jira API for full context (issue type, labels, fix/affects versions, priority).
- DOM mode depends on Jira UI selectors and may need tuning on some screens.
