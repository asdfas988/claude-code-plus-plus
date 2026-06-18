# Create a "Claude Code++" shortcut on the Desktop.
# It points directly at electron.exe (a normal GUI program) -- no hidden
# PowerShell, no console window, and far less likely to trip antivirus.
# Usage: right-click this file -> Run with PowerShell
#    or: powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
# Run this AFTER `npm install` (electron.exe must already exist).

$ErrorActionPreference = 'Stop'

$projectDir = $PSScriptRoot
$electron   = Join-Path $projectDir 'node_modules\electron\dist\electron.exe'
$desktop    = [Environment]::GetFolderPath('Desktop')
$lnkPath    = Join-Path $desktop 'Claude Code++.lnk'

if (-not (Test-Path $electron)) {
  Write-Host "[!] electron.exe not found. Run 'npm install' first, then re-run this script."
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath       = $electron      # launch the app directly
$sc.Arguments        = '.'            # load the app from its project dir
$sc.WorkingDirectory = $projectDir
$sc.IconLocation     = $electron
$sc.Description       = 'Claude Code++'
$sc.Save()

Write-Host "[OK] Desktop shortcut created: $lnkPath"
