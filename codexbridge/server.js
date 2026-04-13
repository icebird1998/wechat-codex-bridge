#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import express from "express";
import { fileURLToPath } from "node:url";
// child_process not directly used; Codex SDK manages subprocess spawning
import { Codex } from "@openai/codex-sdk";
import {
  ensureApprovalDirectories,
  findApprovalRecord,
  listApprovalRecords,
  moveApprovalRecord,
  writeApprovalRecord,
} from "./approval_queue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";
const DEFAULT_REASONING =
  process.env.CODEX_REASONING ??
  process.env.CODEX_MODEL_REASONING ??
  "medium";
const PORT = Number(process.env.PORT ?? 8080);
const STATE_FILE = path.join(__dirname, ".codex_threads.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const DASHBOARD_HTML = path.join(PUBLIC_DIR, "dashboard.html");
let requestCounter = 0;
const SHOULD_SKIP_GIT =
  process.env.CODEX_SKIP_GIT_CHECK === "false" ? false : true;
const API_KEY = process.env.CODEX_BRIDGE_API_KEY ?? "";
const SANDBOX_OPTIONS = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_POLICY_OPTIONS = [
  "never",
  "on-request",
  "on-failure",
  "untrusted",
];
const SANDBOX_MODE = normalizeSandboxMode(
  process.env.CODEX_SANDBOX_MODE ?? "danger-full-access",
);
const WORKING_DIRECTORY = resolveWorkingDirectory(process.env.CODEX_WORKDIR);
const NETWORK_ACCESS = readBooleanEnv(
  process.env.CODEX_NETWORK_ACCESS,
  false,
);
const WEB_SEARCH = readBooleanEnv(process.env.CODEX_WEB_SEARCH, false);
const APPROVAL_POLICY = normalizeApprovalPolicy(
  process.env.CODEX_APPROVAL_POLICY ?? "never",
);
const LOG_REQUESTS = readBooleanEnv(process.env.CODEX_LOG_REQUESTS, false);
const REQUIRE_SESSION_ID = readBooleanEnv(
  process.env.CODEX_REQUIRE_SESSION_ID,
  false,
);
const JSON_LIMIT = process.env.CODEX_JSON_LIMIT ?? "10mb";
const APP_START = Date.now();
const DEFAULT_CODEX_DIR =
  process.env.CODEX_STATE_DIR ?? path.join(os.homedir(), ".codex");
const CODEX_STATE_DIR =
  process.env.CODEX_STATE_DIR ?? process.env.CODEX_DIR ?? DEFAULT_CODEX_DIR;
const CODEX_AUTH_FILE =
  process.env.CODEX_AUTH_FILE ?? path.join(CODEX_STATE_DIR, "auth.json");
const APP_VERSION = process.env.npm_package_version ?? "dev";
const CODEX_EXECUTABLE =
  process.env.CODEX_EXECUTABLE ??
  process.env.CODEX_PATH ??
  null;
const APPROVALS_ENABLED = readBooleanEnv(
  process.env.CODEX_ASYNC_APPROVALS_ENABLED,
  false,
);
const APPROVAL_POLL_INTERVAL_MS = Number(
  process.env.CODEX_APPROVAL_POLL_INTERVAL_MS ?? 3000,
);
const APPROVAL_ELEVATED_SANDBOX_MODE = normalizeSandboxMode(
  process.env.CODEX_APPROVAL_ELEVATED_SANDBOX_MODE ?? "danger-full-access",
);
const APPROVAL_ELEVATED_NETWORK_ACCESS = readBooleanEnv(
  process.env.CODEX_APPROVAL_ELEVATED_NETWORK_ACCESS,
  NETWORK_ACCESS,
);
const APPROVAL_ELEVATED_WEB_SEARCH = readBooleanEnv(
  process.env.CODEX_APPROVAL_ELEVATED_WEB_SEARCH,
  WEB_SEARCH,
);
const WORKSPACE_ROOT_NORMALIZED = WORKING_DIRECTORY
  ? path.resolve(WORKING_DIRECTORY).toLowerCase()
  : null;
/** Paths under this root (e.g. repo root) do not trigger "outside workspace" approval; Codex cwd may still be only WORKSPACE_ROOT. */
const APPROVAL_SAFE_ROOT_NORMALIZED = resolveApprovalSafeRoot();
let approvalWorkerRunning = false;

function resolveApprovalSafeRoot(workingDirectory = WORKING_DIRECTORY) {
  const fromEnv = process.env.CODEX_APPROVAL_SAFE_ROOT?.trim();
  if (fromEnv) {
    try {
      return path.resolve(fromEnv).toLowerCase();
    } catch {
      return null;
    }
  }
  if (!workingDirectory) return null;
  const base = path.basename(path.resolve(workingDirectory));
  if (base.toLowerCase() === "code_project") {
    return path.resolve(workingDirectory, "..").toLowerCase();
  }
  return null;
}
// Store SSE clients for real-time CLI output streaming
const sseClients = new Set();

/**
 * Broadcast message to all connected SSE clients
 */
function broadcastToCLIClients(data) {
  const message = JSON.stringify(data);
  sseClients.forEach(client => {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (err) {
      // Client disconnected
      sseClients.delete(client);
    }
  });
}

const MODEL_PRESETS = [
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3-Codex",
    description: "面向复杂开发任务的旗舰 Codex，适合深度修改代码与调用多种工具。",
    reasonings: [
      { level: "low", label: "Low", description: "响应最快，推理深度最低，适合简单改动。" },
      { level: "medium", label: "Medium", description: "推理深度与速度折中（默认）。" },
      { level: "high", label: "High", description: "推理深度最高，适合疑难杂症与大型重构。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    description: "轻量版 Codex，适合日常增删改查与脚本编辑，成本更低。",
    reasonings: [
      { level: "low", label: "Low", description: "最快速的响应，适合简单编辑。" },
      { level: "medium", label: "Medium", description: "在速度与质量之间取得平衡（默认）。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    description: "通用型 GPT-5.2，覆盖广泛常识与自然语言任务，侧重综合推理。",
    reasonings: [
      { level: "low", label: "Low", description: "高速度模式，适合问答/总结等轻负载任务。" },
      { level: "medium", label: "Medium", description: "标准推理深度（默认），适合大多数对话场景。" },
      { level: "high", label: "High", description: "最大化推理能力，适合复杂需求或长篇创作。" },
    ],
    defaultReasoning: "medium",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    description: "ChatGPT GPT-5.4（网页版同款）模型，适合需要更强通用问答和摘要能力的工作流。",
    reasonings: [
      { level: "minimal", label: "Minimal", description: "极速模式，最低延迟，适合快速问答。" },
      { level: "low", label: "Low", description: "快速模式，适合低负载问答或简单说明。" },
      { level: "medium", label: "Medium", description: "均衡推理深度，适合日常沟通与分析。" },
      { level: "high", label: "High", description: "高推理深度，适合复杂分析。" },
      { level: "extra-high", label: "Extra High", description: "极高推理深度（Codex 界面同款），极致推理能力。" },
    ],
    defaultReasoning: "extra-high",
  },

];

const runtimeConfig = {
  defaultModel: DEFAULT_MODEL,
  defaultReasoning: DEFAULT_REASONING,
  sandboxMode: SANDBOX_MODE,
  workingDirectory: WORKING_DIRECTORY,
  networkAccess: NETWORK_ACCESS,
  webSearch: WEB_SEARCH,
  approvalPolicy: APPROVAL_POLICY,
};

const codex = new Codex(
  CODEX_EXECUTABLE ? { codexPathOverride: CODEX_EXECUTABLE } : {},
);
const inMemoryThreads = new Map();
const persistedThreadIds = await loadState();
const saveQueue = createSaveQueue();

const app = express();
app.use(express.json({ limit: JSON_LIMIT }));
app.use((req, _res, next) => {
  if (!req.path.startsWith("/public")) {
    requestCounter += 1;
  }
  next();
});
if (await fileExists(DASHBOARD_HTML)) {
  app.use("/public", express.static(PUBLIC_DIR));
  app.get("/dashboard", (_req, res) => {
    res.sendFile(DASHBOARD_HTML);
  });
  app.get("/api/dashboard", async (_req, res) => {
    try {
      const snapshot = await buildDashboardSnapshot();
      res.json(snapshot);
    } catch (error) {
      console.error("Failed to build dashboard snapshot:", error);
      res.status(500).json({
        error: {
          message: "Failed to load Codex dashboard data.",
        },
      });
    }
  });
}
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!API_KEY) {
    return res.status(503).json({
      error: {
        message: "CODEX_BRIDGE_API_KEY must be set before serving API requests.",
        type: "configuration_error",
      },
    });
  }
  const authHeader = req.get("authorization") ?? "";
  let suppliedKey = null;
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    suppliedKey = authHeader.slice(7).trim();
  } else if (req.get("x-api-key")) {
    suppliedKey = req.get("x-api-key");
  }
  if (suppliedKey !== API_KEY) {
    return res.status(401).json({
      error: {
        message: "Invalid or missing API key.",
        type: "unauthorized",
      },
    });
  }
  return next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// SSE endpoint for real-time CLI output streaming
app.get("/cli-stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  console.log("[SSE] Client connected to CLI stream");
  sseClients.add(res);

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: "connected", message: "CLI stream connected" })}\n\n`);

  req.on("close", () => {
    console.log("[SSE] Client disconnected from CLI stream");
    sseClients.delete(res);
  });
});

app.get("/v1/models", (_req, res) => {
  const flattened = MODEL_PRESETS.flatMap((model) =>
    model.reasonings.map((reasoning) => ({
      object: "model",
      id: `${model.id}:${reasoning.level}`,
      label: `${model.label} · ${reasoning.label}`,
      description: `${model.description} (Reasoning: ${reasoning.label})`,
      base_model: model.id,
      reasoning: reasoning.level,
      default_reasoning: model.defaultReasoning,
    })),
  );

  res.json({
    object: "list",
    data: flattened,
    defaults: {
      model: `${runtimeConfig.defaultModel}:${runtimeConfig.defaultReasoning}`,
    },
  });
});

app.get("/v1/runtime-config", (_req, res) => {
  res.json({
    runtime: buildRuntimeConfigSnapshot(),
    allowed: {
      sandboxModes: SANDBOX_OPTIONS,
      approvalPolicies: APPROVAL_POLICY_OPTIONS,
      models: MODEL_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        reasonings: preset.reasonings.map((item) => item.level),
        defaultReasoning: preset.defaultReasoning,
      })),
    },
  });
});

app.post("/v1/runtime-config", (req, res) => {
  try {
    const updates = req.body?.updates ?? req.body ?? {};
    const next = applyRuntimeConfigUpdates(updates);
    broadcastToCLIClients({
      type: "runtime.config.updated",
      runtime: next,
      timestamp: new Date().toISOString(),
    });
    return res.json({
      status: "ok",
      runtime: next,
    });
  } catch (error) {
    return res.status(400).json({
      error: {
        message: error?.message ?? "Invalid runtime config updates.",
        type: "invalid_request_error",
      },
    });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  const { messages, model, reasoning_effort, stream } = req.body ?? {};

  if (LOG_REQUESTS) {
    console.log(
      "[Codex Bridge] incoming chat request:",
      JSON.stringify(
        {
          session_id:
            req.body?.session_id ??
            req.body?.conversation_id ??
            req.body?.thread_id ??
            req.body?.user ??
            null,
          model,
          reasoning_effort: reasoning_effort ?? req.body?.model_reasoning_effort,
          stream: Boolean(stream),
          message_count: Array.isArray(messages) ? messages.length : 0,
          raw: req.body,
        },
        null,
        2,
      ),
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "Request body must include a non-empty messages array.",
        type: "invalid_request_error",
      },
    });
  }

  let sessionId = resolveSessionId(req);
  const sessionProvided = Boolean(sessionId);
  if (!sessionProvided && REQUIRE_SESSION_ID) {
    return res.status(400).json({
      error: {
        message:
          "session_id (or conversation_id / thread_id / user) is required in this deployment.",
        type: "missing_session_id",
      },
    });
  }
  if (!sessionProvided) {
    sessionId = `ephemeral-${crypto.randomUUID()}`;
  }

  let normalizedMessages;
  try {
    normalizedMessages = await normalizeMessages(messages);
  } catch (error) {
    return res.status(400).json({
      error: {
        message: error?.message ?? "Invalid message attachments.",
        type: "invalid_request_error",
      },
    });
  }

  let outputSchema = null;
  try {
    outputSchema = resolveOutputSchemaFromBody(req.body);
  } catch (error) {
    return res.status(400).json({
      error: {
        message: error?.message ?? "Invalid response_format schema.",
        type: "invalid_request_error",
      },
    });
  }

  const { resolvedModel, resolvedReasoning } = resolveModelAndReasoning({
    model: model ?? runtimeConfig.defaultModel,
    reasoning:
      reasoning_effort ??
      req.body?.model_reasoning_effort ??
      runtimeConfig.defaultReasoning,
    defaultModel: runtimeConfig.defaultModel,
    defaultReasoning: runtimeConfig.defaultReasoning,
  });
  const latestUserPrompt = extractLatestUserContent(normalizedMessages);
  const latestUserInputs = extractLatestUserInputs(normalizedMessages);
  const conversationPrompt = buildConversationPrompt(normalizedMessages);
  const conversationInputs = buildConversationInputs(normalizedMessages);
  const systemPrompt = buildSystemPrompt(
    normalizedMessages,
    buildRuntimeTruthPrompt({
      model: resolvedModel,
      reasoning: resolvedReasoning,
      sandboxMode: runtimeConfig.sandboxMode,
      networkAccess: runtimeConfig.networkAccess,
      webSearch: runtimeConfig.webSearch,
      workingDirectory: runtimeConfig.workingDirectory,
    }),
  );
  const finalPrompt = sessionProvided
    ? mergePrompts(systemPrompt, latestUserPrompt)
    : mergePrompts(systemPrompt, conversationPrompt);
  const finalStructuredPrompt = sessionProvided
    ? mergeStructuredPrompts(systemPrompt, latestUserInputs)
    : mergeStructuredPrompts(systemPrompt, conversationInputs);
  if (
    !finalPrompt &&
    (!finalStructuredPrompt || finalStructuredPrompt.length === 0)
  ) {
    return res.status(400).json({
      error: {
        message: "Messages must include at least one user entry.",
        type: "invalid_request_error",
      },
    });
  }
  const codexInput = finalStructuredPrompt ?? finalPrompt;
  const turnOptions = {};
  if (outputSchema) turnOptions.outputSchema = outputSchema;
  const attachmentCleanups = collectAttachmentCleanups(normalizedMessages);
  const threadOptions = {
    skipGitRepoCheck: SHOULD_SKIP_GIT,
    model: resolvedModel,
    modelReasoningEffort: toCodexReasoning(resolvedReasoning),
  };
  if (runtimeConfig.sandboxMode) threadOptions.sandboxMode = runtimeConfig.sandboxMode;
  if (runtimeConfig.workingDirectory)
    threadOptions.workingDirectory = runtimeConfig.workingDirectory;
  if (runtimeConfig.networkAccess !== null)
    threadOptions.networkAccessEnabled = runtimeConfig.networkAccess;
  if (runtimeConfig.webSearch !== null)
    threadOptions.webSearchEnabled = runtimeConfig.webSearch;
  if (runtimeConfig.approvalPolicy)
    threadOptions.approvalPolicy = runtimeConfig.approvalPolicy;

  const runtimeFactsAnswer = buildRuntimeFactsAnswer(latestUserPrompt, {
    model: resolvedModel,
    reasoning: resolvedReasoning,
    sandboxMode: runtimeConfig.sandboxMode,
    networkAccess: runtimeConfig.networkAccess,
    webSearch: runtimeConfig.webSearch,
    workingDirectory: runtimeConfig.workingDirectory,
  });
  if (runtimeFactsAnswer) {
    return res.json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: threadOptions.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: runtimeFactsAnswer,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 1,
        total_tokens: 1,
      },
    });
  }

  if (APPROVALS_ENABLED) {
    const approvalDecision = evaluateApprovalRequirement({
      sessionId,
      prompt: finalPrompt ?? latestUserPrompt ?? "",
      normalizedMessages,
      codexInput,
      model: resolvedModel,
      reasoning: resolvedReasoning,
      sessionProvided,
      deliveryTarget:
        typeof req.body?.approval_delivery_target === "string"
          ? req.body.approval_delivery_target.trim().toLowerCase()
          : "weixin",
    });
    if (approvalDecision.requiresApproval) {
      const record = await createApprovalRequest({
        sessionId,
        sessionProvided,
        model: resolvedModel,
        reasoning: resolvedReasoning,
        codexInput,
        latestUserPrompt,
        approvalDecision,
      });
      return res.json(buildApprovalQueuedResponse(record, threadOptions.model));
    }
  }

  const threadRecord = await getOrCreateThread(sessionId, threadOptions, {
    ephemeral: !sessionProvided,
  });
  const { thread } = threadRecord;

  if (stream) {
    if (LOG_REQUESTS) {
      console.log(
        "[Codex Bridge] runStreamed payload:",
        JSON.stringify(
          {
            session_id: sessionId,
            model: threadOptions.model,
            reasoning: threadOptions.modelReasoningEffort,
            sandboxMode: threadOptions.sandboxMode,
            workingDirectory: threadOptions.workingDirectory,
            networkAccessEnabled: threadOptions.networkAccessEnabled,
            webSearchEnabled: threadOptions.webSearchEnabled,
            approvalPolicy: threadOptions.approvalPolicy,
            prompt: codexInput,
            response_format: outputSchema ? "json_schema" : "text",
            output_schema: outputSchema,
            ephemeral: !sessionProvided,
          },
          null,
          2,
        ),
      );
    }
    await handleStreamResponse({
      res,
      thread,
      threadOptions,
      sessionId,
      prompt: codexInput,
      shouldPersist: sessionProvided,
      turnOptions,
      cleanupTasks: attachmentCleanups,
    });
    return;
  }

  try {
    if (LOG_REQUESTS) {
      console.log(
        "[Codex Bridge] run payload:",
        JSON.stringify(
          {
            session_id: sessionId,
            model: threadOptions.model,
            reasoning: threadOptions.modelReasoningEffort,
            sandboxMode: threadOptions.sandboxMode,
            workingDirectory: threadOptions.workingDirectory,
            networkAccessEnabled: threadOptions.networkAccessEnabled,
            webSearchEnabled: threadOptions.webSearchEnabled,
            approvalPolicy: threadOptions.approvalPolicy,
            prompt: codexInput,
            response_format: outputSchema ? "json_schema" : "text",
            output_schema: outputSchema,
            ephemeral: !sessionProvided,
          },
          null,
          2,
        ),
      );
    }
    // Broadcast session start to CLI clients
    broadcastToCLIClients({
      type: "session.started",
      sessionId: sessionProvided ? sessionId : null,
      model: threadOptions.model,
      prompt: latestUserPrompt ?? finalPrompt,
      promptPreview:
        (latestUserPrompt ?? finalPrompt).slice(0, 100) +
        ((latestUserPrompt ?? finalPrompt).length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });

    // 改为流式执行，但收集完整结果后一次性返回，同时实时打印到控制台
    console.log("[Codex] Starting non-stream execution with real-time logs...");
    const streamed = await thread.runStreamed(codexInput, turnOptions);
    let fullText = "";
    let usage = undefined;

    for await (const event of streamed.events) {
      // 实时打印到服务器控制台
      console.log("[Codex Event]", event?.type, JSON.stringify(event, null, 2));

      // Broadcast to CLI clients for real-time web terminal display
      broadcastToCLIClients({
        type: "codex.event",
        eventType: event?.type,
        event: event,
        timestamp: new Date().toISOString(),
      });

      if (event?.type === "turn.completed") {
        usage = formatUsage(event?.usage);
      }
      if (event?.type === "turn.failed") {
        throw new Error(event?.error?.message ?? "Codex turn failed.");
      }

      const text = extractAgentMessageText(event);
      if (typeof text === "string") {
        if (text.length > fullText.length) {
          const delta = text.slice(fullText.length);
          fullText = text;
          process.stdout.write(delta); // 实时输出到控制台
          
          // Broadcast text delta to CLI clients
          broadcastToCLIClients({
            type: "codex.delta",
            content: delta,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
    console.log("\n[Codex] Execution completed.");
    
    // Broadcast completion
    broadcastToCLIClients({
      type: "session.completed",
      sessionId: sessionProvided ? sessionId : null,
      timestamp: new Date().toISOString(),
    });

    if (sessionProvided) {
      await persistThreadIdIfNeeded(sessionId, thread);
    }

    return res.json({
      id: `chatcmpl-${thread.id ?? crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: threadOptions.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullText || extractAssistantResponse({ items: [{ type: "agent_message", text: fullText }] }),
          },
          finish_reason: "stop",
        },
      ],
      usage: usage || { prompt_tokens: 0, completion_tokens: fullText.length / 4, total_tokens: fullText.length / 4 },
    });
  } catch (error) {
    console.error("Codex run failed:", error);
    broadcastToCLIClients({
      type: "session.failed",
      sessionId: sessionProvided ? sessionId : null,
      error: error?.message ?? "Codex execution failed.",
      timestamp: new Date().toISOString(),
    });
    return res.status(500).json({
      error: {
        message: error?.message ?? "Codex execution failed.",
        type: "codex_execution_error",
      },
    });
  } finally {
    await cleanupAttachmentFiles(attachmentCleanups);
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: {
      message: err?.message ?? "Unexpected server error.",
      type: "internal_server_error",
    },
  });
});

