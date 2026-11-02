@echo off
chcp 65001 >nul
node "%~dp0bin\serve.mjs" %*
if errorlevel 1 pause
