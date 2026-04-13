# CodexBridge（中文版）

[English Version](README.md)

CodexBridge 将官方 Codex CLI/SDK 封装成 OpenAI 兼容的 `/v1/chat/completions` 服务，并保留一个极简 CLI，方便在本地直接与 Codex 对话。OpenAI 客户端（OpenWebUI、Cherry Studio、curl 等）都可以把 CodexBridge 当作模型来调用。

## 功能亮点

- **OpenAI 兼容 API**：`/v1/chat/completions`（同步 + SSE）和 `/v1/models`。
- **会话持久化**：通过 `session_id` / `conversation_id` / `thread_id` / `user` 任一字段即可复用 Codex 线程；缺省时自动生成一次性线程。
- **多模态输入**：支持 `image_url`、`local_image` 内容块（HTTP(S)、`file://`、`data:` URI、本地路径），自动转换为 Codex 的 `local_image`。
- **结构化输出**：映射 OpenAI `response_format` / `output_schema` 到 Codex `outputSchema`，强制返回符合 JSON Schema 的结果。
- **可配置沙箱**：通过环境变量控制文件权限、工作目录、联网、Web 搜索、命令审批策略。
- **数据自托管**：Codex 线程保存在 `~/.codex/sessions`，桥接层 session 映射位于 `.codex_threads.json`。

## 环境要求

- Node.js 18+
- 已安装并登录的 Codex CLI（与桥接器运行在同一台机器）
- npm（或根据需要改成 pnpm / yarn）

## 安装

```bash
git clone https://github.com/begonia599/CodexBridge
cd codexbridge
npm install
cp .env.example .env
cp .env .env.local   # 可选：保留一份自定义配置
```

在 `.env` / `.env.local` 中设置默认值（API key、沙箱模式、工作目录等），再启动服务。

## CLI 对话

```bash
npm run codex:chat
```

- 输入自然语言即可对话。
- `/reset` 创建新的 Codex 线程。
- `/exit` 退出 CLI。

线程 ID 缓存于 `.codex_thread.json`，重启 CLI 仍可延续当前会话。

## HTTP 桥接

```bash
npm run codex:server
```

- 默认端口：`8080`（可用 `PORT` 覆盖）
- 健康检查：`GET /health`
- 会话映射：`.codex_threads.json`（删除即可重置桥接层 session）

### 通用请求

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:medium","session_id":"demo","messages":[{"role":"user","content":"ls"}]}'
```

### session_id 与会话持久化

- 建议在前端或生产环境打开 `CODEX_REQUIRE_SESSION_ID=true`，强制所有请求携带会话 ID。
- 可把 ID 写在请求体（`session_id` / `conversation_id` / `thread_id` / `user`）或请求头（`x-session-id`、`session-id`、`x-conversation-id`、`x-thread-id`、`x-user-id`）。
- ID 必须是非空字符串（例如 UUID、用户 ID、聊天 ID）；不要传纯数字或对象。
- 若完全缺省且 `CODEX_REQUIRE_SESSION_ID=false`，桥接器会把整个 `messages` 展开成 `[ROLE]` 块一次性发送，Codex 不会保存该上下文。

### 流式输出

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:high","session_id":"stream","stream":true,"messages":[{"role":"user","content":"一步步介绍如何使用 npm init 创建项目"}]}'
```

### 多模态输入

- `{"type":"image_url","image_url":{"url":"https://example.com/demo.png"}}`
- `{"type":"local_image","path":"./images/demo.png"}`（或 `image_path`）

远程资源会下载到临时目录，转换为 Codex `local_image`，回合结束后自动清理。

### 结构化输出

设置 `response_format`（或顶层 `output_schema`）即可触发 Codex 的 `outputSchema` 功能：

```json
{
  "model": "gpt-5-codex",
  "session_id": "lint",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "lint_report",
      "schema": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" },
          "status": { "type": "string", "enum": ["ok", "action_required"] }
        },
        "required": ["summary", "status"],
        "additionalProperties": false
      }
    }
  },
  "messages": [
    { "role": "user", "content": "检查 src/ 的 lint 问题，并以 JSON 返回结果" }
  ]
}
```

