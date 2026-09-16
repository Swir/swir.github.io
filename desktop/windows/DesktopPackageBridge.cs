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
    private readonly DesktopPackageSignatureVerifier? _packageTrust;
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
        DateTimeOffset? ExpiresAt = null,
        string? PackageSignatureJson = null);

    public DesktopPackageBridge(CapabilityBroker capabilities, DesktopAppPackageInstaller installer)
        : this(
            capabilities,
            installer,
            DesktopCatalogTrustRootStore.CreateVerifier(DefaultDataRoot()),
            DesktopPackageTrustRootStore.CreateVerifier(),
            null)
    {
    }

    internal DesktopPackageBridge(
        CapabilityBroker capabilities,
        DesktopAppPackageInstaller installer,
        DesktopCatalogTrustVerifier? catalogTrust,
        string? releaseRoot = null)
        : this(capabilities, installer, catalogTrust, null, releaseRoot)
    {
    }

    internal DesktopPackageBridge(
        CapabilityBroker capabilities,
        DesktopAppPackageInstaller installer,
        DesktopCatalogTrustVerifier? catalogTrust,
        DesktopPackageSignatureVerifier? packageTrust,
        string? releaseRoot = null)
    {
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _installer = installer ?? throw new ArgumentNullException(nameof(installer));
        _catalogTrust = catalogTrust;
        _packageTrust = packageTrust;
        _releaseRoot = Path.GetFullPath(releaseRoot ?? AppContext.BaseDirectory);
        _dependencies = new DesktopPackageDependencyResolver(
            new DesktopPackageDependencyResolver.RuntimeInfo("1.7.13", "1.3.0", 2, "DESKTOP"));
    }

    public object Describe() => new
    {
        schema = "swir.desktop-package-bridge/1.4",
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
        packageSignatureVerification = _packageTrust is not null,
        packageSignatureSchema = DesktopPackageSignatureVerifier.SignatureSchema,
        packageSignatureAlgorithm = "Ed25519",
        releaseArtifactRoot = "packages/",
        legacySha256Fallback = _catalogTrust is null && _packageTrust is null,
        trustMode = TrustMode()
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

        if (_packageTrust is not null)
        {
            if (string.IsNullOrWhiteSpace(trust.PackageSignatureJson))
                throw new DesktopPackageException(
                    "PACKAGE_SIGNATURE_REQUIRED",
                    "Provisioned package trust roots require an Ed25519 .swirapp signature envelope.");
            var verified = _packageTrust.Verify(path, trust.PackageSignatureJson, plan.PackageId, plan.Version);
            if (!string.Equals(verified.Sha256, trust.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new DesktopPackageException(
                    "PACKAGE_SIGNATURE_TRUST_MISMATCH",
                    "Verified package signature digest does not match the trusted catalog/package authorization digest.");
        }

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
            try
            {
                using var doc = JsonDocument.Parse(input);
                var root = doc.RootElement;
                var schema = String(root, "schema");
                if (string.Equals(schema, AuthorizationSchema, StringComparison.Ordinal))
                    return ResolveCatalogAuthorization(root);
                if (string.Equals(schema, DesktopPackageSignatureVerifier.SignatureSchema, StringComparison.Ordinal))
                    return ResolveDirectPackageSignature(input);
                throw new DesktopPackageException(
                    "PACKAGE_TRUST_INPUT_INVALID",
                    $"Unsupported Desktop package trust schema: {schema ?? "<missing>"}.");
            }
            catch (DesktopPackageException) { throw; }
            catch (JsonException ex) { throw new DesktopPackageException("PACKAGE_TRUST_INPUT_INVALID", ex.Message); }
        }

        if (_catalogTrust is not null)
            throw new DesktopPackageException("CATALOG_AUTHORIZATION_REQUIRED", "Provisioned catalog trust roots require signed catalog authorization; arbitrary UI/runtime SHA-256 input is disabled.");
        if (_packageTrust is not null)
            throw new DesktopPackageException("PACKAGE_SIGNATURE_REQUIRED", "Provisioned package trust roots require an Ed25519 .swirapp signature; arbitrary UI/runtime SHA-256 input is disabled.");
        return new TrustedInstallAuthorization(input, null, null, null, "LEGACY_SHA");
    }

    private TrustedInstallAuthorization ResolveCatalogAuthorization(JsonElement root)
    {
        if (_catalogTrust is null)
            throw new DesktopPackageException("CATALOG_TRUST_ROOT_UNAVAILABLE", "Signed catalog authorization cannot be used until a native catalog public root is provisioned.");
        if (!string.Equals(String(root, "schema"), AuthorizationSchema, StringComparison.Ordinal))
            throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", $"Authorization schema must be {AuthorizationSchema}.");
        var packageId = RequiredString(root, "packageId");
        var version = RequiredString(root, "version");
        if (!root.TryGetProperty("catalog", out var catalog) || catalog.ValueKind != JsonValueKind.Array)
            throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", "Authorization requires a catalog array.");
        if (!root.TryGetProperty("envelope", out var envelope) || envelope.ValueKind != JsonValueKind.Object)
            throw new DesktopPackageException("CATALOG_AUTHORIZATION_INVALID", "Authorization requires a signature envelope.");

        var authorization = _catalogTrust.VerifyAndAuthorize(catalog.GetRawText(), envelope.GetRawText(), packageId, version);
        string? packageSignature = null;
        if (root.TryGetProperty("packageSignature", out var signatureNode))
        {
            if (signatureNode.ValueKind != JsonValueKind.Object)
                throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "packageSignature must be an object when supplied.");
            packageSignature = signatureNode.GetRawText();
        }
        return new TrustedInstallAuthorization(
            authorization.Sha256,
            authorization.PackageId,
            authorization.Version,
            authorization.ArtifactUrl,
            "SIGNED_CATALOG",
            authorization.Sequence,
            authorization.CatalogVersion,
            authorization.KeyId,
            authorization.ExpiresAt,
            packageSignature);
    }

    private TrustedInstallAuthorization ResolveDirectPackageSignature(string input)
    {
        if (_catalogTrust is not null)
            throw new DesktopPackageException(
                "CATALOG_AUTHORIZATION_REQUIRED",
                "A release with provisioned catalog trust roots cannot bypass signed catalog policy with a standalone package signature.");
        if (_packageTrust is null)
            throw new DesktopPackageException("PACKAGE_TRUST_ROOT_UNAVAILABLE", "Package signature authorization cannot be used until a native package public root is provisioned.");

        var metadata = DesktopPackageSignatureVerifier.ReadMetadata(input);
        return new TrustedInstallAuthorization(
            metadata.Sha256,
            metadata.PackageId,
            metadata.Version,
            null,
            "PACKAGE_SIGNATURE",
            KeyId: metadata.KeyId,
            PackageSignatureJson: input);
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

    private string TrustMode()
    {
        if (_catalogTrust is not null && _packageTrust is not null) return "SIGNED_CATALOG_AND_PACKAGE_SIGNATURE_REQUIRED";
        if (_catalogTrust is not null) return "SIGNED_CATALOG_REQUIRED";
        if (_packageTrust is not null) return "PACKAGE_SIGNATURE_REQUIRED";
        return "LEGACY_SHA_UNTIL_ROOT_PROVISIONED";
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
