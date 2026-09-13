import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const program = read('desktop/windows/Program.cs');
const permissions = read('desktop/windows/PermissionBroker.cs');
const bridge = read('desktop/windows/DesktopPackageBridge.cs');
const resolver = read('desktop/windows/DesktopPackageDependencyResolver.cs');
const catalogTrust = read('desktop/windows/DesktopCatalogTrustVerifier.cs');
const trustRoots = read('desktop/windows/DesktopCatalogTrustRootStore.cs');
const trustRootTemplate = read('desktop/windows/catalog-trust-roots.json');
const hostProject = read('desktop/windows/SWIR.Desktop.Host.csproj');
const runtime = read('swir-runtime.js');

const checks = [
  [program.includes('private readonly DesktopPackageBridge _packages;'), 'shipping host owns DesktopPackageBridge'],
  [program.includes('new DesktopPackageBridge(_capabilities, new DesktopAppPackageInstaller(_dataRoot))'), 'shipping host constructs package installer from native data root'],
  [program.includes('"packages" => DispatchPackagesAsync(request.Method, request.Args)'), 'shipping dispatch routes packages surface'],
  [program.includes('"installFromCapability" => _packages.InstallFromCapability'), 'shipping dispatch exposes package install boundary'],
  [program.includes('DesktopPackageException package => package.Code'), 'package error codes survive native bridge'],
  [program.includes('nativePackageBridge: true'), 'desktop host advertises native package bridge'],
  [permissions.includes('"packages.inspect"') && permissions.includes('"packages.manage"'), 'shell permissions cover package inspect/manage'],
  [bridge.includes('DesktopPackageDependencyResolver _dependencies'), 'shipping package bridge owns Desktop dependency resolver'],
  [bridge.includes('EvaluateBundle(path, InstalledPackage)'), 'shipping install performs dependency preflight before payload mutation'],
  [bridge.includes('PACKAGE_DEPENDENCY_UNSATISFIED'), 'unsatisfied dependencies fail closed with stable package code'],
  [bridge.includes('DesktopCatalogTrustVerifier? _catalogTrust'), 'shipping package bridge owns native catalog trust verifier'],
  [bridge.includes('DesktopCatalogTrustRootStore.CreateVerifier'), 'shipping package bridge loads provisioned native catalog roots'],
  [bridge.includes('CATALOG_AUTHORIZATION_REQUIRED'), 'provisioned roots disable arbitrary runtime SHA authorization'],
  [bridge.includes('VerifyAndAuthorize(catalog.GetRawText(), envelope.GetRawText(), packageId, version)'), 'signed authorization resolves trust through native verifier'],
  [bridge.includes('BindAuthorizationToBundle(trust, plan)'), 'shipping install binds authorization to bundle identity'],
  [bridge.includes('signedReleaseArtifactRouting = true'), 'package bridge advertises signed release artifact routing'],
  [bridge.includes('ReleaseArtifactReference = "release:verified-catalog-artifact"'), 'native bridge recognizes only the dedicated release artifact reference'],
  [bridge.includes('ResolveReleaseArtifactPath('), 'signed release routing resolves artifact path natively'],
  [bridge.includes('Path.Combine(_releaseRoot, "packages")'), 'release routing is anchored to the native packages directory'],
  [bridge.includes('CATALOG_ARTIFACT_PATH_ESCAPE') && bridge.includes('CATALOG_ARTIFACT_MISSING'), 'release routing fails closed on path escape or missing artifact'],
  [catalogTrust.includes('string? ArtifactUrl'), 'native catalog authorization carries the signed Desktop artifact URL'],
  [catalogTrust.includes('CATALOG_ARTIFACT_URL_INVALID'), 'native verifier rejects unsafe signed artifact URLs'],
  [catalogTrust.includes('IsSafeDesktopArtifactUrl'), 'native verifier owns release-local artifact URL policy'],
  [catalogTrust.includes('CATALOG_ROLLBACK_DETECTED') && catalogTrust.includes('CATALOG_BAD_SIGNATURE'), 'native catalog verifier remains fail-closed for rollback and bad signatures'],
  [trustRoots.includes('swir.catalog-trust-roots/1.0') && trustRoots.includes('catalog:official'), 'native trust-root store validates catalog-only root scope'],
  [trustRoots.includes('SWIR_CATALOG_TRUST_ROOTS'), 'native trust-root path supports explicit deployment provisioning'],
  [trustRoots.includes('RequireSignedCatalog') && trustRoots.includes('CATALOG_TRUST_ROOT_REQUIRED'), 'release trust lock fails closed when signed catalog is required but roots are missing'],
  [trustRootTemplate.includes('"requireSignedCatalog": false'), 'source trust-root template explicitly identifies preview fallback policy'],
  [hostProject.includes('catalog-trust-roots.json') && hostProject.includes('CopyToOutputDirectory="PreserveNewest"'), 'shipping host carries trust-root provisioning document'],
  [resolver.includes('public const string Contract = "swir.dependencies/1.0"'), 'Desktop resolver implements shared dependency schema'],
  [runtime.includes("version: '1.7.0'"), 'runtime contract version is 1.7.0'],
  [runtime.includes("DESKTOP_CATALOG_AUTH_SCHEMA = 'swir.desktop-catalog-authorization/1.0'"), 'runtime knows structured Desktop catalog authorization schema'],
  [runtime.includes("SIGNED_RELEASE_ARTIFACT_REF = 'release:verified-catalog-artifact'"), 'runtime knows native signed release artifact reference'],
  [runtime.includes('installAuthorizedReleaseArtifact:'), 'runtime exposes pickerless signed release artifact install helper'],
  [runtime.includes('installAuthorizedFromCapability:'), 'runtime retains explicit capability install helper for controlled preview/testing'],
  [runtime.includes("call('packages', 'installFromCapability'"), 'runtime package installs cross the existing native package surface'],
  [runtime.includes('filesystem,appData,packages,processes'), 'runtime public API includes packages']
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error('Desktop package runtime contract failed:');
  failed.forEach(label => console.error(` - ${label}`));
  process.exit(1);
}
console.log(`Desktop package runtime contract OK (${checks.length}/${checks.length}).`);