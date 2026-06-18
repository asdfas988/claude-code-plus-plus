@echo off
rem 双击启动 Claude Code++。App 始终以独立进程运行，关闭命令行不会退出 App。
cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" (
  rem 已装好依赖：直接拉起 Electron（GUI、无黑窗口），本窗口随即自动关闭
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
) else (
  rem 首次运行：把安装放进一个独立窗口，你双击的【本】窗口立刻就能关；
  rem 安装窗口装完依赖会自动打开 App。
  start "Claude Code++ Setup" /min cmd /c ""%~dp0_setup-and-run.cmd""
)
