param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDir,

    [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = [System.IO.Path]::GetFullPath($SourceRoot)
$output = [System.IO.Path]::GetFullPath($OutputDir)
if (-not (Test-Path $source -PathType Container)) { throw "SWIR source root does not exist: $source" }
if (-not (Test-Path (Join-Path $source 'swir-packages.js') -PathType Leaf)) { throw 'swir-packages.js is missing.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required to export the reviewed package catalog.' }

New-Item -ItemType Directory -Path $output -Force | Out-Null
$packagesDir = Join-Path $output 'packages'
New-Item -ItemType Directory -Path $packagesDir -Force | Out-Null

$catalogJson = & node -e @'
const fs=require('fs'),vm=require('vm');
const p=process.argv[1];
const source=fs.readFileSync(p,'utf8');
const sandbox={window:{}};
vm.createContext(sandbox);
vm.runInContext(source,sandbox,{filename:p,timeout:3000});
const catalog=sandbox.window.SWIR_PACKAGE_CATALOG;
if(!Array.isArray(catalog)||!catalog.length) throw new Error('SWIR_PACKAGE_CATALOG must be non-empty');
process.stdout.write(JSON.stringify(catalog));
'@ (Join-Path $source 'swir-packages.js')
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($catalogJson)) { throw 'Could not export SWIR package catalog.' }
$catalog = @($catalogJson | ConvertFrom-Json)
if ($catalog.Count -eq 0) { throw 'Exported package catalog is empty.' }

$artifactRecords = [System.Collections.Generic.List[object]]::new()
$seenIdentity = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$seenOutput = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

function Assert-SafeRelativePath([string]$RelativePath, [string]$Context) {
    $normalized = $RelativePath.Replace('\\','/').Trim()
    if ($normalized.StartsWith('./')) { $normalized = $normalized.Substring(2) }
    if ([string]::IsNullOrWhiteSpace($normalized) -or [System.IO.Path]::IsPathRooted($normalized) -or $normalized.StartsWith('/') -or $normalized -match '(^|/)\.\.(/|$)') {
        throw "Unsafe relative path in ${Context}: $RelativePath"
    }
    return $normalized
}

function Copy-PackageAsset([string]$RelativePath, [string]$StageRoot, [System.Collections.Generic.HashSet[string]]$Copied) {
    $safe = Assert-SafeRelativePath $RelativePath 'package asset'
    if (-not $Copied.Add($safe)) { return }
    $src = [System.IO.Path]::GetFullPath((Join-Path $source $safe))
    $sourcePrefix = $source.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $src.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Package asset escaped source root: $safe" }
    if (-not (Test-Path $src -PathType Leaf)) { throw "Package asset is missing: $safe" }
    $item = Get-Item -LiteralPath $src -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Package asset cannot be a symlink/reparse point: $safe" }
    $dest = Join-Path $StageRoot $safe
    New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $src -Destination $dest -Force
}

foreach ($pkg in ($catalog | Sort-Object packageId, version)) {
    if ($pkg.desktop -ne $true) { continue }
    $packageId = [string]$pkg.packageId
    $version = [string]$pkg.version
    $entryRaw = [string]$pkg.entry
    if ($pkg.schema -ne 'swir.app/1.0') { throw "Unsupported package schema for $packageId: $($pkg.schema)" }
    if ($packageId -notmatch '^swir\.[a-z0-9][a-z0-9._-]{1,126}$') { throw "Invalid packageId: $packageId" }
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version for ${packageId}: $version" }
    if ([string]::IsNullOrWhiteSpace([string]$pkg.name) -or [string]::IsNullOrWhiteSpace([string]$pkg.author) -or [string]::IsNullOrWhiteSpace([string]$pkg.type)) {
        throw "Package identity/runtime fields are incomplete for $packageId"
    }
    $identity = "$packageId@$version"
    if (-not $seenIdentity.Add($identity)) { throw "Duplicate Desktop package identity: $identity" }
    $entry = Assert-SafeRelativePath $entryRaw "$identity entry"

    $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("swirapp-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        $copied = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        Copy-PackageAsset $entry $stage $copied

        # Include reviewed local script/style/image dependencies referenced by the entry document.
        # Remote URLs, data URLs, fragments and absolute paths are deliberately not imported.
        $entryText = Get-Content -LiteralPath (Join-Path $source $entry) -Raw
        $matches = [regex]::Matches($entryText, '(?i)(?:src|href)\s*=\s*["''](\./[^"''?#]+)')
        foreach ($match in $matches) {
            $dep = [string]$match.Groups[1].Value
            if (-not [string]::IsNullOrWhiteSpace($dep)) { Copy-PackageAsset $dep $stage $copied }
        }

        $manifest = [ordered]@{}
        foreach ($prop in $pkg.PSObject.Properties) { $manifest[$prop.Name] = $prop.Value }
        $manifest['entry'] = './' + $entry.Replace('\\','/')
        $manifestPath = Join-Path $stage 'swir-package.json'
        [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))

        $safeName = ($packageId -replace '[^A-Za-z0-9._-]', '_')
        $fileName = "$safeName-$version.swirapp"
        if (-not $seenOutput.Add($fileName)) { throw "Duplicate package artifact filename: $fileName" }
        $zipPath = Join-Path $output ($fileName + '.zip')
        $artifactPath = Join-Path $packagesDir $fileName
        Compress-Archive -LiteralPath (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
        Move-Item -LiteralPath $zipPath -Destination $artifactPath -Force

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [System.IO.Compression.ZipFile]::OpenRead($artifactPath)
        try {
            $rootManifests = @($archive.Entries | Where-Object { $_.FullName.Replace('\\','/') -ceq 'swir-package.json' })
            if ($rootManifests.Count -ne 1) { throw "Built artifact must contain exactly one root swir-package.json: $identity" }
            $reader = [System.IO.StreamReader]::new($rootManifests[0].Open())
            try { $builtManifest = ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
            if ($builtManifest.packageId -ne $packageId -or $builtManifest.version -ne $version) { throw "Built package identity mismatch: $identity" }
            $entryInZip = $archive.GetEntry($entry.Replace('\\','/'))
            if ($null -eq $entryInZip) { throw "Built package is missing entry file $entry for $identity" }
        } finally { $archive.Dispose() }

        $sha = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $artifactRecords.Add([ordered]@{
            packageId = $packageId
            version = $version
            desktop = [ordered]@{
                sha256 = $sha
                url = "packages/$fileName"
            }
        })
    }
    finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($artifactRecords.Count -eq 0) { throw 'No Desktop-installable packages were produced.' }
if ($artifactRecords.Count -ne @($catalog | Where-Object { $_.desktop -eq $true }).Count) { throw 'Desktop package artifact count does not match reviewed catalog.' }

$map = [ordered]@{
    schema = 'swir.catalog-artifacts/1.0'
    generatedFrom = (& git -C $source rev-parse HEAD).Trim().ToLowerInvariant()
    artifacts = @($artifactRecords)
}
$mapPath = Join-Path $output 'catalog-artifacts.json'
[System.IO.File]::WriteAllText($mapPath, ($map | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

Write-Host "Built $($artifactRecords.Count) reviewed Desktop Store package artifacts."
Write-Host "Artifact map: $mapPath"
Write-Host "Package directory: $packagesDir"
