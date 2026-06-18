@echo off
rem 首次安装依赖并自动启动 App —— 由 start.bat 在独立窗口里调用。
rem 这个窗口跑完会自己关；请勿在安装途中手动关它（会中断安装）。
cd /d "%~dp0"
echo ============================================
echo  Claude Code++ 首次安装依赖中，请稍候...
echo  （仅首次，装完会自动打开 App，本窗口随后自动关闭）
echo ============================================
call npm install
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo [错误] 依赖安装失败，请检查网络后重试。
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
