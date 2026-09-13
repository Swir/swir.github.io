using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopSignedPackageLifecycleSelfTests
{
    private const string Shell = "swir.system.shell";
    private const string KeyId = "signed-lifecycle-root";

    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-signed-lifecycle-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var previousRoots = Environment.GetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS");
        try
        {
            var packageData = Path.Combine(root, "packages");
            var trustData = Path.Combine(root, "trust");
            using var signingKey = Key.Create(SignatureAlgorithm.Ed25519, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
            var rootsPath = Path.Combine(root, "catalog-trust-roots.json");
            WriteTrustRoots(rootsPath, signingKey.PublicKey.Export(KeyBlobFormat.RawPublicKey));
            Environment.SetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS", rootsPath);

            var v1 = Path.Combine(root, "lifecycle-1.0.0.swirapp");
            var v2 = Path.Combine(root, "lifecycle-2.0.0.swirapp");
            CreateBundle(v1, "swir.lifecycle", "1.0.0", "v1");
            CreateBundle(v2, "swir.lifecycle", "2.0.0", "v2");

            // Signed install, then reconstruct all native bridge objects to model a Host restart.
            var bridge = NewBridge(packageData, trustData);
            InstallSigned(bridge, v1, signingKey, "1.0.0", 501);
            Require(StatusJson(bridge).Contains("1.0.0", StringComparison.Ordinal), "signed v1 install should be visible before restart");

            bridge = NewBridge(packageData, trustData);
            Require(StatusJson(bridge).Contains("1.0.0", StringComparison.Ordinal), "signed v1 must survive Host restart");

            // Signed update through a strictly newer catalog sequence.
            InstallSigned(bridge, v2, signingKey, "2.0.0", 502);
            Require(StatusJson(bridge).Contains("2.0.0", StringComparison.Ordinal), "signed v2 update should become current");

            bridge = NewBridge(packageData, trustData);
            Require(StatusJson(bridge).Contains("2.0.0", StringComparison.Ordinal), "signed v2 must survive Host restart");

            // Native rollback must restore the previously verified payload and survive another restart.
            var rollback = JsonSerializer.Serialize(bridge.Rollback("swir.lifecycle", Shell));
            Require(rollback.Contains("1.0.0", StringComparison.Ordinal), "rollback should restore v1 metadata");

            bridge = NewBridge(packageData, trustData);
            Require(StatusJson(bridge).Contains("1.0.0", StringComparison.Ordinal), "rolled-back v1 must survive Host restart");

            // Rolling the payload back must never roll the catalog trust high-water mark back.
            var staleToken = Register(bridge, v1);
            var staleAuthorization = CreateSignedAuthorization(signingKey, "swir.lifecycle", "1.0.0", Sha256(v1), 501);
            ExpectPackageCode(() => bridge.InstallFromCapability(staleToken, staleAuthorization, Shell), "CATALOG_ROLLBACK_DETECTED");

            bridge = NewBridge(packageData, trustData);
            Require(StatusJson(bridge).Contains("1.0.0", StringComparison.Ordinal), "rejected stale catalog must not mutate rolled-back payload");

            Console.WriteLine("Signed Desktop package lifecycle self-tests passed.");
            return 0;
        }
        finally
        {
            Environment.SetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS", previousRoots);
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static DesktopPackageBridge NewBridge(string packageData, string trustData)
    {
        var verifier = DesktopCatalogTrustRootStore.CreateVerifier(trustData)
            ?? throw new Exception("Provisioned signed lifecycle root was not loaded.");
        return new DesktopPackageBridge(new CapabilityBroker(), new DesktopAppPackageInstaller(packageData), verifier);
    }

    private static void InstallSigned(DesktopPackageBridge bridge, string bundle, Key key, string version, long sequence)
    {
        var token = Register(bridge, bundle);
        var authorization = CreateSignedAuthorization(key, "swir.lifecycle", version, Sha256(bundle), sequence);
        var result = JsonSerializer.Serialize(bridge.InstallFromCapability(token, authorization, Shell));
        Require(result.Contains(version, StringComparison.Ordinal), $"signed install result should contain {version}");
        Require(result.Contains("VERIFIED", StringComparison.Ordinal), "signed install must retain installer health verification");
    }

    private static string Register(DesktopPackageBridge bridge, string bundle)
    {
        var field = typeof(DesktopPackageBridge).GetField("_capabilities", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            ?? throw new Exception("DesktopPackageBridge capability broker field not found.");
        var broker = (CapabilityBroker)(field.GetValue(bridge) ?? throw new Exception("Capability broker unavailable."));
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(broker.RegisterFile(bundle, Shell)));
        return doc.RootElement.GetProperty("token").GetString() ?? throw new Exception("Capability token missing.");
    }

    private static string StatusJson(DesktopPackageBridge bridge) => JsonSerializer.Serialize(bridge.Status("swir.lifecycle", Shell));

    private static void WriteTrustRoots(string path, byte[] publicKey)
    {
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            schema = DesktopCatalogTrustRootStore.Schema,
            requireSignedCatalog = true,
            roots = new[]
            {
                new
                {
                    keyId = KeyId,
                    name = "Signed lifecycle CI root",
                    algorithm = "Ed25519",
                    format = "raw",
                    publicKey = Convert.ToBase64String(publicKey),
                    scope = new[] { "catalog:official" },
                    enabled = true
                }
            }
        }));
    }

    private static string CreateSignedAuthorization(Key key, string packageId, string version, string sha256, long sequence)
    {
        var now = DateTimeOffset.UtcNow;
        var generatedAt = now.AddMinutes(-1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        var expiresAt = now.AddHours(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        var catalogVersion = $"lifecycle-{sequence}";
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
            ["keyId"] = KeyId,
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

    private static void CreateBundle(string path, string packageId, string version, string payloadText)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifest = archive.CreateEntry("swir-package.json");
        using (var writer = new StreamWriter(manifest.Open(), new UTF8Encoding(false)))
            writer.Write(JsonSerializer.Serialize(new
            {
                schema = "swir.app/1.0",
                id = packageId,
                packageId,
                name = "SWIR signed lifecycle",
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
