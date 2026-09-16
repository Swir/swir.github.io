using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopPackageSignatureSelfTests
{
    private const string Shell = "swir.system.shell";

    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-package-signature-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var previousRoots = Environment.GetEnvironmentVariable("SWIR_PACKAGE_TRUST_ROOTS");
        try
        {
            var algorithm = SignatureAlgorithm.Ed25519;
            using var key = Key.Create(algorithm, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
            var trustRoot = new DesktopPackageSignatureVerifier.TrustRoot(
                "test-package-root",
                "SWIR package self-test root",
                key.PublicKey.Export(KeyBlobFormat.RawPublicKey),
                new[] { "package:*" });
            var verifier = new DesktopPackageSignatureVerifier(new[] { trustRoot });

            var bundle = Path.Combine(root, "signed.swirapp");
            CreateBundle(bundle, "swir.signed-package", "1.0.0");
            var hash = Sha256(bundle);
            var signature = CreateSignature(key, "test-package-root", "swir.signed-package", "1.0.0", hash);

            var direct = verifier.Verify(bundle, signature, "swir.signed-package", "1.0.0");
            Require(direct.Sha256 == hash, "verified digest mismatch");
            Require(direct.KeyId == "test-package-root", "verified key id mismatch");

            VerifyBridgeRequiresAndAcceptsSignature(root, verifier, bundle, signature, hash);
            VerifyTamperAndIdentityRejection(root, key, verifier, bundle, hash);
            VerifyScopeRejection(root, key, bundle, hash);
            VerifyTrustRootStore(root, key);

            Console.WriteLine("Desktop .swirapp Ed25519 signature self-tests passed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            Environment.SetEnvironmentVariable("SWIR_PACKAGE_TRUST_ROOTS", previousRoots);
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static void VerifyBridgeRequiresAndAcceptsSignature(string root, DesktopPackageSignatureVerifier verifier, string bundle, string signature, string hash)
    {
        var capabilities = new CapabilityBroker();
        var installer = new DesktopAppPackageInstaller(Path.Combine(root, "bridge-data"));
        var bridge = new DesktopPackageBridge(capabilities, installer, null, verifier, root);
        var descriptor = JsonSerializer.Serialize(bridge.Describe());
        Require(descriptor.Contains("PACKAGE_SIGNATURE_REQUIRED", StringComparison.Ordinal), "bridge must advertise package signature mode");
        Require(descriptor.Contains("\"packageSignatureVerification\":true", StringComparison.OrdinalIgnoreCase), "bridge must advertise native signature verification");

        var unsignedToken = TokenOf(capabilities.RegisterFile(bundle, Shell));
        ExpectPackageCode(() => bridge.InstallFromCapability(unsignedToken, hash, Shell), "PACKAGE_SIGNATURE_REQUIRED");
        ExpectBridgeCode(() => capabilities.Describe(unsignedToken, Shell), "CAPABILITY_INVALID");

        var token = TokenOf(capabilities.RegisterFile(bundle, Shell));
        var installed = JsonSerializer.Serialize(bridge.InstallFromCapability(token, signature, Shell));
        Require(installed.Contains("swir.signed-package", StringComparison.Ordinal), "valid package signature should authorize install");
        Require(JsonSerializer.Serialize(bridge.Status("swir.signed-package", Shell)).Contains("1.0.0", StringComparison.Ordinal), "signed package version must persist");
    }

    private static void VerifyTamperAndIdentityRejection(string root, Key key, DesktopPackageSignatureVerifier verifier, string bundle, string hash)
    {
        var capabilities = new CapabilityBroker();
        var bridge = new DesktopPackageBridge(capabilities, new DesktopAppPackageInstaller(Path.Combine(root, "negative-data")), null, verifier, root);

        var badSignature = CreateSignature(key, "test-package-root", "swir.signed-package", "1.0.0", hash, new byte[64]);
        var badToken = TokenOf(capabilities.RegisterFile(bundle, Shell));
        ExpectPackageCode(() => bridge.InstallFromCapability(badToken, badSignature, Shell), "PACKAGE_SIGNATURE_BAD_SIGNATURE");

        var wrongIdentity = CreateSignature(key, "test-package-root", "swir.other-package", "1.0.0", hash);
        var identityToken = TokenOf(capabilities.RegisterFile(bundle, Shell));
        ExpectPackageCode(() => bridge.InstallFromCapability(identityToken, wrongIdentity, Shell), "PACKAGE_SIGNATURE_IDENTITY_MISMATCH");

        var wrongDigest = CreateSignature(key, "test-package-root", "swir.signed-package", "1.0.0", new string('0', 64));
        var digestToken = TokenOf(capabilities.RegisterFile(bundle, Shell));
        ExpectPackageCode(() => bridge.InstallFromCapability(digestToken, wrongDigest, Shell), "PACKAGE_SIGNATURE_HASH_MISMATCH");
    }

    private static void VerifyScopeRejection(string root, Key key, string bundle, string hash)
    {
        var restricted = new DesktopPackageSignatureVerifier(new[]
        {
            new DesktopPackageSignatureVerifier.TrustRoot(
                "test-package-root",
                "Restricted root",
                key.PublicKey.Export(KeyBlobFormat.RawPublicKey),
                new[] { "package:swir.allowed-only" })
        });
        var bridge = new DesktopPackageBridge(
            new CapabilityBroker(),
            new DesktopAppPackageInstaller(Path.Combine(root, "scope-data")),
            null,
            restricted,
            root);
        var signature = CreateSignature(key, "test-package-root", "swir.signed-package", "1.0.0", hash);
        var capabilitiesField = new CapabilityBroker();
        var scopedBridge = new DesktopPackageBridge(
            capabilitiesField,
            new DesktopAppPackageInstaller(Path.Combine(root, "scope-data-2")),
            null,
            restricted,
            root);
        var token = TokenOf(capabilitiesField.RegisterFile(bundle, Shell));
        ExpectPackageCode(() => scopedBridge.InstallFromCapability(token, signature, Shell), "PACKAGE_SIGNATURE_KEY_OUT_OF_SCOPE");
    }

    private static void VerifyTrustRootStore(string root, Key key)
    {
        var rootsPath = Path.Combine(root, "package-trust-roots.json");
        File.WriteAllText(rootsPath, JsonSerializer.Serialize(new
        {
            schema = DesktopPackageTrustRootStore.Schema,
            requireSignedPackages = true,
            roots = new[]
            {
                new
                {
                    keyId = "provisioned-package-root",
                    name = "Provisioned package root",
                    algorithm = "Ed25519",
                    format = "raw",
                    publicKey = Convert.ToBase64String(key.PublicKey.Export(KeyBlobFormat.RawPublicKey)),
                    scope = new[] { "package:*" },
                    enabled = true
                }
            }
        }));
        Environment.SetEnvironmentVariable("SWIR_PACKAGE_TRUST_ROOTS", rootsPath);
        var loaded = DesktopPackageTrustRootStore.LoadProvisioned();
        Require(loaded.RequireSignedPackages, "provisioned trust policy should require signed packages");
        Require(loaded.Roots.Count == 1, "expected one provisioned package trust root");

        var lockedEmpty = Path.Combine(root, "locked-empty-package-roots.json");
        File.WriteAllText(lockedEmpty, JsonSerializer.Serialize(new
        {
            schema = DesktopPackageTrustRootStore.Schema,
            requireSignedPackages = true,
            roots = Array.Empty<object>()
        }));
        Environment.SetEnvironmentVariable("SWIR_PACKAGE_TRUST_ROOTS", lockedEmpty);
        ExpectPackageCode(() => DesktopPackageTrustRootStore.LoadProvisioned(), "PACKAGE_TRUST_ROOT_REQUIRED");
    }

    private static string CreateSignature(Key key, string keyId, string packageId, string version, string hash, byte[]? overrideSignature = null)
    {
        var payload = DesktopPackageSignatureVerifier.BuildSignedPayload(keyId, packageId, version, hash);
        var signature = overrideSignature ?? SignatureAlgorithm.Ed25519.Sign(key, Encoding.UTF8.GetBytes(payload));
        return JsonSerializer.Serialize(new
        {
            schema = DesktopPackageSignatureVerifier.SignatureSchema,
            algorithm = "Ed25519",
            keyId,
            packageId,
            version,
            sha256 = hash,
            signature = Convert.ToBase64String(signature)
        });
    }

    private static void CreateBundle(string path, string packageId, string version)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifest = archive.CreateEntry("swir-package.json");
        using (var writer = new StreamWriter(manifest.Open(), new UTF8Encoding(false)))
            writer.Write(JsonSerializer.Serialize(new
            {
                schema = "swir.app/1.0",
                id = packageId,
                packageId,
                name = "Signed package self-test",
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
        payloadWriter.Write("<!doctype html><title>Signed SWIR package</title>");
    }

    private static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string TokenOf(object descriptor)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(descriptor));
        return doc.RootElement.GetProperty("token").GetString() ?? throw new InvalidOperationException("Capability token missing.");
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
