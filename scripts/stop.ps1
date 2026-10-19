$ErrorActionPreference = 'Stop'
$projectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverPath = Join-Path $projectDir 'src\server.js'
$pidFile = Join-Path $projectDir 'data\server.pid'
if (!(Test-Path -LiteralPath $pidFile)) { Write-Host 'No background server PID found.'; exit 0 }
$savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$running = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
if ($running) {
    if ($running.Name -ne 'node.exe' -or !$running.CommandLine.Contains($serverPath)) { throw 'PID belongs to a different process; refusing to stop it.' }
    Stop-Process -Id $savedPid
    Write-Host 'Memoria stopped.'
} else { Write-Host 'Memoria is not running.' }
Remove-Item -LiteralPath $pidFile
