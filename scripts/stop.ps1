$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-runtime.ps1')
$context = Get-MemoriaWindowsContext
$gate = [Threading.Mutex]::new($false, $context.GateName)
$locked = $false
$core = $null
$supervisor = $null
try {
    $locked = Enter-MemoriaWindowsMutex $gate
    if (!$locked) { throw 'Another Memoria start or stop is in progress; no process was changed. Try again shortly.' }
    New-Item -ItemType Directory -Path $context.DataDirectory -Force | Out-Null
    [IO.File]::WriteAllText($context.StopMarker, "Stopped by stop.ps1. Run start.cmd to start again.`n", [Text.UTF8Encoding]::new($false))
    $supervisor = Get-MemoriaWindowsManagedProcess $context 'Supervisor'
    if ($null -ne $supervisor) { Stop-MemoriaWindowsProcess $supervisor }
    $core = Get-MemoriaWindowsManagedProcess $context 'Server'
    if ($null -ne $core) { Stop-MemoriaWindowsProcess $core }
    foreach ($record in @($context.SupervisorRecord, $context.ServerRecord)) {
        if (Test-Path -LiteralPath $record) { Remove-Item -LiteralPath $record }
    }
    Write-MemoriaWindowsSupervisorStatus $context 'stopped'
    Write-Host 'Memoria stopped. Background crash recovery will not restart it.'
} finally {
    if ($null -ne $core) { $core.Process.Dispose() }
    if ($null -ne $supervisor) { $supervisor.Process.Dispose() }
    if ($locked) { $gate.ReleaseMutex() }
    $gate.Dispose()
}
