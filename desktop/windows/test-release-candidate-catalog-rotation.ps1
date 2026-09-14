param(
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$WorkRoot = (Join-Path ([System.IO.Path]::GetTempPath()) ('swir-release-candidate-rotation-' + [guid]::NewGuid().ToString('N')))
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file missing: $Path" }
}

function Sha256-File([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Sha256-RawBase64([string]$Value) {
  $raw = [Convert]::FromBase64String($Value)
  return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant()
}

$desktop = Join-Path $SourceRoot 'desktop\windows'
$storeBuilder = Join-Path $desktop 'build-store-packages.ps1'
$hostPublish = Join-Path $desktop 'publish-desktop-host.ps1'
$hostProject = Join-Path $desktop 'SWIR.Desktop.Host.csproj'
$hostProgram = Join-Path $desktop 'Program.cs'
$runtimeStage = Join-Path $desktop 'stage-desktop-runtime.ps1'
$rotationApply = Join-Path $SourceRoot 'scripts\apply-catalog-root-rotation.mjs'
$rotationVerify = Join-Path $SourceRoot 'scripts\verify-catalog-root-rotation.mjs'
$catalogBuilder = Join-Path $SourceRoot 'scripts\build-signed-catalog-release.mjs'
foreach ($required in @($storeBuilder, $hostPublish, $hostProject, $hostProgram, $runtimeStage, $rotationApply, $rotationVerify, $catalogBuilder)) { Require-File $required }

$publish = Join-Path $WorkRoot 'publish'
$store = Join-Path $WorkRoot 'store'
$catalog = Join-Path $WorkRoot 'catalog'
$bundle = Join-Path $WorkRoot 'bundle'
$expanded = Join-Path $WorkRoot 'expanded'
$currentPrivate = Join-Path $WorkRoot 'catalog-current-private.pem'
$rsaPrivate = Join-Path $WorkRoot 'release-private.pem'
$rsaPublic = Join-Path $WorkRoot 'release-public.pem'
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

try {
  Push-Location $desktop
  try {
    dotnet build SWIR.Desktop.Host.csproj --configuration Release
    if ($LASTEXITCODE -ne 0) { throw 'Desktop Host build failed.' }
    dotnet build SWIR.Desktop.ReleaseBundleTool.csproj --configuration Release
    if ($LASTEXITCODE -ne 0) { throw 'Release bundle tool build failed.' }
    dotnet build SWIR.Desktop.ReleaseBundleVerifierTool.csproj --configuration Release
    if ($LASTEXITCODE -ne 0) { throw 'Release verifier tool build failed.' }
    dotnet build SWIR.Desktop.UpdaterWorker.csproj --configuration Release
    if ($LASTEXITCODE -ne 0) { throw 'Updater worker build failed.' }
  } finally {
    Pop-Location
  }

  & $storeBuilder -OutputDir $store -SourceRoot $SourceRoot
  $artifactMapPath = Join-Path $store 'catalog-artifacts.json'
  Require-File $artifactMapPath
  $artifactMap = Get-Content $artifactMapPath -Raw | ConvertFrom-Json
  if ($artifactMap.schema -ne 'swir.catalog-artifacts/1.0' -or @($artifactMap.artifacts).Count -lt 1) { throw 'Store artifact map is invalid.' }

  node -e "const fs=require('fs'),crypto=require('crypto'); const {privateKey}=crypto.generateKeyPairSync('ed25519'); fs.writeFileSync(process.argv[1], privateKey.export({format:'pem',type:'pkcs8'}));" $currentPrivate
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate current Ed25519 signing key.' }
  $env:SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM = Get-Content $currentPrivate -Raw

  node $catalogBuilder `
    --catalog-source (Join-Path $SourceRoot 'swir-packages.js') `
    --artifact-map $artifactMapPath `
    --output-dir $catalog `
    --key-id ci-rc-current `
    --sequence 910000 `
    --catalog-version ci-release-candidate-rotation `
    --valid-hours 24
  if ($LASTEXITCODE -ne 0) { throw 'Signed catalog build failed.' }
  Remove-Item Env:SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM -ErrorAction SilentlyContinue

  $trustPath = Join-Path $catalog 'catalog-trust-roots.json'
  Require-File $trustPath
  $trust = Get-Content $trustPath -Raw | ConvertFrom-Json
  $current = @($trust.roots | Where-Object { $_.enabled -ne $false -and @($_.scope) -contains 'catalog:official' })
  if ($trust.requireSignedCatalog -ne $true -or $current.Count -ne 1 -or $current[0].keyId -ne 'ci-rc-current') { throw 'Initial catalog trust root is not fail-closed/current-root bound.' }
  $currentFingerprint = Sha256-RawBase64 ([string]$current[0].publicKey)

  $nextJson = node -e "const crypto=require('crypto'); const {publicKey}=crypto.generateKeyPairSync('ed25519'); const jwk=publicKey.export({format:'jwk'}); const raw=Buffer.from(jwk.x.replace(/-/g,'+').replace(/_/g,'/'),'base64'); process.stdout.write(JSON.stringify({publicKey:raw.toString('base64'),fingerprint:crypto.createHash('sha256').update(raw).digest('hex')}));"
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate next Ed25519 public root.' }
  $next = $nextJson | ConvertFrom-Json

  node $rotationApply $trustPath $currentFingerprint ci-rc-current ([string]$next.publicKey) ([string]$next.fingerprint) ci-rc-next 910001 910002
  if ($LASTEXITCODE -ne 0) { throw 'Catalog root rotation applicator failed.' }
  node $rotationVerify $trustPath $currentFingerprint ci-rc-current ([string]$next.fingerprint) ci-rc-next 910001 910002
  if ($LASTEXITCODE -ne 0) { throw 'Catalog root rotation verification failed before staging.' }

  & $hostPublish -PublishDir $publish -ReleaseVersion '0.5.2' -Channel 'preview' -ProjectFile $hostProject -ProgramFile $hostProgram -SourceCommit ($env:GITHUB_SHA ?? 'local-contract')
  & $runtimeStage -PublishDir $publish -SourceRoot $SourceRoot -CatalogReleaseDir $catalog

  $publishPackages = Join-Path $publish 'packages'
  New-Item -ItemType Directory -Path $publishPackages -Force | Out-Null
  Copy-Item -Path (Join-Path $store 'packages\*.swirapp') -Destination $publishPackages -Force
  Copy-Item -LiteralPath $artifactMapPath -Destination (Join-Path $publish 'catalog-artifacts.json') -Force

  $toolDir = Join-Path $desktop 'bin\Release\net8.0'
  $worker = Join-Path $toolDir 'SWIR.Desktop.UpdaterWorker.exe'
  $bundleTool = Join-Path $toolDir 'SWIR.Desktop.ReleaseBundleTool.dll'
  $verifyTool = Join-Path $toolDir 'SWIR.Desktop.ReleaseBundleVerifierTool.dll'
  foreach ($required in @($worker, $bundleTool, $verifyTool)) { Require-File $required }
  Copy-Item -LiteralPath $worker -Destination (Join-Path $publish 'SWIR.Desktop.UpdaterWorker.exe') -Force
  Copy-Item -LiteralPath (Join-Path $desktop 'desktop-update-policy.example.json') -Destination (Join-Path $publish 'desktop-update-policy.json') -Force

  node $rotationVerify (Join-Path $publish 'catalog-trust-roots.json') $currentFingerprint ci-rc-current ([string]$next.fingerprint) ci-rc-next 910001 910002
  if ($LASTEXITCODE -ne 0) { throw 'Catalog root rotation verification failed after Desktop staging.' }

  foreach ($artifact in @($artifactMap.artifacts)) {
    $relative = [string]$artifact.desktop.url
    if ($relative -notmatch '^packages/[A-Za-z0-9._-]+\.swirapp$') { throw "Unsafe Store artifact URL: $relative" }
    $stagedPath = Join-Path $publish $relative
    Require-File $stagedPath
    if ((Sha256-File $stagedPath) -ne [string]$artifact.desktop.sha256) { throw "Staged Store package SHA mismatch: $relative" }
  }

  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  try {
    [IO.File]::WriteAllText($rsaPrivate, $rsa.ExportRSAPrivateKeyPem())
    [IO.File]::WriteAllText($rsaPublic, $rsa.ExportSubjectPublicKeyInfoPem())
    dotnet $bundleTool --source $publish --output-dir $bundle --version 0.5.2 --entry-point SWIR.Desktop.Host.exe --package-url https://github.com/Swir/swir.github.io/releases/download/desktop-v0.5.2-preview/SWIR-Desktop-0.5.2-preview.zip --channel preview --key-id ci-rc-outer --private-key $rsaPrivate
    if ($LASTEXITCODE -ne 0) { throw 'Release bundle creation failed.' }
    dotnet $verifyTool --bundle-dir $bundle --version 0.5.2 --channel preview --public-key $rsaPublic --package-host github.com
    if ($LASTEXITCODE -ne 0) { throw 'Release bundle verification failed.' }
  } finally {
    $rsa.Dispose()
  }

  $releaseZip = Get-ChildItem -LiteralPath $bundle -Filter 'SWIR-Desktop-*.zip' -File | Select-Object -First 1
  if (-not $releaseZip) { throw 'Final Desktop release ZIP is missing.' }
  Expand-Archive -LiteralPath $releaseZip.FullName -DestinationPath $expanded -Force

  $expandedTrust = Get-ChildItem -LiteralPath $expanded -Filter 'catalog-trust-roots.json' -File -Recurse | Select-Object -First 1
  if (-not $expandedTrust) { throw 'Final Desktop release ZIP does not contain catalog-trust-roots.json.' }
  $releaseRoot = Split-Path -Parent $expandedTrust.FullName
  node $rotationVerify $expandedTrust.FullName $currentFingerprint ci-rc-current ([string]$next.fingerprint) ci-rc-next 910001 910002
  if ($LASTEXITCODE -ne 0) { throw 'Final Desktop ZIP changed the pinned current/next trust policy.' }

  $expandedEnvelope = Get-Content (Join-Path $releaseRoot 'catalog-envelope.json') -Raw | ConvertFrom-Json
  if ([long]$expandedEnvelope.sequence -ne 910000 -or $expandedEnvelope.keyId -ne 'ci-rc-current') { throw 'Final Desktop ZIP catalog envelope identity/sequence mismatch.' }
  foreach ($artifact in @($artifactMap.artifacts)) {
    $packagePath = Join-Path $releaseRoot ([string]$artifact.desktop.url)
    Require-File $packagePath
    if ((Sha256-File $packagePath) -ne [string]$artifact.desktop.sha256) { throw "Final Desktop ZIP Store package SHA mismatch: $($artifact.desktop.url)" }
  }

  Write-Host 'SWIR Desktop release-candidate catalog rotation E2E passed.'
  Write-Host "Current root: ci-rc-current $currentFingerprint"
  Write-Host "Next root: ci-rc-next $($next.fingerprint)"
  Write-Host 'Cutover sequence: 910001; current retirement: 910002'
} finally {
  Remove-Item Env:SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $currentPrivate, $rsaPrivate, $rsaPublic -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $WorkRoot) { Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
