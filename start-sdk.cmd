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
node "%ROOT%packages\identity-sdk\bin\sdk.mjs" %*
if "%~1"=="" pause
