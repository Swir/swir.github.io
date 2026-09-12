using System.Security.Cryptography;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseBundleSelfTests
{
    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-release-bundle-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "publish");
            Directory.CreateDirectory(source);
            File.WriteAllText(Path.Combine(source, "SWIR.Desktop.Host.exe"), "host-binary-test");
            Directory.CreateDirectory(Path.Combine(source, "assets"));
            File.WriteAllText(Path.Combine(source, "assets", "shell.txt"), "shell");

            using var rsa = RSA.Create(2048);
            var privatePem = rsa.ExportRSAPrivateKeyPem();
            var publicPem = rsa.ExportSubjectPublicKeyInfoPem();
            var version = new Version(0, 5, 2);
            var publishedAt = DateTimeOffset.UtcNow.AddMinutes(-1);
            var packageUri = new Uri("https://updates.example.test/SWIR-Desktop-0.5.2-stable.zip");

            var bundle1 = DesktopReleaseBundleBuilder.Build(
                source,
                Path.Combine(root, "bundle-1"),
                version,
                "SWIR.Desktop.Host.exe",
                packageUri,
                "stable",
                "test-key-1",
                privatePem,
                publishedAt);

            Require(File.Exists(bundle1.PackagePath), "release package missing");
            Require(File.Exists(bundle1.ManifestPath), "signed manifest missing");
            Require(File.Exists(bundle1.MetadataPath), "bundle metadata missing");

            var broker = new UpdateBroker(publicPem, new[] { "updates.example.test" });
            var verified = broker.VerifyManifest(File.ReadAllText(bundle1.ManifestPath), new Version(0, 5, 1), "stable");
            Require(verified.Version == version, "signed manifest version mismatch");
            Require(string.Equals(verified.Sha256, bundle1.PackageSha256, StringComparison.Ordinal), "signed package hash mismatch");
            Require(UpdateBroker.VerifyPackage(File.ReadAllBytes(bundle1.PackagePath), verified).Verified, "package verification failed");

            var metadata = JsonSerializer.Deserialize<DesktopReleaseBundleBuilder.ReleaseBundleMetadata>(File.ReadAllText(bundle1.MetadataPath));
            Require(metadata is not null, "bundle metadata could not be decoded");
            Require(metadata!.Schema == DesktopReleaseBundleBuilder.BundleSchema, "bundle schema mismatch");
            Require(metadata.PackageSha256 == bundle1.PackageSha256, "metadata package hash mismatch");
            Require(metadata.ManifestSha256 == bundle1.ManifestSha256, "metadata manifest hash mismatch");

            var bundle2 = DesktopReleaseBundleBuilder.Build(
                source,
                Path.Combine(root, "bundle-2"),
                version,
                "SWIR.Desktop.Host.exe",
                packageUri,
                "stable",
                "test-key-1",
                privatePem,
                publishedAt);
            Require(bundle1.PackageSha256 == bundle2.PackageSha256, "deterministic package hash changed between release bundles");
            Require(File.ReadAllBytes(bundle1.PackagePath).SequenceEqual(File.ReadAllBytes(bundle2.PackagePath)), "deterministic packages differ byte-for-byte");

            ExpectCode("UPDATE_RELEASE_BUNDLE_OUTPUT_EXISTS", () => DesktopReleaseBundleBuilder.Build(
                source, Path.Combine(root, "bundle-1"), version, "SWIR.Desktop.Host.exe", packageUri, "stable", "test-key-1", privatePem, publishedAt));

            ExpectCode("UPDATE_RELEASE_BUNDLE_URL_MISMATCH", () => DesktopReleaseBundleBuilder.Build(
                source, Path.Combine(root, "bundle-bad-url"), version, "SWIR.Desktop.Host.exe",
                new Uri("https://updates.example.test/wrong.zip"), "stable", "test-key-1", privatePem, publishedAt));
            Require(!Directory.Exists(Path.Combine(root, "bundle-bad-url")), "failed bundle left final output behind");

            Console.WriteLine("Desktop release bundle self-tests passed.");
            return 0;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void ExpectCode(string code, Action action)
    {
        try { action(); }
        catch (UpdateSecurityException ex) when (ex.Code == code) { return; }
        throw new InvalidOperationException($"Expected {code}.");
    }
}
