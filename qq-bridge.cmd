@echo off
rem ============================================================
rem  QQ-DSH 桥接 · 命令行入口（Windows）
rem
rem  双击它会显示用法；在命令行里带参数用：
rem      qq-bridge.cmd start            起控制台 + 桥接（后台）
rem      qq-bridge.cmd start --no-console  只起桥接
rem      qq-bridge.cmd status           看状态
rem      qq-bridge.cmd logs bridge --lines 100
rem      qq-bridge.cmd stop             全停
rem      qq-bridge.cmd test             跑全量测试
rem
rem  和「一键启动.cmd」的区别：这个不装托盘、不开浏览器，适合服务器 / 计划任务 / 远程会话。
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo 没找到 node，请先安装 Node.js 20 或更高版本。
    exit /b 1
)

if "%~1"=="" (
    node "tools\cli.mjs" --help
    echo.
    pause
    exit /b 0
)

node "tools\cli.mjs" %*
exit /b %errorlevel%
