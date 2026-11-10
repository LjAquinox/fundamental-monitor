# Intentionally no param block: preserve -Fresh, -Concurrency and GNU flags.
$ErrorActionPreference = 'Stop'
$mode = if ($args.Count -gt 0) { [string]$args[0] } else { 'start' }
$workflowArgs = @()
if ($args.Count -gt 1) { $workflowArgs = @($args[1..($args.Count - 1)]) }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location -LiteralPath $root
try {
    if ($mode -notin @('start', 'workflow')) { throw 'Unknown launcher mode.' }
    $manifestPath = Join-Path $root '.local-build\build.json'
    if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Prebuilt app missing. Extract the complete release archive, or run npm ci and npm run build as a developer.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($group in @($manifest.sourceFiles, $manifest.files)) {
        foreach ($entry in $group.PSObject.Properties) {
            $path = [IO.Path]::GetFullPath((Join-Path $root $entry.Name))
            if (!$path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid build manifest path.' }
            if (!(Test-Path -LiteralPath $path) -or ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.Value)) {
                throw "Build does not match source: $($entry.Name). Extract the complete release archive, or rebuild with npm run build."
            }
        }
    }
    $versions = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-versions.json') -Raw | ConvertFrom-Json
    $runtimeDir = Join-Path $root '.runtime'
    $node = Join-Path $runtimeDir ($versions.node.directory + '\node.exe')
    if (!(Test-Path -LiteralPath $node)) {
        New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
        $archive = Join-Path $runtimeDir 'node-download.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host "Downloading portable Node $($versions.node.version)..."
        Invoke-WebRequest -UseBasicParsing -Uri $versions.node.url -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $versions.node.sha256) {
            Remove-Item -LiteralPath $archive -Force
            throw 'Portable Node checksum mismatch. Download was rejected.'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir -Force
        Remove-Item -LiteralPath $archive -Force
    }
    $env:FUNDAMENTAL_ROOT = $root
    if (!(Test-Path -LiteralPath (Join-Path $root '.dev.vars'))) {
        Copy-Item -LiteralPath (Join-Path $root '.dev.vars.example') -Destination (Join-Path $root '.dev.vars')
    }
    if ($mode -eq 'workflow') {
        Write-Host 'Stop the app with Ctrl+C before continuing.'
        $localReview = @($workflowArgs | Where-Object { $_ -match '^(--?(ApplySavedReview|apply-saved-review|RecoverReview|recover-review))(=|$)' }).Count -gt 0
        if ($localReview) {
            Write-Host 'Local saved-review application only. A backup is created first. No model calls are made.'
        } else {
            Write-Host 'Paid model calls are used. PDF extraction runs in parallel, then one high-reasoning reconciliation per company.'
            Write-Host 'Progress resumes by default. -Fresh reruns everything; -ReviewOnly uses existing typed reports.'
        }
        & $node (Join-Path $root 'scripts\run-workflow.mjs') @workflowArgs
        exit $LASTEXITCODE
    }
    $port = if ($env:FUNDAMENTAL_PORT) { $env:FUNDAMENTAL_PORT } else { '5173' }
    if ($port -notmatch '^\d+$' -or [int]$port -lt 1 -or [int]$port -gt 65535) { throw 'Invalid FUNDAMENTAL_PORT.' }
    $url = "http://127.0.0.1:$port"
    $health = $null
    try { $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2 } catch { }
    if ($health.runtime -eq 'local-node') { Start-Process $url; exit 0 }
    # Open the browser only after the server answers; no persistent helper process.
    $browserWait = @"
for (`$i = 0; `$i -lt 90; `$i++) {
    try {
        `$health = Invoke-RestMethod -Uri '$url/api/health' -TimeoutSec 1
        if (`$health.runtime -eq 'local-node') { Start-Process '$url'; exit }
    } catch { }
    Start-Sleep -Milliseconds 500
}
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($browserWait))
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', $encoded)
    Write-Host "Starting $url. Keep this window open; press Ctrl+C to stop."
    & $node (Join-Path $root '.local-build\server.mjs')
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