app.get("/v1/approvals", async (req, res) => {
  try {
    const status =
      typeof req.query.status === "string"
        ? req.query.status.trim().toLowerCase()
        : "pending";
    const allowed = ["pending", "approved", "running", "completed", "rejected", "failed"];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: {
          message: `Unsupported approval status "${status}".`,
          type: "invalid_request_error",
        },
      });
    }
    const records = await listApprovalRecords(__dirname, status);
    return res.json({
      object: "list",
      data: records.map((record) => summarizeApprovalRecord(record)),
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        message: error?.message ?? "Failed to list approvals.",
        type: "internal_server_error",
      },
    });
  }
});

app.get("/v1/approvals/:id", async (req, res) => {
  try {
    const found = await findApprovalRecord(__dirname, req.params.id);
    if (!found) {
      return res.status(404).json({
        error: {
          message: "Approval record not found.",
          type: "not_found",
        },
      });
    }
    return res.json({
      approval: found.record,
      summary: summarizeApprovalRecord(found.record),
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        message: error?.message ?? "Failed to read approval record.",
        type: "internal_server_error",
      },
    });
  }
});

if (APPROVALS_ENABLED) {
  await ensureApprovalDirectories(__dirname);
  setInterval(() => {
    processApprovedQueue().catch((error) => {
      console.error("Approval queue processor failed:", error);
    });
  }, APPROVAL_POLL_INTERVAL_MS);
}

