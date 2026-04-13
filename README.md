# WeChat Codex Bridge V1

这是一个面向中文用户的 Codex 微信/QQ/Web 桥接套件。

## 项目来源与致谢

本项目是组合式二次开发版本，包含并改造了其他优秀开源项目的部分能力：

- 感谢 [zhayujie/chatgpt-on-wechat](https://github.com/zhayujie/chatgpt-on-wechat)：微信、QQ、Web 通道与消息入口能力基于该项目扩展。
- 特别感谢我的师兄 Wei Zhu 博士：对项目设计、部署稳定性和可靠性能力给予指导，并推动增加了线程终止自动重启、常驻守护等功能。
- 感谢 [OpenAI Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk)：`codexbridge` 通过该 SDK 调用 Codex。
- 感谢 [Express](https://github.com/expressjs/express) 和 [xterm.js](https://github.com/xtermjs/xterm.js) 等依赖项目。

公开使用时请保留原项目版权与许可说明。

完整安装、配置、常驻运行和审批说明请看：[README.zh-CN.md](README.zh-CN.md)。

README 里也提供了一段可直接复制给 Codex 的自动安装提示词，适合让 Codex 根据仓库地址完成本机部署。

## 一句话启动

1. 启动 `codexbridge`，提供 OpenAI 兼容接口。
2. 启动 `chatgpt-on-wechat`，接入微信、QQ、飞书、钉钉、企业微信、公众号或 Web 控制台。
3. 把 `chatgpt-on-wechat/config.json` 的 `open_ai_api_base` 指向 `http://127.0.0.1:8080/v1`。

公开部署前请修改所有默认密钥，并保持 Web 控制台默认只监听 `127.0.0.1`。