`type: "json_schema"` 必须提供 `schema`，缺失会直接返回 400。

### 联网与 Web 搜索

- `CODEX_NETWORK_ACCESS=true`：允许 Codex 执行联网命令（`curl`、`git clone` 等）。
- `CODEX_WEB_SEARCH=true`：允许 Codex 使用内置 Web 搜索。

默认均为 `false`。

## 源码部署

```bash
cp .env.example .env
npm run codex:server
```

如需常驻后台，可搭配 `pm2`、`systemd`、`nohup` 等方式运行；若需要 HTTPS，可在前面挂 Nginx / Caddy 等反向代理。想要 CLI 配合时再运行 `npm run codex:chat`。

### Linux 一键脚本

```bash
curl -fsSL https://raw.githubusercontent.com/begonia599/CodexBridge/master/scripts/install.sh | bash
```

脚本会：
1. 自动安装 git、Node.js、Docker、Docker Compose（如尚未安装）。
2. 克隆或更新仓库到 `~/codexbridge`（可通过 `CODEXBRIDGE_DIR` 环境变量自定义路径）。
3. 将 `.env.example` 复制为 `.env`（请随后自行编辑）。
4. 执行 `docker compose up -d --build` 启动服务。

> 脚本需要 sudo 权限以安装系统依赖和 Docker。

## Docker 部署

### Docker Compose

```bash
docker compose up -d
docker compose logs -f codexbridge
```

> Compose 会把 Codex 数据挂载到 `./codex-data`（自动创建）。删除该目录即可清空 Codex 线程。

### Docker CLI

```bash
docker build -t codexbridge .

docker run --rm -p 8080:8080 \
  --env-file .env \
  -v "%cd%":/workspace \
  -v "%LOCALAPPDATA%\\Codex":/root/.codex \
  -w /workspace \
  codexbridge
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 端口 |
| `CODEX_MODEL` | `gpt-5-codex` | 默认模型 |
| `CODEX_REASONING` | `medium` | 默认推理等级 (`low` / `medium` / `high`) |
| `CODEX_BRIDGE_API_KEY` | `123321` | API key（`Authorization: Bearer` / `x-api-key`） |
| `CODEX_SKIP_GIT_CHECK` | `true` | 是否跳过 Codex “受信任 Git 仓库”检查 |
| `CODEX_SANDBOX_MODE` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `CODEX_WORKDIR` | 空 | 强制 Codex 在该目录运行（相对路径基于仓库根目录） |
| `CODEX_NETWORK_ACCESS` | `false` | 允许 Codex 联网 |
| `CODEX_WEB_SEARCH` | `false` | 允许 Codex 使用 Web 搜索 |
| `CODEX_APPROVAL_POLICY` | `never` | `never` / `on-request` / `on-failure` / `untrusted` |
| `CODEX_LOG_REQUESTS` | `false` | 打印请求 payload 以便调试 |
| `CODEX_REQUIRE_SESSION_ID` | `false` | `true` 时缺少 session ID 会直接返回 400 |
| `CODEX_JSON_LIMIT` | `10mb` | `express.json()` 请求体上限 |

## 常见问题

- **413 PayloadTooLargeError**：增大 `CODEX_JSON_LIMIT`，尤其是发送 base64 图片时。
- **“Invalid or missing API key”**：确认请求附带正确的 `Authorization: Bearer <KEY>` 或 `x-api-key`。
- **Codex 报 Git 仓库限制**：仅在可信仓库内运行时才关闭 `CODEX_SKIP_GIT_CHECK`。
- **需要重置所有会话**：停止服务后删除 `.codex_threads.json` 以及 `~/.codex/sessions`。

## 许可证

仅限非商业用途，详见 [LICENSE](LICENSE)。若要商用，请先联系 begonia 获取书面授权。

## 支持与联系

- 仓库地址：https://github.com/begonia599/CodexBridge
- 邮箱：`begonia@bgnhub.me`

如在使用 CodexBridge 时需要帮助、希望扩展功能或进行二次开发，欢迎随时联系，也欢迎通过 Issue / PR 共同完善项目。
