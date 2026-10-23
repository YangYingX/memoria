$ErrorActionPreference = 'Stop'

function Get-MemoriaWindowsContext {
    $project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
    $data = Join-Path $project 'data'
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($project.ToLowerInvariant()))).Replace('-', '').Substring(0, 24) }
    finally { $sha.Dispose() }
    return [pscustomobject]@{
        ProjectDirectory = $project
        DataDirectory = $data
        ServerPath = Join-Path $project 'src\server.js'
        SupervisorPath = Join-Path $project 'scripts\supervise.ps1'
        PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        ServerRecord = Join-Path $data 'server.pid'
        SupervisorRecord = Join-Path $data 'supervisor.pid'
        StopMarker = Join-Path $data 'server.stopped'
        SupervisorStatus = Join-Path $data 'supervisor-status.json'
        GateName = "Local\MemoriaStart-$key"
        SupervisorMutexName = "Local\MemoriaSupervisor-$key"
    }
}

function Enter-MemoriaWindowsMutex($Mutex, [int]$Milliseconds = 30000) {
    try { return $Mutex.WaitOne($Milliseconds) }
    catch [Threading.AbandonedMutexException] { return $true }
}

function ConvertTo-MemoriaWindowsArgument([string]$Value) {
    if ($Value -match '["\x00-\x1f]') { throw 'A process argument contains unsupported characters.' }
    return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}

function Split-MemoriaWindowsArguments([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
    if (!('Memoria.WindowsArgumentReader' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Memoria {
    public static class WindowsArgumentReader {
        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        public static string[] Read(string commandLine) {
            int count;
            IntPtr memory = CommandLineToArgvW(commandLine, out count);
            if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            try {
                string[] result = new string[count];
                for (int index = 0; index < count; index++)
                    result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
                return result;
            } finally { LocalFree(memory); }
        }
    }
}
'@
    }
    return [Memoria.WindowsArgumentReader]::Read($CommandLine)
}

function Test-MemoriaWindowsArguments($Actual, $Expected) {
    if ($Actual.Count -ne $Expected.Count) { return $false }
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        if (![string]::Equals([string]$Actual[$index], [string]$Expected[$index], [StringComparison]::OrdinalIgnoreCase)) { return $false }
    }
    return $true
}

function Get-MemoriaWindowsSupervisorArguments($Context) {
    return @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $Context.SupervisorPath)
}

function Test-MemoriaWindowsProcessKind($Context, $Snapshot, [ValidateSet('Server', 'Supervisor')][string]$Kind) {
    if ($Kind -eq 'Server') {
        return $Snapshot.Name -ieq 'node.exe' -and [IO.Path]::GetFileName($Snapshot.ExecutablePath) -ieq 'node.exe' -and
            (Test-MemoriaWindowsArguments $Snapshot.Arguments @($Context.ServerPath))
    }
    return $Snapshot.Name -ieq 'powershell.exe' -and $Snapshot.ExecutablePath -ieq $Context.PowerShellPath -and
        (Test-MemoriaWindowsArguments $Snapshot.Arguments (Get-MemoriaWindowsSupervisorArguments $Context))
}

function Get-MemoriaWindowsProcessSnapshot([int]$ProcessId) {
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $details) { return $null }
    $process = $null
    try {
        try { $process = [Diagnostics.Process]::GetProcessById($ProcessId) }
        catch [ArgumentException] { return $null }
        $null = $process.Handle
        if ($process.HasExited) { $process.Dispose(); return $null }
        $created = $details.CreationDate.ToUniversalTime()
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $created).TotalMilliseconds) -gt 1) {
            throw 'Process identity changed while it was being inspected; no process was changed.'
        }
        $arguments = @(Split-MemoriaWindowsArguments ([string]$details.CommandLine))
        if ($arguments.Count -eq 0 -or [string]::IsNullOrWhiteSpace($details.ExecutablePath)) {
            throw 'The process command line or executable could not be verified; no process was changed.'
        }
        return [pscustomobject]@{
            Process = $process
            Pid = $ProcessId
            CreatedAtUtc = $created.ToString('o')
            ExecutablePath = [string]$details.ExecutablePath
            Name = [string]$details.Name
            Arguments = @($arguments | Select-Object -Skip 1)
        }
    } catch {
        if ($null -ne $process) { $process.Dispose() }
        throw
    }
}

function Read-MemoriaWindowsProcessRecord([string]$Path, [bool]$AllowLegacy = $false) {
    if (!(Test-Path -LiteralPath $Path)) { return $null }
    $text = [IO.File]::ReadAllText($Path).Trim()
    if ($AllowLegacy -and $text -match '^[1-9][0-9]{0,9}$' -and [long]$text -le [int]::MaxValue) {
        return [pscustomobject]@{ Pid = [int]$text; Legacy = $true }
    }
    try {
        $record = $text | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $record -and $record.createdAtUtc -is [datetime] -and $record.createdAtUtc.Kind -eq [DateTimeKind]::Utc) { $record.createdAtUtc = $record.createdAtUtc.ToUniversalTime().ToString('o') }
        if ($null -eq $record -or [string]$record.pid -notmatch '^[1-9][0-9]{0,9}$' -or [long]$record.pid -gt [int]::MaxValue -or
            $record.createdAtUtc -isnot [string] -or $record.executablePath -isnot [string] -or
            ![IO.Path]::IsPathRooted($record.executablePath) -or $record.arguments -isnot [Array] -or
            @($record.arguments | Where-Object { $_ -isnot [string] }).Count -gt 0) { throw 'Invalid record.' }
        $created = [datetime]::ParseExact($record.createdAtUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        if ($created.Kind -ne [DateTimeKind]::Utc) { throw 'Invalid creation time.' }
        return [pscustomobject]@{
            Pid = [int]$record.pid
            CreatedAtUtc = $record.createdAtUtc
            ExecutablePath = $record.executablePath
            Arguments = @($record.arguments)
            Legacy = $false
        }
    } catch { throw "Invalid process record; inspect it before retrying: $Path" }
}

