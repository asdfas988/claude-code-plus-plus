@echo off
rem 双击即可启动 Claude Code++（直接拉起 Electron，独立进程、无命令行残留）
cd /d "%~dp0"

rem 首次运行若还没装依赖，自动装一次
if not exist "node_modules\electron\dist\electron.exe" (
  echo [Claude Code++] 首次启动，正在安装依赖...
  call npm install
)

rem 直接启动 electron.exe（GUI 程序，无黑窗口）；start 让它成为独立进程，
rem 本 bat 随即退出，关闭任何窗口都不影响 App。
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
