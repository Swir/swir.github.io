import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const program = read('desktop/windows/Program.cs');
const permissions = read('desktop/windows/PermissionBroker.cs');
const bridge = read('desktop/windows/DesktopPackageBridge.cs');
const resolver = read('desktop/windows/DesktopPackageDependencyResolver.cs');
const catalogTrust = read('desktop/windows/DesktopCatalogTrustVerifier.cs');
const trustRoots = read('desktop/windows/DesktopCatalogTrustRootStore.cs');
const hostProject = read('desktop/windows/SWIR.Desktop.Host.csproj');
const runtime = read('swir-runtime.js');

const checks = [
  [program.includes('private readonly DesktopPackageBridge _packages;'), 'shipping host owns DesktopPackageBridge'],
  [program.includes('new DesktopPackageBridge(_capabilities, new DesktopAppPackageInstaller(_dataRoot))'), 'shipping host constructs package installer from native data root'],
  [program.includes('"packages" => DispatchPackagesAsync(request.Method, request.Args)'), 'shipping dispatch routes packages surface'],
  [program.includes('"installFromCapability" => _packages.InstallFromCapability'), 'shipping dispatch exposes capability-bound install'],
  [program.includes('"status" => _packages.Status'), 'shipping dispatch exposes native package status'],
  [program.includes('"rollback" => _packages.Rollback'), 'shipping dispatch exposes native package rollback'],
  [program.includes('DesktopPackageException package => package.Code'), 'package error codes survive native bridge'],
  [program.includes('nativePackageBridge: true'), 'desktop host advertises native package bridge'],
  [program.includes("packages: surface('packages', ['info','installFromCapability','status','rollback'])"), 'bootstrap exposes packages methods'],
  [permissions.includes('"packages.inspect"'), 'shell has packages.inspect'],
  [permissions.includes('"packages.manage"'), 'shell has packages.manage'],
  [permissions.includes('(\"packages\", \"info\" or \"status\") => \"packages.inspect\"'), 'permission broker maps package inspection'],
  [permissions.includes('(\"packages\", \"installFromCapability\" or \"rollback\") => \"packages.manage\"'), 'permission broker maps package mutation'],
  [bridge.includes('DesktopPackageDependencyResolver _dependencies'), 'shipping package bridge owns Desktop dependency resolver'],
  [bridge.includes('EvaluateBundle(path, InstalledPackage)'), 'shipping install performs dependency preflight before payload mutation'],
  [bridge.includes('PACKAGE_DEPENDENCY_UNSATISFIED'), 'unsatisfied dependencies fail closed with stable package code'],
  [bridge.includes('dependencyPreflight = true'), 'package bridge advertises dependency preflight'],
  [bridge.includes('DesktopCatalogTrustVerifier? _catalogTrust'), 'shipping package bridge owns optional native catalog trust verifier'],
  [bridge.includes('DesktopCatalogTrustRootStore.CreateVerifier'), 'shipping package bridge loads provisioned native catalog roots'],
  [bridge.includes('CATALOG_AUTHORIZATION_REQUIRED'), 'provisioned roots disable arbitrary runtime SHA authorization'],
  [bridge.includes('VerifyAndAuthorize(catalog.GetRawText(), envelope.GetRawText(), packageId, version)'), 'signed authorization resolves package hash through native verifier'],
  [trustRoots.includes('swir.catalog-trust-roots/1.0') && trustRoots.includes('catalog:official'), 'native trust-root store validates catalog-only root scope'],
  [trustRoots.includes('SWIR_CATALOG_TRUST_ROOTS'), 'native trust-root path supports explicit deployment provisioning'],
  [catalogTrust.includes('CATALOG_ROLLBACK_DETECTED') && catalogTrust.includes('CATALOG_BAD_SIGNATURE'), 'native catalog verifier remains fail-closed for rollback and bad signatures'],
  [hostProject.includes('catalog-trust-roots.json') && hostProject.includes('CopyToOutputDirectory="PreserveNewest"'), 'shipping host carries trust-root provisioning document'],
  [resolver.includes('public const string Contract = "swir.dependencies/1.0"'), 'Desktop resolver implements shared dependency schema'],
  [resolver.includes('compatibility.MinOS') && resolver.includes('compatibility.MinSDK') && resolver.includes('compatibility.PlatformApi'), 'Desktop resolver enforces runtime compatibility requirements'],
  [resolver.includes('package.Dependencies') && resolver.includes('package.OptionalDependencies'), 'Desktop resolver handles required and optional package dependencies'],
  [runtime.includes("version: '1.5.0'"), 'runtime contract version is 1.5.0'],
  [runtime.includes('const packages = Object.freeze({'), 'runtime exports package adapter'],
  [runtime.includes("call('packages', 'installFromCapability'"), 'runtime install goes through native packages surface'],
  [runtime.includes("call('packages', 'status'"), 'runtime status goes through native packages surface'],
  [runtime.includes("call('packages', 'rollback'"), 'runtime rollback goes through native packages surface'],
  [runtime.includes("const surfaces=['filesystem','appData','packages'"), 'runtime capability inventory includes packages'],
  [runtime.includes('filesystem,appData,packages,processes'), 'runtime public API includes packages']
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error('Desktop package runtime contract failed:');
  failed.forEach(label => console.error(` - ${label}`));
  process.exit(1);
}

console.log(`Desktop package runtime contract OK (${checks.length}/${checks.length}).`);
