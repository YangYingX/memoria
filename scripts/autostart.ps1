param(
    [ValidateSet('Enable', 'Disable', 'Status')]
    [string]$Mode = 'Status',
    [string]$BrowserCache
)

$ErrorActionPreference = 'Stop'

function Test-MemoriaAbsolutePath([string]$Value) {
    return $Value -match '^[a-zA-Z]:[\\/]' -or ($Value -match '^\\\\[^\\/]+\\[^\\/]+(?:\\|$)' -and $Value -notmatch '^\\\\[?.]\\')
}

function Get-MemoriaAutostartPath([string]$Value, [ValidateSet('Directory', 'File')][string]$Kind) {
    if (![string]::IsNullOrWhiteSpace($Value) -and (Test-MemoriaAbsolutePath $Value) -and $Value -notmatch '["\x00-\x1f]') {
        $resolved = Resolve-Path -LiteralPath $Value -ErrorAction Stop
        if ($resolved.Provider.Name -ne 'FileSystem') { throw 'Only filesystem paths are supported.' }
        $item = Get-Item -LiteralPath $resolved.ProviderPath -Force
        if (($Kind -eq 'Directory') -ne [bool]$item.PSIsContainer) { throw 'The required file or directory is unavailable.' }
        $cursor = $item
        while ($null -ne $cursor) {
            if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked paths are not supported for managed autostart.' }
            if ($cursor.PSIsContainer) { $cursor = $cursor.Parent } else { $cursor = $cursor.Directory }
        }
        return [IO.Path]::GetFullPath($resolved.ProviderPath)
    }
    throw 'An existing absolute filesystem path without control characters is required.'
}

function ConvertTo-MemoriaQuotedArgument([string]$Value) {
    if ($Value -match '["\x00-\x1f]') { throw 'The startup argument contains unsupported characters.' }
    return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}

function Get-MemoriaAutostartContext([string]$ProjectDirectory, [string]$StartupDirectory) {
    $project = Get-MemoriaAutostartPath $ProjectDirectory 'Directory'
    $startup = Get-MemoriaAutostartPath $StartupDirectory 'Directory'
    $start = Get-MemoriaAutostartPath (Join-Path $project 'scripts\start.ps1') 'File'
    $powershell = Get-MemoriaAutostartPath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') 'File'
    $canonical = $project.TrimEnd([char[]]'\/').ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))).Replace('-', '').ToLowerInvariant().Substring(0, 12) }
    finally { $sha.Dispose() }
    return [pscustomobject]@{
        ProjectDirectory = $project
        StartupDirectory = $startup
        ShortcutPath = Join-Path $startup ('Memoria-' + $digest + '.lnk')
        Description = 'Memoria managed current-user autostart v1 ' + $digest
        PowerShellPath = $powershell
        BaseArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (ConvertTo-MemoriaQuotedArgument $start)
    }
}

function Get-MemoriaAutostartArguments($Context, [string]$Cache) {
    if ([string]::IsNullOrEmpty($Cache)) { return $Context.BaseArguments }
    return $Context.BaseArguments + ' -BrowserCache ' + (ConvertTo-MemoriaQuotedArgument $Cache)
}

