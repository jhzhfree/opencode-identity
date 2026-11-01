@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
echo 启动【插件生成工具】: http://127.0.0.1:4180
node "%ROOT%apps\plugin-studio\server.mjs" %*
if errorlevel 1 pause