await new Promise((resolve) => {
  app.listen(PORT, () => {
    console.log(
      `Codex OpenAI-compatible bridge listening on http://localhost:${PORT}`,
    );
    resolve();
  });
});

function normalizeReasoning(value) {
  if (!value) return null;
  const lowered = String(value).toLowerCase();
  // Support "xhigh" / "extra-high" / "extra_high" -> internal "extra-high"
  if (lowered === "xhigh" || lowered === "extra-high" || lowered === "extra_high") {
    return "extra-high";
  }
  if (["minimal", "low", "medium", "high"].includes(lowered)) {
    return lowered;
  }
  return null;
}

function toCodexReasoning(internalValue) {
  // Convert internal reasoning value to Codex CLI format
  // Codex CLI uses "xhigh" for extra-high
  if (internalValue === "extra-high") {
    return "xhigh";
  }
  return internalValue;
}

function buildConversationPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const lines = [];
  for (const entry of messages) {
    if (!entry?.role || !entry?.text) continue;
    lines.push(`[${entry.role.toUpperCase()}]\n${entry.text}`.trim());
  }
  return lines.length ? lines.join("\n\n") : null;
}

function buildConversationInputs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const inputs = [];
  for (const entry of messages) {
    if (!entry?.role) continue;
    const label = `[${entry.role.toUpperCase()}]`;
    let prefixed = false;
    if (entry.text) {
      inputs.push({
        type: "text",
        text: `${label}\n${entry.text}`.trim(),
      });
      prefixed = true;
    }
    if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
      if (!prefixed) {
        inputs.push({ type: "text", text: label });
        prefixed = true;
      }
      for (const attachment of entry.attachments) {
        if (attachment?.path) {
          inputs.push({ type: "local_image", path: attachment.path });
        }
      }
    }
  }
  return inputs.length ? inputs : null;
}

