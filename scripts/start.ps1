param([string]$BrowserCache)

$ErrorActionPreference = 'Stop'
if ($PSBoundParameters.ContainsKey('BrowserCache')) { $env:PLAYWRIGHT_BROWSERS_PATH = $BrowserCache }
. (Join-Path $PSScriptRoot 'windows-runtime.ps1')
$context = Get-MemoriaWindowsContext
$gate = [Threading.Mutex]::new($false, $context.GateName)
$locked = $false
$core = $null
$supervisor = $null
try {
    $locked = Enter-MemoriaWindowsMutex $gate 0
    if (!$locked) { throw 'Another Memoria start or stop is in progress. Try again shortly.' }
    New-Item -ItemType Directory -Path $context.DataDirectory -Force | Out-Null
    $supervisor = Get-MemoriaWindowsManagedProcess $context 'Supervisor'
    if ((Test-Path -LiteralPath $context.StopMarker) -and $null -ne $supervisor) { throw 'Memoria is still stopping. Wait for its supervisor to exit before starting again.' }
    $core = Get-MemoriaWindowsManagedProcess $context 'Server'
    if ($null -ne $supervisor) {
        Write-Host 'Memoria supervision is already running: http://127.0.0.1:3210'
        exit 0
    }
    if ($null -eq $core -and (Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue)) {
        throw 'Port 3210 is already in use. Stop that service first, or use PORT with npm run dev.'
    }
    $nodePath = if ($null -ne $core) { $core.ExecutablePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
    $version = & $nodePath -p 'process.versions.node'
    if ([version]$version -lt [version]'22.16.0') { throw 'Node.js 22.16 or newer is required.' }
    & $nodePath -e "try { for (const name of ['@mozilla/readability', 'linkedom', 'playwright']) require.resolve(name, { paths: [process.argv[1]] }); } catch { process.exitCode = 1; }" $context.ProjectDirectory > $null
    if ($LASTEXITCODE -ne 0) { throw 'Dependencies missing. Run npm.cmd ci --ignore-scripts in the project directory first.' }
    if (Test-Path -LiteralPath $context.StopMarker) { Remove-Item -LiteralPath $context.StopMarker }
    if ($null -eq $core) { $core = Start-MemoriaWindowsProcess $context 'Server' $nodePath }
    else { Write-MemoriaWindowsProcessRecord $context.ServerRecord $core }
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($core.Process.HasExited) { throw 'Server exited. See data\server.err.log.' }
        try {
            $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/status' -TimeoutSec 2
            if ($status.initialized -isnot [bool]) { throw 'The service status response was invalid.' }
            if ($core.Process.HasExited) { throw 'Server exited during readiness checking.' }
            $ready = $true
            break
        } catch { if ($attempt -eq 19) { throw 'Startup timed out. See data\server.err.log.' } }
    }
    if (!$ready) { throw 'Startup timed out. See data\server.err.log.' }
    $supervisor = Start-MemoriaWindowsProcess $context 'Supervisor'
    Write-Host 'Memoria: http://127.0.0.1:3210 (background crash recovery enabled)'
    if (!$status.initialized) { Write-Host ('Setup key: ' + (Join-Path $context.DataDirectory 'setup-key.txt')) }
} finally {
    if ($null -ne $supervisor) { $supervisor.Process.Dispose() }
    if ($null -ne $core) { $core.Process.Dispose() }
    if ($locked) { $gate.ReleaseMutex() }
    $gate.Dispose()
}
