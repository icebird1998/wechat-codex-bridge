#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_FILE = path.join(__dirname, ".codex_thread.json");
const DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5-codex";
const DEFAULT_REASONING =
  process.env.CODEX_REASONING ?? process.env.CODEX_MODEL_REASONING ?? "medium";

async function loadThreadId() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const { threadId } = JSON.parse(raw);
    return threadId || null;
  } catch {
    return null;
  }
}

async function saveThreadId(threadId) {
  await fs.writeFile(STATE_FILE, JSON.stringify({ threadId }, null, 2), "utf8");
}

async function clearThreadId() {
  try {
    await fs.unlink(STATE_FILE);
  } catch {
    // ignore missing file
  }
}

async function main() {
  const codex = new Codex();

  const threadOptions = {
    skipGitRepoCheck: true,
    model: DEFAULT_MODEL,
    modelReasoningEffort: DEFAULT_REASONING,
  };

  let threadId = await loadThreadId();
  let thread;

  console.log(
    `当前模型：${threadOptions.model}，推理强度：${threadOptions.modelReasoningEffort}`,
  );

  if (threadId) {
    thread = codex.resumeThread(threadId, threadOptions);
    console.log(`✔ 恢复会话：${threadId}`);
  } else {
    thread = codex.startThread(threadOptions);
    console.log("✔ 新建会话，等待 Codex 第一次回复后会生成会话 ID");
  }

  const updateThreadIdIfNeeded = async () => {
    if (!thread.id || thread.id === threadId) return;
    threadId = thread.id;
    await saveThreadId(threadId);
    console.log(`✔ 会话 ID：${threadId}`);
  };

  console.log("提示：输入 /reset 重新开始；/exit 退出。");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "你> ",
  });
  rl.prompt();

  rl
    .on("line", async (line) => {
      const msg = line.trim();
      if (!msg) {
        rl.prompt();
        return;
      }

      if (msg === "/exit") {
        rl.close();
        return;
      }

      if (msg === "/reset") {
        await clearThreadId();
        threadId = null;
        thread = codex.startThread(threadOptions);
        console.log("（已重置）已创建新会话，等待 Codex 回复后会保存 ID");
        rl.prompt();
        return;
      }

      try {
        process.stdout.write("Codex 正在思考与执行...\n");
        const result = await thread.run(msg);
        await updateThreadIdIfNeeded();
        console.log("\nCodex>\n" + (result?.text ?? JSON.stringify(result, null, 2)));
      } catch (err) {
        console.error("运行出错:", err?.message ?? err);
      }

      rl.prompt();
    })
    .on("close", () => {
      console.log("再见～");
      process.exit(0);
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