function extractLatestUserContent(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.role !== "user") continue;
    if (entry?.text) return entry.text;
  }
  return null;
}

function extractLatestUserInputs(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.role !== "user") continue;
    const inputs = [];
    if (entry?.text) {
      inputs.push({ type: "text", text: entry.text });
    }
    if (Array.isArray(entry?.attachments)) {
      for (const attachment of entry.attachments) {
        if (attachment?.path) {
          inputs.push({ type: "local_image", path: attachment.path });
        }
      }
    }
    return inputs.length ? inputs : null;
  }
  return null;
}

function buildSystemPrompt(messages, runtimeTruthPrompt = null) {
  const blocks = [];
  if (runtimeTruthPrompt) {
    blocks.push(`[SYSTEM]\n${runtimeTruthPrompt}`.trim());
  }
  if (!Array.isArray(messages)) {
    return blocks.length ? blocks.join("\n\n") : null;
  }
  for (const entry of messages) {
    if (entry?.role !== "system" || !entry?.text) continue;
    blocks.push(`[SYSTEM]\n${entry.text}`.trim());
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

function buildRuntimeTruthPrompt({
  model,
  reasoning,
  sandboxMode,
  networkAccess,
  webSearch,
  workingDirectory,
}) {
  const workspaceLabel = workingDirectory ?? "the configured workspace";
  const runtimeFacts = [
    `Runtime facts: model=${model}:${reasoning}.`,
    `Normal sandbox=${sandboxMode ?? "default"}.`,
    `Network access=${networkAccess ? "enabled" : "disabled"}.`,
    `Web search=${webSearch ? "enabled" : "disabled"}.`,
    `Writes outside ${workspaceLabel} require approval.`,
    "If asked about model, permissions, or network, use these facts instead of prior conversation memory.",
  ];
  return runtimeFacts.join(" ");
}

function buildRuntimeFactsAnswer(prompt, runtime) {
  const text = String(prompt ?? "").trim();
  if (!text) return null;

  const asksModel = /(模型|型号|model)/i.test(text);
  const asksNetwork = /(联网|网络|web search|websearch|internet|online)/i.test(text);
  const asksPermissions = /(写入权限|权限|只读|沙箱|sandbox|审批|approval|写文件)/i.test(text);

  if (!asksModel && !asksNetwork && !asksPermissions) {
    return null;
  }

  if (text.length > 120 && !(asksModel && asksNetwork && asksPermissions)) {
    return null;
  }

  const lines = [];
  if (asksModel) {
    lines.push(`模型：${runtime.model}:${runtime.reasoning}`);
  }
  if (asksNetwork) {
    lines.push(`联网：${runtime.networkAccess ? "已开启" : "未开启"}；Web search：${runtime.webSearch ? "已开启" : "未开启"}`);
  }
  if (asksPermissions) {
    lines.push(
      `权限：普通线程是 ${runtime.sandboxMode ?? "default"}；工作区内可写，工作区外写入需要审批。`
    );
  }
  return lines.join("\n");
}

function mergePrompts(systemPrompt, userPrompt) {
  if (!userPrompt) return null;
  if (!systemPrompt) return userPrompt;
  return `${systemPrompt}\n\n${userPrompt}`;
}

function mergeStructuredPrompts(systemPrompt, userInputs) {
  const inputs = [];
  if (systemPrompt) {
    inputs.push({ type: "text", text: systemPrompt });
  }
  if (Array.isArray(userInputs) && userInputs.length > 0) {
    inputs.push(...userInputs);
  }
  return inputs.length ? inputs : null;
}

function resolveSessionId(req) {
  const body = req?.body ?? {};
  const headers = req?.headers ?? {};
  const readHeader = (key) => {
    const value = headers[String(key).toLowerCase()];
    if (value === undefined || value === null) return null;
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  };
  return (
    body?.session_id ??
    body?.conversation_id ??
    body?.thread_id ??
    body?.user ??
    readHeader("x-session-id") ??
    readHeader("session-id") ??
    readHeader("x-conversation-id") ??
    readHeader("x-thread-id") ??
    readHeader("x-user-id") ??
    null
  );
}

function getModelPreset(modelId) {
  if (!modelId) return null;
  const normalized = String(modelId).toLowerCase();
  return MODEL_PRESETS.find((preset) => preset.id === normalized) ?? null;
}

function resolveModelAndReasoning({
  model,
  reasoning,
  defaultModel = DEFAULT_MODEL,
  defaultReasoning = DEFAULT_REASONING,
}) {
  if (!model) {
    return {
      resolvedModel: defaultModel,
      resolvedReasoning: defaultReasoning,
    };
  }

  const split = String(model).toLowerCase().split(":");
  const modelId = split[0];
  const appendedReasoning = split[1];
  const modelPreset = getModelPreset(modelId) ?? getModelPreset(defaultModel);

  const requestedReasoning = normalizeReasoning(reasoning ?? appendedReasoning);
  const allowedReasoning =
    requestedReasoning &&
    modelPreset?.reasonings?.some((r) => r.level === requestedReasoning)
      ? requestedReasoning
      : modelPreset?.defaultReasoning ?? defaultReasoning;

  return {
    resolvedModel: modelPreset?.id ?? defaultModel,
    resolvedReasoning: allowedReasoning,
  };
}

function buildRuntimeConfigSnapshot() {
  return {
    model: runtimeConfig.defaultModel,
    reasoning: runtimeConfig.defaultReasoning,
    sandboxMode: runtimeConfig.sandboxMode,
    workingDirectory: runtimeConfig.workingDirectory,
    networkAccess: runtimeConfig.networkAccess,
    webSearch: runtimeConfig.webSearch,
    approvalPolicy: runtimeConfig.approvalPolicy,
  };
}

function applyRuntimeConfigUpdates(updates) {
  if (!updates || typeof updates !== "object") {
    throw new Error("Updates payload must be an object.");
  }

  const next = {
    ...runtimeConfig,
  };

  const requestedModelRaw =
    typeof updates.model === "string" ? updates.model.trim().toLowerCase() : null;
  const requestedModelPart =
    requestedModelRaw && requestedModelRaw.includes(":")
      ? requestedModelRaw.split(":")[0]
      : requestedModelRaw;
  const requestedReasoningFromModel =
    requestedModelRaw && requestedModelRaw.includes(":")
      ? normalizeReasoning(requestedModelRaw.split(":")[1])
      : null;
  const hasReasoningField = Object.prototype.hasOwnProperty.call(
    updates,
    "reasoning",
  );
  const requestedReasoningField = hasReasoningField
    ? normalizeReasoning(updates.reasoning)
    : null;

  if (requestedModelPart && !getModelPreset(requestedModelPart)) {
    throw new Error(`Unsupported model "${requestedModelPart}".`);
  }
  if (hasReasoningField && !requestedReasoningField) {
    throw new Error(`Unsupported reasoning "${String(updates.reasoning)}".`);
  }

  if (requestedModelPart || hasReasoningField || requestedReasoningFromModel) {
    const resolved = resolveModelAndReasoning({
      model: requestedModelPart ?? next.defaultModel,
      reasoning:
        requestedReasoningField ??
        requestedReasoningFromModel ??
        (hasReasoningField ? updates.reasoning : next.defaultReasoning),
      defaultModel: next.defaultModel,
      defaultReasoning: next.defaultReasoning,
    });
    next.defaultModel = resolved.resolvedModel;
    next.defaultReasoning = resolved.resolvedReasoning;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "sandboxMode")) {
    if (updates.sandboxMode === null || updates.sandboxMode === "") {
      next.sandboxMode = null;
    } else {
      const normalized = normalizeSandboxMode(updates.sandboxMode);
      if (!normalized) {
        throw new Error(`Unsupported sandbox mode "${String(updates.sandboxMode)}".`);
      }
      next.sandboxMode = normalized;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, "workingDirectory")) {
    if (updates.workingDirectory === null || updates.workingDirectory === "") {
      next.workingDirectory = null;
    } else if (typeof updates.workingDirectory === "string") {
      next.workingDirectory = resolveWorkingDirectory(updates.workingDirectory.trim());
    } else {
      throw new Error("workingDirectory must be a string, empty string, or null.");
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, "networkAccess")) {
    const parsed = parseBooleanLike(updates.networkAccess);
    if (parsed === null) {
      throw new Error(`Unsupported networkAccess value "${String(updates.networkAccess)}".`);
    }
    next.networkAccess = parsed;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "webSearch")) {
    const parsed = parseBooleanLike(updates.webSearch);
    if (parsed === null) {
      throw new Error(`Unsupported webSearch value "${String(updates.webSearch)}".`);
    }
    next.webSearch = parsed;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "approvalPolicy")) {
    if (updates.approvalPolicy === null || updates.approvalPolicy === "") {
      next.approvalPolicy = null;
    } else {
      const normalized = normalizeApprovalPolicy(updates.approvalPolicy);
      if (!normalized) {
        throw new Error(
          `Unsupported approval policy "${String(updates.approvalPolicy)}".`,
        );
      }
      next.approvalPolicy = normalized;
    }
  }

  runtimeConfig.defaultModel = next.defaultModel;
  runtimeConfig.defaultReasoning = next.defaultReasoning;
  runtimeConfig.sandboxMode = next.sandboxMode;
  runtimeConfig.workingDirectory = next.workingDirectory;
  runtimeConfig.networkAccess = next.networkAccess;
  runtimeConfig.webSearch = next.webSearch;
  runtimeConfig.approvalPolicy = next.approvalPolicy;
  inMemoryThreads.clear();

  return buildRuntimeConfigSnapshot();
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "enable", "enabled"].includes(normalized))
    return true;
  if (["0", "false", "no", "n", "off", "disable", "disabled"].includes(normalized))
    return false;
  return null;
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
  return SANDBOX_OPTIONS.includes(normalized) ? normalized : null;
}

