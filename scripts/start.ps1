$ErrorActionPreference = 'Stop'
$projectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverPath = Join-Path $projectDir 'src\server.js'
$dataDir = Join-Path $projectDir 'data'
$pidFile = Join-Path $dataDir 'server.pid'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $running = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
    if ($running -and $running.Name -eq 'node.exe' -and $running.CommandLine.Contains($serverPath)) {
        Write-Host 'Memoria is already running: http://127.0.0.1:3210'
        exit 0
    }
}
if (Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 3210 is already in use. Stop that service first, or use PORT with npm run dev.'
}
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$version = & $nodePath -p 'process.versions.node'
if ([version]$version -lt [version]'22.16.0') { throw 'Node.js 22.16 or newer is required.' }
if (!(Test-Path -LiteralPath (Join-Path $projectDir 'node_modules\@mozilla\readability'))) {
    throw 'Dependencies missing. Run npm.cmd ci in the project directory first.'
}
$env:PORT = '3210'
$env:PERSONA_DATA_DIR = $dataDir
$process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server.err.log') -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw 'Server exited. See data\server.err.log.' }
    try {
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/status' -TimeoutSec 2
        Write-Host 'Memoria: http://127.0.0.1:3210'
        if (!$status.initialized) { Write-Host ('Setup key: ' + (Join-Path $dataDir 'setup-key.txt')) }
        exit 0
    } catch { if ($attempt -eq 19) { throw 'Startup timed out. See data\server.err.log.' } }
}
