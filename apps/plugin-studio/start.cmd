@echo off
chcp 65001 >nul
node "%~dp0server.mjs" %*
if errorlevel 1 pause
