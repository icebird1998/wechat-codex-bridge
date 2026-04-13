# WeChat Codex Bridge V1

## 项目来源与致谢

这个项目是一个组合式二次开发版本，代码中包含并改造了其他优秀开源项目的部分能力。公开使用时请一并保留原项目版权与许可说明。

- 感谢 [zhayujie/chatgpt-on-wechat](https://github.com/zhayujie/chatgpt-on-wechat)：本项目的微信、QQ、Web 通道、消息上下文、插件体系等主要入口能力基于该项目扩展。
- 特别感谢我的师兄 Wei Zhu 博士：在项目设计、运行稳定性和实际部署流程上给予了重要指导，并推动增加了线程终止自动重启、常驻守护等可靠性能力。
- 感谢 [OpenAI Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk)：`codexbridge` 通过该 SDK 调用 Codex thread/run 能力。
- 感谢 [Express](https://github.com/expressjs/express)：`codexbridge` 的 HTTP 服务基于 Express。
- 感谢 [xterm.js](https://github.com/xtermjs/xterm.js)：Web 控制台的终端/过程展示使用了 xterm.js。
- 感谢 Python/Node.js 生态中所有依赖库的维护者，本项目保留各子项目和依赖自身的 LICENSE 文件与说明。

再次感谢以上项目和作者。没有这些基础工作，V1 不可能这么快成型。

把 Codex 接到微信、QQ、飞书、钉钉、企业微信、公众号和网页控制台里的本地桥接套件。V1 版本包含两个核心服务：

- `codexbridge`：OpenAI Chat Completions 兼容接口，负责调用 Codex SDK、管理会话、运行时配置、异步审批队列和 CLI 过程流。
- `chatgpt-on-wechat`：聊天入口层，负责微信、QQ、飞书、钉钉、企业微信、公众号、Web 等通道、文件上传、网页控制台和消息回传。

默认部署面向 Windows 本机常驻运行。公开部署前请务必改掉所有默认密钥，并优先只监听 `127.0.0.1`。

## 功能

- 微信、QQ、飞书机器人、钉钉机器人、企业微信、公众号、Web 控制台等多通道接入 Codex。
- 兼容 OpenAI `/v1/chat/completions` 请求格式。
- 支持稳定会话：同一用户消息会复用同一个 Codex thread。
- 支持模型、推理强度、沙箱、联网、Web search 的运行时查看和调整。
- 支持高风险任务异步审批：微信里收到审批请求后，可回复“同意/拒绝”继续处理。
- Web 控制台提供 Codex CLI 过程监控。
- 支持线程/进程异常终止后的自动重启、开机常驻脚本和服务状态检查脚本。

## 目录

```text
wechat-codex-bridge/
  codexbridge/          # Codex OpenAI-compatible bridge
  chatgpt-on-wechat/    # 微信/QQ/飞书/钉钉/企业微信/Web 等通道入口
  scripts/              # Windows 常驻、审批、启动/停止脚本
  README.zh-CN.md       # 中文使用说明
```

## 环境要求

- Windows 10/11
- Node.js 20+
- Python 3.9+，推荐 3.12
- Git
- Codex CLI 已登录可用
- 可访问 OpenAI/Codex 服务的网络环境

## 快速开始

### 让 Codex 自动安装

如果你已经在本机安装并登录了 Codex CLI，也可以直接把安装工作交给 Codex。复制下面这段提示词给 Codex，它会根据项目地址自动克隆、安装依赖、生成配置模板，并尽量完成本机可运行部署。

```text
请帮我在 Windows 本机自动安装并配置这个项目：
https://github.com/icebird1998/wechat-codex-bridge

要求：
1. 克隆到 C:\wechat-codex-bridge，如果目录已存在，请先检查现有文件，不要覆盖我的私有配置和运行数据。
2. 安装 codexbridge 的 Node.js 依赖，复制 .env.example 为 .env，并提示我设置 CODEX_BRIDGE_API_KEY、CODEX_WORKDIR、模型、沙箱、联网和审批配置。
3. 安装 chatgpt-on-wechat 的 Python 依赖，创建虚拟环境，复制 config-template.json 为 config.json，并把 open_ai_api_base 指向 http://127.0.0.1:8080/v1。
4. 生成一个适合本机的最小可用配置，默认 web_host=127.0.0.1，web_terminal_enabled=false，不要把服务暴露到公网。
5. 创建或检查 C:\wechat-codex-bridge\code_project 作为 Codex 工作目录。
6. 运行基础验证：node --check codexbridge\server.js，python -m py_compile 关键 Python 文件，并检查 .env/config.json 没有占位错误。
7. 告诉我如何分别启动 CodexBridge 和聊天入口，以及如何打开 Web 控制台。
8. 如果我要求常驻运行，再帮我执行 scripts\register-resident-services.ps1；在我确认前不要注册开机启动。
9. 全程不要打印或上传我的 token、API key、微信凭证、日志和 approvals 运行数据。

完成后请给我一个简短报告：安装路径、启动命令、Web 控制台地址、还需要我手动填写的配置项。
```

### 1. 克隆项目

```powershell
git clone <你的仓库地址> C:\wechat-codex-bridge
cd C:\wechat-codex-bridge
```

### 2. 安装 CodexBridge 依赖

```powershell
cd C:\wechat-codex-bridge\codexbridge
npm install
Copy-Item .env.example .env
```

编辑 `codexbridge\.env`：

```env
PORT=8080
CODEX_MODEL=gpt-5.3-codex
CODEX_REASONING=medium
CODEX_BRIDGE_API_KEY=请改成你自己的长随机字符串
CODEX_SANDBOX_MODE=read-only
CODEX_WORKDIR=C:\wechat-codex-bridge\code_project
CODEX_NETWORK_ACCESS=false
CODEX_WEB_SEARCH=false
CODEX_APPROVAL_POLICY=never
CODEX_ASYNC_APPROVALS_ENABLED=true
```

`CODEX_WORKDIR` 是 Codex 主要工作的目录。首次使用可以手动创建：

```powershell
New-Item -ItemType Directory -Force C:\wechat-codex-bridge\code_project
```

启动 CodexBridge：

```powershell
npm run codex:server
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
```

### 3. 安装聊天入口依赖

```powershell
cd C:\wechat-codex-bridge\chatgpt-on-wechat
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item config-template.json config.json
```

编辑 `chatgpt-on-wechat\config.json`，最小配置示例：

```json
{
  "channel_type": "web",
  "web_host": "127.0.0.1",
  "web_port": 9899,
  "web_terminal_enabled": false,
  "model": "gpt-5.3-codex",
  "open_ai_api_base": "http://127.0.0.1:8080/v1",
  "open_ai_api_key": "与 CODEX_BRIDGE_API_KEY 相同的字符串",
  "agent": true,
  "weixin_approval_callbacks_path": "C:\\wechat-codex-bridge\\chatgpt-on-wechat\\.weixin_codex_approvals.json",
  "codex_approval_root": "C:\\wechat-codex-bridge\\codexbridge\\approvals"
}
```

启动：

```powershell
python app.py
```

打开 Web 控制台：

```text
http://127.0.0.1:9899/chat
```

## 多通道使用方式

`channel_type` 控制通道：

- `web`：网页聊天控制台。
- `qq`：QQ 通道。
- `weixin`：个人微信 ilink bot 通道。
- `feishu`：飞书机器人通道。
- `dingtalk`：钉钉机器人通道。
- `wecom_bot`：企业微信机器人通道。
- `wechatmp` / `wechatmp_service`：微信公众号通道。
- `wechatcom_app`：企业微信自建应用通道。

示例：

```json
{
  "channel_type": "weixin",
  "open_ai_api_base": "http://127.0.0.1:8080/v1",
  "open_ai_api_key": "你的 CodexBridge API Key"
}
```

微信通道首次启动会走扫码/凭证流程，凭证默认保存在 `weixin_credentials_path`。如果登录异常，删除该凭证文件后重新启动即可。

## 异步审批

当 `CODEX_ASYNC_APPROVALS_ENABLED=true` 时，安装软件、修改系统配置、删除文件、访问工作区外路径等高风险请求会进入审批队列。

用户会收到类似：

```text
[审批请求 #xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx]
这次请求已转为异步审批，微信不会卡住。
原因：涉及安装或卸载软件/依赖
批准命令：powershell ...
拒绝命令：powershell ...
```

审批方式：

- 微信里回复：`同意`
- 微信里回复：`拒绝`
- 或手动执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\wechat-codex-bridge\scripts\approve-codex-approval.ps1 -Id <审批ID>
powershell -NoProfile -ExecutionPolicy Bypass -File C:\wechat-codex-bridge\scripts\reject-codex-approval.ps1 -Id <审批ID>
```

审批结果会写入 `codexbridge\approvals\completed`、`failed` 或 `rejected`，微信通道会轮询并回传结果。

## 常驻运行

注册开机启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\wechat-codex-bridge\scripts\register-resident-services.ps1
```

手动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\wechat-codex-bridge\scripts\start-resident-services.ps1
```

查看状态：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\wechat-codex-bridge\scripts\status-resident-services.ps1
```

停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\wechat-codex-bridge\scripts\stop-resident-services.ps1
```

## 安全建议

- 不要公开 `.env`、`config.json`、`.weixin_*`、`approvals/`、日志和 `.venv/`。
- `CODEX_BRIDGE_API_KEY` 必须改成长随机字符串。
- `web_host` 默认建议保持 `127.0.0.1`。
- `web_terminal_enabled` 默认保持 `false`；开启后等价于允许 Web 控制台启动本机终端。
- 公网部署请放在带鉴权的反向代理后面。
- 默认使用 `read-only` 沙箱；确实需要写文件时再切到 `workspace-write` 或走审批。

## 常见问题

### Web 控制台打不开

确认 `python app.py` 正在运行，且 `web_port` 没被占用：

```powershell
netstat -ano | findstr 9899
```

### CodexBridge 返回 401

确认 `chatgpt-on-wechat\config.json` 的 `open_ai_api_key` 与 `codexbridge\.env` 的 `CODEX_BRIDGE_API_KEY` 完全一致。

### Web 终端提示 pywinpty 缺失

Windows Web 终端依赖 `pywinpty`：

```powershell
pip install pywinpty
```

V1 默认关闭 Web 终端，需要显式设置：

```json
{
  "web_terminal_enabled": true
}
```

### 审批同意后没有结果

检查 CodexBridge 是否开启审批轮询：

```env
CODEX_ASYNC_APPROVALS_ENABLED=true
```

再检查：

```powershell
Get-ChildItem C:\wechat-codex-bridge\codexbridge\approvals -Recurse
```

## V1 发布说明

- 初始公开版本。
- 增加 CodexBridge OpenAI 兼容接口。
- 增加 Web 控制台 Codex 过程监控。
- 增加微信审批回调和异步审批队列。
- 默认隐藏本地密钥和运行态文件。