function normalizeApprovalPolicy(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  return APPROVAL_POLICY_OPTIONS.includes(normalized) ? normalized : null;
}

function resolveWorkingDirectory(value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return path.resolve(__dirname, value);
}

function resolveOutputSchemaFromBody(body) {
  if (!body || typeof body !== "object") return null;
  if (body.output_schema !== undefined) {
    return ensureJsonSchemaObject(body.output_schema, "output_schema");
  }
  if (body.outputSchema !== undefined) {
    return ensureJsonSchemaObject(body.outputSchema, "outputSchema");
  }
  const responseFormat = body.response_format ?? body.responseFormat;
  if (responseFormat === undefined || responseFormat === null) return null;
  if (typeof responseFormat === "string") {
    const normalized = responseFormat.toLowerCase();
    if (normalized === "json_schema") {
      throw new Error(
        "response_format \"json_schema\" requires an accompanying schema.",
      );
    }
    if (normalized === "json_object") {
      return { type: "object" };
    }
    return null;
  }
  if (!isPlainObject(responseFormat)) {
    throw new Error("response_format must be an object when provided.");
  }
  const type =
    typeof responseFormat.type === "string"
      ? responseFormat.type.toLowerCase()
      : null;
  if (type === "json_schema" || responseFormat.json_schema || responseFormat.schema) {
    const schemaCandidate =
      responseFormat?.json_schema?.schema ??
      responseFormat?.schema ??
      responseFormat?.json_schema;
    if (!schemaCandidate) {
      throw new Error(
        "response_format.json_schema.schema must be provided for type=json_schema.",
      );
    }
    return ensureJsonSchemaObject(
      schemaCandidate,
      "response_format.json_schema.schema",
    );
  }
  if (type === "json_object") {
    return { type: "object" };
  }
  if (type && type !== "text") {
    throw new Error(`Unsupported response_format type "${responseFormat.type}".`);
  }
  if (responseFormat.schema) {
    return ensureJsonSchemaObject(responseFormat.schema, "response_format.schema");
  }
  return null;
}

