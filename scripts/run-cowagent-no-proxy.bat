@echo off
setlocal
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "GIT_HTTP_PROXY="
set "GIT_HTTPS_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="
set "git_http_proxy="
set "git_https_proxy="
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=localhost,127.0.0.1,::1"
cd /d C:\wechat-codex-bridge\chatgpt-on-wechat
"C:\wechat-codex-bridge\chatgpt-on-wechat\.venv\Scripts\python.exe" app.py >> "C:\wechat-codex-bridge\chatgpt-on-wechat\run.console.log" 2>&1