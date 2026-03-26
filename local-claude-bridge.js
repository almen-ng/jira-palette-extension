#!/usr/bin/env node
"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 8787);
const HOST = process.env.CLAUDE_BRIDGE_HOST || "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 45000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(payload);
}

function cleanLabel(label) {
  return String(label || "").trim();
}

function parseLabelsFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return [];
  }

  const blockMatch = raw.match(/\[[\s\S]*\]/);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.map(cleanLabel).filter(Boolean);
      }
    } catch (_error) {
      // Fall back to line parsing.
    }
  }

  return raw
    .split(/\n|,/g)
    .map((entry) => entry.replace(/^[-*\d.\s]+/, ""))
    .map(cleanLabel)
    .filter(Boolean);
}

function buildPrompt({ context = {}, model = "sonnet" }) {
  return [
    "You suggest labels for a Jira issue.",
    "Return ONLY a JSON array of 5-10 concise labels.",
    "Rules:",
    "- preserve label text exactly as intended (case, punctuation, separators)",
    "- no explanations",
    "",
    `Model hint: ${model}`,
    `Issue key: ${context.issueKey || "unknown"}`,
    `Issue title: ${context.title || ""}`,
    `Issue description: ${context.description || ""}`,
    `Issue URL: ${context.url || ""}`
  ].join("\n");
}

function runClaude({ prompt, model }) {
  const attempts = [
    ["-p", "--output-format", "text", "--model", model || "sonnet", prompt],
    ["-p", "--output-format", "text", "--model", "sonnet", prompt],
    ["-p", "--output-format", "text", prompt],
    ["-p", "--output-format", "text", "--dangerously-skip-permissions", prompt]
  ];

  return tryClaudeAttempts(attempts, 0);
}

function tryClaudeAttempts(attempts, index) {
  return new Promise((resolve, reject) => {
    const args = attempts[index];
    const child = spawn(CLAUDE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude command timed out after ${CLAUDE_TIMEOUT_MS}ms.`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (index < attempts.length - 1) {
        tryClaudeAttempts(attempts, index + 1).then(resolve).catch(reject);
        return;
      }
      reject(
        new Error(
          `Failed to start Claude binary "${CLAUDE_BIN}". ${error.message}. Set CLAUDE_BIN to the full path.`
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
        if (index < attempts.length - 1) {
          tryClaudeAttempts(attempts, index + 1).then(resolve).catch(reject);
          return;
        }
        reject(
          new Error(
            `Claude exited with code ${code}. ${details || "No stderr/stdout. Run 'claude -p \"test\"' in terminal."}`
          )
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  if (req.method !== "POST" || req.url !== "/suggest-labels") {
    json(res, 404, { error: "Not found." });
    return;
  }

  let rawBody = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    rawBody += chunk;
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    try {
      const body = rawBody ? JSON.parse(rawBody) : {};
      const context = body.context || {};
      const model = String(body.model || "sonnet");
      const prompt = String(body.prompt || "").trim() || buildPrompt({ context, model });
      const output = await runClaude({ prompt, model });
      const mode = String(body.mode || "labels");
      if (mode === "severity" || mode === "suggestion-box") {
        json(res, 200, { text: output });
        return;
      }
      const labels = Array.from(new Set(parseLabelsFromText(output))).slice(0, 10);
      json(res, 200, { labels, text: output });
    } catch (error) {
      json(res, 500, { error: error.message || "Local Claude bridge failed." });
    }
  });

  req.on("error", () => {
    json(res, 400, { error: "Invalid request." });
  });
});

server.listen(PORT, HOST, () => {
  const claudeBinExists = CLAUDE_BIN.includes("/") ? fs.existsSync(CLAUDE_BIN) : true;
  // eslint-disable-next-line no-console
  console.log(`Local Claude bridge listening on http://${HOST}:${PORT}/suggest-labels`);
  // eslint-disable-next-line no-console
  console.log(`Using Claude binary: ${CLAUDE_BIN}${claudeBinExists ? "" : " (path not found)"}`);
});