function ensureJsonSchemaObject(candidate, label = "output schema") {
  if (!isPlainObject(candidate)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return candidate;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const normalized = [];
  for (let i = 0; i < messages.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    normalized.push(await normalizeMessageEntry(messages[i], i));
  }
  return normalized;
}

async function normalizeMessageEntry(entry, index) {
  if (!entry || typeof entry !== "object") {
    return { role: null, text: null, attachments: [] };
  }
  const role =
    typeof entry.role === "string" ? entry.role.trim().toLowerCase() : null;
  const text = extractTextContent(entry);
  const attachments = await extractImageAttachments(entry, index);
  return { role, text, attachments };
}

function extractTextContent(entry) {
  if (typeof entry?.content === "string") return entry.content;
  if (!Array.isArray(entry?.content)) return null;
  const textBlocks = entry.content
    .filter((block) => block?.type === "text" && block?.text)
    .map((block) => block.text);
  if (textBlocks.length === 0) return null;
  return textBlocks.join("\n");
}

async function extractImageAttachments(entry, index) {
  if (!Array.isArray(entry?.content)) return [];
  const attachments = [];
  for (const block of entry.content) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveImageBlock(block, index);
    if (resolved) attachments.push(resolved);
  }
  return attachments;
}

async function resolveImageBlock(block, index) {
  if (!block || typeof block !== "object") return null;
  const type = block.type;
  if (type === "local_image") {
    const candidate =
      typeof block.path === "string"
        ? block.path
        : typeof block.image_path === "string"
          ? block.image_path
          : null;
    if (!candidate) {
      throw new Error(`Message ${index + 1} local_image block is missing path.`);
    }
    return { path: resolveImagePath(candidate) };
  }
  if (type === "image_url" || type === "input_image") {
    const candidate =
      typeof block.image_url?.url === "string"
        ? block.image_url.url
        : typeof block.url === "string"
          ? block.url
          : null;
    if (!candidate) {
      throw new Error(`Message ${index + 1} image_url block is missing url.`);
    }
    return resolveImageUrlReference(candidate);
  }
  return null;
}

function resolveImagePath(value) {
  if (typeof value !== "string") {
    throw new Error("Image reference must be a string path or URL.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Image reference cannot be empty.");
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    const scheme = trimmed.split(":")[0].toLowerCase();
    if (scheme !== "file") {
      throw new Error(
        "Only file:// URLs, HTTP(S) URLs, or local file paths are supported for images.",
      );
    }
    try {
      return fileURLToPath(trimmed);
    } catch {
      throw new Error("Invalid file:// URL provided for image attachment.");
    }
  }
  if (/^[a-z]+:/i.test(trimmed)) {
    throw new Error(
      "Only file:// URLs, HTTP(S) URLs, or local file paths are supported for images.",
    );
  }
  const baseDir = WORKING_DIRECTORY ?? process.cwd();
  return path.resolve(baseDir, trimmed);
}

