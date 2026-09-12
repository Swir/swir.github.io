param(
    [Parameter(Mandatory = $true)]
    [string]$PublishDir,

    [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = [System.IO.Path]::GetFullPath($SourceRoot)
$publish = [System.IO.Path]::GetFullPath($PublishDir)
if (-not (Test-Path $source -PathType Container)) { throw "SWIR source root does not exist: $source" }
if (-not (Test-Path (Join-Path $source 'index.html') -PathType Leaf)) { throw "SWIR source root is missing index.html: $source" }
if (-not (Test-Path $publish -PathType Container)) { throw "Desktop publish directory does not exist: $publish" }

$sourceWithSep = $source.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$publishWithSep = $publish.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($publishWithSep.StartsWith($sourceWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Desktop publish output must be outside the repository source tree.'
}

$webRoot = Join-Path $publish 'Web'
if (Test-Path $webRoot) { Remove-Item $webRoot -Recurse -Force }
New-Item -ItemType Directory -Path $webRoot -Force | Out-Null

# Only tracked files can enter a Desktop release. This prevents local secrets, build outputs
# and unreviewed files from being silently bundled into a signed SWIR Desktop package.
$tracked = @(& git -C $source ls-files)
if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed while staging the Desktop runtime.' }
if ($tracked.Count -eq 0) { throw 'No tracked files were returned for the Desktop runtime.' }

$runtimeExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(
    '.html', '.htm', '.js', '.mjs', '.css', '.json', '.webmanifest', '.xml',
    '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.bmp', '.avif',
    '.woff', '.woff2', '.ttf', '.otf', '.wasm',
    '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.txt'
) | ForEach-Object { [void]$runtimeExtensions.Add($_) }

$manifestFiles = [System.Collections.Generic.List[object]]::new()
foreach ($relativeRaw in ($tracked | Sort-Object -Unique)) {
    $relative = $relativeRaw.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative)) { continue }
    if ($relative.StartsWith('.github/', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($relative.StartsWith('desktop/windows/', [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $relative.Equals('desktop/windows/app-policy.json', [System.StringComparison]::OrdinalIgnoreCase)) { continue }

    $extension = [System.IO.Path]::GetExtension($relative)
    if (-not $runtimeExtensions.Contains($extension)) { continue }

    if ($relative.Contains('../') -or $relative.StartsWith('../') -or [System.IO.Path]::IsPathRooted($relative)) {
        throw "Unsafe tracked runtime path: $relative"
    }

    $sourcePath = [System.IO.Path]::GetFullPath((Join-Path $source $relative))
    if (-not $sourcePath.StartsWith($sourceWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Tracked runtime path escaped repository root: $relative"
    }
    if (-not (Test-Path $sourcePath -PathType Leaf)) { throw "Tracked runtime file is missing: $relative" }

    $item = Get-Item $sourcePath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Reparse/symlink runtime files are not allowed in Desktop releases: $relative"
    }

    $destination = Join-Path $webRoot $relative
    $destinationDir = Split-Path $destination -Parent
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destination -Force

    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestFiles.Add([ordered]@{
        path = $relative
        sha256 = $hash
        size = [long](Get-Item -LiteralPath $destination).Length
    })
}

$required = @(
    'index.html',
    'swir-os.js',
    'swir-runtime.js',
    'swir-apps.js',
    'swir-app-bridge.js',
    'swir-app-bridge-host.js',
    'swir-updates.html',
    'sw.js',
    'desktop/windows/app-policy.json'
)
foreach ($relative in $required) {
    if (-not (Test-Path (Join-Path $webRoot $relative) -PathType Leaf)) {
        throw "Required Desktop web runtime file was not staged: $relative"
    }
}

$commit = (& git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Could not resolve source commit for Desktop runtime manifest.' }

$manifest = [ordered]@{
    schema = 'swir.desktop-web-runtime/0.1'
    sourceCommit = $commit.ToLowerInvariant()
    fileCount = $manifestFiles.Count
    files = @($manifestFiles)
}
$manifestPath = Join-Path $webRoot 'desktop-runtime.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))

Write-Host "Staged SWIR Desktop web runtime: $($manifestFiles.Count) tracked files"
Write-Host "Runtime root: $webRoot"
Write-Host "Runtime manifest: $manifestPath"
