# Create a "Claude Code++" shortcut on the Desktop (launches hidden, no console window).
# Usage: right-click this file -> Run with PowerShell
#    or: powershell -ExecutionPolicy Bypass -File create-shortcut.ps1

$ErrorActionPreference = 'Stop'

$projectDir = $PSScriptRoot
$desktop    = [Environment]::GetFolderPath('Desktop')
$lnkPath    = Join-Path $desktop 'Claude Code++.lnk'

# Launch hidden: powershell runs "npm start" with no visible window
$target    = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "-WindowStyle Hidden -NoProfile -Command ""cd '$projectDir'; npm start"""

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
