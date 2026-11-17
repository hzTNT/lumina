@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Lumina 微光影库

set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

if not exist "%~dp0server\index.js" (
  echo [错误] 找不到 server\index.js，请确认 Lumina 目录完整。
  pause
  exit /b 1
)

echo.
echo   Lumina 微光影库
echo   ----------------------------------------
echo   正在启动服务，浏览器会自动打开...
echo   关闭本窗口即可停止服务。
echo.

rem 如果 Lumina 已经在运行，直接打开浏览器，避免端口冲突
powershell -NoProfile -WindowStyle Hidden -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8096/api/health' -TimeoutSec 2; if ($r.name -like 'Lumina*') { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  echo   检测到 Lumina 已在运行，正在打开浏览器...
  start "" "http://127.0.0.1:8096"
  exit /b 0
)

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8096'"

"%NODE%" server\index.js

echo.
echo 服务已停止。
pause