function Get-MemoriaWindowsManagedProcess($Context, [ValidateSet('Server', 'Supervisor')][string]$Kind) {
    $path = if ($Kind -eq 'Server') { $Context.ServerRecord } else { $Context.SupervisorRecord }
    $record = Read-MemoriaWindowsProcessRecord $path ($Kind -eq 'Server')
    if ($null -ne $record) {
        $saved = Get-MemoriaWindowsProcessSnapshot $record.Pid
        if ($null -ne $saved) {
            if (!(Test-MemoriaWindowsProcessKind $Context $saved $Kind) -or (!$record.Legacy -and
                ($saved.CreatedAtUtc -cne $record.CreatedAtUtc -or $saved.ExecutablePath -ine $record.ExecutablePath -or
                !(Test-MemoriaWindowsArguments $saved.Arguments $record.Arguments)))) {
                $saved.Process.Dispose()
                throw "Process record does not identify this project's $Kind; no process was changed: $path"
            }
            return $saved
        }
    }
    $name = if ($Kind -eq 'Server') { 'node.exe' } else { 'powershell.exe' }
    $found = @()
    try {
        foreach ($details in @(Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction Stop)) {
            $arguments = @(Split-MemoriaWindowsArguments ([string]$details.CommandLine))
            $candidate = [pscustomobject]@{
                Name = [string]$details.Name
                ExecutablePath = [string]$details.ExecutablePath
                Arguments = @($arguments | Select-Object -Skip 1)
            }
            if (!(Test-MemoriaWindowsProcessKind $Context $candidate $Kind)) { continue }
            $snapshot = Get-MemoriaWindowsProcessSnapshot ([int]$details.ProcessId)
            if ($null -ne $snapshot) {
                if (!(Test-MemoriaWindowsProcessKind $Context $snapshot $Kind)) { $snapshot.Process.Dispose(); throw 'Process identity changed during discovery.' }
                $found += $snapshot
            }
        }
        if ($found.Count -gt 1) { throw "Multiple $Kind processes match this project; inspect them before retrying." }
        if ($found.Count -eq 1) { return $found[0] }
        return $null
    } catch {
        foreach ($item in $found) { $item.Process.Dispose() }
        throw
    }
}

function Write-MemoriaWindowsJson([string]$Path, $Value) {
    $temporary = $Path + '.' + $PID + '-' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Write-MemoriaWindowsProcessRecord([string]$Path, $Snapshot) {
    Write-MemoriaWindowsJson $Path ([ordered]@{
        pid = $Snapshot.Pid
        createdAtUtc = $Snapshot.CreatedAtUtc
        executablePath = $Snapshot.ExecutablePath
        arguments = @($Snapshot.Arguments)
    })
}

function Stop-MemoriaWindowsProcess($Snapshot) {
    if (!$Snapshot.Process.HasExited) { $Snapshot.Process.Kill() }
    if (!$Snapshot.Process.WaitForExit(10000)) { throw 'The verified process did not exit within ten seconds; the stop marker was kept.' }
}

function Start-MemoriaWindowsProcess($Context, [ValidateSet('Server', 'Supervisor')][string]$Kind, [string]$NodePath) {
    if ($Kind -eq 'Server') {
        $env:PORT = '3210'
        $env:PERSONA_DATA_DIR = $Context.DataDirectory
        $process = Start-Process -FilePath $NodePath -ArgumentList (ConvertTo-MemoriaWindowsArgument $Context.ServerPath) -WorkingDirectory $Context.ProjectDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Context.DataDirectory 'server.log') -RedirectStandardError (Join-Path $Context.DataDirectory 'server.err.log') -PassThru
        $record = $Context.ServerRecord
    } else {
        $arguments = @(Get-MemoriaWindowsSupervisorArguments $Context | ForEach-Object { ConvertTo-MemoriaWindowsArgument $_ }) -join ' '
        $process = Start-Process -FilePath $Context.PowerShellPath -ArgumentList $arguments -WorkingDirectory $Context.ProjectDirectory -WindowStyle Hidden -PassThru
        $record = $Context.SupervisorRecord
    }
    $snapshot = $null
    try {
        $snapshot = Get-MemoriaWindowsProcessSnapshot $process.Id
        if ($null -eq $snapshot -or !(Test-MemoriaWindowsProcessKind $Context $snapshot $Kind)) { throw "$Kind exited or could not be verified after launch. Check the runtime logs." }
        Write-MemoriaWindowsProcessRecord $record $snapshot
        return $snapshot
    } catch {
        if (!$process.HasExited) { $process.Kill(); $null = $process.WaitForExit(10000) }
        if ($null -ne $snapshot) { $snapshot.Process.Dispose() }
        throw
    } finally { $process.Dispose() }
}

function Write-MemoriaWindowsSupervisorStatus($Context, [string]$State, [int]$CorePid = 0, [int]$DelaySeconds = 0) {
    Write-MemoriaWindowsJson $Context.SupervisorStatus ([ordered]@{
        updatedAt = [datetime]::UtcNow.ToString('o')
        supervisorPid = $PID
        state = $State
        corePid = $CorePid
        retryDelaySeconds = $DelaySeconds
    })
}
