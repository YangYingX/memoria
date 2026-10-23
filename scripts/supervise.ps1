$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-runtime.ps1')
$context = Get-MemoriaWindowsContext
$lifetime = [Threading.Mutex]::new($false, $context.SupervisorMutexName)
$gate = [Threading.Mutex]::new($false, $context.GateName)
$ownsLifetime = $false
$locked = $false
$core = $null
$exitedCore = $null
$self = $null
try {
    $ownsLifetime = Enter-MemoriaWindowsMutex $lifetime 0
    if (!$ownsLifetime) { exit 0 }
    $locked = Enter-MemoriaWindowsMutex $gate
    if (!$locked) { throw 'The Memoria lifecycle lock was not available.' }
    if (Test-Path -LiteralPath $context.StopMarker) { exit 0 }
    $self = Get-MemoriaWindowsManagedProcess $context 'Supervisor'
    if ($null -eq $self -or $self.Pid -ne $PID) { throw 'The supervisor process identity could not be verified.' }
    Write-MemoriaWindowsProcessRecord $context.SupervisorRecord $self
    $core = Get-MemoriaWindowsManagedProcess $context 'Server'
    $nodePath = if ($null -ne $core) { $core.ExecutablePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
    $gate.ReleaseMutex()
    $locked = $false
    $retry = 0
    $delays = @(5, 15, 60, 300)
    while ($true) {
        if ($null -ne $core) {
            Write-MemoriaWindowsSupervisorStatus $context 'running' $core.Pid
            while (!$core.Process.WaitForExit(500)) {
                if (Test-Path -LiteralPath $context.StopMarker) { return }
                if (([datetime]::UtcNow - $core.Process.StartTime.ToUniversalTime()).TotalSeconds -ge 60) { $retry = 0 }
            }
            if (([datetime]::UtcNow - $core.Process.StartTime.ToUniversalTime()).TotalSeconds -ge 60) { $retry = 0 }
            $exitedCore = $core
            $core = $null
        }
        if (Test-Path -LiteralPath $context.StopMarker) { break }
        $delay = $delays[[Math]::Min($retry, $delays.Count - 1)]
        $retry = [Math]::Min($retry + 1, $delays.Count - 1)
        Write-MemoriaWindowsSupervisorStatus $context 'waiting' 0 $delay
        $until = [datetime]::UtcNow.AddSeconds($delay)
        while ([datetime]::UtcNow -lt $until) {
            if (Test-Path -LiteralPath $context.StopMarker) { return }
            Start-Sleep -Milliseconds 250
        }
        $locked = Enter-MemoriaWindowsMutex $gate
        if (!$locked) { throw 'The Memoria lifecycle lock was not available.' }
        if (Test-Path -LiteralPath $context.StopMarker) { break }
        if ($null -ne $exitedCore) {
            $record = Read-MemoriaWindowsProcessRecord $context.ServerRecord $true
            if ($null -ne $record -and !$record.Legacy -and $record.Pid -eq $exitedCore.Pid -and
                $record.CreatedAtUtc -ceq $exitedCore.CreatedAtUtc -and $record.ExecutablePath -ieq $exitedCore.ExecutablePath -and
                (Test-MemoriaWindowsArguments $record.Arguments $exitedCore.Arguments) -and $exitedCore.Process.HasExited) {
                Remove-Item -LiteralPath $context.ServerRecord
            }
            $exitedCore.Process.Dispose()
            $exitedCore = $null
        }
        $core = Get-MemoriaWindowsManagedProcess $context 'Server'
        if ($null -eq $core) {
            try { $core = Start-MemoriaWindowsProcess $context 'Server' $nodePath }
            catch { Write-MemoriaWindowsSupervisorStatus $context 'launch-failed' 0 $delay }
        }
        $gate.ReleaseMutex()
        $locked = $false
    }
} catch {
    try { Write-MemoriaWindowsSupervisorStatus $context 'error' } catch { }
    throw
} finally {
    if ($null -ne $core) { $core.Process.Dispose() }
    if ($null -ne $exitedCore) { $exitedCore.Process.Dispose() }
    if ($null -ne $self) { $self.Process.Dispose() }
    if ($locked) { $gate.ReleaseMutex() }
    if ($ownsLifetime) { $lifetime.ReleaseMutex() }
    $gate.Dispose()
    $lifetime.Dispose()
}
