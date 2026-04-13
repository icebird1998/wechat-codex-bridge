#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import {
  moveApprovalRecord,
} from "./approval_queue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const id = process.argv[2];
if (!id) {
  console.error("Usage: node run-approved-job.js <approval-id>");
  process.exit(1);
}

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";
const DEFAULT_REASONING =
  process.env.CODEX_REASONING ??
  process.env.CODEX_MODEL_REASONING ??
  "medium";
const SHOULD_SKIP_GIT =
  process.env.CODEX_SKIP_GIT_CHECK === "false" ? false : true;
const WORKING_DIRECTORY = resolveWorkingDirectory(process.env.CODEX_WORKDIR);
const DEFAULT_CODEX_DIR =
  process.env.CODEX_STATE_DIR ?? path.join(os.homedir(), ".codex");
const SANDBOX_MODE = normalizeSandboxMode(
  process.env.CODEX_APPROVAL_ELEVATED_SANDBOX_MODE ??
    process.env.CODEX_SANDBOX_MODE ??
    "danger-full-access",
);
const NETWORK_ACCESS = readBooleanEnv(
  process.env.CODEX_APPROVAL_ELEVATED_NETWORK_ACCESS,
  readBooleanEnv(process.env.CODEX_NETWORK_ACCESS, true),
);
const WEB_SEARCH = readBooleanEnv(
  process.env.CODEX_APPROVAL_ELEVATED_WEB_SEARCH,
  readBooleanEnv(process.env.CODEX_WEB_SEARCH, true),
);
const STATE_FILE = path.join(__dirname, ".codex_threads.json");
const CODEX_EXECUTABLE =
  process.env.CODEX_EXECUTABLE ??
  process.env.CODEX_PATH ??
  null;

const codex = new Codex(
  CODEX_EXECUTABLE ? { codexPathOverride: CODEX_EXECUTABLE } : {},
);

try {
  const runningRecord = await moveApprovalRecord(
    __dirname,
    id,
    "approved",
    "running",
    (record) => ({
      ...record,
      status: "running",
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    }),
  );

  const elevatedSessionId = `elevated:${runningRecord.sessionId}`;
  const persistedThreadIds = await loadState();
  const persistedId = persistedThreadIds.get(elevatedSessionId);
  const threadOptions = {
    skipGitRepoCheck: SHOULD_SKIP_GIT,
    model: runningRecord.model ?? DEFAULT_MODEL,
    modelReasoningEffort: toCodexReasoning(runningRecord.reasoning ?? DEFAULT_REASONING),
    sandboxMode: SANDBOX_MODE,
    workingDirectory: WORKING_DIRECTORY,
    networkAccessEnabled: NETWORK_ACCESS,
    webSearchEnabled: WEB_SEARCH,
    approvalPolicy: "never",
  };

  const thread = persistedId
    ? codex.resumeThread(persistedId, threadOptions)
    : codex.startThread(threadOptions);
  const turn = await thread.run(runningRecord.codexInput);

  if (runningRecord.sessionProvided && thread.id) {
    persistedThreadIds.set(elevatedSessionId, thread.id);
    await saveState(persistedThreadIds);
  }

  const completedAt = new Date().toISOString();
  await moveApprovalRecord(__dirname, id, "running", "completed", (record) => ({
    ...record,
    status: "completed",
    updatedAt: completedAt,
    completedAt,
    resultText: extractAssistantResponse(turn),
    usage: formatUsage(turn?.usage) ?? null,
  }));
} catch (error) {
  const completedAt = new Date().toISOString();
  try {
    await moveApprovalRecord(__dirname, id, "running", "failed", (record) => ({
      ...record,
      status: "failed",
      updatedAt: completedAt,
      completedAt,
      errorText: error?.message ?? "Approved run failed.",
    }));
  } catch {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}

function formatUsage(raw) {
  if (!raw) return undefined;
  const prompt = raw.input_tokens ?? 0;
  const completion = raw.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function extractAssistantResponse(turn) {
  if (turn?.finalResponse) return turn.finalResponse;
  if (turn?.text) return turn.text;
  const agentMessage = turn?.items?.find(
    (item) => item?.type === "agent_message" && item?.text,
  );
  return agentMessage?.text ?? "";
}

function readBooleanEnv(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeSandboxMode(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  const allowed = [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ];
  return allowed.includes(normalized) ? normalized : null;
}

function toCodexReasoning(value) {
  return value === "extra-high" ? "xhigh" : value;
}

function resolveWorkingDirectory(value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return path.resolve(__dirname, value);
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed.sessions ?? {}));
  } catch {
    return new Map();
  }
}

async function saveState(map) {
  const payload = {
    sessions: Object.fromEntries(map.entries()),
  };
  await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}
