[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PublishDir,

    [Parameter(Mandatory = $true)]
    [string]$ReleaseVersion,

    [Parameter(Mandatory = $true)]
    [ValidateSet('preview', 'stable')]
    [string]$Channel,

    [string]$ProjectFile = 'SWIR.Desktop.Host.csproj',
    [string]$ProgramFile = 'Program.cs',
    [string]$SourceCommit = $env:GITHUB_SHA
)

$ErrorActionPreference = 'Stop'

$parsedVersion = $null
if (-not [Version]::TryParse($ReleaseVersion, [ref]$parsedVersion) -or $parsedVersion.Build -lt 0) {
    throw "ReleaseVersion must be a three-part numeric version such as 0.5.2. Got: $ReleaseVersion"
}
if ($parsedVersion -le [Version]'0.0.0') {
    throw 'ReleaseVersion must be greater than 0.0.0.'
}

$projectPath = (Resolve-Path -LiteralPath $ProjectFile).Path
$programPath = (Resolve-Path -LiteralPath $ProgramFile).Path
$publishPath = [System.IO.Path]::GetFullPath($PublishDir)
$hostVersion = "$ReleaseVersion-$Channel"

$sourceBytes = [System.IO.File]::ReadAllBytes($programPath)
$sourceText = [System.Text.Encoding]::UTF8.GetString($sourceBytes)
$pattern = "version: '(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?)'"
$matches = [System.Text.RegularExpressions.Regex]::Matches($sourceText, $pattern)
if ($matches.Count -ne 2) {
    throw "Expected exactly two Desktop Host version literals in Program.cs, found $($matches.Count). Refusing an ambiguous release build."
}

$patchedText = [System.Text.RegularExpressions.Regex]::Replace(
    $sourceText,
    $pattern,
    "version: '$hostVersion'")
$patchedMatches = [System.Text.RegularExpressions.Regex]::Matches($patchedText, [regex]::Escape("version: '$hostVersion'"))
if ($patchedMatches.Count -ne 2) {
    throw "Desktop Host version injection did not produce exactly two $hostVersion literals."
}

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
try {
    [System.IO.File]::WriteAllText($programPath, $patchedText, $utf8NoBom)

    if (Test-Path -LiteralPath $publishPath) {
        Remove-Item -LiteralPath $publishPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $publishPath -Force | Out-Null

    & dotnet publish $projectPath --configuration Release --output $publishPath
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed with exit code $LASTEXITCODE"
    }
}
finally {
    [System.IO.File]::WriteAllBytes($programPath, $sourceBytes)
}

$hostExe = Join-Path $publishPath 'SWIR.Desktop.Host.exe'
$hostDll = Join-Path $publishPath 'SWIR.Desktop.Host.dll'
if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
    throw "Desktop Host publish output is missing the entry point: $hostExe"
}
if (-not (Test-Path -LiteralPath $hostDll -PathType Leaf)) {
    throw "Desktop Host publish output is missing the managed assembly: $hostDll"
}

$commit = if ([string]::IsNullOrWhiteSpace($SourceCommit)) { 'local-unpinned' } else { $SourceCommit.Trim().ToLowerInvariant() }
if ($commit -ne 'local-unpinned' -and $commit -notmatch '^[0-9a-f]{40}$') {
    throw "SourceCommit must be a 40-character Git SHA when supplied. Got: $SourceCommit"
}

$manifest = [ordered]@{
    schema = 'swir.desktop-host-build/0.1'
    releaseVersion = $ReleaseVersion
    channel = $Channel
    hostVersion = $hostVersion
    sourceCommit = $commit
    entryPoint = 'SWIR.Desktop.Host.exe'
}
$manifestPath = Join-Path $publishPath 'desktop-host-build.json'
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 4),
    $utf8NoBom)

$restoredBytes = [System.IO.File]::ReadAllBytes($programPath)
if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$sourceBytes, [byte[]]$restoredBytes)) {
    throw 'Program.cs was not restored byte-for-byte after Desktop Host publish.'
}

Write-Host "SWIR Desktop Host published as $hostVersion"
Write-Host "Build manifest: $manifestPath"
