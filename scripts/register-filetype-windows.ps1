# Registers the .drawrdis file type on Windows (optional).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-filetype-windows.ps1 [-Unregister]
param(
  [switch]$Unregister
)

$app = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ($Unregister) {
  Remove-Item -Path 'HKCU:\Software\Classes\.drawrdis' -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path 'HKCU:\Software\Classes\drawrdis.board' -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output '.drawrdis association removed'
  return
}

$bat = Join-Path $app 'bin\drawrdis-open.bat'
$icon = Join-Path $app 'public\favicon.ico'

New-Item -Path 'HKCU:\Software\Classes\.drawrdis' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\.drawrdis' -Name '(Default)' -Value 'drawrdis.board'
New-Item -Path 'HKCU:\Software\Classes\drawrdis.board' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\drawrdis.board' -Name '(Default)' -Value 'Drawrdis board'
New-Item -Path 'HKCU:\Software\Classes\drawrdis.board\DefaultIcon' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\drawrdis.board\DefaultIcon' -Name '(Default)' -Value $icon
New-Item -Path 'HKCU:\Software\Classes\drawrdis.board\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\drawrdis.board\shell\open\command' -Name '(Default)' -Value ('"' + $bat + '" "%1"')

Write-Output '.drawrdis registered: double-click now opens boards in Drawrdis'
