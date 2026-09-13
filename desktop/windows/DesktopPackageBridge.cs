using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class DesktopPackageBridge
{
    private const string ShellOwner = "swir.system.shell";
    private const string AuthorizationSchema = "swir.desktop-catalog-authorization/1.0";
    private const string ReleaseArtifactReference = "release:verified-catalog-artifact";
    private readonly CapabilityBroker _capabilities;
    private readonly DesktopAppPackageInstaller _installer;
    private readonly DesktopPackageDependencyResolver _dependencies;
    private readonly DesktopCatalogTrustVerifier? _catalogTrust;
    private readonly string _releaseRoot;

    private sealed record TrustedInstallAuthorization(
        string Sha256,
        string? PackageId,
        string? Version,
        string? ArtifactUrl,
        string Mode,
        long? CatalogSequence = null,
        string? CatalogVersion = null,
        string? KeyId = null,
        DateTimeOffset? ExpiresAt = null);

    public DesktopPackageBridge(CapabilityBroker capabilities, DesktopAppPackageInstaller installer)
        : this(capabilities, installer, DesktopCatalogTrustRootStore.CreateVerifier(DefaultDataRoot()))
    {
    }

    internal DesktopPackageBridge(CapabilityBroker capabilities, DesktopAppPackageInstaller installer, DesktopCatalogTrustVerifier? catalogTrust, string? releaseRoot = null)
    {
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _installer = installer ?? throw new ArgumentNullException(nameof(installer));
        _catalogTrust = catalogTrust;
        _releaseRoot = Path.GetFullPath(releaseRoot ?? AppContext.BaseDirectory);
        _dependencies = new DesktopPackageDependencyResolver(
            new DesktopPackageDependencyResolver.RuntimeInfo("1.7.13", "1.3.0", 2, "DESKTOP"));
    }

    public object Describe() => new
    {
        schema = "swir.desktop-package-bridge/1.3",
        provider = "desktop-native",
        input = "owner-bound-file-capability-or-signed-release-artifact",
        installer = _installer.Describe(),
        dependencySchema = DesktopPackageDependencyResolver.Contract,
        dependencyPreflight = true,
        trustedOwner = ShellOwner,
        consumesCapabilityAfterInstall = true,
        signedCatalogAuthorization = _catalogTrust is not null,
        catalogAuthorizationSchema = AuthorizationSchema,
        signedIdentityBinding = true,
        signedReleaseArtifactRouting = true,
        releaseArtifactRoot = "packages/",
        legacySha256Fallback = _catalogTrust is null,
        trustMode = _catalogTrust is null ? "LEGACY_SHA_UNTIL_ROOT_PROVISIONED" : "SIGNED_CATALOG_REQUIRED"
    };

    public object InstallFromCapability(string capabilityToken, string trustInput, string ownerAppId)
    {
        RequireShellOwner(ownerAppId);
        var releaseArtifact = string.Equals(capabilityToken, ReleaseArtifactReference, StringComparison.Ordinal);
        if (releaseArtifact)
        {
            var releaseTrust = ResolveTrust(trustInput);
            var releasePath = ResolveReleaseArtifactPath(releaseTrust);
            return InstallTrustedPath(releasePath, releaseTrust);
        }

        var capabilityPath = _capabilities.RequireFilePath(capabilityToken, ownerAppId);
        try
        {
            var capabilityTrust = ResolveTrust(trustInput);
            return InstallTrustedPath(capabilityPath, capabilityTrust);
        }
        finally
        {
            TryRevoke(capabilityToken, ownerAppId);
        }
    }

    private object InstallTrustedPath(string path, TrustedInstallAuthorization trust)
    {
        var plan = _dependencies.EvaluateBundle(path, InstalledPackage);
        BindAuthorizationToBundle(trust, plan);
        if (!plan.Ok)
            throw new DesktopPackageException("PACKAGE_DEPENDENCY_UNSATISFIED", string.Join("; ", plan.Errors));
        return _installer.Install(path, trust.Sha256);
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

    private TrustedInstallAuthorization ResolveTrust(string trustInput)
    {
        var input = (trustInput ?? string.Empty).Trim();
        if (input.StartsWith('{'))
        {
            if (_catalogTrust is null)
                throw new DesktopPackageException("CATALOG_TRUST_ROOT_UNAVAILABLE", "Signed catalog authorization cannot be used until a native catalog public root is provisioned.");
            try
            {
                using var doc = JsonDocument.Parse(input);
                var root = doc.RootElement;
                if (!string.Equals(String(root, "schema"), AuthorizationSchema, StringComparison.Ordinal))
                    throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", $"Authorization schema must be {AuthorizationSchema}.");
                var packageId = RequiredString(root, "packageId");
                var version = RequiredString(root, "version");
                if (!root.TryGetProperty("catalog", out var catalog) || catalog.ValueKind != JsonValueKind.Array)
                    throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", "Authorization requires a catalog array.");
                if (!root.TryGetProperty("envelope", out var envelope) || envelope.ValueKind != JsonValueKind.Object)
                    throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", "Authorization requires a signature envelope.");

                var authorization = _catalogTrust.VerifyAndAuthorize(catalog.GetRawText(), envelope.GetRawText(), packageId, version);
                return new TrustedInstallAuthorization(
                    authorization.Sha256,
                    authorization.PackageId,
                    authorization.Version,
                    authorization.ArtifactUrl,
                    "SIGNED_CATALOG",
                    authorization.Sequence,
                    authorization.CatalogVersion,
                    authorization.KeyId,
                    authorization.ExpiresAt);
            }
            catch (DesktopPackageException) { throw; }
            catch (JsonException ex) { throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", ex.Message); }
        }

        if (_catalogTrust is not null)
            throw new DesktopPackageException("CATALOG_AUTHORIZATION_REQUIRED", "Provisioned catalog trust roots require signed catalog authorization; arbitrary UI/runtime SHA-256 input is disabled.");
        return new TrustedInstallAuthorization(input, null, null, null, "LEGACY_SHA");
    }

    private string ResolveReleaseArtifactPath(TrustedInstallAuthorization trust)
    {
        if (!string.Equals(trust.Mode, "SIGNED_CATALOG", StringComparison.Ordinal))
            throw new DesktopPackageException("CATALOG_AUTHORIZATION_REQUIRED", "Release artifact routing requires a verified signed catalog authorization.");
        if (string.IsNullOrWhiteSpace(trust.ArtifactUrl))
            throw new DesktopPackageException("CATALOG_ARTIFACT_URL_REQUIRED", "Verified signed catalog entry does not provide a Desktop release artifact URL.");
        if (!DesktopCatalogTrustVerifier.IsSafeDesktopArtifactUrl(trust.ArtifactUrl))
            throw new DesktopPackageException("CATALOG_ARTIFACT_URL_INVALID", "Signed Desktop artifact URL is outside the supported release-local packages directory.");

        var relative = trust.ArtifactUrl.Replace('/', Path.DirectorySeparatorChar);
        var path = Path.GetFullPath(Path.Combine(_releaseRoot, relative));
        var packagesRoot = Path.GetFullPath(Path.Combine(_releaseRoot, "packages"));
        var prefix = packagesRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new DesktopPackageException("CATALOG_ARTIFACT_PATH_ESCAPE", "Signed Desktop artifact resolved outside the trusted release packages directory.");
        if (!File.Exists(path))
            throw new DesktopPackageException("CATALOG_ARTIFACT_MISSING", "Signed Desktop artifact is not present in the trusted release packages directory.");
        return path;
    }

    private static void BindAuthorizationToBundle(TrustedInstallAuthorization trust, DesktopPackageDependencyResolver.DependencyResult plan)
    {
        if (!string.Equals(trust.Mode, "SIGNED_CATALOG", StringComparison.Ordinal)) return;
        if (!string.Equals(plan.PackageId, trust.PackageId, StringComparison.Ordinal) ||
            !string.Equals(plan.Version, trust.Version, StringComparison.Ordinal))
        {
            throw new DesktopPackageException(
                "CATALOG_PACKAGE_IDENTITY_MISMATCH",
                $"Verified catalog authorization targets {trust.PackageId}@{trust.Version}, but the selected .swirapp declares {plan.PackageId}@{plan.Version}.");
        }
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

    private static string DefaultDataRoot() => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SWIR", "DesktopHost", "Data");
    private static string? String(JsonElement node, string name) => node.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string RequiredString(JsonElement node, string name) => String(node, name) is { Length: > 0 } value ? value : throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", $"{name} is required.");

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