function Read-MemoriaManagedShortcut($Context, $Shell) {
    try { $item = Get-Item -LiteralPath $Context.ShortcutPath -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return $null }
    $null = Get-MemoriaAutostartPath $item.FullName 'File'
    $link = $Shell.CreateShortcut($Context.ShortcutPath)
    try {
        if ($link.Description -cne $Context.Description -or $link.TargetPath -ine $Context.PowerShellPath -or
            $link.WorkingDirectory.TrimEnd([char[]]'\/') -ine $Context.ProjectDirectory.TrimEnd([char[]]'\/')) {
            throw 'An existing startup entry is not owned by this project; it was not changed.'
        }
        $arguments = [string]$link.Arguments
        $cache = $null
        if ($arguments -ine $Context.BaseArguments) {
            $pattern = '^' + [regex]::Escape($Context.BaseArguments) + ' -BrowserCache "([^"\x00-\x1f]*)"$'
            $match = [regex]::Match($arguments, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if (!$match.Success) { throw 'The managed startup arguments have changed; no entry was changed.' }
            $encoded = $match.Groups[1].Value
            $trailing = $encoded.Length - $encoded.TrimEnd([char]'\').Length
            if ($trailing % 2) { throw 'The managed browser cache argument is invalid.' }
            $cache = $encoded.Substring(0, $encoded.Length - $trailing) + ('\' * [int]($trailing / 2))
            if ($cache -cne '0' -and !(Test-MemoriaAbsolutePath $cache)) { throw 'The managed browser cache argument is invalid.' }
            if ((Get-MemoriaAutostartArguments $Context $cache) -ine $arguments) { throw 'The managed startup arguments are invalid.' }
        }
        return [pscustomobject]@{ Link = $link; BrowserCache = $cache }
    } catch {
        $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($link)
        throw
    }
}

function Invoke-MemoriaAutostart($Context, [ValidateSet('Enable', 'Disable', 'Status')][string]$Action = 'Status',
    [string]$Cache, [bool]$CacheSpecified = $false) {
    $mutex = New-Object Threading.Mutex($false, ('Local\MemoriaAutostart-' + $Context.Description.Substring($Context.Description.Length - 12)))
    $locked = $false
    $shell = $null
    $existing = $null
    $created = $null
    try {
        try { $locked = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw 'Another autostart change is in progress for this project.' }
        $null = Get-MemoriaAutostartPath $Context.StartupDirectory 'Directory'
        $shell = New-Object -ComObject WScript.Shell
        $existing = Read-MemoriaManagedShortcut $Context $shell
        if ($Action -eq 'Enable') {
            $preservingCache = $false
            if (!$CacheSpecified) {
                $Cache = $env:PLAYWRIGHT_BROWSERS_PATH
                if ([string]::IsNullOrEmpty($Cache) -and $null -ne $existing) { $Cache = $existing.BrowserCache; $preservingCache = $true }
            }
            if ([string]::IsNullOrEmpty($Cache) -and !$CacheSpecified) { $Cache = $null }
            elseif ($Cache -cne '0' -and !$preservingCache) { $Cache = Get-MemoriaAutostartPath $Cache 'Directory' }
            $arguments = Get-MemoriaAutostartArguments $Context $Cache
            if ($null -eq $existing -or $existing.Link.Arguments -ine $arguments) {
                $created = $shell.CreateShortcut($Context.ShortcutPath)
                $created.TargetPath = $Context.PowerShellPath
                $created.Arguments = $arguments
                $created.WorkingDirectory = $Context.ProjectDirectory
                $created.Description = $Context.Description
                $created.WindowStyle = 7
                $created.Save()
            }
            $verified = Read-MemoriaManagedShortcut $Context $shell
            try {
                if ($verified.Link.Arguments -ine $arguments) { throw 'The saved startup entry did not match the requested configuration.' }
            } finally { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($verified.Link) }
        } elseif ($Action -eq 'Disable' -and $null -ne $existing) {
            $null = Get-MemoriaAutostartPath $Context.ShortcutPath 'File'
            Remove-Item -LiteralPath $Context.ShortcutPath -Force
        }
        $enabled = if ($Action -eq 'Enable') { $true } elseif ($Action -eq 'Disable') { $false } else { $null -ne $existing }
        $selectedCache = if ($Action -eq 'Enable') { $Cache } elseif ($enabled) { $existing.BrowserCache } else { $null }
        return [pscustomobject]@{
            Configured = $enabled
            ShortcutPath = $Context.ShortcutPath
            BrowserCache = $selectedCache
            Note = 'Configuration only. This does not report service state, start or stop Node, or provide crash recovery. Takes effect at user sign-in.'
        }
    } finally {
        if ($null -ne $created) { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($created) }
        if ($null -ne $existing) { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($existing.Link) }
        if ($null -ne $shell) { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -eq '.') { return }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This autostart script requires Windows.' }
$projectDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$startupDirectory = [Environment]::GetFolderPath('Startup')
$context = Get-MemoriaAutostartContext $projectDirectory $startupDirectory
Invoke-MemoriaAutostart $context $Mode $BrowserCache ($PSBoundParameters.ContainsKey('BrowserCache'))
