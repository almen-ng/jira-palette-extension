# Jira Label Palette (Chrome Extension)

Add common Jira labels with one click from a Chrome extension popup.

## What this does

- Shows your saved list of common labels in the extension popup.
- Clicking a label sends it to the current Jira tab and attempts to add it to the Labels field.
- Prevents re-adding a label when it already exists on the issue.
- Includes a settings page where you can manage labels (one per line).

## Project structure

- `manifest.json` - Chrome extension manifest (MV3)
- `popup.html`, `popup.js`, `popup.css` - popup UI to click labels
- `options.html`, `options.js`, `options.css` - settings page for labels
- `content.js` - code injected into Jira pages to set/add labels
- `icons/` - extension icons (`16`, `48`, `128`)

## Run locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open a Jira issue/create view.
5. Click the extension icon and pick a label.

## Notes

- Jira UI differs across versions and screens, so selectors may need tuning for your instance.
- Host permissions currently include common Jira domains (`*.atlassian.net` and `jira.*`).
- Labels are stored in `chrome.storage.sync`.

## Next improvements

- Add multiple-label click support.
- Add domain allowlist in options.
- Add robust Jira selectors for issue create modal vs issue detail view.
