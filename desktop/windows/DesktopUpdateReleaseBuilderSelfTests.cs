using System.Security.Cryptography;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopUpdateReleaseBuilderSelfTests
{
    public static int Main()
    {
        var passed = 0;
        using var rsa = RSA.Create(2048);
        var privateKey = rsa.ExportPkcs8PrivateKeyPem();
        var publicKey = rsa.ExportSubjectPublicKeyInfoPem();
        var root = Path.Combine(Path.GetTempPath(), "swir-release-builder-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var packagePath = Path.Combine(root, "swir-desktop-0.5.2.zip");
            File.WriteAllBytes(packagePath, Enumerable.Range(0, 4096).Select(i => (byte)(i % 251)).ToArray());
            var packageUri = new Uri("https://updates.example.test/releases/swir-desktop-0.5.2.zip");
            var publishedAt = DateTimeOffset.UtcNow.AddMinutes(-1);

            var envelope = DesktopUpdateReleaseBuilder.BuildEnvelope(
                packagePath, packageUri, new Version(0, 5, 2), "stable", "desktop-test-2026", privateKey, publishedAt);
            var verifier = new UpdateBroker(publicKey, new[] { "updates.example.test" });
            var verified = verifier.VerifyManifest(envelope, new Version(0, 5, 1), "stable");
            Expect(verified.Version == new Version(0, 5, 2), "signed builder envelope accepted by production verifier", ref passed);
            Expect(verified.PackageUri == packageUri, "package URI preserved", ref passed);
            Expect(verified.Size == new FileInfo(packagePath).Length, "package size signed", ref passed);
            Expect(verified.Sha256.Length == 64, "package SHA-256 signed", ref passed);
            Expect(verified.KeyId == "desktop-test-2026", "key id preserved", ref passed);

            using (var document = JsonDocument.Parse(envelope))
            {
                var rootElement = document.RootElement;
                Expect(rootElement.GetProperty("Schema").GetString() == UpdateBroker.EnvelopeSchema, "envelope schema emitted", ref passed);
                Expect(rootElement.GetProperty("Algorithm").GetString() == UpdateBroker.SignatureAlgorithm, "RSA-PSS algorithm emitted", ref passed);
            }

            var manifestPath = Path.Combine(root, "channel", "stable.json");
            DesktopUpdateReleaseBuilder.WriteEnvelopeAtomic(manifestPath, envelope);
            Expect(File.ReadAllText(manifestPath) == envelope, "manifest written atomically", ref passed);

            ExpectSecurity("UPDATE_RELEASE_URL_INVALID", () => DesktopUpdateReleaseBuilder.BuildEnvelope(
                packagePath, new Uri("http://updates.example.test/release.zip"), new Version(0, 5, 2), "stable", "key", privateKey, publishedAt),
                "HTTP release URL rejected", ref passed);
            ExpectSecurity("UPDATE_RELEASE_CHANNEL_INVALID", () => DesktopUpdateReleaseBuilder.BuildEnvelope(
                packagePath, packageUri, new Version(0, 5, 2), "stable/../../x", "key", privateKey, publishedAt),
                "invalid release channel rejected", ref passed);
            ExpectSecurity("UPDATE_RELEASE_PRIVATE_KEY_INVALID", () => DesktopUpdateReleaseBuilder.BuildEnvelope(
                packagePath, packageUri, new Version(0, 5, 2), "stable", "key", publicKey, publishedAt),
                "public-only PEM cannot sign", ref passed);

            var emptyPath = Path.Combine(root, "empty.zip");
            File.WriteAllBytes(emptyPath, Array.Empty<byte>());
            ExpectSecurity("UPDATE_RELEASE_PACKAGE_SIZE_INVALID", () => DesktopUpdateReleaseBuilder.BuildEnvelope(
                emptyPath, packageUri, new Version(0, 5, 2), "stable", "key", privateKey, publishedAt),
                "empty release package rejected", ref passed);

            Console.WriteLine($"SWIR Desktop release builder self-tests passed: {passed}");
            return 0;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static void Expect(bool condition, string name, ref int passed)
    {
        if (!condition) throw new InvalidOperationException("FAIL: " + name);
        Console.WriteLine("PASS: " + name);
        passed++;
    }

    private static void ExpectSecurity(string code, Action action, string name, ref int passed)
    {
        try
        {
            action();
            throw new InvalidOperationException($"FAIL: {name} (no exception)");
        }
        catch (UpdateSecurityException ex) when (ex.Code == code)
        {
            Console.WriteLine("PASS: " + name);
            passed++;
        }
    }
}