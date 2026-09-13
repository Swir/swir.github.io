namespace Swir.Desktop.Host;

internal sealed class DesktopPackageBridge
{
    private const string ShellOwner = "swir.system.shell";
    private readonly CapabilityBroker _capabilities;
    private readonly DesktopAppPackageInstaller _installer;

    public DesktopPackageBridge(CapabilityBroker capabilities, DesktopAppPackageInstaller installer)
    {
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _installer = installer ?? throw new ArgumentNullException(nameof(installer));
    }

    public object Describe() => new
    {
        schema = "swir.desktop-package-bridge/1.0",
        provider = "desktop-native",
        input = "owner-bound-file-capability",
        installer = _installer.Describe(),
        trustedOwner = ShellOwner,
        consumesCapabilityAfterInstall = true
    };

    public object InstallFromCapability(string capabilityToken, string expectedSha256, string ownerAppId)
    {
        RequireShellOwner(ownerAppId);
        var path = _capabilities.RequireFilePath(capabilityToken, ownerAppId);
        try
        {
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
