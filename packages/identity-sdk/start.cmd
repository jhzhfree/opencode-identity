@echo off
chcp 65001 >nul
node "%~dp0bin\sdk.mjs" %*
if "%~1"=="" pause
