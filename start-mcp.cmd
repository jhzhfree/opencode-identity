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
if "%~1"=="" (
  node "%ROOT%apps\mcp-server\bin\serve.mjs" --help
  echo.
  echo 用法示例: start-mcp.cmd --registry C:\path\to\registry.json --port 8781
  pause
  exit /b 2
)
node "%ROOT%apps\mcp-server\bin\serve.mjs" %*
if errorlevel 1 pause
