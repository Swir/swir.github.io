using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopPackageBridgeSelfTests
{
    private const string Shell = "swir.system.shell";

    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-package-bridge-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var previousTrustRoots = Environment.GetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS");
        try
        {
            var data = Path.Combine(root, "data");
            var bundle = Path.Combine(root, "demo.swirapp");
            CreateBundle(bundle, "swir.demo", "1.0.0");
            var hash = Sha256(bundle);

            var capabilities = new CapabilityBroker();
            var installer = new DesktopAppPackageInstaller(data);
            var bridge = new DesktopPackageBridge(capabilities, installer);

            var token = TokenOf(capabilities.RegisterFile(bundle, Shell));
            var installed = JsonSerializer.Serialize(bridge.InstallFromCapability(token, hash, Shell));
            Require(installed.Contains("swir.demo", StringComparison.Ordinal), "install result should identify package");
            Require(installed.Contains("VERIFIED", StringComparison.Ordinal), "install result should expose verified staged health");
            ExpectBridgeCode(() => capabilities.Describe(token, Shell), "CAPABILITY_INVALID");

            var status = JsonSerializer.Serialize(bridge.Status("swir.demo", Shell));
            Require(status.Contains("1.0.0", StringComparison.Ordinal), "status should expose installed version");
            Require(status.Contains("app/index.html", StringComparison.Ordinal), "status should expose verified package entry");

            var blockedBundle = Path.Combine(root, "blocked.swirapp");
            CreateBundle(blockedBundle, "swir.blocked", "1.0.0", "swir.missing-runtime", "2.0.0");
            var blockedToken = TokenOf(capabilities.RegisterFile(blockedBundle, Shell));
            ExpectPackageCode(() => bridge.InstallFromCapability(blockedToken, Sha256(blockedBundle), Shell), "PACKAGE_DEPENDENCY_UNSATISFIED");
            ExpectBridgeCode(() => capabilities.Describe(blockedToken, Shell), "CAPABILITY_INVALID");
            var blockedStatus = JsonSerializer.Serialize(bridge.Status("swir.blocked", Shell));
            Require(blockedStatus.Contains("\"installed\":false", StringComparison.OrdinalIgnoreCase), "unsatisfied dependency must not install payload");

            var runtimeBundle = Path.Combine(root, "runtime.swirapp");
            CreateBundle(runtimeBundle, "swir.runtime", "2.1.0");
            var runtimeToken = TokenOf(capabilities.RegisterFile(runtimeBundle, Shell));
            bridge.InstallFromCapability(runtimeToken, Sha256(runtimeBundle), Shell);

            var consumerBundle = Path.Combine(root, "consumer.swirapp");
            CreateBundle(consumerBundle, "swir.consumer", "1.0.0", "swir.runtime", "2.0.0");
            var consumerToken = TokenOf(capabilities.RegisterFile(consumerBundle, Shell));
            var consumer = JsonSerializer.Serialize(bridge.InstallFromCapability(consumerToken, Sha256(consumerBundle), Shell));
            Require(consumer.Contains("swir.consumer", StringComparison.Ordinal), "satisfied dependency should allow payload install");

            var badToken = TokenOf(capabilities.RegisterFile(bundle, Shell));
            ExpectPackageCode(() => bridge.InstallFromCapability(badToken, new string('0', 64), Shell), "PACKAGE_HASH_MISMATCH");
            ExpectBridgeCode(() => capabilities.Describe(badToken, Shell), "CAPABILITY_INVALID");

            var foreignToken = TokenOf(capabilities.RegisterFile(bundle, "swir.demo"));
            ExpectPackageCode(() => bridge.InstallFromCapability(foreignToken, hash, "swir.demo"), "PACKAGE_BRIDGE_FORBIDDEN");
            Require(JsonSerializer.Serialize(capabilities.Describe(foreignToken, "swir.demo")).Contains("swir.demo", StringComparison.Ordinal), "forbidden caller capability must not be consumed");

            VerifyProvisionedRootDisablesArbitrarySha(root, bundle, hash);
            VerifySignedCatalogInstallAndIdentityBinding(root);

            Console.WriteLine("Desktop package bridge self-tests passed.");
            return 0;
        }
        finally
        {
            Environment.SetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS", previousTrustRoots);
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static void VerifyProvisionedRootDisablesArbitrarySha(string root, string bundle, string hash)
    {
        var rootsPath = Path.Combine(root, "catalog-trust-roots.json");
        File.WriteAllText(rootsPath, JsonSerializer.Serialize(new
        {
            schema = DesktopCatalogTrustRootStore.Schema,
            roots = new[]
            {
                new
                {
                    keyId = "test-catalog-root",
                    name = "Test catalog root",
                    algorithm = "Ed25519",
                    format = "raw",
                    publicKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
                    scope = new[] { "catalog:official" },
                    enabled = true
                }
            }
        }));
        Environment.SetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS", rootsPath);

        var capabilities = new CapabilityBroker();
        var secureBridge = new DesktopPackageBridge(capabilities, new DesktopAppPackageInstaller(Path.Combine(root, "secure-data")));
        var info = JsonSerializer.Serialize(secureBridge.Describe());
        Require(info.Contains("SIGNED_CATALOG_REQUIRED", StringComparison.Ordinal), "provisioned root must switch package bridge to signed-catalog mode");
        Require(info.Contains("\"signedCatalogAuthorization\":true", StringComparison.OrdinalIgnoreCase), "bridge must advertise signed catalog authorization");
        Require(info.Contains("\"signedIdentityBinding\":true", StringComparison.OrdinalIgnoreCase), "bridge must advertise signed package identity binding");

        var token = TokenOf(capabilities.RegisterFile(bundle, Shell));
        ExpectPackageCode(() => secureBridge.InstallFromCapability(token, hash, Shell), "CATALOG_AUTHORIZATION_REQUIRED");
        ExpectBridgeCode(() => capabilities.Describe(token, Shell), "CAPABILITY_INVALID");
    }

    private static void VerifySignedCatalogInstallAndIdentityBinding(string root)
    {
        var algorithm = SignatureAlgorithm.Ed25519;
        using var key = Key.Create(algorithm, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        var publicKey = key.PublicKey.Export(KeyBlobFormat.RawPublicKey);
        var trustRoot = new DesktopCatalogTrustVerifier.TrustRoot("bridge-signing-root", "Bridge signing root", publicKey, new[] { "catalog:official" });
        var verifier = new DesktopCatalogTrustVerifier(Path.Combine(root, "signed-trust"), new[] { trustRoot });
        var capabilities = new CapabilityBroker();
        var installer = new DesktopAppPackageInstaller(Path.Combine(root, "signed-data"));
        var bridge = new DesktopPackageBridge(capabilities, installer, verifier);

        var signedBundle = Path.Combine(root, "signed.swirapp");
        CreateBundle(signedBundle, "swir.signed", "3.0.0");
        var authorization = CreateSignedAuthorization(key, "bridge-signing-root", "swir.signed", "3.0.0", Sha256(signedBundle), 101);
        var token = TokenOf(capabilities.RegisterFile(signedBundle, Shell));
        var installed = JsonSerializer.Serialize(bridge.InstallFromCapability(token, authorization, Shell));
        Require(installed.Contains("swir.signed", StringComparison.Ordinal), "valid signed catalog authorization should install matching bundle");
        Require(JsonSerializer.Serialize(bridge.Status("swir.signed", Shell)).Contains("3.0.0", StringComparison.Ordinal), "signed install should persist matching version");

        var mismatchBundle = Path.Combine(root, "signed-mismatch.swirapp");
        CreateBundle(mismatchBundle, "swir.actual", "4.0.0");
        var mismatchAuthorization = CreateSignedAuthorization(key, "bridge-signing-root", "swir.catalog-name", "4.0.0", Sha256(mismatchBundle), 102);
        var mismatchToken = TokenOf(capabilities.RegisterFile(mismatchBundle, Shell));
        ExpectPackageCode(() => bridge.InstallFromCapability(mismatchToken, mismatchAuthorization, Shell), "CATALOG_PACKAGE_IDENTITY_MISMATCH");
        ExpectBridgeCode(() => capabilities.Describe(mismatchToken, Shell), "CAPABILITY_INVALID");
        Require(JsonSerializer.Serialize(bridge.Status("swir.actual", Shell)).Contains("\"installed\":false", StringComparison.OrdinalIgnoreCase), "identity mismatch must be rejected before package mutation");
    }

    private static string CreateSignedAuthorization(Key key, string keyId, string packageId, string version, string sha256, long sequence)
    {
        var now = DateTimeOffset.UtcNow;
        var generatedAt = now.AddMinutes(-1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        var expiresAt = now.AddHours(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        var catalogVersion = $"test-{sequence}";
        var package = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["artifacts"] = new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["desktop"] = new SortedDictionary<string, object?>(StringComparer.Ordinal) { ["sha256"] = sha256 }
            },
            ["packageId"] = packageId,
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
            packageId,
            version,
            catalog = JsonSerializer.Deserialize<JsonElement>(catalogJson),
            envelope
        });
    }

    private static string TokenOf(object descriptor)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(descriptor));
        return doc.RootElement.GetProperty("token").GetString() ?? throw new InvalidOperationException("Capability token missing.");
    }

    private static void CreateBundle(string path, string packageId, string version, string? dependencyId = null, string? minVersion = null)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifest = archive.CreateEntry("swir-package.json");
        using (var writer = new StreamWriter(manifest.Open(), new UTF8Encoding(false)))
            writer.Write(JsonSerializer.Serialize(new
            {
                schema = "swir.app/1.0",
                id = packageId,
                packageId,
                name = "SWIR demo",
                version,
                author = "SWIR",
                type = "iframe",
                entry = "app/index.html",
                compatibility = new { minOS = "1.7.0", minSDK = "1.3.0", platformApi = 2, editions = new[] { "DESKTOP" } },
                dependencies = dependencyId is null ? Array.Empty<object>() : new object[] { new { packageId = dependencyId, minVersion } },
                optionalDependencies = Array.Empty<object>()
            }));
        var payload = archive.CreateEntry("app/index.html");
        using var payloadWriter = new StreamWriter(payload.Open(), new UTF8Encoding(false));
        payloadWriter.Write("<!doctype html><title>SWIR demo</title>");
    }

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

    private static void ExpectBridgeCode(Action action, string code)
    {
        try { action(); throw new Exception($"Expected {code}."); }
        catch (BridgeException ex) when (ex.Code == code) { }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
