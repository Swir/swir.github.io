using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseBundleVerifierSelfTests
{
    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-release-verifier-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "publish");
            Directory.CreateDirectory(source);
            File.WriteAllText(Path.Combine(source, "SWIR.Desktop.Host.exe"), "host-binary-test");
            File.WriteAllText(Path.Combine(source, "shell.txt"), "shell");

            using var rsa = RSA.Create(2048);
            var privatePem = rsa.ExportRSAPrivateKeyPem();
            var publicPem = rsa.ExportSubjectPublicKeyInfoPem();
            var version = new Version(0, 5, 2);
            var channel = "stable";
            var host = "updates.example.test";
            var publishedAt = DateTimeOffset.UtcNow.AddMinutes(-2);
            var packageUri = new Uri($"https://{host}/SWIR-Desktop-{version}-{channel}.zip");
            var bundle = DesktopReleaseBundleBuilder.Build(
                source,
                Path.Combine(root, "bundle"),
                version,
                "SWIR.Desktop.Host.exe",
                packageUri,
                channel,
                "test-key-1",
                privatePem,
                publishedAt);

            var verified = DesktopReleaseBundleVerifier.Verify(bundle.OutputDirectory, version, channel, publicPem, new[] { host });
            Require(verified.Schema == DesktopReleaseBundleVerifier.VerifierSchema, "verifier schema mismatch");
            Require(verified.PackageSha256 == bundle.PackageSha256, "verified package hash mismatch");
            Require(verified.ManifestSha256 == bundle.ManifestSha256, "verified manifest hash mismatch");
            Require(verified.PackageHost == host, "verified package host mismatch");

            ExpectCode("UPDATE_HOST_DENIED", () => DesktopReleaseBundleVerifier.Verify(bundle.OutputDirectory, version, channel, publicPem, new[] { "other.example.test" }));
            ExpectCode("UPDATE_RELEASE_BUNDLE_VERSION_MISMATCH", () => DesktopReleaseBundleVerifier.Verify(bundle.OutputDirectory, new Version(0, 5, 3), channel, publicPem, new[] { host }));
            ExpectCode("UPDATE_RELEASE_BUNDLE_CHANNEL_MISMATCH", () => DesktopReleaseBundleVerifier.Verify(bundle.OutputDirectory, version, "preview", publicPem, new[] { host }));

            File.AppendAllText(bundle.PackagePath, "tamper");
            ExpectCode("UPDATE_RELEASE_BUNDLE_SIZE_MISMATCH", () => DesktopReleaseBundleVerifier.Verify(bundle.OutputDirectory, version, channel, publicPem, new[] { host }));

            Console.WriteLine("Desktop release bundle verifier self-tests passed.");
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
