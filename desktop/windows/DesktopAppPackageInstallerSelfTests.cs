using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopAppPackageInstallerSelfTests
{
    private static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-package-selftest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var dataRoot = Path.Combine(root, "data");
            var installer = new DesktopAppPackageInstaller(dataRoot);

            var v1 = CreateBundle(root, "demo-v1.swirapp", "swir.test.demo", "1.0.0", "hello-v1");
            var v1Hash = Sha256(v1);
            installer.Install(v1, v1Hash);
            AssertStatus(installer, "swir.test.demo", true, "1.0.0", false, "payload/index.html");
            AssertPayload(dataRoot, "swir.test.demo", "hello-v1");

            var v2 = CreateBundle(root, "demo-v2.swirapp", "swir.test.demo", "2.0.0", "hello-v2");
            installer.Install(v2, Sha256(v2));
            AssertStatus(installer, "swir.test.demo", true, "2.0.0", true, "payload/index.html");
            AssertPayload(dataRoot, "swir.test.demo", "hello-v2");

            installer.Rollback("swir.test.demo");
            AssertStatus(installer, "swir.test.demo", true, "1.0.0", true, "payload/index.html");
            AssertPayload(dataRoot, "swir.test.demo", "hello-v1");

            ExpectCode("PACKAGE_HASH_MISMATCH", () => installer.Install(v2, new string('0', 64)));

            var traversal = Path.Combine(root, "bad-traversal.swirapp");
            using (var zip = ZipFile.Open(traversal, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "swir-package.json", Manifest("swir.test.bad", "1.0.0"));
                WriteEntry(zip, "../escape.txt", "blocked");
            }
            ExpectCode("PACKAGE_PATH_TRAVERSAL", () => installer.Install(traversal, Sha256(traversal)));
            if (File.Exists(Path.Combine(root, "escape.txt"))) throw new Exception("Traversal escaped extraction root.");

            var duplicate = Path.Combine(root, "bad-duplicate.swirapp");
            using (var zip = ZipFile.Open(duplicate, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "swir-package.json", Manifest("swir.test.dupe", "1.0.0"));
                WriteEntry(zip, "payload/File.txt", "one");
                WriteEntry(zip, "payload/file.txt", "two");
            }
            ExpectCode("PACKAGE_DUPLICATE_PATH", () => installer.Install(duplicate, Sha256(duplicate)));

            var missingEntry = Path.Combine(root, "bad-entry.swirapp");
            using (var zip = ZipFile.Open(missingEntry, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "swir-package.json", Manifest("swir.test.missing", "1.0.0", "payload/missing.html"));
                WriteEntry(zip, "payload/index.html", "present");
            }
            ExpectCode("PACKAGE_ENTRY_MISSING", () => installer.Install(missingEntry, Sha256(missingEntry)));
            AssertNotInstalled(installer, "swir.test.missing");

            var entryTraversal = Path.Combine(root, "bad-entry-traversal.swirapp");
            using (var zip = ZipFile.Open(entryTraversal, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "swir-package.json", Manifest("swir.test.entrytraversal", "1.0.0", "../outside.html"));
                WriteEntry(zip, "payload/index.html", "present");
            }
            ExpectCode("PACKAGE_ENTRY_INVALID", () => installer.Install(entryTraversal, Sha256(entryTraversal)));
            AssertNotInstalled(installer, "swir.test.entrytraversal");

            var missingRequired = Path.Combine(root, "bad-manifest-required.swirapp");
            using (var zip = ZipFile.Open(missingRequired, ZipArchiveMode.Create))
            {
                WriteEntry(zip, "swir-package.json", JsonSerializer.Serialize(new { schema = "swir.app/1.0", id = "swir.test.required", packageId = "swir.test.required", version = "1.0.0", entry = "payload/index.html" }));
                WriteEntry(zip, "payload/index.html", "present");
            }
            ExpectCode("PACKAGE_MANIFEST_INVALID", () => installer.Install(missingRequired, Sha256(missingRequired)));
            AssertNotInstalled(installer, "swir.test.required");

            VerifyCrashRecovery(root);

            Console.WriteLine("Desktop .swirapp payload installer self-tests passed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static void VerifyCrashRecovery(string root)
    {
        var dataRoot = Path.Combine(root, "recovery-data");
        var installer = new DesktopAppPackageInstaller(dataRoot);
        var bundle = CreateBundle(root, "recovery.swirapp", "swir.test.recovery", "1.0.0", "known-good");
        installer.Install(bundle, Sha256(bundle));

        var packageRoot = Path.Combine(dataRoot, "Packages", "Installed", "swir.test.recovery");
        var current = Path.Combine(packageRoot, "Current");
        var previous = Path.Combine(packageRoot, "Previous");
        Directory.Move(current, previous);
        var incoming = Path.Combine(packageRoot, ".incoming-orphan");
        Directory.CreateDirectory(incoming);
        File.WriteAllText(Path.Combine(incoming, "partial.tmp"), "partial");
        var staging = Path.Combine(dataRoot, "Packages", ".staging", "orphan-stage");
        Directory.CreateDirectory(staging);
        File.WriteAllText(Path.Combine(staging, "partial.tmp"), "partial");

        var recovered = new DesktopAppPackageInstaller(dataRoot);
        AssertStatus(recovered, "swir.test.recovery", true, "1.0.0", false, "payload/index.html");
        AssertPayload(dataRoot, "swir.test.recovery", "known-good");
        if (Directory.Exists(incoming)) throw new Exception("Orphan incoming package directory was not cleaned during startup recovery.");
        if (Directory.Exists(staging)) throw new Exception("Orphan staging directory was not cleaned during startup recovery.");
    }

    private static string CreateBundle(string root, string name, string id, string version, string payload)
    {
        var path = Path.Combine(root, name);
        using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
        WriteEntry(zip, "swir-package.json", Manifest(id, version));
        WriteEntry(zip, "payload/index.html", payload);
        return path;
    }

    private static string Manifest(string id, string version, string entry = "payload/index.html") => JsonSerializer.Serialize(new
    {
        schema = "swir.app/1.0",
        id,
        packageId = id,
        name = "Self-test app",
        version,
        author = "SWIR",
        type = "iframe",
        entry
    });

    private static void WriteEntry(ZipArchive zip, string name, string content)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        using var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false));
        writer.Write(content);
    }

    private static string Sha256(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    private static void AssertStatus(DesktopAppPackageInstaller installer, string id, bool installed, string version, bool rollback, string entry)
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(installer.Status(id)));
        var root = json.RootElement;
        if (root.GetProperty("installed").GetBoolean() != installed) throw new Exception("Unexpected installed state.");
        if (root.GetProperty("version").GetString() != version) throw new Exception("Unexpected package version.");
        if (root.GetProperty("rollbackAvailable").GetBoolean() != rollback) throw new Exception("Unexpected rollback state.");
        if (root.GetProperty("entry").GetString() != entry) throw new Exception("Unexpected package entry.");
        if (root.GetProperty("health").GetString() != "VERIFIED") throw new Exception("Package health was not persisted.");
    }

    private static void AssertNotInstalled(DesktopAppPackageInstaller installer, string id)
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(installer.Status(id)));
        if (json.RootElement.GetProperty("installed").GetBoolean()) throw new Exception("Invalid package was promoted to Current.");
    }

    private static void AssertPayload(string dataRoot, string id, string expected)
    {
        var path = Path.Combine(dataRoot, "Packages", "Installed", id, "Current", "payload", "index.html");
        if (File.ReadAllText(path) != expected) throw new Exception("Unexpected current payload content.");
    }

    private static void ExpectCode(string code, Action action)
    {
        try { action(); }
        catch (DesktopPackageException ex) when (ex.Code == code) { return; }
        throw new Exception($"Expected DesktopPackageException code {code}.");
    }
}