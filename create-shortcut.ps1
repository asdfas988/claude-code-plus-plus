# Create a "Claude Code++" shortcut on the Desktop (launches hidden, no console window).
# Usage: right-click this file -> Run with PowerShell
#    or: powershell -ExecutionPolicy Bypass -File create-shortcut.ps1

$ErrorActionPreference = 'Stop'

$projectDir = $PSScriptRoot
$desktop    = [Environment]::GetFolderPath('Desktop')
$lnkPath    = Join-Path $desktop 'Claude Code++.lnk'

# Launch detached + hidden: the launcher fires npm start as an independent
# process and exits immediately, so the app keeps running on its own.
$target    = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "-WindowStyle Hidden -NoProfile -Command ""Start-Process npm -ArgumentList 'start' -WorkingDirectory '$projectDir' -WindowStyle Hidden"""

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath       = $target
$sc.Arguments        = $arguments
$sc.WorkingDirectory = $projectDir
$sc.Description       = 'Claude Code++'

# Use Electron icon if dependencies are installed
$icon = Join-Path $projectDir 'node_modules\electron\dist\electron.exe'
if (Test-Path $icon) { $sc.IconLocation = $icon }

$sc.Save()
Write-Host "[OK] Desktop shortcut created: $lnkPath"
