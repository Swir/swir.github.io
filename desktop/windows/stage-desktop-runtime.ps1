param(
    [Parameter(Mandatory = $true)]
    [string]$PublishDir,

    [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$CatalogReleaseDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = [System.IO.Path]::GetFullPath($SourceRoot)
$publish = [System.IO.Path]::GetFullPath($PublishDir)
$desktopEntryRelative = 'swir-desktop.html'
$desktopEntrySource = Join-Path $source $desktopEntryRelative
if (-not (Test-Path $source -PathType Container)) { throw "SWIR source root does not exist: $source" }
if (-not (Test-Path $desktopEntrySource -PathType Leaf)) { throw "SWIR source root is missing the dedicated Desktop shell entry: $desktopEntrySource" }
if (-not (Test-Path $publish -PathType Container)) { throw "Desktop publish directory does not exist: $publish" }

$catalogRelease = $null
if (-not [string]::IsNullOrWhiteSpace($CatalogReleaseDir)) {
    $catalogRelease = [System.IO.Path]::GetFullPath($CatalogReleaseDir)
    if (-not (Test-Path $catalogRelease -PathType Container)) { throw "Catalog release directory does not exist: $catalogRelease" }
    foreach ($requiredCatalogFile in @('swir-signed-catalog-release.js', 'catalog-trust-roots.json', 'catalog-envelope.json', 'catalog.json')) {
        if (-not (Test-Path (Join-Path $catalogRelease $requiredCatalogFile) -PathType Leaf)) {
            throw "Catalog release directory is incomplete; missing $requiredCatalogFile"
        }
    }
}

$sourceWithSep = $source.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$publishWithSep = $publish.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($publishWithSep.StartsWith($sourceWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Desktop publish output must be outside the repository source tree.'
}

# Runtime web assets live beside SWIR.Desktop.Host.exe. Program.ResolveRepoRoot() deliberately
# resolves index.html from AppContext.BaseDirectory first, so the signed package is standalone
# and does not depend on a Git checkout after installation. The public GitHub Pages index.html
# is only the product preview; swir-desktop.html is the canonical Desktop shell and is staged
# as index.html for the native host.
$runtimeRoot = $publish

# Only tracked files can enter a Desktop release. This prevents local secrets, build outputs
# and unreviewed files from being silently bundled into a signed SWIR Desktop package.
$tracked = @(& git -C $source ls-files)
if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed while staging the Desktop runtime.' }
if ($tracked.Count -eq 0) { throw 'No tracked files were returned for the Desktop runtime.' }
if (-not ($tracked -contains $desktopEntryRelative)) { throw "Dedicated Desktop shell is not tracked by Git: $desktopEntryRelative" }

$runtimeExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(
    '.html', '.htm', '.js', '.mjs', '.css', '.json', '.webmanifest', '.xml',
    '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.bmp', '.avif',
    '.woff', '.woff2', '.ttf', '.otf', '.wasm',
    '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.txt'
) | ForEach-Object { [void]$runtimeExtensions.Add($_) }

$manifestFiles = [System.Collections.Generic.List[object]]::new()
$desktopEntryStaged = $false
foreach ($relativeRaw in ($tracked | Sort-Object -Unique)) {
    $relative = $relativeRaw.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative)) { continue }
    if ($relative.StartsWith('.github/', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($relative.StartsWith('desktop/windows/', [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $relative.Equals('desktop/windows/app-policy.json', [System.StringComparison]::OrdinalIgnoreCase)) { continue }

    # GitHub Pages owns root index.html. Desktop Edition must never accidentally package the
    # public showcase as its shell. The dedicated shell is remapped to index.html below.
    if ($relative.Equals('index.html', [System.StringComparison]::OrdinalIgnoreCase)) { continue }

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

    $copySource = $sourcePath
    if ($catalogRelease -and $relative.Equals('swir-signed-catalog-release.js', [System.StringComparison]::OrdinalIgnoreCase)) {
        $copySource = Join-Path $catalogRelease 'swir-signed-catalog-release.js'
    }

    $isDesktopEntry = $relative.Equals($desktopEntryRelative, [System.StringComparison]::OrdinalIgnoreCase)
    $runtimeRelative = if ($isDesktopEntry) { 'index.html' } else { $relative }
    $destination = Join-Path $runtimeRoot $runtimeRelative
    if (Test-Path $destination -PathType Leaf) {
        throw "Tracked web runtime would overwrite Desktop publish output: $runtimeRelative (source: $relative)"
    }
    $destinationDir = Split-Path $destination -Parent
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    Copy-Item -LiteralPath $copySource -Destination $destination -Force
    if ($isDesktopEntry) { $desktopEntryStaged = $true }

    # Shipping Desktop Store loads public release metadata before the coordinator. Web/source
    # builds do not need this extra script tag and keep their fail-closed null release slot.
    if ($catalogRelease -and $relative.Equals('swir-store.html', [System.StringComparison]::OrdinalIgnoreCase)) {
        $html = Get-Content -LiteralPath $destination -Raw
        $needle = '<script src="./swir-store-desktop.js"></script>'
        $replacement = '<script src="./swir-signed-catalog-release.js"></script>' + [Environment]::NewLine + $needle
        if (-not $html.Contains($needle)) { throw 'Could not locate Desktop Store coordinator script tag for signed catalog injection.' }
        $html = $html.Replace($needle, $replacement)
        [System.IO.File]::WriteAllText($destination, $html, [System.Text.UTF8Encoding]::new($false))
    }

    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestFiles.Add([ordered]@{
        path = $runtimeRelative
        sha256 = $hash
        size = [long](Get-Item -LiteralPath $destination).Length
    })
}

if ($catalogRelease) {
    # The Host project ships a fail-closed source template. A production catalog release may
    # replace only the PUBLIC trust-root document; private key material never enters PublishDir.
    Copy-Item -LiteralPath (Join-Path $catalogRelease 'catalog-trust-roots.json') -Destination (Join-Path $runtimeRoot 'catalog-trust-roots.json') -Force
    Copy-Item -LiteralPath (Join-Path $catalogRelease 'catalog-envelope.json') -Destination (Join-Path $runtimeRoot 'catalog-envelope.json') -Force
    Copy-Item -LiteralPath (Join-Path $catalogRelease 'catalog.json') -Destination (Join-Path $runtimeRoot 'catalog.json') -Force
}

$required = @(
    'index.html',
    'swir-i18n.js',
    'swir-os.js',
    'swir-runtime.js',
    'swir-file-storage.js',
    'swir-apps.js',
    'swir-app-bridge.js',
    'swir-app-bridge-host.js',
    'swir-updates.html',
    'sw.js',
    'swir-store-desktop.js',
    'swir-signed-catalog-release.js',
    'desktop/windows/app-policy.json'
)
foreach ($relative in $required) {
    if (-not (Test-Path (Join-Path $runtimeRoot $relative) -PathType Leaf)) {
        throw "Required Desktop web runtime file was not staged: $relative"
    }
}

# Fail closed if a future website redesign is accidentally routed into the native Desktop Host.
if (-not $desktopEntryStaged) { throw 'Dedicated Desktop shell was not staged.' }
$runtimeEntryPath = Join-Path $runtimeRoot 'index.html'
$runtimeEntryHtml = Get-Content -LiteralPath $runtimeEntryPath -Raw
foreach ($needle in @('id="boot-screen"', 'id="os-shell"', './swir-app-bridge-host.js', './swir-os.js')) {
    if (-not $runtimeEntryHtml.Contains($needle)) { throw "Desktop runtime entry is missing shell invariant: $needle" }
}
if ($runtimeEntryHtml.Contains('ONE OS.<span>EVERY SCREEN.</span>')) {
    throw 'Desktop runtime entry resolved to the public SWIR OS showcase instead of the native shell.'
}
$entryManifestRecords = @($manifestFiles | Where-Object { $_.path -eq 'index.html' })
if ($entryManifestRecords.Count -ne 1) { throw 'Desktop runtime manifest must contain exactly one index.html shell entry.' }

if ($catalogRelease) {
    foreach ($relative in @('catalog-trust-roots.json', 'catalog-envelope.json', 'catalog.json')) {
        if (-not (Test-Path (Join-Path $runtimeRoot $relative) -PathType Leaf)) { throw "Signed catalog runtime file was not staged: $relative" }
    }
    $trust = Get-Content (Join-Path $runtimeRoot 'catalog-trust-roots.json') -Raw | ConvertFrom-Json
    if ($trust.schema -ne 'swir.catalog-trust-roots/1.0' -or $trust.requireSignedCatalog -ne $true -or @($trust.roots).Count -lt 1) {
        throw 'Production signed catalog trust roots must require signed catalogs and contain at least one root.'
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
$manifestPath = Join-Path $runtimeRoot 'desktop-runtime.json'
if (Test-Path $manifestPath) { throw 'Desktop publish output already contains reserved desktop-runtime.json.' }
$manifestJson = $manifest | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))

Write-Host "Staged SWIR Desktop web runtime: $($manifestFiles.Count) tracked files"
Write-Host "Desktop entry: $desktopEntryRelative -> index.html"
if ($catalogRelease) { Write-Host "Signed catalog release: $catalogRelease" }
Write-Host "Runtime root: $runtimeRoot"
Write-Host "Runtime manifest: $manifestPath"
