@echo off
rem 双击即可启动 Claude Code++（从源码运行）
rem %~dp0 = 本文件所在目录，放在任何设备都能用
cd /d "%~dp0"

rem 首次运行若还没装依赖，自动装一次
if not exist "node_modules\electron" (
  echo [Claude Code++] 首次启动，正在安装依赖...
  call npm install
)

echo [Claude Code++] 启动中...
call npm start
