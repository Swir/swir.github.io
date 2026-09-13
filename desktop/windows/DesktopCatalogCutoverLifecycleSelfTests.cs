using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopCatalogCutoverLifecycleSelfTests
{
    private const string Shell = "swir.system.shell";
    private const string PackageId = "swir.cutover";
    private const string CurrentKeyId = "cutover-current";
    private const string NextKeyId = "cutover-next";
    private const string ReleaseArtifactReference = "release:verified-catalog-artifact";
    private sealed record BridgeContext(DesktopPackageBridge Bridge, string ReleaseRoot);

    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-native-cutover-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var previousRoots = Environment.GetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS");
        try
        {
            using var currentKey = Key.Create(SignatureAlgorithm.Ed25519, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
            using var nextKey = Key.Create(SignatureAlgorithm.Ed25519, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });

            var trustRootsPath = Path.Combine(root, "catalog-trust-roots.json");
            WriteTrustRoots(trustRootsPath, currentKey, nextKey);
            Environment.SetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS", trustRootsPath);

            var packageData = Path.Combine(root, "package-data");
            var trustData = Path.Combine(root, "trust-data");
            var releaseRoot = Path.Combine(root, "release");
            var packagesRoot = Path.Combine(releaseRoot, "packages");
            Directory.CreateDirectory(packagesRoot);

            var v1 = Path.Combine(packagesRoot, "swir.cutover-1.0.0.swirapp");
            var v2 = Path.Combine(packagesRoot, "swir.cutover-2.0.0.swirapp");
            var v3 = Path.Combine(packagesRoot, "swir.cutover-3.0.0.swirapp");
            CreateBundle(v1, "1.0.0", "current-root-install");
            CreateBundle(v2, "2.0.0", "current-root-overlap");
            CreateBundle(v3, "3.0.0", "next-root-cutover");

            // 1) Install with current root, then reconstruct the bridge to model a full Host restart.
            var context = NewBridge(packageData, trustData, releaseRoot);
            InstallRelease(context, v1, currentKey, CurrentKeyId, "1.0.0", 1000);
            Require(Status(context.Bridge).Contains("1.0.0", StringComparison.Ordinal), "v1 should install under current root");

            context = NewBridge(packageData, trustData, releaseRoot);
            Require(Status(context.Bridge).Contains("1.0.0", StringComparison.Ordinal), "v1 should survive Host restart");

            // 2) The next root is provisioned but cannot authorize a package before its cutover sequence.
            ExpectPackageCode(
                () => InstallRelease(context, v2, nextKey, NextKeyId, "2.0.0", 1001),
                "CATALOG_KEY_NOT_ACTIVE");
            Require(Status(context.Bridge).Contains("1.0.0", StringComparison.Ordinal), "pre-cutover next-root rejection must not mutate installed payload");

            // 3) Current root remains valid through its overlap window.
            InstallRelease(context, v2, currentKey, CurrentKeyId, "2.0.0", 1001);
            context = NewBridge(packageData, trustData, releaseRoot);
            Require(Status(context.Bridge).Contains("2.0.0", StringComparison.Ordinal), "v2 should survive restart during overlap");

            // 4) At cutover, the next root becomes authoritative and advances the persistent high-water mark.
            InstallRelease(context, v3, nextKey, NextKeyId, "3.0.0", 1002);
            context = NewBridge(packageData, trustData, releaseRoot);
            Require(Status(context.Bridge).Contains("3.0.0", StringComparison.Ordinal), "next-root v3 should survive restart after cutover");

            // 5) Native rollback restores the previous verified payload, but must not roll trust state back.
            var rollback = JsonSerializer.Serialize(context.Bridge.Rollback(PackageId, Shell));
            Require(rollback.Contains("2.0.0", StringComparison.Ordinal), "native rollback should restore the previously verified v2 payload");
            context = NewBridge(packageData, trustData, releaseRoot);
            Require(Status(context.Bridge).Contains("2.0.0", StringComparison.Ordinal), "rolled-back v2 should survive Host restart");

            // 6) The retired current root is rejected even for a newer package sequence.
            ExpectPackageCode(
                () => InstallRelease(context, v3, currentKey, CurrentKeyId, "3.0.0", 1003),
                "CATALOG_KEY_RETIRED");
            Require(Status(context.Bridge).Contains("2.0.0", StringComparison.Ordinal), "retired-root rejection must not mutate payload");

            // 7) A stale next-root catalog remains blocked by the restart-safe high-water mark after rollback.
            ExpectPackageCode(
                () => InstallRelease(context, v2, nextKey, NextKeyId, "2.0.0", 1001),
                "CATALOG_ROLLBACK_DETECTED");

            // 8) A fresh next-root sequence succeeds and restores forward progress.
            InstallRelease(context, v3, nextKey, NextKeyId, "3.0.0", 1003);
            context = NewBridge(packageData, trustData, releaseRoot);
            Require(Status(context.Bridge).Contains("3.0.0", StringComparison.Ordinal), "fresh next-root update should survive final Host restart");

            Console.WriteLine("Native Desktop catalog cutover package lifecycle self-tests passed.");
            return 0;
        }
        finally
        {
            Environment.SetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS", previousRoots);
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static BridgeContext NewBridge(string packageData, string trustData, string releaseRoot)
    {
        var verifier = DesktopCatalogTrustRootStore.CreateVerifier(trustData)
            ?? throw new Exception("Provisioned current/next catalog trust roots were not loaded.");
        var bridge = new DesktopPackageBridge(
            new CapabilityBroker(),
            new DesktopAppPackageInstaller(packageData),
            verifier,
            releaseRoot);
        var description = JsonSerializer.Serialize(bridge.Describe());
        Require(description.Contains("SIGNED_CATALOG_REQUIRED", StringComparison.Ordinal), "cutover bridge must remain fail-closed after restart");
        Require(description.Contains("signedCatalogAuthorization", StringComparison.OrdinalIgnoreCase), "cutover bridge must advertise signed catalog authorization");
        return new BridgeContext(bridge, releaseRoot);
    }

    private static void InstallRelease(BridgeContext context, string bundle, Key key, string keyId, string version, long sequence)
    {
        var relativeUrl = "packages/" + Path.GetFileName(bundle);
        var authorization = CreateSignedAuthorization(key, keyId, version, Sha256(bundle), sequence, relativeUrl);
        var result = JsonSerializer.Serialize(context.Bridge.InstallFromCapability(ReleaseArtifactReference, authorization, Shell));
        Require(result.Contains(version, StringComparison.Ordinal), $"signed release install result should contain {version}");
        Require(result.Contains("VERIFIED", StringComparison.Ordinal), "signed release install must retain native package health verification");
    }

    private static void WriteTrustRoots(string path, Key currentKey, Key nextKey)
    {
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            schema = DesktopCatalogTrustRootStore.Schema,
            requireSignedCatalog = true,
            roots = new object[]
            {
                new
                {
                    keyId = CurrentKeyId,
                    name = "Catalog cutover current root",
                    algorithm = "Ed25519",
                    format = "raw",
                    publicKey = Convert.ToBase64String(currentKey.PublicKey.Export(KeyBlobFormat.RawPublicKey)),
                    scope = new[] { "catalog:official" },
                    enabled = true,
                    notBeforeSequence = 1,
                    retireAfterSequence = 1002
                },
                new
                {
                    keyId = NextKeyId,
                    name = "Catalog cutover next root",
                    algorithm = "Ed25519",
                    format = "raw",
                    publicKey = Convert.ToBase64String(nextKey.PublicKey.Export(KeyBlobFormat.RawPublicKey)),
                    scope = new[] { "catalog:official" },
                    enabled = true,
                    notBeforeSequence = 1002
                }
            }
        }));
    }

    private static string CreateSignedAuthorization(Key key, string keyId, string version, string sha256, long sequence, string artifactUrl)
    {
        var now = DateTimeOffset.UtcNow;
        var generatedAt = now.AddMinutes(-1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        var expiresAt = now.AddHours(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        var catalogVersion = $"native-cutover-{sequence}";
        var package = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["artifacts"] = new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["desktop"] = new SortedDictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["sha256"] = sha256,
                    ["url"] = artifactUrl
                }
            },
            ["packageId"] = PackageId,
            ["version"] = version
        };
        var catalogJson = JsonSerializer.Serialize(new object[] { package });
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(catalogJson))).ToLowerInvariant();
        var signedPayload = JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["catalogId"] = "official",
            ["catalogSha256"] = digest,
            ["catalogVersion"] = catalogVersion,
            ["expiresAt"] = expiresAt,
            ["generatedAt"] = generatedAt,
            ["schema"] = DesktopCatalogTrustVerifier.SignatureSchema,
            ["sequence"] = sequence
        });
        var signature = SignatureAlgorithm.Ed25519.Sign(key, Encoding.UTF8.GetBytes(signedPayload));
        var envelope = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["algorithm"] = "Ed25519",
            ["catalogId"] = "official",
            ["catalogSha256"] = digest,
            ["catalogVersion"] = catalogVersion,
            ["expiresAt"] = expiresAt,
            ["generatedAt"] = generatedAt,
            ["keyId"] = keyId,
            ["schema"] = DesktopCatalogTrustVerifier.SignatureSchema,
            ["sequence"] = sequence,
            ["signature"] = Convert.ToBase64String(signature)
        };
        return JsonSerializer.Serialize(new
        {
            schema = "swir.desktop-catalog-authorization/1.0",
            packageId = PackageId,
            version,
            catalog = JsonSerializer.Deserialize<JsonElement>(catalogJson),
            envelope
        });
    }

    private static void CreateBundle(string path, string version, string payloadText)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifest = archive.CreateEntry("swir-package.json");
        using (var writer = new StreamWriter(manifest.Open(), new UTF8Encoding(false)))
            writer.Write(JsonSerializer.Serialize(new
            {
                schema = "swir.app/1.0",
                id = PackageId,
                packageId = PackageId,
                name = "SWIR catalog cutover lifecycle",
                version,
                author = "SWIR",
                type = "iframe",
                entry = "app/index.html",
                compatibility = new { minOS = "1.7.0", minSDK = "1.3.0", platformApi = 2, editions = new[] { "DESKTOP" } },
                dependencies = Array.Empty<object>(),
                optionalDependencies = Array.Empty<object>()
            }));
        var payload = archive.CreateEntry("app/index.html");
        using var payloadWriter = new StreamWriter(payload.Open(), new UTF8Encoding(false));
        payloadWriter.Write($"<!doctype html><title>{payloadText}</title>");
    }

    private static string Status(DesktopPackageBridge bridge) => JsonSerializer.Serialize(bridge.Status(PackageId, Shell));

    private static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void ExpectPackageCode(Action action, string code)
    {
        try { action(); throw new Exception($"Expected {code}."); }
        catch (DesktopPackageException ex) when (ex.Code == code) { }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
