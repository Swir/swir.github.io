using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopPackageBuilderSelfTests
{
    private static int Main()
    {
        var passed = 0;
        var root = Path.Combine(Path.GetTempPath(), "swir-package-builder-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "publish");
            Directory.CreateDirectory(Path.Combine(source, "Assets"));
            File.WriteAllText(Path.Combine(source, "SWIR.Desktop.Host.exe"), "host-binary-placeholder");
            File.WriteAllBytes(Path.Combine(source, "Assets", "shell.bin"), Enumerable.Range(0, 256).Select(i => (byte)i).ToArray());

            var first = Path.Combine(root, "first.zip");
            var second = Path.Combine(root, "second.zip");
            var version = new Version(0, 5, 2);
            var a = DesktopPackageBuilder.Build(source, first, version, "SWIR.Desktop.Host.exe");
            var b = DesktopPackageBuilder.Build(source, second, version, "SWIR.Desktop.Host.exe");

            Expect(a.Schema == DesktopPackageBuilder.BuilderSchema, "builder schema", ref passed);
            Expect(a.FileCount == 2 && a.ExpandedBytes > 0, "file inventory", ref passed);
            Expect(string.Equals(a.Sha256, b.Sha256, StringComparison.Ordinal), "repeat builds have identical SHA-256", ref passed);
            Expect(File.ReadAllBytes(first).SequenceEqual(File.ReadAllBytes(second)), "repeat builds are byte-for-byte deterministic", ref passed);

            using (var archive = ZipFile.OpenRead(first))
            {
                var names = archive.Entries.Select(entry => entry.FullName).ToArray();
                Expect(names.SequenceEqual(new[] { "desktop-package.json", "Assets/shell.bin", "SWIR.Desktop.Host.exe" }), "archive entries are canonical and sorted", ref passed);

                var manifestEntry = archive.GetEntry(DesktopPackageBuilder.ManifestEntryName) ?? throw new Exception("manifest missing");
                using var manifestStream = manifestEntry.Open();
                var manifest = JsonSerializer.Deserialize<DesktopPackageBuilder.PackageManifest>(manifestStream) ?? throw new Exception("manifest invalid");
                Expect(manifest.Schema == CandidatePackagePreparer.PackageManifestSchema, "manifest schema matches runtime candidate verifier", ref passed);
                Expect(manifest.Version == version.ToString() && manifest.EntryPoint == "SWIR.Desktop.Host.exe", "manifest release identity", ref passed);
                Expect(manifest.Files.Select(file => file.Path).SequenceEqual(new[] { "Assets/shell.bin", "SWIR.Desktop.Host.exe" }), "manifest file list sorted", ref passed);

                foreach (var file in manifest.Files)
                {
                    var entry = archive.GetEntry(file.Path) ?? throw new Exception($"missing {file.Path}");
                    using var input = entry.Open();
                    var hash = Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();
                    Expect(entry.Length == file.Size && hash == file.Sha256, $"manifest integrity {file.Path}", ref passed);
                }
            }

            ExpectThrows("UPDATE_PACKAGE_ENTRYPOINT_MISSING", () => DesktopPackageBuilder.Build(source, Path.Combine(root, "missing.zip"), version, "missing.exe"), ref passed);
            ExpectThrows("UPDATE_PACKAGE_OUTPUT_INVALID", () => DesktopPackageBuilder.Build(source, Path.Combine(source, "bad.zip"), version, "SWIR.Desktop.Host.exe"), ref passed);

            File.WriteAllText(Path.Combine(source, DesktopPackageBuilder.ManifestEntryName), "reserved");
            ExpectThrows("UPDATE_PACKAGE_RESERVED_PATH", () => DesktopPackageBuilder.Build(source, Path.Combine(root, "reserved.zip"), version, "SWIR.Desktop.Host.exe"), ref passed);

            Console.WriteLine($"Desktop package builder self-tests passed: {passed}");
            return 0;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static void Expect(bool condition, string name, ref int passed)
    {
        if (!condition) throw new Exception("FAILED: " + name);
        passed++;
    }

    private static void ExpectThrows(string code, Action action, ref int passed)
    {
        try
        {
            action();
            throw new Exception("FAILED: expected " + code);
        }
        catch (UpdateSecurityException ex) when (ex.Code == code)
        {
            passed++;
        }
    }
}