async function resolveImageUrlReference(value) {
  if (typeof value !== "string") {
    throw new Error("Image reference must be a string path or URL.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Image reference cannot be empty.");
  }
  if (trimmed.startsWith("data:")) {
    return createTempFileFromDataUrl(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return downloadImageToTempFile(trimmed);
  }
  return { path: resolveImagePath(trimmed) };
}

async function createTempFileFromDataUrl(dataUrl) {
  const match = /^data:(?<mime>[^;]+);base64,(?<payload>.+)$/i.exec(dataUrl);
  if (!match?.groups?.payload) {
    throw new Error("Invalid data URL provided for image attachment.");
  }
  const mime = match.groups.mime;
  const base64 = match.groups.payload.replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");
  return writeTempImageFile(buffer, inferExtensionFromMime(mime));
}

async function downloadImageToTempFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download image from ${url} (status ${response.status}).`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type");
  return writeTempImageFile(buffer, inferExtensionFromMime(contentType));
}

async function writeTempImageFile(buffer, extension = ".png") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-image-"));
  const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const filePath = path.join(dir, `attachment${safeExtension}`);
  await fs.writeFile(filePath, buffer);
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to remove temporary image directory:", error);
    }
  };
  return { path: filePath, cleanup };
}

function inferExtensionFromMime(mime) {
  if (!mime) return ".png";
  const normalized = mime.toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("bmp")) return ".bmp";
  return ".png";
}

function collectAttachmentCleanups(messages) {
  const cleanups = [];
  if (!Array.isArray(messages)) return cleanups;
  for (const entry of messages) {
    if (!Array.isArray(entry?.attachments)) continue;
    for (const attachment of entry.attachments) {
      if (typeof attachment?.cleanup === "function") {
        cleanups.push(attachment.cleanup);
      }
    }
  }
  return cleanups;
}

async function cleanupAttachmentFiles(cleanups) {
  if (!Array.isArray(cleanups) || cleanups.length === 0) return;
  await Promise.all(
    cleanups.map(async (cleanup) => {
      try {
        await cleanup();
      } catch (error) {
        console.warn("Failed to cleanup temporary attachment:", error);
      }
    }),
  );
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildDashboardSnapshot() {
  const account = await readAccountMetadata();
  return {
    generatedAt: new Date().toISOString(),
    account,
    stats: {
      totalRequests: requestCounter,
      activeSessions: persistedThreadIds.size,
      uptimeSeconds: Math.floor((Date.now() - APP_START) / 1000),
      sandboxMode: runtimeConfig.sandboxMode ?? "default",
      approvalPolicy: runtimeConfig.approvalPolicy ?? "never",
      networkAccess: Boolean(runtimeConfig.networkAccess),
      webSearch: Boolean(runtimeConfig.webSearch),
      version: APP_VERSION,
    },
    tokens: Array.isArray(account?.tokens) ? account.tokens : [],
  };
}

async function readAccountMetadata() {
  const auth = await readJsonFile(CODEX_AUTH_FILE);
  if (!auth) {
    return {
      status: "missing",
      source: CODEX_AUTH_FILE,
    };
  }

  const tokens = auth?.tokens ?? {};
  const idToken =
    tokens?.id_token ??
    tokens?.idToken ??
    auth?.id_token ??
    auth?.idToken ??
    null;
  const accessToken =
    tokens?.access_token ??
    tokens?.accessToken ??
    auth?.access_token ??
    null;

  const idPayload = idToken ? decodeJwtPayload(idToken) : null;
  const accessPayload = accessToken ? decodeJwtPayload(accessToken) : null;

  const issuedAt = unixToIso(accessPayload?.iat ?? idPayload?.iat);
  const expiresAt = unixToIso(accessPayload?.exp ?? idPayload?.exp);
  const status = deriveStatus(accessPayload?.exp ?? idPayload?.exp);

  const tokenMeta = [];
  if (accessToken) {
    tokenMeta.push({
      type: "Access Token",
      email:
        accessPayload?.["https://api.openai.com/profile"]?.email ??
        accessPayload?.email ??
        null,
      issuer: accessPayload?.iss ?? null,
      issuedAt: unixToIso(accessPayload?.iat),
      expiresAt: unixToIso(accessPayload?.exp),
      status: deriveStatus(accessPayload?.exp),
      preview: formatTokenPreview(accessToken),
      scopes: accessPayload?.scope ?? tokens?.scope ?? tokens?.scopes ?? null,
      audience: Array.isArray(accessPayload?.aud)
        ? accessPayload.aud.join(", ")
        : accessPayload?.aud ?? null,
    });
  }

  return {
    status,
    email:
      idPayload?.email ??
      accessPayload?.["https://api.openai.com/profile"]?.email ??
      auth?.email ??
      null,
    issuer: idPayload?.iss ?? accessPayload?.iss ?? null,
    accountId: tokens?.account_id ?? auth?.account_id ?? null,
    subject: idPayload?.sub ?? accessPayload?.sub ?? null,
    issuedAt,
    expiresAt,
    device: auth?.device?.name ?? auth?.device_id ?? null,
    source: CODEX_AUTH_FILE,
    tokens: tokenMeta,
  };
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function readJsonFile(targetPath) {
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function unixToIso(value) {
  if (value === undefined || value === null) return null;
  return new Date(value * 1000).toISOString();
}

function deriveStatus(exp) {
  if (exp === undefined || exp === null) return "unknown";
  return Date.now() > exp * 1000 ? "expired" : "active";
}

function formatTokenPreview(token) {
  if (!token || token.length < 12) return token ?? null;
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}

async function getOrCreateThread(sessionId, threadOptions, options = {}) {
  const cacheKey = `${sessionId}:${options.cacheKey ?? "default"}`;
  const cached = inMemoryThreads.get(cacheKey);
  if (cached) return cached;

  const persistedId = persistedThreadIds.get(sessionId);
  let thread;
  if (persistedId) {
    try {
      thread = codex.resumeThread(persistedId, threadOptions);
      inMemoryThreads.set(cacheKey, { thread });
      return { thread };
    } catch (error) {
      console.warn(
        `Failed to resume thread ${persistedId} for session ${sessionId}:`,
        error?.message ?? error,
      );
    }
  }

  thread = codex.startThread(threadOptions);
  inMemoryThreads.set(cacheKey, { thread });
  return { thread };
}

async function persistThreadIdIfNeeded(sessionId, thread) {
  if (!thread?.id) return;
  if (persistedThreadIds.get(sessionId) === thread.id) return;
  persistedThreadIds.set(sessionId, thread.id);
  await saveQueue(async () => saveState(persistedThreadIds));
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Object.entries(parsed.sessions ?? {});
    return new Map(entries);
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

function createSaveQueue() {
  let last = Promise.resolve();
  return (task) => {
    last = last.then(() => task()).catch((err) => {
      console.error("Failed to persist thread IDs:", err);
    });
    return last;
  };
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

function extractAgentMessageText(event) {
  const item = event?.item;
  if (!item) return null;
  if (item.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  return null;
}

async function handleStreamResponse({
  res,
  thread,
  threadOptions,
  sessionId,
  prompt,
  shouldPersist = true,
  turnOptions = {},
  cleanupTasks = [],
}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-${thread.id ?? crypto.randomUUID()}`;
  const chunkBase = {
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model: threadOptions.model,
  };
  const sendChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const sendDone = () => {
    res.write("data: [DONE]\n\n");
  };

  const sendDelta = (delta, finishReason = null, usage = null, extra = {}) => {
    const chunk = {
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
      ...extra,
    };
    if (usage) chunk.usage = usage;
    sendChunk(chunk);
  };

  const promptText =
    typeof prompt === "string" ? prompt : stringifyStructuredInput(prompt);

  // Broadcast session start to CLI clients
  broadcastToCLIClients({
    type: "session.started",
    sessionId,
    model: threadOptions.model,
    prompt: promptText,
    promptPreview:
      promptText.slice(0, 100) + (promptText.length > 100 ? "..." : ""),
    timestamp: new Date().toISOString(),
  });

  try {
    const streamed = await thread.runStreamed(prompt, turnOptions);
    let bufferedText = "";
    let roleSent = false;
    let usage = undefined;

    for await (const event of streamed.events) {
      // 实时打印到服务器控制台
      console.log("[Codex Event]", JSON.stringify(event, null, 2));

      // Broadcast to CLI clients for real-time web terminal display
      broadcastToCLIClients({
        type: "codex.event",
        eventType: event?.type,
        event: event,
        timestamp: new Date().toISOString(),
      });

      if (event?.type === "turn.completed") {
        usage = formatUsage(event?.usage);
        continue;
      }
      if (event?.type === "turn.failed") {
        throw new Error(event?.error?.message ?? "Codex turn failed.");
      }

      const text = extractAgentMessageText(event);
      if (typeof text === "string") {
        if (!roleSent) {
          sendDelta({ role: "assistant" });
          roleSent = true;
        }
        if (text.length > bufferedText.length) {
          const deltaContent = text.slice(bufferedText.length);
          bufferedText = text;
          sendDelta({ content: deltaContent });
          // 实时打印输出内容
          process.stdout.write(deltaContent);
          
          // Broadcast text delta to CLI clients
          broadcastToCLIClients({
            type: "codex.delta",
            content: deltaContent,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
    console.log("\n[Codex] Response completed.");

    if (shouldPersist) {
      await persistThreadIdIfNeeded(sessionId, thread);
    }
    sendDelta({}, "stop", usage);
    sendDone();
    res.end();
  } catch (error) {
    console.error("Codex stream failed:", error);
    sendChunk({
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "error",
        },
      ],
      error: {
        message: error?.message ?? "Codex streaming failed.",
        type: "codex_stream_error",
      },
    });
    sendDone();
    res.end();
  } finally {
    await cleanupAttachmentFiles(cleanupTasks);
  }
}

function summarizeApprovalRecord(record) {
  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sessionId: record.sessionId,
    deliveryTarget: record.deliveryTarget ?? null,
    riskLevel: record.riskLevel ?? "medium",
    reasonSummary: record.reasonSummary ?? "",
    promptPreview: truncateText(record.latestUserPrompt ?? "", 160),
  };
}

function truncateText(value, limit = 160) {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function buildApprovalQueuedResponse(record, model) {
  return {
    id: `chatcmpl-${record.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: record.noticeText,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 1,
      total_tokens: 1,
    },
    approval: {
      required: true,
      id: record.id,
      status: record.status,
      risk_level: record.riskLevel,
    },
  };
}

function evaluateApprovalRequirement({
  prompt,
  normalizedMessages,
  codexInput,
  deliveryTarget,
}) {
  const text = [
    typeof prompt === "string" ? prompt : "",
    extractLatestUserContent(normalizedMessages),
    typeof codexInput === "string" ? codexInput : stringifyStructuredInput(codexInput),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    return {
      requiresApproval: false,
      reasons: [],
      riskLevel: "low",
      reasonSummary: "",
      deliveryTarget,
    };
  }

  const matches = [];
  const actionVerbPattern =
    /(执行|运行|修改|写入|创建|删除|移动|复制|安装|卸载|注册|停止|启动|kill|remove|delete|write|create|install|uninstall|register|stop|start|move|copy|set|change|edit|update|run|execute)/i;

  if (/(winget|choco|apt-get|apt |yum |brew |pip install|npm install|pnpm add|cargo install)/i.test(text)) {
    matches.push("涉及安装或卸载软件/依赖");
  }

  if (/(注册表|registry|HKLM\\|HKCU\\|计划任务|schtasks|service|服务|startup|开机自启|环境变量|Program Files|System32)/i.test(text)) {
    matches.push("涉及系统配置、服务、计划任务或环境变量");
  }

  if (/(删除|清空|格式化|wipe|truncate|drop|reset|rm\s+-|del\s+|remove-item|git reset|git clean|stop-process|taskkill)/i.test(text)) {
    matches.push("涉及删除、重置或停止进程等高风险操作");
  }

  const pathMatches = text.match(/[A-Za-z]:\\[^\s"'`]+/g) ?? [];
  const currentWorkspaceRoot = runtimeConfig.workingDirectory
    ? path.resolve(runtimeConfig.workingDirectory).toLowerCase()
    : WORKSPACE_ROOT_NORMALIZED;
  const currentApprovalSafeRoot =
    resolveApprovalSafeRoot(runtimeConfig.workingDirectory) ??
    APPROVAL_SAFE_ROOT_NORMALIZED;
  for (const rawPath of pathMatches) {
    const normalized = path.resolve(rawPath).toLowerCase();
    const insideCodexWorkspace =
      currentWorkspaceRoot && isPathInside(normalized, currentWorkspaceRoot);
    const insideApprovalSafe =
      currentApprovalSafeRoot && isPathInside(normalized, currentApprovalSafeRoot);
    if (!insideCodexWorkspace && !insideApprovalSafe) {
      matches.push(`涉及工作区外路径：${rawPath}`);
      break;
    }
  }

  if (/(admin|administrator|sudo|提权|越权|管理员权限|elevat)/i.test(text) && actionVerbPattern.test(text)) {
    matches.push("明确请求管理员或越权执行");
  }

  const uniqueReasons = [...new Set(matches)];
  return {
    requiresApproval: uniqueReasons.length > 0,
    reasons: uniqueReasons,
    riskLevel: uniqueReasons.length >= 2 ? "high" : "medium",
    reasonSummary: uniqueReasons.join("；"),
    deliveryTarget,
  };
}

function extractAllUserText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((entry) => entry?.role === "user" && entry?.text)
    .map((entry) => entry.text)
    .join("\n");
}

function stringifyStructuredInput(input) {
  if (!Array.isArray(input)) return "";
  return input
    .map((item) => {
      if (item?.type === "text") return item.text ?? "";
      if (item?.type === "local_image") return `[local_image] ${item.path ?? ""}`.trim();
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function createApprovalRequest({
  sessionId,
  sessionProvided,
  model,
  reasoning,
  codexInput,
  latestUserPrompt,
  approvalDecision,
}) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const noticeText = [
    `[审批请求 #${id}]`,
    "这次请求已转为异步审批，微信不会卡住。",
    `原因：${approvalDecision.reasonSummary}`,
    `批准命令：powershell -NoProfile -ExecutionPolicy Bypass -File C:\\wechat-codex-bridge\\scripts\\approve-codex-approval.ps1 -Id ${id}`,
    `拒绝命令：powershell -NoProfile -ExecutionPolicy Bypass -File C:\\wechat-codex-bridge\\scripts\\reject-codex-approval.ps1 -Id ${id}`,
  ].join("\n");

  const record = {
    id,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    sessionId,
    sessionProvided,
    model,
    reasoning,
    latestUserPrompt,
    codexInput,
    reasons: approvalDecision.reasons,
    reasonSummary: approvalDecision.reasonSummary,
    riskLevel: approvalDecision.riskLevel,
    deliveryTarget: approvalDecision.deliveryTarget ?? "weixin",
    noticeText,
    resultText: null,
    errorText: null,
  };
  await writeApprovalRecord(__dirname, "pending", record);
  return record;
}

async function processApprovedQueue() {
  if (!APPROVALS_ENABLED || approvalWorkerRunning) return;
  approvalWorkerRunning = true;
  try {
    const approved = await listApprovalRecords(__dirname, "approved");
    for (const approval of approved) {
      await runApprovedRecord(approval.id);
    }
  } finally {
    approvalWorkerRunning = false;
  }
}

function isPathInside(candidate, root) {
  if (!candidate || !root) return false;
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

async function runApprovedRecord(id) {
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

  const elevatedThreadOptions = {
    skipGitRepoCheck: SHOULD_SKIP_GIT,
    model: runningRecord.model ?? DEFAULT_MODEL,
    modelReasoningEffort: toCodexReasoning(runningRecord.reasoning ?? DEFAULT_REASONING),
    sandboxMode: APPROVAL_ELEVATED_SANDBOX_MODE ?? SANDBOX_MODE,
    workingDirectory: WORKING_DIRECTORY,
    networkAccessEnabled: APPROVAL_ELEVATED_NETWORK_ACCESS,
    webSearchEnabled: APPROVAL_ELEVATED_WEB_SEARCH,
    approvalPolicy: "never",
  };
  const elevatedSessionId = `elevated:${runningRecord.sessionId}`;

  try {
    const threadRecord = await getOrCreateThread(
      elevatedSessionId,
      elevatedThreadOptions,
      {
        ephemeral: !runningRecord.sessionProvided,
        cacheKey: "elevated",
      },
    );
    const turn = await threadRecord.thread.run(runningRecord.codexInput);
    if (runningRecord.sessionProvided) {
      await persistThreadIdIfNeeded(elevatedSessionId, threadRecord.thread);
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
    await moveApprovalRecord(__dirname, id, "running", "failed", (record) => ({
      ...record,
      status: "failed",
      updatedAt: completedAt,
      completedAt,
      errorText: error?.message ?? "Approved run failed.",
    }));
  }
}
