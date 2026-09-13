using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class DesktopPackageBridge
{
    private const string ShellOwner = "swir.system.shell";
    private readonly CapabilityBroker _capabilities;
    private readonly DesktopAppPackageInstaller _installer;
    private readonly DesktopPackageDependencyResolver _dependencies;

    public DesktopPackageBridge(CapabilityBroker capabilities, DesktopAppPackageInstaller installer)
    {
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _installer = installer ?? throw new ArgumentNullException(nameof(installer));
        _dependencies = new DesktopPackageDependencyResolver(
            new DesktopPackageDependencyResolver.RuntimeInfo("1.7.13", "1.3.0", 2, "DESKTOP"));
    }

    public object Describe() => new
    {
        schema = "swir.desktop-package-bridge/1.0",
        provider = "desktop-native",
        input = "owner-bound-file-capability",
        installer = _installer.Describe(),
        dependencySchema = DesktopPackageDependencyResolver.Contract,
        dependencyPreflight = true,
        trustedOwner = ShellOwner,
        consumesCapabilityAfterInstall = true
    };

    public object InstallFromCapability(string capabilityToken, string expectedSha256, string ownerAppId)
    {
        RequireShellOwner(ownerAppId);
        var path = _capabilities.RequireFilePath(capabilityToken, ownerAppId);
        try
        {
            var plan = _dependencies.EvaluateBundle(path, InstalledPackage);
            if (!plan.Ok)
                throw new DesktopPackageException("PACKAGE_DEPENDENCY_UNSATISFIED", string.Join("; ", plan.Errors));
            return _installer.Install(path, expectedSha256);
        }
        finally
        {
            TryRevoke(capabilityToken, ownerAppId);
        }
    }

    public object Status(string packageId, string ownerAppId)
    {
        RequireShellOwner(ownerAppId);
        return _installer.Status(packageId);
    }

    public object Rollback(string packageId, string ownerAppId)
    {
        RequireShellOwner(ownerAppId);
        return _installer.Rollback(packageId);
    }

    private DesktopPackageDependencyResolver.InstalledPackageInfo? InstalledPackage(string packageId)
    {
        var status = _installer.Status(packageId);
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(status));
        var root = doc.RootElement;
        if (!root.TryGetProperty("installed", out var installed) || !installed.GetBoolean()) return null;
        if (!root.TryGetProperty("version", out var versionNode) || versionNode.ValueKind != JsonValueKind.String) return null;
        var version = versionNode.GetString();
        if (string.IsNullOrWhiteSpace(version)) return null;
        return new DesktopPackageDependencyResolver.InstalledPackageInfo(packageId, packageId, version, true);
    }

    private static void RequireShellOwner(string ownerAppId)
    {
        if (!string.Equals(ownerAppId, ShellOwner, StringComparison.Ordinal))
            throw new DesktopPackageException("PACKAGE_BRIDGE_FORBIDDEN", "Desktop package mutation is restricted to the trusted SWIR system shell.");
    }

    private void TryRevoke(string capabilityToken, string ownerAppId)
    {
        try { _capabilities.Revoke(capabilityToken, ownerAppId); }
        catch (BridgeException) { }
    }
}
